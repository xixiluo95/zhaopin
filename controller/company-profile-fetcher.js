const { normalizeCompanyName } = require('./company-normalizer');
const { readRuntimeConfig } = require('./runtime-config');
const { execFile } = require('child_process');
const fs = require('fs');

const BOSS_VERIFY_SAMPLE_SIZE = 3;
const PUBLIC_SEARCH_ENDPOINT = 'https://www.bing.com/search';
// DuckDuckGo 已移除——当前环境下不稳定且贡献大量低质量候选
// const PUBLIC_SEARCH_FALLBACK_ENDPOINT = 'https://html.duckduckgo.com/html/';
const BOSS_VERIFY_ENDPOINT = 'https://www.zhipin.com/gongsis/';
const BAIDU_BAIKE_ENDPOINT = 'https://baike.baidu.com/item/';
const ZH_WIKIPEDIA_ENDPOINT = 'https://zh.wikipedia.org/wiki/';
const AIQICHA_SEARCH_ENDPOINT = 'https://aiqicha.baidu.com/s?searchType=3&q=';
const DEFAULT_SAMPLES = ['字节跳动', '腾讯', '阿里巴巴'];
const MIN_CONFIDENCE_SCORE = 45;
const CANDIDATE_PAGE_FETCH_TIMEOUT_MS = 12000;
const KNOWN_SOURCE_OVERRIDES = [
  {
    names: ['正浩创新', 'EcoFlow正浩', '深圳市正浩创新科技股份有限公司'],
    url: 'https://www.ecoflow.com/cn/about-us',
    source: 'known_official_site'
  },
  {
    names: ['乐信集团', '乐信'],
    url: 'https://www.lexin.com/',
    source: 'known_official_site'
  },
  {
    names: ['深圳市首航新能源', '首航新能源', 'SOFAR', 'SOFAR Solar'],
    url: 'https://www.sofarsolar.com/',
    source: 'known_official_site'
  },
  {
    names: ['Anker', '安克', '安克创新'],
    url: 'https://www.anker.com/about',
    source: 'known_official_site',
    description: '从事消费电子与智能硬件研发，主要产品包括充电设备、移动电源、储能设备和智能家居产品。'
  },
  {
    names: ['顺丰速运', '顺丰'],
    url: 'https://www.sf-express.com/chn/sc/about',
    source: 'known_official_site',
    description: '提供综合快递物流与供应链服务，主要面向行业场景提供快递、仓配及相关解决方案。',
    type: '上市公司'
  },
  {
    names: ['瑞芯微', '瑞芯微电子股份有限公司'],
    url: 'https://www.rock-chips.com/',
    source: 'known_official_site',
    description: '专注于移动互联网和数字多媒体芯片设计，主要提供SoC芯片及终端解决方案，产品覆盖平板、电视盒子和音频等场景。'
  },
  {
    names: ['352空气净化器', '352', '北京三五二环保科技有限公司'],
    url: 'https://www.352group.com.cn/article/11.html',
    source: 'known_official_site',
    description: '提供家庭环境系统解决方案，主要业务覆盖空气净化、饮用水处理和环境湿度管理产品。'
  },
  {
    names: ['绿联科技', '深圳市绿联科技股份有限公司', 'UGREEN绿联'],
    url: 'https://baike.baidu.com/item/%E7%BB%BF%E8%81%94%E7%A7%91%E6%8A%80',
    source: 'known_official_site',
    description: '从事消费电子与数码配件研发、设计、生产和销售，主要产品覆盖充电设备、NAS私有云、传输类及音视频类硬件。',
    type: '上市公司'
  },
  {
    names: ['货拉拉科技', '货拉拉', '深圳依时货拉拉科技有限公司'],
    url: 'https://baike.baidu.com/item/%E8%B4%A7%E6%8B%89%E6%8B%89',
    source: 'known_official_site',
    description: '提供同城及跨城货运、搬家、跑腿和企业物流服务，主要作为互联网物流平台连接运力与货运需求。',
    type: '民营企业'
  },
  {
    names: ['蕉下', '深圳减字科技有限公司', 'Beneunder'],
    url: 'https://baike.baidu.com/item/%E8%95%89%E4%B8%8B',
    source: 'known_official_site',
    description: '从事轻量化户外消费品研发与销售，主要产品包括防晒服饰、伞具、帽子及其他户外配饰。',
    type: '民营企业'
  },
  {
    names: ['跨越速运', '跨越速运集团有限公司'],
    url: 'https://baike.baidu.com/item/%E8%B7%A8%E8%B6%8A%E9%80%9F%E8%BF%90',
    source: 'known_official_site',
    description: '主营限时速运服务，主要提供跨省时效快运、航空货运及企业物流解决方案。',
    type: '民营企业'
  },
  {
    names: ['科曼医疗', '深圳市科曼医疗设备有限公司'],
    url: 'https://www.szgm.gov.cn/szgm/132104/kjcx/252743/content/post_12151724.html',
    source: 'known_official_site',
    description: '从事高端医疗器械与NICU综合解决方案研发，主要产品覆盖监护仪、呼吸机、辐射台、育婴箱及相关医疗设备。'
  },
  {
    names: ['大秦数字能源技术股份', '大秦数能', '大秦数字能源技术股份有限公司'],
    url: 'https://www.dyness.cn/company-profile',
    source: 'known_official_site',
    description: '专注于储能系统研发、生产与销售，主要产品覆盖工商业储能、户用储能及便携式储能解决方案。',
    type: '民营企业'
  },
  {
    names: ['极联股份', '深圳极联信息技术股份有限公司'],
    url: 'https://www.zhipin.com/companys/4448aa89325495ff1nB73du7EFM~.html',
    source: 'known_official_site',
    description: '致力于提供综合IT技术服务，主要业务覆盖移动应用开发、小程序、大型网站系统、ERP及SAP相关技术服务。'
  },
  {
    names: ['华印源科技有限公司', '深圳市华印源科技有限公司', '华印源科技'],
    url: 'https://huayinyuan.gys.cn/',
    source: 'known_official_site',
    description: '从事印刷检测仪器及印前处理设备销售，主要产品包括分光仪、印刷检测仪器及相关印刷耗材设备。'
  }
];
const KNOWN_COMPANY_TYPE_OVERRIDES = [
  { names: ['中国移动', '中国移动通信集团有限公司'], tags: ['央企'] },
  { names: ['中国电信', '中国电信集团有限公司'], tags: ['央企'] },
  { names: ['中国联通', '中国联合网络通信集团有限公司'], tags: ['央企'] },
  { names: ['国家电网', '国家电网有限公司'], tags: ['央企'] },
  { names: ['南方电网', '中国南方电网有限责任公司'], tags: ['央企'] },
  { names: ['中国石油', '中国石油天然气集团有限公司'], tags: ['央企'] },
  { names: ['中国石化', '中国石油化工集团有限公司'], tags: ['央企'] },
  { names: ['中国海油', '中国海洋石油集团有限公司'], tags: ['央企'] },
  { names: ['国家能源集团', '国家能源投资集团有限责任公司'], tags: ['央企'] },
  { names: ['三峡集团', '中国长江三峡集团有限公司'], tags: ['央企'] },
  { names: ['中核集团', '中国核工业集团有限公司'], tags: ['央企'] },
  { names: ['华润集团', '中国华润有限公司'], tags: ['央企'] },
  { names: ['招商局集团', '招商局集团有限公司'], tags: ['央企'] },
  { names: ['保利集团', '中国保利集团有限公司'], tags: ['央企'] },
  { names: ['中粮集团', '中粮集团有限公司'], tags: ['央企'] },
  { names: ['国药集团', '中国医药集团有限公司'], tags: ['央企'] },
  { names: ['中国建筑', '中国建筑集团有限公司'], tags: ['央企'] },
  { names: ['中国中铁', '中国铁路工程集团有限公司'], tags: ['央企'] },
  { names: ['中国铁建', '中国铁道建筑集团有限公司'], tags: ['央企'] },
  { names: ['中国交建', '中国交通建设集团有限公司'], tags: ['央企'] },
  { names: ['中国中车', '中国中车集团有限公司'], tags: ['央企'] },
  { names: ['深投控', '深圳市投资控股有限公司'], tags: ['国企'] },
  { names: ['深业集团', '深业集团有限公司'], tags: ['国企'] },
  { names: ['深铁集团', '深圳市地铁集团有限公司', '深圳地铁'], tags: ['国企'] },
  { names: ['深圳港集团', '深圳港集团有限公司'], tags: ['国企'] },
  { names: ['深圳机场集团', '深圳市机场(集团)有限公司', '深圳机场'], tags: ['国企'] },
  { names: ['深圳能源集团', '深圳能源集团股份有限公司', '深圳能源'], tags: ['国企', '上市公司'] },
  { names: ['深圳巴士集团', '深圳巴士集团股份有限公司'], tags: ['国企'] },
  { names: ['深圳人才安居集团', '深圳市人才安居集团有限公司'], tags: ['国企'] },
  { names: ['深创投', '深圳市创新投资集团有限公司'], tags: ['国企'] },
  { names: ['深高速', '深圳高速公路集团股份有限公司'], tags: ['国企', '上市公司'] },
  { names: ['深国际', '深圳国际控股有限公司'], tags: ['国企', '上市公司'] },
  { names: ['德科信息', '广州德科信息技术有限公司'], tags: ['外包'] },
  { names: ['杭州佰钧成', '佰钧成'], tags: ['外包'] },
  { names: ['中软国际', '中软国际有限公司'], tags: ['上市公司', '外包'] },
  { names: ['软通动力', '软通动力信息技术（集团）股份有限公司'], tags: ['上市公司', '外包'] },
  { names: ['博彦科技', '博彦科技股份有限公司'], tags: ['上市公司', '外包'] },
  { names: ['文思海辉', '文思海辉技术有限公司', 'Pactera'], tags: ['外包'] },
  { names: ['腾娱互动', '深圳市腾娱互动科技有限公司'], tags: ['内包'] }
];
const KNOWN_ENTITY_HINTS = [
  {
    names: ['润檬科技', '深圳润檬科技', '深圳润檬科技有限公司'],
    canonicalName: '深圳润檬科技',
    companyIdentifier: '胡亮'
  },
  {
    names: ['上上客', '深圳上上客', '深圳上上客信息科技有限公司', '深圳市上上客信息科技有限公司', '上上客信息科技'],
    canonicalName: '深圳市上上客信息科技有限公司'
  },
  {
    names: ['飞翼未来科技', '贵州飞翼未来科技', '贵州飞翼未来科技有限公司', '飞翼未来'],
    canonicalName: '贵州飞翼未来科技有限公司'
  },
  {
    names: ['杭州佰钧成', '佰钧成', '杭州佰钧成信息技术有限公司', '佰钧成信息技术'],
    canonicalName: '杭州佰钧成信息技术有限公司'
  }
];
const REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
};

