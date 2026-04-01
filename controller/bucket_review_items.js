/**
 * Review 分桶脚本
 * 将 company_backfill_review.json 的记录分 3 类：
 *   - auto: 有明确业务含义，可自动写入
 *   - manual: 有价值但实体/简介有歧义，需人工审核
 *   - discard: 脏内容/错误实体/截断/HTML残留，直接丢弃
 */
const fs = require('fs');
const path = require('path');
const { initFeishuClient, listTargets, listRecords, updateRecord } = require('./feishu-client');

const REVIEW_FILE = path.join(__dirname, 'data', 'company_backfill_review.json');

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// ---- 判定规则 ----

function isDirtyDiscard(item) {
  const desc = cleanString(item.companyDescription);
  const sourceUrl = cleanString(item.sourceUrl);

  // HTML 实体残留
  if (/&ensp;|&emsp;|&#\d+;|&#[xX][0-9a-fA-F]+;/.test(desc)) return 'dirty_html_entity';
  // 知乎问答页（覆盖"是怎样一种体验"等变体）
  if (/zhihu\.com/.test(sourceUrl) && /怎么样|是怎样一种体验|是一种怎样的体验|offer|怎么选|关注.*推荐|被浏览|新老员工|朋友.*说|公司还可以/.test(desc)) return 'dirty_zhihu_question';
  // 百度知道
  if (/zhidao\.baidu\.com/.test(sourceUrl)) return 'dirty_baidu_zhidao';
  // 百度首页
  if (/baidu\.com\/Index|baidu\.com\/$/.test(sourceUrl)) return 'dirty_baidu_homepage';
  // 百度百科：匹配到错误实体（深圳市词条、通达集团词条等）
  if (/baike\.baidu\.com/.test(sourceUrl)) {
    if (/深圳市|Shenzhen City|鹏城/.test(desc) && !desc.includes(item.companyName)) return 'non_company_entity_baike';
    if (/通达集团/.test(desc) && !desc.includes('通达致远')) return 'non_company_entity_baike';
  }
  // 爱企查截断表格（只有"是一家小微企业，该公司"开头且没有实质内容）
  if (/aiqicha\.baidu\.com/.test(sourceUrl)) {
    if (/^·?\s*(简介[：:]?\s*)?\d+、\s*.{0,15}是一(家|个)/.test(desc) && desc.length < 60) return 'dirty_aiqicha_truncated';
    if (/小微企业.*该公司/.test(desc) && desc.length < 60) return 'dirty_aiqicha_truncated';
    if (/^·?\s*\d+、$/.test(desc.trim())) return 'dirty_aiqicha_truncated';
    if (/公众号二维码|粤ICP备|版权所有/.test(desc)) return 'dirty_website_footer';
    // 爱企查来源的内容如果 < 40 字，基本都是截断
    if (desc.length < 40) return 'dirty_aiqicha_truncated';
  }
  // 论坛帖子
  if (/amobbs\.com/.test(sourceUrl)) return 'dirty_forum_post';
  // qcc 工商信息表格
  if (/qcc\.com/.test(sourceUrl) && /法定代表人|注册资本|统一社会信用代码/.test(desc)) return 'dirty_qcc_table';
  // 工商信息残句
  if (/一般经营项目是|经营范围包括|法定代表人/.test(desc) && !/主要业务/.test(desc)) return 'dirty_business_table';
  // 过短无意义
  if (desc.length < 15) return 'too_short_meaningless';
  // 仅注册日期，无业务内容
  if (/^·?\s*(简介[：:]?\s*)?[^，。]{2,30}(?:公司|科技|技术|电子)\s*，?\s*成立于\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(desc) && desc.length < 60) return 'too_short_meaningless';
  // 纯头衔/荣誉（无实际业务描述）
  if (/^["""].*["""]$/.test(desc.trim()) || (/工程技术研究中心[""\u201c\u201d]?$/u.test(desc.trim()) && desc.length < 50)) return 'pure_title_no_business';
  // 网站页脚/导航
  if (/网站地图|在线客服|版权所有|Copyright|ICP备/.test(desc)) return 'dirty_website_footer';

  return null;
}

function isNonCompanyEntity(item) {
  const desc = cleanString(item.companyDescription);
  const name = cleanString(item.companyName);

  // 内容明显描述的是其他实体
  if (/大秦是古代中国对罗马帝国/.test(desc)) return 'non_company_entity_roma';
  if (/深圳市.*简称.*深.*别称鹏城/.test(desc) && !desc.includes(name)) return 'non_company_entity_city';
  if (/钻石、珠宝、翡/.test(desc) && name.includes('鼎盛威')) return 'non_company_entity_wrong_match';

  return null;
}

function isEntityAmbiguous(item) {
  const desc = cleanString(item.companyDescription);
  const sourceUrl = cleanString(item.sourceUrl);
  const name = cleanString(item.companyName);

  // 路特 vs 路特斯
  if (name === '路特' && /路特斯|Lotus/.test(desc)) return 'entity_ambiguous_lotus';
  // 通达致远 vs 通达集团
  if (name === '通达致远' && /通达集团/.test(desc)) return 'entity_ambiguous_tongda';
  // 源URL是新闻文章而非公司页面
  if (/sohu\.com/.test(sourceUrl) && !/简介|公司|企业/.test(desc.slice(0, 30))) return 'entity_ambiguous_news';

  return null;
}

function isAutoApprovable(item) {
  const desc = cleanString(item.companyDescription);
  if (desc.length < 25) return null; // 太短不自动通过

  // 不能以标点开头（说明是截断片段）
  if (/^[、，,．.·\s]/.test(desc)) return null;

  // 必须有业务关键词
  const hasBusinessKeyword = /主要|提供|专注于|从事|产品|服务|解决方案|业务|研发|平台|品牌|技术|智能|硬件|软件|物流|数据|互联网|消费|医疗|教育|新能源|电子|通信|金融|设计|制造|销售|运营|管理|咨询|芯片|存储|自动化|显示|光学|传感器|监控|安防|跨境|光伏|逆变器|充电|储能|机器人|终端/.test(desc);
  if (!hasBusinessKeyword) return null;

  // 不能包含脏内容标记
  if (/百度百科|百度首页|百度知道|hao123|贴吧|文库|文心|更多 翻译|学术|设置 登录|你就知道/.test(desc)) return null;
  if (/这个公司怎么样|我要提问|欢迎.*新老员工|官网登录/.test(desc)) return null;
  if (/关注.*推荐|热榜|专栏|圈子|付费咨询|知学堂|登录\/注册|被浏览|被收录/.test(desc)) return null;
  if (/网站地图|在线客服|版权所有|Copyright|ICP备|公众号二维码/.test(desc)) return null;
  if (/一般经营项目是|经营范围包括|法定代表人|注册资本|统一社会信用代码|参保人数/.test(desc)) return null;
  if (/成立于\d{4}年\d+月|位于[^，。]{2,40}[，。]/.test(desc) && desc.length < 40) return null;
  // 不能是问答/评价类内容
  if (/怎么样|是一个怎样的|怎么选|还可以啊|朋友.*说/.test(desc)) return null;
  // 不能是纯头衔/荣誉（没有实际业务描述）
  if (/^[""「].*[""」]$/.test(desc.trim())) return null;
  if (/工程技术研究中心$/.test(desc.trim()) && desc.length < 40) return null;

  return 'auto_approve';
}

// ---- 分桶 ----

function classifyItem(item) {
  // 第一优先：脏内容/错误实体 -> discard
  const discardReason = isDirtyDiscard(item);
  if (discardReason) return { bucket: 'discard', reason: discardReason };

  const nonEntityReason = isNonCompanyEntity(item);
  if (nonEntityReason) return { bucket: 'discard', reason: nonEntityReason };

  // 第二优先：实体歧义 -> manual
  const ambiguousReason = isEntityAmbiguous(item);
  if (ambiguousReason) return { bucket: 'manual', reason: ambiguousReason };

  // 第三优先：可自动通过
  const autoReason = isAutoApprovable(item);
  if (autoReason) return { bucket: 'auto', reason: autoReason };

  // 剩余：manual
  return { bucket: 'manual', reason: 'needs_human_review' };
}

async function main() {
  const items = JSON.parse(fs.readFileSync(REVIEW_FILE, 'utf-8'));

  const buckets = { auto: [], manual: [], discard: [] };

  for (const item of items) {
    const result = classifyItem(item);
    item._bucket = result.bucket;
    item._reason = result.reason;
    buckets[result.bucket].push(item);
  }

  console.log(`=== Review 分桶结果 (${items.length} 条) ===`);
  console.log(`auto (可自动写入): ${buckets.auto.length}`);
  for (const item of buckets.auto) {
    console.log(`  [AUTO] ${item.companyName} | ${item._reason} | ${(item.companyDescription || '').slice(0, 50)}`);
  }
  console.log(`\nmanual (需人工审核): ${buckets.manual.length}`);
  for (const item of buckets.manual) {
    console.log(`  [MANUAL] ${item.companyName} | ${item._reason} | ${(item.companyDescription || '').slice(0, 50)}`);
  }
  console.log(`\ndiscard (直接丢弃): ${buckets.discard.length}`);
  for (const item of buckets.discard.slice(0, 20)) {
    console.log(`  [DISCARD:${item._reason}] ${item.companyName} | ${(item.companyDescription || '').slice(0, 50)}`);
  }
  if (buckets.discard.length > 20) {
    console.log(`  ... 还有 ${buckets.discard.length - 20} 条`);
  }

  // 写入分桶后的文件
  fs.writeFileSync(
    REVIEW_FILE.replace('.json', '_bucketed.json'),
    JSON.stringify(items, null, 2)
  );
  fs.writeFileSync(
    REVIEW_FILE.replace('.json', '_manual.json'),
    JSON.stringify(buckets.manual, null, 2)
  );
  console.log(`\n分桶结果已写入 company_backfill_review_bucketed.json 和 _manual.json`);
}

main().catch(err => {
  console.error('[ReviewBucket] Failed: ' + err.message);
  process.exitCode = 1;
});
