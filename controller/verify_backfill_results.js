/**
 * 回填结果验证脚本
 * 功能：飞书读回统计 + 重点样本回归 + 旧缓存污染扫描
 */
const { execFile } = require('child_process');
const { initDatabase, getCompanyProfileCacheByNormalizedName } = require('./db');
const { initFeishuClient, listTargets, listRecords } = require('./feishu-client');
const path = require('path');

const SAMPLE_COMPANIES = ['飞翼未来科技', '上上客', '杭州佰钧成'];
const DB_PATH = path.join(__dirname, 'data', 'zhaopin.db');

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function runSqlite(query) {
  return new Promise((resolve, reject) => {
    execFile('sqlite3', ['-json', DB_PATH, query], { maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      try {
        resolve(JSON.parse(stdout || '[]'));
      } catch {
        resolve([]);
      }
    });
  });
}

async function main() {
  initDatabase();
  initFeishuClient();

  const targetName = process.env.FEISHU_TARGET || (listTargets().find((item) => item.isDefault)?.name || null);
  if (!targetName) {
    throw new Error('No Feishu target configured');
  }

  // ===== 第一部分：飞书读回统计 =====
  console.log('========================================');
  console.log('一、飞书表读回统计');
  console.log('========================================\n');

  const allRecords = [];
  let pageToken = null;
  do {
    const page = await listRecords(targetName, { pageToken, pageSize: 500 });
    allRecords.push(...page.items);
    pageToken = page.hasMore ? page.pageToken : null;
  } while (pageToken);

  let total = allRecords.length;
  let descFilled = 0;
  let typeFilled = 0;
  let bothFilled = 0;
  let bothEmpty = 0;

  for (const item of allRecords) {
    const fields = item.fields || {};
    const desc = cleanString(fields['公司简介']);
    const type = cleanString(fields['公司类型']);
    if (desc.length > 0) descFilled++;
    if (type.length > 0) typeFilled++;
    if (desc.length > 0 && type.length > 0) bothFilled++;
    if (desc.length === 0 && type.length === 0) bothEmpty++;
  }

  console.log(`总数: ${total}`);
  console.log(`公司简介 已填: ${descFilled}`);
  console.log(`公司类型 已填: ${typeFilled}`);
  console.log(`两列都有: ${bothFilled}`);
  console.log(`两列都空: ${bothEmpty}`);
  console.log('');

  // ===== 第二部分：重点样本回归 =====
  console.log('========================================');
  console.log('二、重点样本回归');
  console.log('========================================\n');

  for (const companyName of SAMPLE_COMPANIES) {
    const feishuRecord = allRecords.find((item) => {
      const name = cleanString(item.fields?.['公司名称']);
      return name.includes(companyName) || companyName.includes(name);
    });
    const cache = getCompanyProfileCacheByNormalizedName(companyName);

    console.log(`--- ${companyName} ---`);
    if (feishuRecord) {
      const fields = feishuRecord.fields || {};
      console.log(`  飞书 公司简介: ${cleanString(fields['公司简介']) || '(空)'}`);
      console.log(`  飞书 公司类型: ${cleanString(fields['公司类型']) || '(空)'}`);
    } else {
      console.log('  飞书: 未找到匹配记录');
    }
    if (cache) {
      console.log(`  缓存 status: ${cache.status}`);
      console.log(`  缓存 source: ${cache.source || '(空)'}`);
      console.log(`  缓存 companyType: ${cleanString(cache.companyType) || '(空)'}`);
      console.log(`  缓存 companyDescription: ${cleanString(cache.companyDescription) || '(空)'}`);
    } else {
      console.log('  缓存: 未找到');
    }
    console.log('');
  }

  // ===== 第三部分：旧缓存污染扫描 =====
  console.log('========================================');
  console.log('三、旧缓存污染扫描');
  console.log('========================================\n');

  let ddgRows = [];
  let challengeRows = [];
  try {
    ddgRows = await runSqlite("SELECT company_name_normalized, status, source FROM company_profile_cache WHERE source LIKE '%duckduckgo%'");
    challengeRows = await runSqlite("SELECT company_name_normalized, status, source FROM company_profile_cache WHERE company_description LIKE '%arg1=%' OR company_description LIKE '%acw_sc__v2%'");
  } catch (error) {
    console.log(`(缓存扫描跳过: ${error.message})\n`);
  }

  console.log(`DDG 源缓存条目: ${ddgRows.length}`);
  if (ddgRows.length > 0) {
    for (const row of ddgRows.slice(0, 10)) {
      console.log(`  - ${cleanString(row.company_name_normalized)} (${row.status}, ${row.source})`);
    }
    if (ddgRows.length > 10) {
      console.log(`  ... 还有 ${ddgRows.length - 10} 条`);
    }
  }

  console.log(`挑战页残留缓存条目: ${challengeRows.length}`);
  for (const row of challengeRows) {
    console.log(`  - ${cleanString(row.company_name_normalized)} (${row.status}, ${row.source})`);
  }
  console.log('');

  // ===== 第四部分：与上轮基线对比 =====
  console.log('========================================');
  console.log('四、与上轮基线对比');
  console.log('========================================\n');

  console.log('              上轮基线   本轮飞书读回   变化');
  console.log(`公司简介已填:  57        ${String(descFilled).padStart(4)}         ${descFilled >= 57 ? '+' : ''}${descFilled - 57}`);
  console.log(`公司类型已填:  43        ${String(typeFilled).padStart(4)}         ${typeFilled >= 43 ? '+' : ''}${typeFilled - 43}`);
  console.log(`两列都有:     22        ${String(bothFilled).padStart(4)}         ${bothFilled >= 22 ? '+' : ''}${bothFilled - 22}`);
  console.log(`两列都空:     102       ${String(bothEmpty).padStart(4)}         ${bothEmpty <= 102 ? '' : '+'}${bothEmpty - 102}`);
  console.log('');
}

main().catch((error) => {
  console.error(`[VerifyBackfill] Failed: ${error.message}`);
  process.exitCode = 1;
});
