/**
 * 飞书数据质量抽查脚本
 * 输出所有有简介的记录，按来源标注，方便人工审查
 */
const { initFeishuClient, listTargets, listRecords } = require('./feishu-client');

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// 脏内容模式
const DIRTY_PATTERNS = [
  /百度百科\s*网页|百度百科$|网页\s*新闻|贴吧|知道$|文库|文心|更多 翻译|学术|百科/u,
  /百度知道|知乎|百度首页|hao123|设置 登录|你就知道|票根网官网登录/u,
  /这个公司怎么样|我要提问|欢迎.*新老员工|官网登录|Shenzhen City|深圳市/u,
  /经营范围包括|一般经营项目是|公司已于.*年.*月.*日|法定代表人/u,
  /acw_sc__v2|arg1=|__jsl_clearance|请完成安全?验证|人机验证|滑块验证/u,
  /&ensp;|&emsp;|&#\d+;|&#[xX][0-9a-fA-F]+;/u,
  /成立于|开业状态|企业概况|工商信息|团队信息/u
];

function isDirty(value) {
  const text = cleanString(value);
  if (!text) return false;
  return DIRTY_PATTERNS.some(p => p.test(text));
}

function isShort(value) {
  const text = cleanString(value);
  return text.length > 0 && text.length < 20;
}

async function main() {
  initFeishuClient();
  const target = listTargets().find(t => t.isDefault).name;
  const allRecords = [];
  let pageToken = null;
  do {
    const page = await listRecords(target, { pageToken, pageSize: 500 });
    allRecords.push(...page.items);
    pageToken = page.hasMore ? page.pageToken : null;
  } while (pageToken);

  console.log(`飞书总记录: ${allRecords.length}`);
  console.log('');

  // 分类统计
  const stats = { total: 0, dirty: 0, short: 0, clean: 0, empty: 0 };
  const dirtyRecords = [];
  const shortRecords = [];
  const cleanRecords = [];

  for (const item of allRecords) {
    const fields = item.fields || {};
    const name = cleanString(fields['公司名称']);
    const desc = cleanString(fields['公司简介']);
    const type = cleanString(fields['公司类型']);

    if (!desc) continue;

    stats.total++;
    if (isDirty(desc)) {
      stats.dirty++;
      dirtyRecords.push({ name, desc: desc.slice(0, 120), type });
    } else if (isShort(desc)) {
      stats.short++;
      shortRecords.push({ name, desc, type });
    } else {
      stats.clean++;
      cleanRecords.push({ name, desc: desc.slice(0, 120), type });
    }
  }

  console.log('=== 简介质量分布 ===');
  console.log(`有简介记录: ${stats.total}`);
  console.log(`疑似脏内容: ${stats.dirty}`);
  console.log(`过短(<20字): ${stats.short}`);
  console.log(`干净简介: ${stats.clean}`);
  console.log('');

  if (dirtyRecords.length > 0) {
    console.log('=== 疑似脏内容记录 ===');
    for (const r of dirtyRecords) {
      console.log(`  [DIRTY] ${r.name} | type=${r.type || '(空)'}`);
      console.log(`          ${r.desc}`);
    }
    console.log('');
  }

  if (shortRecords.length > 0) {
    console.log('=== 过短简介记录 ===');
    for (const r of shortRecords) {
      console.log(`  [SHORT] ${r.name} (${r.desc.length}字) | type=${r.type || '(空)'}`);
      console.log(`          ${r.desc}`);
    }
    console.log('');
  }

  // 输出所有有简介的记录（方便全面审查）
  console.log('=== 全部有简介记录 ===');
  for (const r of [...dirtyRecords, ...shortRecords, ...cleanRecords]) {
    const tag = dirtyRecords.includes(r) ? '[DIRTY]' : shortRecords.includes(r) ? '[SHORT]' : '[OK]';
    console.log(`  ${tag} ${r.name} | type=${r.type || '(空)'} | ${r.desc}`);
  }

  // 只有两列都空的记录
  const bothEmpty = allRecords.filter(item => {
    const fields = item.fields || {};
    return !cleanString(fields['公司简介']) && !cleanString(fields['公司类型']);
  });
  console.log(`\n=== 两列都空: ${bothEmpty.length} ===`);
  for (const item of bothEmpty) {
    const fields = item.fields || {};
    const name = cleanString(fields['公司名称']);
    const industry = cleanString(fields['行业领域']);
    const scale = cleanString(fields['公司规模']);
    console.log(`  ${name} | 行业=${industry || '-'} | 规模=${scale || '-'}`);
  }
}

main().catch(err => {
  console.error('[AuditQuality] Failed: ' + err.message);
  process.exitCode = 1;
});
