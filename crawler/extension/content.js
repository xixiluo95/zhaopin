/**
 * Content Script - 在Boss直聘页面中运行
 */

// 注入反 CDP 检测脚本到 main world（必须尽早执行）
try {
  const stealthScript = document.createElement('script');
  stealthScript.src = chrome.runtime.getURL('boss-stealth.js');
  (document.head || document.documentElement).prepend(stealthScript);
  stealthScript.onload = () => stealthScript.remove();
} catch (_) { /* ignore */ }

// 日志开关（调试时设为true，生产环境设为false）
const DEBUG = false;

function log(...args) {
  if (DEBUG) console.log('[BossScraper]', ...args);
}

console.log('[BossScraper] Content script loaded');

// 监听来自Background的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  log('Received:', request.type);

  (async () => {
    try {
      switch (request.type) {
        case 'CHECK_STATUS':
          sendResponse({
            success: true,
            ready: true,
            securityCheck: isSecurityCheckPage(),
            url: location.href
          });
          break;

        case 'SCRAPE_JOBS':
          const result = await scrapeJobs(
            request.keyword,
            request.cityCode,
            request.pageSize,
            request.experience,
            request.page
          );
          sendResponse(result);
          break;
          
        case 'GET_JOB_DETAIL':
          const detail = await getJobDetail(request.securityId, request.lid);
          sendResponse(detail);
          break;

        default:
          sendResponse({ success: false, error: 'Unknown type' });
      }
    } catch (error) {
      console.error('[BossScraper] Error:', error);
      sendResponse({ success: false, error: error.message });
    }
  })();

  return true;
});

// 搜索职位
async function scrapeJobs(keyword, cityCode, pageSize = 15, experience = '', page = 1) {
  if (isSecurityCheckPage()) {
    return buildSecurityCheckResponse();
  }

  const timestamp = Date.now();

  const params = new URLSearchParams({
    scene: '1',
    query: keyword,
    city: cityCode,
    page: String(page),
    pageSize: pageSize.toString(),
    _: timestamp.toString()
  });

  if (typeof experience === 'string' && experience.trim()) {
    params.set('experience', experience.trim());
  }

  const url = `https://www.zhipin.com/wapi/zpgeek/search/joblist.json?${params.toString()}`;
  log('Fetching:', url);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': 'https://www.zhipin.com/web/geek/job'
      },
      credentials: 'include'
    });

    const data = await response.json();
    log('Response code:', data.code);

    if (data.code !== 0) {
      // 详细错误信息，包含错误码便于反爬检测
      const errorMsg = data.message || 'Unknown';
      console.error(`[BossScraper] API error: code=${data.code}, message=${errorMsg}`);
      const domFallback = await scrapeJobsFromDOM();
      if (domFallback.success && Array.isArray(domFallback.data) && domFallback.data.length > 0) {
        console.warn('[BossScraper] API failed, DOM fallback succeeded');
        return domFallback;
      }

      if (isSecurityCheckPage()) {
        return buildSecurityCheckResponse(errorMsg, data.code);
      }

      return {
        success: false,
        error: `API error: ${errorMsg} (code: ${data.code})`,
        code: data.code
      };
    }

    const jobList = data.zpData?.jobList || [];
    // V2: 提取分页元信息（totalCount / hasMore）
    const apiTotalCount = typeof data.zpData?.totalCount === 'number' ? data.zpData.totalCount : null;
    const apiHasMore = typeof data.zpData?.hasMore === 'boolean'
      ? data.zpData.hasMore
      : (jobList.length >= pageSize);
    log(`Found ${jobList.length} jobs, totalCount=${apiTotalCount}, hasMore=${apiHasMore}`);

    const domLinkMap = buildBossDomLinkMap();
    console.log(
      `[BossScraper] Link mapping for page ${page}: domLinks=${domLinkMap.size}, apiJobs=${jobList.length}`
    );
    const jobs = jobList.map(job => {
      const domMatchedUrl = domLinkMap.get(buildBossDomLookupKey({
        title: job.jobName,
        company: job.brandName,
        salary: job.salaryDesc
      })) || '';

      return ({
      encryptJobId: job.encryptJobId,
      encryptBrandId: job.encryptBrandId || null,
      jobName: job.jobName,
      salaryDesc: job.salaryDesc,
      locationName: job.locationName || job.cityName || '',
      areaDistrict: job.areaDistrict || '',
      jobExperience: job.jobExperience,
      jobDegree: job.jobDegree,
      brandName: job.brandName,
      bossName: job.bossName,
      bossTitle: job.bossTitle || '',
      skills: job.skills || [],
      brandIndustry: job.brandIndustry || '',
      brandStageName: job.brandStageName || '',
      brandScaleName: job.brandScaleName || '',
      securityId: job.securityId || '',  // 用于获取详情
      lid: job.lid || '',  // 用于获取详情
      url: domMatchedUrl
    });
    });

    return {
      success: true,
      data: jobs,
      page,
      pageSize: Number(pageSize),
      batchCount: jobs.length,
      totalCount: apiTotalCount,
      hasMore: apiHasMore,
      source: 'api'
    };

  } catch (error) {
    console.error('[BossScraper] Fetch error:', error);
    const domFallback = await scrapeJobsFromDOM();
    if (domFallback.success && Array.isArray(domFallback.data) && domFallback.data.length > 0) {
      console.warn('[BossScraper] Fetch failed, DOM fallback succeeded');
      return domFallback;
    }
    return {
      success: false,
      error: error.message
    };
  }
}