const sourceDecisionState = {
  initialized: false,
  sourceMode: 'public_search',
  verifiedAt: null,
  bossViable: false,
  samples: [],
  reason: 'verification_not_started'
};

async function ensureSourceDecision(samples = []) {
  if (sourceDecisionState.initialized) {
    return { ...sourceDecisionState };
  }

  const selectedSamples = normalizeSamples(samples);
  const verification = await verifyBossSourceViability(selectedSamples);

  sourceDecisionState.initialized = true;
  sourceDecisionState.verifiedAt = new Date().toISOString();
  sourceDecisionState.samples = verification.samples;
  sourceDecisionState.bossViable = verification.viable;
  sourceDecisionState.sourceMode = verification.viable ? 'boss_public_company' : 'public_search';
  sourceDecisionState.reason = verification.reason;

  console.log(
    `[CompanyProfileFetcher] Source decision=${sourceDecisionState.sourceMode} samples=${sourceDecisionState.samples.join(', ')} reason=${sourceDecisionState.reason}`
  );

  return { ...sourceDecisionState };
}

async function verifyBossSourceViability(samples = []) {
  const selectedSamples = normalizeSamples(samples);
  const attempts = [];

  for (const sample of selectedSamples) {
    const url = `${BOSS_VERIFY_ENDPOINT}?query=${encodeURIComponent(sample)}`;
    try {
      const response = await fetch(url, { headers: REQUEST_HEADERS });
      const html = await response.text();
      const bodyText = stripTags(html);
      attempts.push({
        sample,
        url,
        status: response.status,
        securityCheck: /请稍候|安全|securityCheck|__zp_stoken__/i.test(html),
        hasIntro: /公司简介|companyIntro/i.test(bodyText),
        hasType: /公司类型|融资|brandStage/i.test(bodyText)
      });
    } catch (error) {
      attempts.push({
        sample,
        url,
        status: 0,
        securityCheck: false,
        hasIntro: false,
        hasType: false,
        error: error.message
      });
    }
  }

  const viable = attempts.every((attempt) =>
    attempt.status >= 200 &&
    attempt.status < 300 &&
    !attempt.securityCheck &&
    attempt.hasIntro &&
    attempt.hasType
  );

  return {
    viable,
    samples: selectedSamples,
    attempts,
    reason: viable
      ? 'boss_public_pages_return_intro_and_type'
      : 'boss_public_pages_require_security_check_or_missing_fields'
  };
}

async function fetchCompanyProfile(input = {}) {
  const context = buildLookupContext(input);
  const sourcePlan = buildCompanyProfileSourcePlan();
  if (!context.companyNameNormalized) {
    return {
      status: 'not_found',
      companyType: '',
      companyDescription: '',
      source: 'none',
      sourceUrl: null,
      reason: 'empty_company_name',
      confidenceScore: 0,
      evidenceSnippet: '',
      matchedName: ''
    };
  }

  if (context.isMaskedName) {
    const maskedType = inferMaskedCompanyType(context.companyNameRaw || context.companyNameNormalized);
    if (maskedType) {
      return {
        status: 'partial',
        companyType: maskedType,
        companyDescription: '',
        source: 'masked_headhunter_name',
        sourceUrl: null,
        reason: 'masked_known_company_pattern',
        confidenceScore: 98,
        evidenceSnippet: context.companyNameRaw || context.companyNameNormalized,
        matchedName: context.companyNameRaw || context.companyNameNormalized
      };
    }

    return {
      status: 'not_found',
      companyType: '',
      companyDescription: '',
      source: 'masked_company_name',
      sourceUrl: null,
      reason: 'masked_or_anonymous_company_name',
      confidenceScore: 0,
      evidenceSnippet: '',
      matchedName: ''
    };
  }

  let bestResult = failedSearchResult('none', null, 'no_source_attempted');

  for (const sourceName of sourcePlan.publicSourceOrder) {
    const nextResult = await fetchFromConfiguredSource(sourceName, context);
    if (!nextResult) {
      continue;
    }
    bestResult = chooseBetterFetchResult(bestResult, nextResult);
    if (shouldShortCircuit(bestResult)) {
      return bestResult;
    }
  }

  const decision = await ensureSourceDecision([context.companyNameNormalized]);
  if (decision.sourceMode === 'boss_public_company' && sourcePlan.publicSourceOrder.includes('boss_public_company')) {
    const bossResult = await fetchFromBossPublicCompany(context);
    bestResult = chooseBetterFetchResult(bestResult, bossResult);
    if (shouldShortCircuit(bestResult)) {
      return bestResult;
    }
  }

  if (sourcePlan.enableLoggedInSources && sourcePlan.loggedInSourceOrder.length > 0) {
    const loggedInResult = await fetchFromLoggedInSources(
      context,
      sourcePlan.loggedInSourceOrder,
      sourcePlan.browserConfig || {}
    );
    bestResult = chooseBetterFetchResult(bestResult, loggedInResult);
  }

  return bestResult;
}

function buildCompanyProfileSourcePlan() {
  const runtimeConfig = readRuntimeConfig();
  const config = runtimeConfig.companyProfileSources || {};
  const browserConfig = runtimeConfig.companyProfileBrowser || {};

  return {
    publicSourceOrder: Array.isArray(config.publicSourceOrder) ? config.publicSourceOrder : [],
    enableLoggedInSources: Boolean(config.enableLoggedInSources),
    loggedInSourceOrder: Array.isArray(config.loggedInSourceOrder) ? config.loggedInSourceOrder : [],
    browserConfig
  };
}

async function fetchFromConfiguredSource(sourceName, context) {
  if (sourceName === 'known_official_site') {
    return fetchFromKnownSource(context);
  }
  if (sourceName === 'baidu_baike_direct') {
    return fetchFromBaiduBaike(context);
  }
  if (sourceName === 'wikipedia_direct') {
    return fetchFromWikipedia(context);
  }
  if (sourceName === 'gsxt_search') {
    return fetchFromSiteRestrictedSearch(context, {
      siteHint: 'site:gsxt.gov.cn',
      sourcePrefix: 'gsxt_search'
    });
  }
  if (sourceName === 'aiqicha_search') {
    return fetchFromSiteRestrictedSearch(context, {
      siteHint: 'site:aiqicha.baidu.com',
      sourcePrefix: 'aiqicha_search'
    });
  }
  if (sourceName === 'public_search') {
    return fetchFromPublicSearch(context);
  }
  if (sourceName === 'boss_public_company') {
    return null;
  }

  return null;
}

async function fetchFromLoggedInSources(context, sourceOrder, browserConfig = {}) {
  for (const sourceName of sourceOrder) {
    if (sourceName === 'aiqicha_browser') {
      const result = await fetchFromAiqichaBrowser(context, browserConfig);
      if (result) {
        return result;
      }
      continue;
    }

    return {
      status: 'failed',
      companyType: '',
      companyDescription: '',
      source: sourceName,
      sourceUrl: null,
      reason: 'logged_in_source_declared_but_not_implemented',
      confidenceScore: 0,
      evidenceSnippet: context.companyNameNormalized,
      matchedName: context.companyNameNormalized
    };
  }

  return null;
}

async function fetchFromAiqichaBrowser(context, browserConfig = {}) {
  const chromePath = cleanString(browserConfig.chromePath || '');
  const userDataDir = cleanString(browserConfig.userDataDir || '');
  const timeoutMs = Number(browserConfig.aiqichaSearchTimeoutMs || 15000);
  const source = 'aiqicha_browser';

  if (!chromePath || !fs.existsSync(chromePath)) {
    return failedSearchResult(source, null, 'chrome_binary_not_found');
  }
  if (!userDataDir || !fs.existsSync(userDataDir)) {
    return failedSearchResult(source, null, 'missing_or_invalid_user_data_dir');
  }

  const names = buildSearchNames(context).slice(0, 4);
  let lastUrl = null;
  let lastReason = 'no_browser_results';

  for (const name of names) {
    const searchUrl = `${AIQICHA_SEARCH_ENDPOINT}${encodeURIComponent(name)}`;
    lastUrl = searchUrl;
    const html = await fetchWithChromeDumpDom(searchUrl, browserConfig);
    if (!html) {
      lastReason = 'browser_dump_failed';
      continue;
    }

    if (isAiqichaCaptchaPage(html)) {
      lastReason = 'aiqicha_requires_login_or_captcha';
      continue;
    }

    const candidates = parseAiqichaBrowserResults(html).map((candidate) => rankCandidate(candidate, context));
    const snippetResult = buildSnippetOnlySearchResult(candidates, context, source, searchUrl);
    if (snippetResult) {
      return snippetResult;
    }

    const bestResult = await selectBestCandidate(candidates, context);
    if (!bestResult) {
      lastReason = 'browser_no_matching_candidate';
      continue;
    }

    return buildFetchResult({
      companyType: inferCompanyType(composeEvidence(bestResult), context),
      companyDescription: extractCompanyDescription(bestResult.snippet || bestResult.title),
      source,
      sourceUrl: bestResult.url || searchUrl,
      confidenceScore: bestResult.score,
      evidenceSnippet: bestResult.snippet || bestResult.title || '',
      matchedName: bestResult.title || ''
    });
  }

  return failedSearchResult(source, lastUrl, lastReason);
}

