/**
 * 清理已写入飞书的脏简介数据
 * 模式：基于名单 + 脏内容正则双重检测
 */
const { initFeishuClient, listTargets, listRecords, updateRecord } = require('./feishu-client');

// 已确认的脏数据公司名
const DIRTY_NAMES = [
  '椒房流香', '西格玛', '通达致远', '诚迈科技', '康享日记', '国鑫',
  '正云科技', '清闲智能创新', 'SUTPC', '大秦数字能源技术股份',
  // 第三轮抽查发现的脏数据
  '禾硕科技', '盈立数智', '讴旎科技', '维拍物联', 'Sugr米唐科技',
  '冠捷科技深圳', '深圳芯途智感科技', '海科技术', '睿湾科技', '韦瑞科技',
  '芊妙机器人', '睿服科技', '纽瑞芯科技', '猛玛', '禾泰科技',
  '魔法原子', '美莱雅科技有限公司', '富成魔术贴有限公司', '瑞麒珠宝首饰',
  '大人糖', '富兰瓦时', '深圳市开颜医疗器械',
  // 过短无意义简介
  '鼎盛威融合科技公司', '深圳雁联', '山海星辰传媒',
  // 非公司实体/误匹配
  '深圳易可达科技', '谱程集团', '优必选机器人', ' TCL实业',
  '伟创电气', '云里物里', '嘉立创', '深圳市木薯科技',
  '恒禾立', '星尘智能', '急速国际', '品阔', '泓盛网络科技',
  '承启在贸易', '坦途科技', '小壹', '深圳市首航新能源'
];

// 脏内容正则（与 backfill 中 isDirtySearchSnippet 保持一致）
const DIRTY_PATTERNS = [
  /百度百科\s*网页|百度百科$|网页\s*新闻|贴吧|知道$|文库|文心|更多 翻译|学术|百科/u,
  /百度知道|知乎|百度首页|hao123|设置 登录|你就知道|票根网官网登录/u,
  /网站地图|在线客服|版权所有|Copyright|ICP备|公众号二维码|粤ICP备/u,
  /关注.*推荐|热榜|专栏|圈子|付费咨询|知学堂|登录\/注册|被浏览|被收录/u,
  /参保人数|注册资本|统一社会信用代码|企业注册地址|小微企业|科技型中小企业|瞪羚企业/u,
  /男.*\d{4}年.*月出生|城市管理委员会|科员/u,
  /希腊字母|音译|第十八个|求和符号/u,
  /回帖提示|反政府|封锁ID|提交前|amobbs|电子技术论坛/u,
  /备案号|粤ICP|ICP备|官网.*版权/u,
  /经营范围包括|一般经营项目是|公司已于.*年.*月.*日|法定代表人/u,
  /成立于\d{4}年.*月|位于[^，。]{2,40}[，。]/u,
  /^·\s*简介[：:]\s*\d+、|^·\s*\d+、\s*.{0,10}是一/u,
  /一般经营项目是[^。]{4,}/u
];

function isDirty(value) {
  const text = (value || '').trim();
  if (!text) return false;
  return DIRTY_PATTERNS.some(function(p) { return p.test(text); });
}

async function main() {
  initFeishuClient();
  const target = listTargets().find(function(t) { return t.isDefault; }).name;
  const page = await listRecords(target, { pageSize: 500 });
  let cleaned = 0;
  let skipped = 0;

  for (const item of page.items) {
    const name = (item.fields['公司名称'] || '').trim();
    const desc = (item.fields['公司简介'] || '').trim();
    if (!desc) {
      skipped++;
      continue;
    }

    const nameDirty = DIRTY_NAMES.some(function(dn) { return name.indexOf(dn) >= 0; });
    const contentDirty = isDirty(desc);
    const tooShort = desc.length < 20;

    if (!nameDirty && !contentDirty && !tooShort) {
      skipped++;
      continue;
    }

    const reason = nameDirty ? 'NAME_LIST' : contentDirty ? 'DIRTY_PATTERN' : 'TOO_SHORT';
    try {
      await updateRecord(target, item.record_id, { '公司简介': '' });
      cleaned++;
      console.log('[CLEANED:' + reason + '] ' + name + ' | ' + desc.slice(0, 60));
    } catch (e) {
      console.log('[FAIL] ' + name + ': ' + e.message);
    }
  }

  console.log('\nTotal cleaned: ' + cleaned + ', skipped: ' + skipped);
}

main().catch(function(error) {
  console.error('[CleanDirty] Failed: ' + error.message);
  process.exitCode = 1;
});