function normalizeText(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function isSecurityCheckPage() {
  const href = window.location.href || '';
  const bodyText = normalizeText(document.body?.innerText || '');
  return href.includes('_security_check') ||
    /环境存在异常|安全验证|请完成验证|验证后继续访问/.test(bodyText);
}

function buildSecurityCheckResponse(message = 'security_check_required', code = 'security_check') {
  return {
    success: false,
    error: `Security check required: ${message}`,
    code
  };
}

async function waitForJobCards(timeoutMs = 10000) {
  const selectors = getBossJobCardSelectors();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isSecurityCheckPage()) {
      return false;
    }
    if (selectors.some((selector) => document.querySelector(selector))) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return selectors.some((selector) => document.querySelector(selector));
}

function getBossJobCardSelectors() {
  return [
    '.job-card-wrapper',
    '.job-list-box .job-card-wrapper',
    '.search-job-result .job-card-wrapper',
    '[ka="search_list"] .job-card-wrapper',
    '.rec-job-list .job-card-wrapper',
    '.job-card-box'
  ];
}

function extractBossJobId(url = '') {
  const match = url.match(/job_detail\/([^?./]+)(?:\.html)?/);
  return match ? match[1] : '';
}

function extractBossQueryValue(link, key) {
  try {
    const parsed = new URL(link, window.location.origin);
    return parsed.searchParams.get(key) || '';
  } catch {
    return '';
  }
}

function buildBossDomLookupKey({ title = '', company = '', salary = '' }) {
  return [normalizeText(title), normalizeText(company), normalizeText(salary)].join('::');
}

function buildBossDomLinkMap() {
  const map = new Map();
  const selectors = getBossJobCardSelectors();
  let cards = [];
  for (const selector of selectors) {
    cards = Array.from(document.querySelectorAll(selector));
    if (cards.length > 0) break;
  }

  for (const card of cards) {
    const title = normalizeText(
      card.querySelector('.job-title')?.textContent ||
      card.querySelector('[class*="job-title"]')?.textContent ||
      card.querySelector('a[ka*="job"]')?.textContent ||
      ''
    );
    const company = normalizeText(
      card.querySelector('.company-name')?.textContent ||
      card.querySelector('[class*="company-name"]')?.textContent ||
      ''
    );
    const salary = normalizeText(
      card.querySelector('.salary')?.textContent ||
      card.querySelector('[class*="salary"]')?.textContent ||
      ''
    );
    const url = card.querySelector('a.job-card-left')?.href ||
      card.querySelector('a[href*="job_detail"]')?.href ||
      card.querySelector('.job-card-body a')?.href ||
      '';
    const key = buildBossDomLookupKey({ title, company, salary });
    if (title && company && url && !map.has(key)) {
      map.set(key, url);
    }
  }

  if (map.size > 0) {
    console.log('[BossScraper] DOM href samples:', Array.from(map.entries()).slice(0, 3));
  }

  return map;
}