async function fetchWithChromeDumpDom(url, browserConfig = {}) {
  const chromePath = cleanString(browserConfig.chromePath || '');
  const userDataDir = cleanString(browserConfig.userDataDir || '');
  const timeoutMs = Number(browserConfig.aiqichaSearchTimeoutMs || 15000);
  const extraArgs = Array.isArray(browserConfig.extraArgs) ? browserConfig.extraArgs : [];

  if (!chromePath || !userDataDir) {
    return null;
  }

  const args = [
    '--headless=new',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,2400',
    `--user-data-dir=${userDataDir}`,
    `--virtual-time-budget=${timeoutMs}`,
    '--dump-dom',
    ...extraArgs,
    url
  ];

  return new Promise((resolve) => {
    execFile(chromePath, args, {
      timeout: timeoutMs + 5000,
      maxBuffer: 8 * 1024 * 1024
    }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      resolve(typeof stdout === 'string' ? stdout : String(stdout || ''));
    });
  });
}

function isAiqichaCaptchaPage(html) {
  const text = cleanString(html);
  return /百度安全验证|wappass\.baidu\.com\/static\/captcha|请完成验证|请输入验证码/u.test(text);
}

function isAiqichaTruncatedPage(text) {
  const value = cleanString(text);
  if (!value) return true;
  // 爱企查页面只有工商注册信息摘要，无实质业务描述
  if (/小微企业.*该公司/u.test(value) && value.length < 80) return true;
  if (/^(简介[：:]?\s*)?\d+、\s*.{0,20}是一(家|个)/u.test(value) && value.length < 80) return true;
  return false;
}

function parseAiqichaBrowserResults(html) {
  const matches = [];
  const cardPattern = /<a[^>]+href="([^"]*aiqicha\.baidu\.com[^"]*|\/company[^"]*|\/detail[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match = cardPattern.exec(html);

  while (match) {
    const href = decodeHtml(match[1]);
    const title = stripTags(match[2]);
    if (!title || title.length < 2) {
      match = cardPattern.exec(html);
      continue;
    }

    const surrounding = html.slice(Math.max(0, match.index - 120), Math.min(html.length, match.index + 900));
    const snippet = stripTags(surrounding)
      .replace(title, '')
      .slice(0, 240);

    matches.push({
      url: href.startsWith('http') ? href : `https://aiqicha.baidu.com${href}`,
      title,
      snippet,
      displayUrl: 'aiqicha.baidu.com'
    });
    match = cardPattern.exec(html);
  }

  return dedupeCandidates(matches).slice(0, 10);
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  const next = [];
  for (const candidate of candidates || []) {
    const key = `${cleanString(candidate.url)}|${cleanString(candidate.title)}`;
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    next.push(candidate);
  }
  return next;
}

function buildLookupContext(input = {}) {
  const companyNameRaw = cleanString(input.companyNameRaw);
  const originalCompanyNameNormalized = normalizeCompanyName(companyNameRaw);
  const entityHint = resolveKnownEntityHint(originalCompanyNameNormalized);
  const companyNameNormalized = entityHint?.canonicalName
    ? normalizeCompanyName(entityHint.canonicalName)
    : originalCompanyNameNormalized;
  const industry = normalizeIndustry(input.industry || input.industryRaw || '');
  const scale = normalizeScale(input.scale || input.scaleRaw || '');
  const location = normalizeLocation(input.location || input.locationRaw || '');
  const companyIdentifier = cleanString(input.companyIdentifier || entityHint?.companyIdentifier || '');
  const companyLookupFingerprint = buildLookupFingerprint({
    companyNameRaw: companyNameNormalized || companyNameRaw,
    industry,
    scale,
    location
  });
  const isMaskedName = isMaskedCompanyName(companyNameNormalized);

  return {
    companyNameRaw,
    companyNameNormalized,
    industry,
    scale,
    location,
    companyIdentifier,
    companyAliases: entityHint?.names || [],
    companyLookupFingerprint,
    isMaskedName
  };
}

function buildLookupFingerprint(input = {}) {
  const companyNameNormalized = normalizeCompanyName(input.companyNameRaw || input.companyNameNormalized || '');
  const industry = normalizeIndustry(input.industry || '');
  const scale = normalizeScale(input.scale || '');
  const location = normalizeLocation(input.location || '');

  return [companyNameNormalized || '-', industry || '-', scale || '-', location || '-'].join('|');
}

function resolveKnownEntityHint(companyNameNormalized) {
  if (!companyNameNormalized) {
    return null;
  }

  for (const hint of KNOWN_ENTITY_HINTS) {
    if ((hint.names || []).some((name) => normalizeCompanyName(name) === companyNameNormalized)) {
      return hint;
    }
  }

  return null;
}

async function fetchFromBossPublicCompany(context) {
  const searchHint = context.companyIdentifier
    ? `${context.companyNameNormalized} ${context.companyIdentifier}`
    : context.companyNameNormalized;
  const url = `${BOSS_VERIFY_ENDPOINT}?query=${encodeURIComponent(searchHint)}`;

  try {
    const response = await fetch(url, { headers: REQUEST_HEADERS });
    const html = await response.text();
    if (!response.ok || /请稍候|securityCheck|__zp_stoken__/i.test(html)) {
      return {
        status: 'failed',
        companyType: '',
        companyDescription: '',
        source: 'boss_public_company',
        sourceUrl: url,
        reason: `boss_http_${response.status || 0}`,
        confidenceScore: 0,
        evidenceSnippet: '',
        matchedName: ''
      };
    }

    const text = stripTags(html);
    const companyDescription = extractCompanyDescription(text);
    const companyType = inferCompanyType(text, context);

    return buildFetchResult({
      companyType,
      companyDescription,
      source: 'boss_public_company',
      sourceUrl: url,
      confidenceScore: 80,
      evidenceSnippet: cleanString(text).slice(0, 200),
      matchedName: context.companyNameNormalized
    });
  } catch (error) {
    return {
      status: 'failed',
      companyType: '',
      companyDescription: '',
      source: 'boss_public_company',
      sourceUrl: url,
      reason: error.message,
      confidenceScore: 0,
      evidenceSnippet: '',
      matchedName: ''
    };
  }
}

async function fetchFromPublicSearch(context) {
  // DuckDuckGo 已移除，只使用 Bing
  return fetchFromBing(context);
}

async function fetchFromSiteRestrictedSearch(context, { siteHint, sourcePrefix }) {
  const queries = buildSiteRestrictedQueries(context, siteHint);

  // DuckDuckGo 已移除，只使用 Bing
  return fetchSearchEngineWithQueries(context, queries, {
    endpoint: PUBLIC_SEARCH_ENDPOINT,
    source: `${sourcePrefix}_bing`,
    params: (query) => ({
      q: query,
      setlang: 'zh-Hans',
      mkt: 'zh-CN'
    }),
    parser: parseBingResults
  });
}

async function fetchFromBaiduBaike(context) {
  const candidates = buildBaiduBaikeNames(context);

  for (const name of candidates) {
    const url = `${BAIDU_BAIKE_ENDPOINT}${encodeURIComponent(name)}`;
    const pageHtml = await fetchCandidatePage(url);
    if (!pageHtml) {
      continue;
    }

    const title = extractHtmlTitle(pageHtml);
    const metaDescription = extractMetaDescription(pageHtml);
    const pageText = collapseWhitespace(pageHtml);
    const evidence = `${title} ${metaDescription} ${pageText.slice(0, 400)}`;

    if (isGenericBaiduBaikePage(title, metaDescription, pageText)) {
      continue;
    }
    if (!hasStrongEntityMatch(evidence, context)) {
      continue;
    }

    const companyDescription = isGenericBaiduBaikeMeta(metaDescription)
      ? (extractBaiduBaikeDescription(pageText) || extractCompanyDescription(pageText))
      : (metaDescription || extractBaiduBaikeDescription(pageText) || extractCompanyDescription(pageText));
    const companyType = inferCompanyType(evidence, context);

    return buildFetchResult({
      companyType,
      companyDescription,
      source: 'baidu_baike_direct',
      sourceUrl: url,
      confidenceScore: 90,
      evidenceSnippet: metaDescription || pageText.slice(0, 200),
      matchedName: title || name
    });
  }

  return failedSearchResult('baidu_baike_direct', null, 'no_baike_match');
}

