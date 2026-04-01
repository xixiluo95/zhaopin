/**
 * 写入 auto 桶记录到飞书 + 飞翼/上上客召回分析
 */
const { initFeishuClient, listTargets, listRecords, updateRecord } = require('./feishu-client');
const { buildLookupContext, fetchCompanyProfile } = require('./company-profile-fetcher');

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// auto 桶：确认可写入的记录（已排除飞书中已有的）
const AUTO_WRITE = [
  {
    companyName: '极联股份',
    recordId: 'recvezW6qgSw14',
    '公司简介': '致力于为客户提供全方位、高性价比的综合IT技术服务，公司在北京、广州、上海、武汉、香港设有分公司。'
  },
  {
    companyName: '凯铭诺',
    recordId: 'recvezWBxOUhFa',
    '公司简介': '凯铭诺（深圳）科技有限公司凭借出色的集成技术，将自取电技术、传感技术、无线网络技术以及人工智能技术融为一体，从基础产品到全链条技术支持。'
  },
  {
    companyName: '贝乐实业',
    recordId: 'recvezWQP2glPJ',
    '公司简介': '贝乐实业是专业的技术型存储集成电路芯片代理、分销、现货供应商，代理三星、海力士、镁光等国际品牌。'
  },
  {
    companyName: '奥尼电子',
    recordId: 'recvezXeYqRgb0',
    '公司简介': '深圳奥尼电子股份有限公司（股票代码：301189）是行业领先的智能终端解决方案商与提供商，专注于视听感知产品的研发与生产。'
  },
  {
    companyName: '中能易电',
    recordId: 'recvezZ0cMUzTj',
    '公司简介': '中能易电主要从事城市新能源汽车项目推广运营、新能源汽车整车销售、租赁及充电桩建设运营，是新能源汽车系统运营商。'
  },
  {
    companyName: '坦途科技',
    recordId: 'recvezWJ0tmDpo',
    '公司简介': '坦途科技旗下品牌NAVEE（2021年创立）致力于重塑移动体验，以人性化设计和可持续创新打造智能出行产品，驱动电动出行革新。'
  }
];

// 飞翼/上上客召回测试
const RECALL_COMPANIES = [
  { name: '飞翼未来科技', industry: '电子/硬件开发', scale: '0-20人', location: '深圳' },
  { name: '上上客', industry: '互联网', scale: '20-99人', location: '深圳' }
];

async function writeAutoBucket() {
  initFeishuClient();
  const target = listTargets().find(t => t.isDefault).name;
  const page = await listRecords(target, { pageSize: 500 });

  let written = 0;
  for (const item of AUTO_WRITE) {
    // 检查是否已有简介
    const feishuRecord = page.items.find(r => r.record_id === item.recordId);
    const currentDesc = cleanString(feishuRecord?.fields?.['公司简介']);
    if (currentDesc) {
      console.log('[SKIP:EXISTS] ' + item.companyName);
      continue;
    }

    try {
      await updateRecord(target, item.recordId, { '公司简介': item['公司简介'] });
      written++;
      console.log('[WRITTEN] ' + item.companyName + ' | ' + item['公司简介'].slice(0, 60));
    } catch (e) {
      console.log('[FAIL] ' + item.companyName + ': ' + e.message);
    }
  }
  console.log('\nAuto bucket written: ' + written);
  return written;
}

async function recallAnalysis() {
  console.log('\n=== 飞翼/上上客召回分析 ===\n');

  for (const company of RECALL_COMPANIES) {
    console.log('--- ' + company.name + ' ---');
    const context = buildLookupContext({
      companyNameRaw: company.name,
      industry: company.industry,
      scale: company.scale,
      location: company.location
    });
    console.log('  Normalized: ' + (context.companyNameNormalized || '(空)'));
    console.log('  IsMasked: ' + context.isMaskedName);
    console.log('  Fingerprint: ' + context.companyLookupFingerprint);
    console.log('  Aliases: ' + (context.companyAliases.length > 0 ? context.companyAliases.join(', ') : '(无)'));

    try {
      const result = await fetchCompanyProfile(context);
      console.log('  Status: ' + result.status);
      console.log('  Source: ' + result.source);
      console.log('  Confidence: ' + result.confidenceScore);
      console.log('  Reason: ' + result.reason);
      if (result.companyDescription) {
        console.log('  Desc: ' + result.companyDescription.slice(0, 80));
      }
      if (result.sourceUrl) {
        console.log('  URL: ' + result.sourceUrl.slice(0, 80));
      }
    } catch (e) {
      console.log('  Fetch error: ' + e.message);
    }
    console.log('');
  }
}

async function main() {
  const written = await writeAutoBucket();
  await recallAnalysis();
  console.log('Done. Auto written: ' + written);
}

main().catch(err => {
  console.error('[AutoWrite] Failed: ' + err.message);
  process.exitCode = 1;
});