function parseBossJobCard(card) {
  const titleEl = card.querySelector('.job-title') ||
    card.querySelector('[class*="job-title"]') ||
    card.querySelector('a[ka*="job"]');
  const title = normalizeText(titleEl?.textContent);
  const linkEl = card.querySelector('a.job-card-left') ||
    card.querySelector('a[href*="job_detail"]') ||
    card.querySelector('.job-card-body a');
  const url = linkEl?.href || '';
  const companyEl = card.querySelector('.company-name') ||
    card.querySelector('[class*="company-name"]') ||
    card.querySelector('.boss-name + .company-name');
  const salaryEl = card.querySelector('.salary') || card.querySelector('[class*="salary"]');
  const areaEl = card.querySelector('.job-area') || card.querySelector('[class*="job-area"]');
  const infoItems = Array.from(card.querySelectorAll('.job-info .tag-list li, .job-info li'))
    .map((item) => normalizeText(item.textContent))
    .filter(Boolean);
  const skillItems = Array.from(card.querySelectorAll('.job-card-footer .tag-list li, .job-card-footer .tag-list span, .job-card-tags span, .tags li'))
    .map((item) => normalizeText(item.textContent))
    .filter(Boolean)
    .slice(0, 6);
  const bossEl = card.querySelector('.boss-name') || card.querySelector('[class*="boss-name"]');
  const brandName = normalizeText(companyEl?.textContent);
  if (!title || !brandName) {
    return null;
  }
  return {
    encryptJobId: extractBossJobId(url),
    encryptBrandId: extractBossQueryValue(url, 'encryptBrandId') || null,
    jobName: title,
    salaryDesc: normalizeText(salaryEl?.textContent),
    locationName: normalizeText(areaEl?.textContent),
    areaDistrict: '',
    jobExperience: infoItems[0] || '',
    jobDegree: infoItems[1] || '',
    brandName,
    bossName: normalizeText(bossEl?.textContent),
    bossTitle: '',
    skills: skillItems,
    brandIndustry: '',
    brandStageName: '',
    brandScaleName: infoItems[2] || '',
    securityId: extractBossQueryValue(url, 'securityId') || '',
    lid: extractBossQueryValue(url, 'lid') || '',
    url
  };
}

async function scrapeJobsFromDOM() {
  const ready = await waitForJobCards();
  if (!ready) {
    if (isSecurityCheckPage()) {
      return buildSecurityCheckResponse();
    }
    return { success: false, error: 'Boss DOM fallback found no job cards' };
  }

  const selectors = getBossJobCardSelectors();
  let cards = [];
  for (const selector of selectors) {
    cards = Array.from(document.querySelectorAll(selector));
    if (cards.length > 0) break;
  }

  const jobs = cards
    .map((card) => parseBossJobCard(card))
    .filter(Boolean);

  if (jobs.length === 0) {
    return { success: false, error: 'Boss DOM fallback parsed 0 valid jobs' };
  }

  return {
    success: true,
    data: jobs,
    total: jobs.length,
    page: 1,
    source: 'dom'
  };
}