async function fetchFromWikipedia(context) {
  const candidates = buildWikipediaNames(context);

  for (const name of candidates) {
    const url = `${ZH_WIKIPEDIA_ENDPOINT}${encodeURIComponent(name)}`;
    const pageHtml = await fetchCandidatePage(url);
    if (!pageHtml) {
      continue;
    }

    const title = extractHtmlTitle(pageHtml);
    const intro = extractWikipediaIntro(pageHtml);
    const evidence = `${title} ${intro}`;

    if (isGenericWikipediaPage(title, intro)) {
      continue;
    }
    if (!hasStrongEntityMatch(evidence, context)) {
      continue;
    }

    return buildFetchResult({
      companyType: inferCompanyType(evidence, context),
      companyDescription: intro,
      source: 'wikipedia_direct',
      sourceUrl: url,
      confidenceScore: 82,
      evidenceSnippet: intro || title,
      matchedName: title || name
    });
  }

  return failedSearchResult('wikipedia_direct', null, 'no_wikipedia_match');
}

async function fetchFromKnownSource(context) {
  const normalizedCompanyName = normalizeCompanyName(context.companyNameNormalized);
  const match = KNOWN_SOURCE_OVERRIDES.find((entry) =>
    entry.names.some((name) => normalizeCompanyName(name) === normalizedCompanyName)
  );

  if (!match) {
    return null;
  }

  const pageHtml = await fetchCandidatePage(match.url);
  if (!pageHtml) {
    return null;
  }

  const metaDescription = extractMetaDescription(pageHtml);
  const title = extractHtmlTitle(pageHtml);
  const pageText = collapseWhitespace(pageHtml);
  const structuredDescription = extractStructuredCompanyDescription(pageText);
  const companyDescription = cleanString(match.description) || (isUsableDescription(metaDescription)
    ? metaDescription
    : structuredDescription);
  const companyType = Object.prototype.hasOwnProperty.call(match, 'type')
    ? cleanString(match.type)
    : inferCompanyType(pageText || `${title} ${metaDescription}`, context);

  return buildFetchResult({
    companyType,
    companyDescription,
    source: match.source,
    sourceUrl: match.url,
    confidenceScore: 95,
    evidenceSnippet: metaDescription || pageText.slice(0, 200),
    matchedName: title || context.companyNameNormalized,
    preserveOriginalDescription: Boolean(cleanString(match.description))
  });
}

async function fetchFromBing(context) {
  const queries = buildSearchQueries(context);
  return fetchSearchEngineWithQueries(context, queries, {
    endpoint: PUBLIC_SEARCH_ENDPOINT,
    source: 'public_search_bing',
    params: (query) => ({
      q: query,
      setlang: 'zh-Hans',
      mkt: 'zh-CN'
    }),
    parser: parseBingResults
  });
}

async function fetchFromDuckDuckGo(context, upstreamError = null) {
  const queries = buildSearchQueries(context);
  return fetchSearchEngineWithQueries(context, queries, {
    endpoint: PUBLIC_SEARCH_FALLBACK_ENDPOINT,
    source: 'public_search_duckduckgo',
    params: (query) => ({ q: query }),
    parser: parseDuckDuckGoResults,
    genericPageGuard: isDuckDuckGoGenericResponse,
    unwrapReason: upstreamError
  });
}

function buildSearchQueries(context) {
  const queries = [];
  const names = buildSearchNames(context);
  const companyHint = '公司 简介';
  const officialHint = '官网';
  const baikeHint = 'site:baike.baidu.com';
  const wikipediaHint = 'site:zh.wikipedia.org';
  const gsxtHint = 'site:gsxt.gov.cn';
  // qccHint 已移除——企查查直连已被 WAF 拦截，site 限定搜索收益极低
  const aiqichaHint = 'site:aiqicha.baidu.com';

  const isShortName = cleanString(context.companyNameNormalized).length < 6;

  // 分层策略：短名/歧义名用少量高价值 query，全称名可以多试
  if (isShortName) {
    // 短名：只保留最可能命中的 query
    for (const name of names.slice(0, 3)) {
      pushQuery(queries, [name, officialHint]);
      pushQuery(queries, [name, baikeHint]);
      pushQuery(queries, [name, companyHint]);
      pushQuery(queries, [name, context.location]);
      pushQuery(queries, [name]);
    }
  } else {
    // 全称名：保留更多 query 组合
    for (const name of names) {
      pushQuery(queries, [name, officialHint]);
      pushQuery(queries, [name, baikeHint]);
      pushQuery(queries, [name, wikipediaHint]);
      pushQuery(queries, [name, gsxtHint]);
      pushQuery(queries, [name, aiqichaHint]);
      pushQuery(queries, [name, companyHint]);
      pushQuery(queries, [name, context.industry, companyHint]);
      pushQuery(queries, [name, context.location]);
      pushQuery(queries, [name]);
    }
  }

  return queries;
}

function buildSiteRestrictedQueries(context, siteHint) {
  const queries = [];
  const names = buildSearchNames(context).slice(0, 4);

  for (const name of names) {
    pushQuery(queries, [name, siteHint]);
    pushQuery(queries, [name, context.companyIdentifier, siteHint]);
  }

  return queries;
}

function buildSearchNames(context) {
  const names = [];
  pushUniqueName(names, context.companyNameNormalized);
  for (const alias of (context.companyAliases || []).slice(0, 2)) {
    pushUniqueName(names, alias);
  }

  // 简称自动扩展：对较短的公司名补全常见后缀，控制在 2-3 个高价值后缀
  const normalized = cleanString(context.companyNameNormalized);
  const isShortName = normalized && normalized.length < 6;
  if (normalized && normalized.length <= 10) {
    const hasLegalSuffix = /(有限责任公司|股份有限公司|有限公司|集团|研究院)$/u.test(normalized);
    if (!hasLegalSuffix) {
      const baseName = normalized;
      if (isShortName) {
        // 短名只扩展最可能的 3 个后缀
        pushUniqueName(names, `${baseName}科技有限公司`);
        pushUniqueName(names, `${baseName}有限公司`);
        pushUniqueName(names, `${baseName}集团有限公司`);
      } else {
        // 中等长度名扩展 4 个后缀
        pushUniqueName(names, `${baseName}有限公司`);
        pushUniqueName(names, `${baseName}科技有限公司`);
        pushUniqueName(names, `${baseName}信息技术有限公司`);
        pushUniqueName(names, `${baseName}集团有限公司`);
      }
    }
  }

  if (context.location) {
    // 地域扩展只对前 2 个名字做，不全部展开
    const currentNames = names.slice(0, 2);
    for (const name of currentNames) {
      if (!name.startsWith(context.location)) {
        pushUniqueName(names, `${context.location}${name}`);
      }
    }
  }

  return names;
}

function pushQuery(queries, parts) {
  const query = parts.filter(Boolean).join(' ').trim();
  if (query && !queries.includes(query)) {
    queries.push(query);
  }
}

async function fetchSearchEngineWithQueries(context, queries, options) {
  const {
    endpoint,
    source,
    params,
    parser,
    genericPageGuard = null,
    unwrapReason = null
  } = options;

  let lastSearchUrl = null;

  try {
    for (const query of queries) {
      const searchUrl = `${endpoint}?${new URLSearchParams(params(query)).toString()}`;
      lastSearchUrl = searchUrl;
      const response = await fetch(searchUrl, { headers: REQUEST_HEADERS });
      const html = await response.text();

      if (!response.ok) {
        return failedSearchResult(source, searchUrl, `search_http_${response.status}`);
      }
      if (genericPageGuard && genericPageGuard(html, response.status)) {
        return failedSearchResult(source, searchUrl, 'generic_search_page');
      }

      const candidates = parser(html).map((candidate) => rankCandidate(candidate, context));
      const snippetResult = buildSnippetOnlySearchResult(candidates, context, source, searchUrl);
      if (snippetResult) {
        return snippetResult;
      }
      const bestResult = await selectBestCandidate(candidates, context);
      if (!bestResult) {
        continue;
      }

      return buildFetchResult({
        companyType: inferCompanyType(composeEvidence(bestResult), context),
        companyDescription: extractCompanyDescription(bestResult.snippet || bestResult.title),
        source,
        sourceUrl: bestResult.url || searchUrl,
        confidenceScore: bestResult.score,
        evidenceSnippet: bestResult.snippet || bestResult.title || '',
        matchedName: bestResult.title || ''
      });
    }

    return {
      status: 'not_found',
      companyType: '',
      companyDescription: '',
      source,
      sourceUrl: lastSearchUrl,
      reason: unwrapReason ? `upstream=${unwrapReason}; no_search_results` : 'no_search_results',
      confidenceScore: 0,
      evidenceSnippet: '',
      matchedName: ''
    };
  } catch (error) {
    return failedSearchResult(
      source,
      lastSearchUrl,
      unwrapReason ? `${unwrapReason}; ${error.message}` : error.message
    );
  }
}

function parseBingResults(html) {
  const matches = [];
  const itemPattern = /<li class="b_algo"[\s\S]*?<\/li>/g;
  let itemMatch = itemPattern.exec(html);
  while (itemMatch) {
    const itemHtml = itemMatch[0];
    const linkMatch = itemHtml.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    const snippetMatch = itemHtml.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
      || itemHtml.match(/class="b_caption"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i)
      || itemHtml.match(/class="b_lineclamp\d*"[^>]*>([\s\S]*?)<\/div>/i);

    if (linkMatch) {
      matches.push({
        url: decodeHtml(linkMatch[1]),
        title: stripTags(linkMatch[2]),
        snippet: snippetMatch ? stripTags(snippetMatch[1]) : '',
        displayUrl: ''
      });
    }

    itemMatch = itemPattern.exec(html);
  }

  if (matches.length > 0) {
    return matches;
  }

  const fallbackPattern = /<a[^>]+href="([^"]+)"[^>]*h="ID=SERP[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let match = fallbackPattern.exec(html);
  while (match) {
    matches.push({
      url: decodeHtml(match[1]),
      title: stripTags(match[2]),
      snippet: '',
      displayUrl: ''
    });
    match = fallbackPattern.exec(html);
  }
  return matches;
}

function parseDuckDuckGoResults(html) {
  const matches = [];
  const pattern = /<div class="result results_links[\s\S]*?<a rel="nofollow" class="result__a" href="([^"]+)">([\s\S]*?)<\/a>[\s\S]*?<a class="result__url" href="[^"]*">([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet" href="[^"]*">([\s\S]*?)<\/a>[\s\S]*?<\/div>\s*<\/div>/g;
  let match = pattern.exec(html);
  while (match) {
    matches.push({
      url: unwrapDuckDuckGoUrl(decodeHtml(match[1])),
      title: stripTags(match[2]),
      displayUrl: stripTags(match[3]),
      snippet: stripTags(match[4])
    });
    match = pattern.exec(html);
  }

  if (matches.length > 0) {
    return matches;
  }

  const fallback = [];
  const titlePattern = /<a rel="nofollow" class="result__a" href="([^"]+)">([\s\S]*?)<\/a>/g;
  let titleMatch = titlePattern.exec(html);
  while (titleMatch) {
    fallback.push({
      url: unwrapDuckDuckGoUrl(decodeHtml(titleMatch[1])),
      title: stripTags(titleMatch[2]),
      displayUrl: '',
      snippet: ''
    });
    titleMatch = titlePattern.exec(html);
  }
  return fallback;
}

function rankCandidate(candidate, context) {
  const evidence = composeEvidence(candidate);
  const normalizedEvidence = collapseWhitespace(evidence);
  let score = 0;

  if (!normalizedEvidence) {
    return { ...candidate, score: 0 };
  }

  // 简称匹配：对较短的公司名，放宽模糊匹配条件
  const isShortName = context.companyNameNormalized.length < 6;
  if (normalizedEvidence.includes(context.companyNameNormalized)) {
    score += 60;
  } else if (context.companyNameNormalized.length >= 4 && fuzzyContains(normalizedEvidence, context.companyNameNormalized)) {
    score += 35;
  } else if (isShortName && fuzzyContains(normalizedEvidence, context.companyNameNormalized)) {
    // 简称模糊匹配给较高分数
    score += 30;
  }

  const extractedNames = extractLegalEntityNames(normalizedEvidence);
  const legalMatch = extractedNames.find((name) =>
    fuzzyContains(name, context.companyNameNormalized) || fuzzyContains(context.companyNameNormalized, name)
  );
  if (legalMatch) {
    score += 20;
    // 简称场景下，法人与简称匹配是强信号
    if (isShortName) {
      score += 15;
    }
  }

  // 简称场景下，地域匹配加分更高
  if (context.industry && normalizedEvidence.includes(context.industry)) {
    score += 20;
  }
  if (context.scale && normalizedEvidence.includes(context.scale)) {
    score += 10;
  }
  if (context.location && normalizedEvidence.includes(context.location)) {
    score += isShortName ? 20 : 10;
  }

  if (/官网|about|about us|company|corp|group|华为|爱企查|企查查|百度百科|天眼查/i.test(normalizedEvidence)) {
    score += 10;
  }

  score += domainWeight(candidate.url);

  if (isMaskedCompanyName(candidate.title)) {
    score -= 20;
  }

  if (isLikelyRecruitmentText(normalizedEvidence) || isLikelyRecruitmentHost(candidate.url)) {
    score -= 45;
  }
  if (hasInactiveOperationSignal(normalizedEvidence)) {
    score -= 80;
  }

  // 爱企查截断检测——"是一家小微企业，该公司"类内容几乎无业务信息
  if (/aiqicha\.baidu\.com/.test(candidate.url || '') && /小微企业|该公司[\.。]|简介[：:]/i.test(normalizedEvidence)) {
    score -= 30;
  }

  // 百度百科 URL 实体硬拦截——标题不含公司实体名且无法律后缀时直接拒绝
  // 防止"深圳市""大秦"等泛词/地名/概念词条被当作公司简介
  if (/baike\.baidu\.com/.test(candidate.url || '')) {
    const title = cleanString(candidate.title || '');
    const cn = cleanString(context.companyNameNormalized);
    const titleHasLegalSuffix = /(?:有限公司|有限责任公司|股份有限公司|集团|研究院|医院|学校)$/u.test(title);
    const titleHasCompanyName = cn.length >= 4 && title.includes(cn);
    const baseName = cn.replace(/(?:有限责任公司|股份有限公司|集团股份有限公司|集团有限公司|有限公司)$/u, '');
    const titleHasBaseName = cn.length >= 4 && baseName.length >= 3 && title.includes(baseName);
    if (!titleHasLegalSuffix && !titleHasCompanyName && !titleHasBaseName) {
      score = -50;
    }
  }

  return {
    ...candidate,
    score
  };
}

async function selectBestCandidate(candidates, context) {
  // 只有分数足够高的候选才值得继续抓取候选页（节省网络请求）
  const minScoreForEnrich = MIN_CONFIDENCE_SCORE - 5;
  const sorted = candidates
    .filter((candidate) => candidate.score >= minScoreForEnrich)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  for (const candidate of sorted) {
    const enriched = await enrichCandidate(candidate, context);
    if (enriched.score >= MIN_CONFIDENCE_SCORE) {
      return enriched;
    }
  }

  return null;
}

function buildSnippetOnlySearchResult(candidates, context, source, sourceUrl) {
  const sorted = (candidates || [])
    .filter((candidate) => candidate.score >= MIN_CONFIDENCE_SCORE)
    .sort((a, b) => b.score - a.score);

  const snippetCandidate = sorted.find((candidate) => {
    const evidence = composeEvidence(candidate);
    const description = extractCompanyDescription(candidate.snippet || candidate.title || '');
    return hasStrongEntityMatch(evidence, context) && isUsableDescription(description);
  });

  if (!snippetCandidate) {
    return null;
  }

  return buildFetchResult({
    companyType: inferCompanyType(composeEvidence(snippetCandidate), context),
    companyDescription: extractCompanyDescription(snippetCandidate.snippet || snippetCandidate.title || ''),
    source,
    sourceUrl: snippetCandidate.url || sourceUrl,
    confidenceScore: Math.max(MIN_CONFIDENCE_SCORE, Math.min(78, snippetCandidate.score)),
    evidenceSnippet: snippetCandidate.snippet || snippetCandidate.title || '',
    matchedName: snippetCandidate.title || ''
  });
}

function buildFetchResult({
  companyType,
  companyDescription,
  source,
  sourceUrl,
  confidenceScore = 0,
  evidenceSnippet = '',
  matchedName = '',
  preserveOriginalDescription = false
}) {
  const normalizedType = cleanString(companyType);
  const decodedDesc = collapseWhitespace(companyDescription);
  const summarizedDescription = preserveOriginalDescription
    ? cleanString(decodedDesc)
    : summarizeCompanyDescription(decodedDesc);
  const normalizedDescription = isUsableDescription(summarizedDescription) ? cleanString(summarizedDescription) : '';

  if (confidenceScore < MIN_CONFIDENCE_SCORE) {
    return {
      status: 'not_found',
      companyType: '',
      companyDescription: '',
      source,
      sourceUrl,
      reason: 'low_confidence',
      confidenceScore,
      evidenceSnippet,
      matchedName
    };
  }

  if (normalizedType && normalizedDescription) {
    return {
      status: 'resolved',
      companyType: normalizedType,
      companyDescription: normalizedDescription,
      source,
      sourceUrl,
      confidenceScore,
      evidenceSnippet,
      matchedName
    };
  }

  if (normalizedType || normalizedDescription) {
    return {
      status: 'partial',
      companyType: normalizedType,
      companyDescription: normalizedDescription,
      source,
      sourceUrl,
      confidenceScore,
      evidenceSnippet,
      matchedName
    };
  }

  return {
    status: 'not_found',
    companyType: '',
    companyDescription: '',
    source,
    sourceUrl,
    reason: 'empty_payload_after_match',
    confidenceScore,
    evidenceSnippet,
    matchedName
  };
}

function extractCompanyDescription(text) {
  const normalizedText = collapseWhitespace(text);
  if (!normalizedText) {
    return '';
  }

  if (isBlockedPageText(normalizedText)) {
    return '';
  }

  const introMatch = normalizedText.match(/(?:公司简介|企业简介|关于我们|公司介绍)[:：]?\s*([^。；]{20,220}[。；]?)/u);
  if (introMatch) {
    return introMatch[1].trim();
  }

  const multiMeaningMatch = normalizedText.match(/添加义项\s*((?:一家|一个|一款)[^。；]{6,120}?(?:品牌|企业|公司|平台|服务商|提供商))(?:[。；]|$)/u);
  if (multiMeaningMatch) {
    return postProcessBusinessSummary(multiMeaningMatch[1]);
  }

  // 放宽最低长度要求：从 24 降到 18，让短但有业务含义的描述也能通过
  if (normalizedText.length >= 18) {
    return normalizedText.slice(0, 220).trim();
  }

  return '';
}

function extractStructuredCompanyDescription(text) {
  const normalizedText = collapseWhitespace(text);
  if (!normalizedText || isBlockedPageText(normalizedText)) {
    return '';
  }

  const introMatch = normalizedText.match(/(?:公司简介|企业简介|关于我们|公司介绍)[:：]?\s*([^。；]{20,220}[。；]?)/u);
  return introMatch ? introMatch[1].trim() : '';
}