// 获取职位详情（双端点降级方案 - GitHub最佳实践）
// 优先使用 job/card.json（反爬容忍度高），失败时降级到 job/detail.json
async function getJobDetail(securityId, lid) {
  if (!securityId) {
    return { success: false, error: 'No securityId' };
  }
  
  // 端点配置（按优先级排序）
  const endpoints = [
    {
      name: 'card',
      url: `https://www.zhipin.com/wapi/zpgeek/job/card.json?${new URLSearchParams({ 
        securityId, 
        lid: lid || '' 
      })}`,
      extractPath: (data) => data.zpData?.jobCard,
      description: '推荐端点，反爬容忍度高'
    },
    {
      name: 'detail',
      url: `https://www.zhipin.com/wapi/zpgeek/job/detail.json?${new URLSearchParams({ 
        securityId, 
        lid: lid || '' 
      })}`,
      extractPath: (data) => data.zpData?.jobInfo,
      description: '备用端点，card失败时降级'
    }
  ];
  
  // 依次尝试每个端点
  let lastError = null;
  for (const endpoint of endpoints) {
    log(`Trying ${endpoint.name}: ${endpoint.description}`);

    try {
      const response = await fetch(endpoint.url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': 'https://www.zhipin.com/web/geek/job'
        },
        credentials: 'include'
      });

      const data = await response.json();
      log(`${endpoint.name} response code:`, data.code);

      if (data.code !== 0) {
        const errorMsg = data.message || 'Unknown';
        lastError = { source: endpoint.name, code: data.code, message: errorMsg };
        console.warn(`[BossScraper] ${endpoint.name} API error: code=${data.code}, message=${errorMsg}`);
        continue;
      }

      const rawData = endpoint.extractPath(data);
      if (!rawData) {
        lastError = { source: endpoint.name, code: -2, message: 'No data in expected path' };
        console.warn(`[BossScraper] ${endpoint.name}: No data in expected path`);
        continue;
      }
      
      // 调试日志（验证字段结构）
      log(`${endpoint.name} keys:`, Object.keys(rawData));
      
      // 标准化字段提取（兼容card和detail的差异）
      const description = rawData.postDescription || rawData.jobDescription || '';

      // 关键修复：card成功但描述为空时，不能直接返回成功，要继续尝试detail
      if (!description) {
        lastError = { source: endpoint.name, code: -3, message: 'API成功但描述为空' };
        console.warn(`[BossScraper] ${endpoint.name}: API成功但描述为空，尝试下一个端点`);
        continue;
      }

      const skills = rawData.skills || rawData.showSkills || rawData.skillList || [];
      const welfareList = rawData.welfareList || rawData.welfare || [];
      const address = rawData.address || rawData.location || '';
      const experience = rawData.experienceName || rawData.jobExperience || '';
      const degree = rawData.degreeName || rawData.jobDegree || '';

      // HR信息（只有detail.json有，card.json没有）
      const bossInfo = data.zpData?.bossInfo || {};
      const bossName = bossInfo.name || '';
      const bossTitle = bossInfo.title || '';

      console.log(`[BossScraper] ${endpoint.name} success, desc: ${description.length} chars`);
      log(`Description preview: ${description.substring(0, 100)}...`);

      return {
        success: true,
        data: {
          description: description,
          hardRequirements: (rawData.jobLabels || []).join(' | '),
          skills: skills,
          address: address,
          welfareList: welfareList,
          bossName: bossName,
          bossTitle: bossTitle,
          experience: experience,
          degree: degree,
          _source: endpoint.name  // 记录数据来源，用于监控
        }
      };

    } catch (error) {
      console.warn(`[BossScraper] ${endpoint.name} fetch error:`, error.message);
      // 继续尝试下一个端点
    }
  }
  
  // 所有端点都失败，返回最后一次的具体错误供background反爬判断
  console.error('[BossScraper] All endpoints failed, lastError:', JSON.stringify(lastError));
  return {
    success: false,
    error: lastError
      ? `${lastError.source} failed (code: ${lastError.code}, ${lastError.message})`
      : 'All API endpoints failed (card and detail)',
    code: lastError?.code ?? -1
  };
}

console.log('[BossScraper] Ready');