function summarizeCompanyDescription(text) {
  const value = cleanString(text);
  if (!value) {
    return '';
  }

  const normalized = value
    .replace(/^简介[:：]?\s*/u, '')
    .replace(/^\d+、\s*/u, '')
    .replace(/基本情况/u, '')
    .replace(/\s+/g, ' ')
    .trim();

  const businessPatterns = [
    /(专注于[^。；]{8,120}[。；]?)/u,
    /([^。；]{0,24}专注于[^。；]{8,120}[。；]?)/u,
    /(致力于[^。；]{8,120}[。；]?)/u,
    /([^。；]{0,24}致力于[^。；]{8,120}[。；]?)/u,
    /(主营[^。；]{8,120}[。；]?)/u,
    /([^。；]{0,30}主营[^。；]{8,120}[。；]?)/u,
    /(主要从事[^。；]{8,120}[。；]?)/u,
    /(提供[^。；]{8,120}(?:产品|服务|解决方案)[^。；]{0,80}[。；]?)/u,
    /(研发[^。；]{8,120}(?:产品|设备|终端|系统|方案)[^。；]{0,80}[。；]?)/u,
    /((?:是一家|系)[^。；]{0,20}(?:提供商|服务商|研发商|制造商|解决方案提供商|高新技术企业)[^。；]{0,80}[。；]?)/u,
    /([^。；]{0,30}是一家[^。；]{0,20}(?:提供商|服务商|研发商|制造商|解决方案提供商|高新技术企业)[^。；]{0,80}[。；]?)/u,
    /([^。；]{0,50}是[^。；]{0,60}(?:平台|品牌|综合服务商|物流平台|户外品牌|快递物流综合服务商)[^。；]{0,80}[。；]?)/u,
    /(经营范围包括[^。；]{12,120}[。；]?)/u
  ];

  for (const pattern of businessPatterns) {
    const match = normalized.match(pattern);
    if (match) {
      return postProcessBusinessSummary(match[1]);
    }
  }

  const sentence = normalized.split(/[。；]/u).map((item) => item.trim()).find((item) =>
    /(产品|业务|解决方案|储能|智能|硬件|软件|物流|快递|电商|云摄像头|终端|服务)/u.test(item)
  );
  return postProcessBusinessSummary(sentence || normalized);
}

function postProcessBusinessSummary(text) {
  const value = cleanString(text);
  if (!value) {
    return '';
  }

  return value
    .replace(/^[、，,；;:\-]+/u, '')
    .replace(/^[A-Za-z0-9\u4e00-\u9fa5（）()·\-]+成立于\d{4}年[，,、]?\s*/u, '')
    .replace(/^[A-Za-z0-9\u4e00-\u9fa5（）()·\-]+/u, (match) => match.length <= 10 ? '' : match)
    .replace(/(?:自媒体创作者|新手上路|成长任务|编辑入门|编辑规则|本人编辑|我有疑问|内容质疑|在线客服|官方贴吧|意见反馈|投诉建议|举报不良信息|未通过词条申诉|投诉侵权信息|封禁查询与解封)[\s\S]*$/u, '')
    .replace(/目前处于开业状态.*/u, '')
    .replace(/位于[^，。,；]{2,40}[，。,；]?/u, '')
    .replace(/成立于\d{4}年[^，。,；]{0,20}[，。,；]?/u, '')
    .replace(/更新时间[:：]?\d{4}-\d{2}-\d{2}.*/u, '')
    .replace(/(企业概况|工商信息|证券信息|团队信息|企业情报|财务数据|经营数据|独家分析|知识产权|风险信息|联系信息).*/u, '')
    .replace(/^经营范围包括/u, '主要业务包括')
    .replace(/^是一家/u, '')
    .replace(/^是/u, '')
    .replace(/^系/u, '')
    .replace(/[，,]\s*是[^，。,；]{0,30}(?:企业|公司)/u, '')
    .replace(/\s+/g, ' ')
    .replace(/[，,；;]+$/u, '')
    .trim();
}

async function enrichCandidate(candidate, context) {
  let score = candidate.score;
  let snippet = candidate.snippet || '';
  let matchedName = candidate.title || '';
  let companyType = '';
  const isShortName = context.companyNameNormalized.length < 6;

  const pageHtml = await fetchCandidatePage(candidate.url);
  if (pageHtml) {
    const metaDescription = extractMetaDescription(pageHtml);
    const pageTitle = extractHtmlTitle(pageHtml);
    if (isUsableDescription(metaDescription)) {
      snippet = metaDescription;
      score += 20;
    }
    if (pageTitle && pageTitle.includes(context.companyNameNormalized)) {
      matchedName = pageTitle;
      score += 10;
    }

    const pageText = collapseWhitespace(pageHtml);
    if (pageText && !isBlockedPageText(pageText)) {
      if (hasInactiveOperationSignal(pageText)) {
        score -= 80;
      }

      // 爱企查页面二次检测——抓取后仍为截断摘要
      if (/aiqicha\.baidu\.com/.test(candidate.url || '') && isAiqichaTruncatedPage(pageText)) {
        score -= 40;
      }
      if (context.companyNameNormalized && fuzzyContains(pageText, context.companyNameNormalized)) {
        score += 10;
      }
      if (context.industry && pageText.includes(context.industry)) {
        score += 10;
      }
      if (context.location && pageText.includes(context.location)) {
        score += isShortName ? 15 : 5;
      }

      const extractedNames = extractLegalEntityNames(pageText);
      const bestName = chooseBestMatchedName(extractedNames, context);
      if (bestName) {
        matchedName = bestName;
        score += 10;
      }

      // 简称消歧：法人名与简称+扩展名匹配时额外加分
      if (isShortName && bestName) {
        const extendedNames = buildSearchNames(context);
        if (extendedNames.some((name) => bestName.includes(name) || name.includes(bestName))) {
          score += 15;
        }
      }

      const description = extractCompanyDescription(pageText);
      if (isUsableDescription(description)) {
        snippet = description;
        score += 10;
      }

      companyType = inferCompanyType(pageText, context);
    }
  }

  return {
    ...candidate,
    score,
    snippet,
    matchedName,
    companyType
  };
}

function inferCompanyType(text, context) {
  const haystack = collapseWhitespace(text);
  const normalizedName = cleanString(context.companyNameNormalized);
  const knownOverride = inferCompanyTypeFromKnownCompany(normalizedName);
  if (knownOverride) {
    return knownOverride;
  }

  if (!haystack) {
    return inferCompanyTypeFromIndustry(context.industry);
  }

  const tags = [];
  const ownershipType = inferOwnershipType(haystack);
  if (ownershipType) {
    pushUniqueTag(tags, ownershipType);
  }

  const capitalType = inferCapitalType(haystack);
  if (capitalType) {
    pushUniqueTag(tags, capitalType);
  }

  const employmentType = inferEmploymentModel(haystack, normalizedName);
  if (employmentType) {
    pushUniqueTag(tags, employmentType);
  }

  const institutionType = inferInstitutionType(haystack);
  if (institutionType) {
    pushUniqueTag(tags, institutionType);
  }

  if (tags.length > 0) {
    return tags.join(' / ');
  }

  // 不再回退到非目标集合类型（高新技术企业、集团、行业推断等）
  return '';
}

function inferCompanyTypeFromKnownCompany(companyNameNormalized) {
  if (!companyNameNormalized) {
    return '';
  }

  for (const override of KNOWN_COMPANY_TYPE_OVERRIDES) {
    if ((override.names || []).some((name) => normalizeCompanyName(name) === companyNameNormalized)) {
      return (override.tags || []).filter(Boolean).join(' / ');
    }
  }

  return '';
}

function inferMaskedCompanyType(companyName) {
  const normalized = cleanString(companyName);
  if (!normalized) {
    return '';
  }

  if (/(^某知名.+(?:公司|企业)$|^知名.+(?:公司|企业)$)/u.test(normalized)) {
    return '猎头';
  }

  if (
    /^某.+(?:公司|企业)$/u.test(normalized)
    || /^[\u4e00-\u9fa5]{2,12}某.+(?:公司|企业)$/u.test(normalized)
  ) {
    return '猎头';
  }

  return '';
}

function inferOwnershipType(haystack) {
  if (
    /国务院国资委|国务院国有资产监督管理委员会|中央企业|央企/u.test(haystack)
    && /(子公司|所属企业|成员企业|下属企业|控股企业|旗下)/u.test(haystack)
  ) {
    return '央企子企业';
  }

  if (/国务院国资委|国务院国有资产监督管理委员会|中央企业|央企/u.test(haystack)) {
    return '央企';
  }

  if (/地方国资委|市属国企|省属国企|区属国企|地方国有企业|国有独资|国有控股|国资控股|国企/u.test(haystack)) {
    return '国企';
  }

  return '';
}

function inferCapitalType(haystack) {
  if (/上市公司/u.test(haystack)) {
    return '上市公司';
  }
  if (/外商独资|外资企业|外企/u.test(haystack)) {
    return '外企';
  }
  if (/合资/u.test(haystack)) {
    return '合资';
  }
  if (/民营|民企/u.test(haystack)) {
    return '民营企业';
  }

  return '';
}

function inferEmploymentModel(haystack, companyNameNormalized) {
  const knownEmploymentType = inferEmploymentTypeFromKnownCompany(companyNameNormalized);
  if (knownEmploymentType) {
    return knownEmploymentType;
  }

  if (/服务外包|业务流程外包|软件外包|项目外包|驻场开发|驻场服务|人力外包|劳务派遣|外包供应商|ITO|BPO/u.test(haystack)) {
    return '外包';
  }

  if (/集团内部技术服务|内部共享服务|内部技术中台|为集团内部业务提供/u.test(haystack)) {
    return '内包';
  }

  return '';
}

function inferEmploymentTypeFromKnownCompany(companyNameNormalized) {
  if (!companyNameNormalized) {
    return '';
  }

  for (const override of KNOWN_COMPANY_TYPE_OVERRIDES) {
    if ((override.names || []).some((name) => normalizeCompanyName(name) === companyNameNormalized)) {
      const employmentTag = (override.tags || []).find((tag) => tag === '外包' || tag === '内包');
      if (employmentTag) {
        return employmentTag;
      }
    }
  }

  return '';
}

function inferInstitutionType(haystack) {
  if (/事业单位/u.test(haystack)) {
    return '事业单位';
  }
  if (/学校|教育/u.test(haystack)) {
    return '教育机构';
  }
  if (/医院/u.test(haystack)) {
    return '医疗机构';
  }

  return '';
}

function pushUniqueTag(tags, value) {
  if (!value || tags.includes(value)) {
    return;
  }
  tags.push(value);
}

async function fetchCandidatePage(url) {
  if (!url || !/^https?:\/\//i.test(url)) {
    return null;
  }

  // 挑战页 URL 特征拦截
  if (/arg1=|acw_sc__v2|__jsl_clearance|wappass\.baidu\.com|security-check/i.test(url)) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CANDIDATE_PAGE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: REQUEST_HEADERS,
      signal: controller.signal,
      redirect: 'follow'
    });
    if (!response.ok) {
      return null;
    }
    const html = await response.text();

    // 挑战页正文特征拦截
    if (/请稍候|securityCheck|__zp_stoken__|acw_sc__v2|arg1=|__jsl_clearance/i.test(html)) {
      return null;
    }
    if (isChallengePageContent(html)) {
      return null;
    }
    return html;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function failedSearchResult(source, sourceUrl, reason) {
  return {
    status: 'failed',
    companyType: '',
    companyDescription: '',
    source,
    sourceUrl,
    reason,
    confidenceScore: 0,
    evidenceSnippet: '',
    matchedName: ''
  };
}

function chooseBetterFetchResult(current, next) {
  if (!next) {
    return current;
  }
  if (!current) {
    return next;
  }

  const currentRank = fetchResultRank(current);
  const nextRank = fetchResultRank(next);

  if (nextRank > currentRank) {
    return next;
  }

  if (nextRank === currentRank && Number(next.confidenceScore || 0) > Number(current.confidenceScore || 0)) {
    return next;
  }

  if (nextRank === currentRank && cleanString(current.source) === 'none' && cleanString(next.source) !== 'none') {
    return next;
  }

  return current;
}

function fetchResultRank(result) {
  const status = cleanString(result?.status);
  const confidence = Number(result?.confidenceScore || 0);
  const hasDescription = Boolean(cleanString(result?.companyDescription));
  const hasType = Boolean(cleanString(result?.companyType));
  const source = cleanString(result?.source);

  let base = 0;
  if (status === 'resolved') {
    base = 300;
  } else if (status === 'partial') {
    base = 200;
  } else if (status === 'failed') {
    base = 25;
  } else if (status === 'not_found') {
    base = 50;
  }

  if (hasDescription) {
    base += 30;
  }
  if (hasType) {
    base += 10;
  }

  if (/^known_official_site$/u.test(source)) {
    base += 40;
  } else if (/^gsxt_search_/u.test(source)) {
    base += 35;
  } else if (/^baidu_baike_direct$/u.test(source)) {
    base += 25;
  } else if (/^aiqicha_search_/u.test(source)) {
    base += 18;
  } else if (/qcc|tianyancha/u.test(source)) {
    base += 12;
  }

  return base + confidence;
}

function shouldShortCircuit(result) {
  if (!result) {
    return false;
  }

  const source = cleanString(result.source);
  const confidence = Number(result.confidenceScore || 0);
  const hasDescription = Boolean(cleanString(result.companyDescription));

  if (source === 'known_official_site' && hasDescription) {
    return true;
  }
  if (/^gsxt_search_/u.test(source) && hasDescription) {
    return true;
  }

  return confidence >= 96 && hasDescription;
}

function isUsableDescription(text) {
  const value = cleanString(text);
  if (!value || value.length < 10) {
    return false;
  }
  if (isBlockedPageText(value)) {
    return false;
  }
  // 拦截挑战页残留文本
  if (/acw_sc__v2|arg1=|__jsl_clearance|请完成安全?验证|人机验证|滑块验证|访问频率/i.test(value)) {
    return false;
  }
  if (value.includes('�')) {
    return false;
  }
  if (isLikelyRecruitmentText(value)) {
    return false;
  }
  // 爱企查截断内容——"是一家小微企业，该公司"类无实质业务描述
  if (/小微企业.*该公司|是一(家|个)(小微|科技型中小)/u.test(value) && value.length < 80) {
    return false;
  }
  // 知乎问答/评价内容
  if (/怎么样|什么样|是一种怎样的体验|朋友.*曾|朋友.*说|公司还可以|新老员工|欢迎.*畅谈|关注.*推荐|热榜|专栏|圈子|付费咨询|知学堂|登录\/注册|被浏览|被收录/u.test(value)) {
    return false;
  }
  // 仅注册日期，无业务描述
  if (/^简介[：:]?\s*.{2,60}成立于\d{4}/u.test(value) && value.length < 60) {
    return false;
  }
  // 爱企查编号开头截断（"简介： 1、 某某有限公司"无实质业务描述）
  if (/^简介[：:]?\s*\d+、/u.test(value) && value.length < 50) {
    return false;
  }
  if (/^成立于\d{4}[-/]\d{1,2}[-/]\d{1,2}$/u.test(value.trim())) {
    return false;
  }
  if (/^(企业文化|发展历程|核心产品|加入我们|联系我们)/u.test(value)) {
    return false;
  }
  // 标点开头截断片段（"、"或"、"等无业务主语的残留）
  if (/^[、，,．.·\s]/u.test(value) && value.length < 50) {
    return false;
  }
  if (/企业概况|工商信息|证券信息|团队信息|企业情报|财务数据|经营数据|独家分析|知识产权|风险信息|联系信息/u.test(value)) {
    return false;
  }
  if (/爱企查$|企查查$|百度百科$|职友集$/.test(value)) {
    return false;
  }
  return true;
}

function isBlockedPageText(text) {
  const value = cleanString(text);
  return /验证码|访问异常|请完成验证|提交验证|安全验证|系统检测到访问异常|请输入验证码|请稍后再试|访问频率过高|人机验证|滑块验证|百度安全验证|请完成安全验证/i.test(value);
}

function isChallengePageContent(html) {
  const text = collapseWhitespace(html);
  if (!text) {
    return true;
  }
  // 企查查挑战页
  if (/acw_sc__v2.*=|arg1\s*=/i.test(text)) {
    return true;
  }
  // 通用安全验证页——页面内容几乎只有验证提示，没有实际业务内容
  const strippedText = stripTags(text).trim();
  if (strippedText.length < 200 && /验证|安全|访问异常|请稍后|请完成/i.test(strippedText)) {
    return true;
  }
  // 爱企查/百度验证码页
  if (/wappass\.baidu\.com|百度安全验证|请输入验证码/u.test(text)) {
    return true;
  }
  // GSXT 521 页面
  if (/521\s|__jsl_clearance/i.test(html)) {
    return true;
  }
  return false;
}

function isDuckDuckGoGenericResponse(html, status = 0) {
  const text = cleanString(html);
  return Number(status) === 202
    || /<title>\s*DuckDuckGo\s*<\/title>/i.test(html)
    || /link rel="canonical" href="https:\/\/duckduckgo\.com\/"/i.test(html)
    || /DuckDuckGo<\/title>/i.test(html) && !/result__a/i.test(html);
}

function normalizeSamples(samples = []) {
  const normalized = []
    .concat(samples || [])
    .map((item) => normalizeCompanyName(item))
    .filter(Boolean);

  for (const fallback of DEFAULT_SAMPLES) {
    if (normalized.length >= BOSS_VERIFY_SAMPLE_SIZE) {
      break;
    }
    if (!normalized.includes(fallback)) {
      normalized.push(fallback);
    }
  }

  return normalized.slice(0, BOSS_VERIFY_SAMPLE_SIZE);
}

function normalizeIndustry(value) {
  return cleanString(value)
    .replace(/人工智能|AI|AIGC|大模型/gi, '人工智能')
    .replace(/互联网\/?IT|信息技术/gi, '互联网')
    .replace(/\s+/g, ' ');
}

function normalizeScale(value) {
  return cleanString(value)
    .replace(/人以上/u, '人')
    .replace(/少于/u, '<')
    .replace(/-/g, '-');
}

function normalizeLocation(value) {
  const text = cleanString(value);
  if (!text) {
    return '';
  }
  return text.split(/[·\-\s/]/)[0].trim();
}

function isMaskedCompanyName(value) {
  return /某|某知名|某中型|某大型|某小型/.test(cleanString(value));
}

function hasInactiveOperationSignal(text) {
  const value = cleanString(text);
  if (!value) {
    return false;
  }

  return /已停业|停止运营|已注销|注销企业|吊销|已吊销|经营异常|列入经营异常|工商注销|企业注销|本企业已停止经营/u.test(value);
}

function fuzzyContains(haystack, needle) {
  const segments = needle.split(/有限公司|有限责任公司|股份有限公司|集团|科技|信息|智能|数字|电子/u).filter(Boolean);
  return segments.some((segment) => segment.length >= 2 && haystack.includes(segment));
}

function composeEvidence(candidate) {
  return [candidate.title, candidate.snippet, candidate.url, candidate.displayUrl].filter(Boolean).join(' ');
}

function extractLegalEntityNames(text) {
  const source = cleanString(text);
  if (!source) {
    return [];
  }

  const pattern = /([A-Za-z0-9\u4e00-\u9fa5（）()·\-.]{2,80}?(?:有限责任公司|股份有限公司|集团股份有限公司|集团有限公司|有限公司|股份公司|集团|研究院|医院|学校))/gu;
  const names = new Set();
  let match = pattern.exec(source);
  while (match) {
    names.add(cleanString(match[1]));
    match = pattern.exec(source);
  }
  return [...names];
}

function chooseBestMatchedName(names, context) {
  if (!Array.isArray(names) || names.length === 0) {
    return '';
  }

  const ranked = names.map((name) => {
    let score = 0;
    if (fuzzyContains(name, context.companyNameNormalized) || fuzzyContains(context.companyNameNormalized, name)) {
      score += 50;
    }
    if (context.location && name.includes(context.location)) {
      score += 10;
    }
    if (context.industry && /互联网|信息技术/u.test(context.industry) && /(信息科技|科技|信息)/u.test(name)) {
      score += 6;
    }
    if (/(有限责任公司|股份有限公司|集团有限公司|有限公司|集团)$/.test(name)) {
      score += 10;
    }
    return { name, score };
  }).sort((a, b) => b.score - a.score);

  return ranked[0]?.score > 0 ? ranked[0].name : '';
}

function domainWeight(url) {
  const host = safeHostname(url);
  if (!host) {
    return 0;
  }
  if (isLikelyRecruitmentHost(url)) {
    return -20;
  }
  // 知乎——搜索结果中高比例返回问答/评价内容，非公司简介
  if (/zhihu\.com/.test(host)) {
    return -35;
  }
  // 爱企查——搜索结果中高比例返回截断的工商摘要，无实质业务描述
  if (/aiqicha\.baidu\.com/.test(host)) {
    return -10;
  }
  if (/gsxt\.gov\.cn/.test(host)) {
    return 24;
  }
  if (/qcc\.com|tianyancha\.com/.test(host)) {
    return 0;
  }
  if (/baike\.baidu\.com/.test(host)) {
    return 18;
  }
  if (/huawei\.com|byd\.com|tuya\.com|\.com$/.test(host)) {
    return 8;
  }
  return 0;
}

/**
 * 从行业标签推断公司类型。
 * 严格限制输出必须在目标类型集合内：
 * 央企、央企子企业、国企、上市公司、民营企业、外企、合资、外包、内包、猎头
 * 行业标签无法映射到以上类型时返回空字符串。
 */
function inferCompanyTypeFromIndustry(industry) {
  const text = cleanString(industry);
  if (!text) {
    return '';
  }
  // 行业标签无法可靠推断公司所有制/上市状态，一律不写入
  return '';
}

function buildBaiduBaikeNames(context) {
  const names = [];
  const raw = cleanString(context.companyNameRaw);
  const normalized = cleanString(context.companyNameNormalized);
  pushUniqueName(names, raw);
  pushUniqueName(names, normalized);
  for (const alias of context.companyAliases || []) {
    pushUniqueName(names, alias);
  }
  pushUniqueName(names, normalized.replace(/(有限责任公司|股份有限公司|集团股份有限公司|集团有限公司|有限公司)$/u, ''));
  pushUniqueName(names, normalized.replace(/(科技|智能|信息|电子|软件|数码|医疗|实业|股份|集团|工业|物流|教育)$/u, ''));
  pushUniqueName(
    names,
    normalized
      .replace(/(有限责任公司|股份有限公司|集团股份有限公司|集团有限公司|有限公司)$/u, '')
      .replace(/(科技|智能|信息|电子|软件|数码|医疗|实业|股份|集团|工业|物流|教育)$/u, '')
  );
  return names.filter(Boolean);
}

function buildWikipediaNames(context) {
  const names = [];
  const raw = cleanString(context.companyNameRaw);
  const normalized = cleanString(context.companyNameNormalized);
  pushUniqueName(names, raw);
  pushUniqueName(names, normalized);
  for (const alias of context.companyAliases || []) {
    pushUniqueName(names, alias);
  }
  pushUniqueName(names, normalized.replace(/(有限责任公司|股份有限公司|集团股份有限公司|集团有限公司|有限公司)$/u, ''));
  pushUniqueName(names, normalized.replace(/(科技|智能|信息|电子|软件|数码|医疗|实业|股份|集团|工业|物流|教育)$/u, ''));
  return names.filter(Boolean);
}

function extractBaiduBaikeDescription(text) {
  const normalizedText = collapseWhitespace(text);
  if (!normalizedText) {
    return '';
  }

  const anchorIndex = normalizedText.indexOf('添加义项');
  const anchoredText = anchorIndex >= 0 ? normalizedText.slice(anchorIndex) : normalizedText;
  const multiMeaningMatch = anchoredText.match(/(?:添加义项\s*)?((?:一家|一个|一款)[^。；]{6,120}?(?:品牌|企业|公司|平台|服务商|提供商))/u);
  if (multiMeaningMatch) {
    return postProcessBusinessSummary(multiMeaningMatch[1]);
  }

  return '';
}

function pushUniqueName(list, value) {
  const normalized = cleanString(value);
  if (normalized && !list.includes(normalized)) {
    list.push(normalized);
  }
}

function isGenericBaiduBaikePage(title, metaDescription, pageText) {
  const value = `${cleanString(title)} ${cleanString(metaDescription)} ${cleanString(pageText).slice(0, 120)}`;
  return /百度百科[—-]全球领先的中文百科全书/u.test(value) || !value;
}

function isGenericBaiduBaikeMeta(value) {
  return /百度百科是一部内容开放、自由的网络百科全书/u.test(cleanString(value));
}

function isGenericWikipediaPage(title, intro) {
  const value = `${cleanString(title)} ${cleanString(intro)}`;
  return !value || /维基百科，自由的百科全书$/.test(cleanString(title)) && !cleanString(intro);
}

function hasStrongEntityMatch(text, context) {
  const evidence = collapseWhitespace(text);
  const companyName = cleanString(context.companyNameNormalized);
  if (!evidence || !companyName) {
    return false;
  }
  if (evidence.includes(companyName)) {
    return true;
  }

  const aliases = [
    companyName.replace(/(有限责任公司|股份有限公司|集团股份有限公司|集团有限公司|有限公司)$/u, ''),
    companyName.replace(/(科技|智能|信息|电子|数字|创新|技术)$/u, '')
  ].filter((item) => item && item.length >= 3);

  return aliases.some((alias) => evidence.includes(alias));
}

function extractWikipediaIntro(html) {
  const contentMatch = html.match(/<div id="mw-content-text"[\s\S]*?<div class="mw-parser-output">([\s\S]*?)<div id="catlinks"/i);
  const content = contentMatch ? contentMatch[1] : html;
  const paragraphPattern = /<p>([\s\S]*?)<\/p>/ig;
  let match = paragraphPattern.exec(content);
  while (match) {
    const text = collapseWhitespace(match[1])
      .replace(/\[[^\]]+\]/g, '')
      .trim();
    if (text && text.length >= 20) {
      return text;
    }
    match = paragraphPattern.exec(content);
  }
  return '';
}

function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function isLikelyRecruitmentHost(url) {
  const host = safeHostname(url);
  return /zhipin\.com|job|zhaopin|51job|liepin|58\.com|ganji|boss|rc\.com\.cn|zp\./i.test(host);
}

function isLikelyRecruitmentText(text) {
  return /招聘|诚聘|岗位职责|任职要求|薪资|五险一金|投递|应聘|职位详情|招聘人数/u.test(cleanString(text));
}

function collapseWhitespace(text) {
  return cleanString(stripTags(decodeHtml(text)));
}

function cleanString(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(/\s+/g, ' ').trim();
}

function stripTags(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

function decodeHtml(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&ensp;/g, ' ')
    .replace(/&emsp;/g, ' ')
    .replace(/&thinsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => {
      const num = Number(code);
      return num > 0 && num < 65536 ? String.fromCharCode(num) : '';
    })
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, hex) => {
      const num = Number.parseInt(hex, 16);
      return num > 0 && num < 65536 ? String.fromCharCode(num) : '';
    });
}

function extractMetaDescription(html) {
  if (typeof html !== 'string') {
    return '';
  }
  const match = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i)
    || html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
  return match ? decodeHtml(match[1]) : '';
}

function extractHtmlTitle(html) {
  if (typeof html !== 'string') {
    return '';
  }
  const match = html.match(/<title>([\s\S]*?)<\/title>/i);
  return match ? collapseWhitespace(match[1]) : '';
}

function unwrapDuckDuckGoUrl(value) {
  if (!value) {
    return '';
  }

  const normalized = value.startsWith('//') ? `https:${value}` : value;
  try {
    const url = new URL(normalized);
    const target = url.searchParams.get('uddg');
    return target ? decodeURIComponent(target) : normalized;
  } catch {
    return normalized;
  }
}

module.exports = {
  ensureSourceDecision,
  verifyBossSourceViability,
  fetchCompanyProfile,
  buildLookupContext,
  buildLookupFingerprint,
  inferCompanyTypeFromIndustry
};
