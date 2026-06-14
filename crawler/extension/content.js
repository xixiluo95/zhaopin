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

        case 'GET_CHAT_BUTTON_TARGET':
          const chatTarget = await getBossChatButtonTarget();
          sendResponse(chatTarget);
          break;

        case 'OBSERVE_CHAT_CLICK_RESULT':
          const observedResult = await observeBossChatClickResult({
            urlBefore: request.urlBefore || window.location.href || '',
            buttonText: request.buttonText || '立即沟通',
            timeoutMs: request.timeoutMs || 7000
          });
          sendResponse(observedResult);
          break;

        case 'DOM_CLICK_AND_VERIFY':
          const domClickResult = await executeDomClickAndVerify();
          sendResponse(domClickResult);
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

      // 如果 DOM 上没有 href，可基于 encryptJobId/securityId/lid 构建回退 URL（用于后台在 normalize 时使用）
      let constructedUrl = '';
      if (!domMatchedUrl && job.encryptJobId) {
        const enc = job.encryptJobId;
        const sec = job.securityId || '';
        const lid = job.lid || '';
        constructedUrl = `https://www.zhipin.com/job_detail/${enc}.html${sec || lid ? `?securityId=${encodeURIComponent(sec)}&lid=${encodeURIComponent(lid)}` : ''}`;
      }

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
      url: domMatchedUrl || constructedUrl,
      constructedUrlUsed: !!constructedUrl
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

// ============ Boss Chat 投递相关函数 ============

function normalizeText(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isVisibleElement(element) {
  if (!element) return false;
  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function getElementText(element) {
  return normalizeText(element?.innerText || element?.textContent || '');
}

function isSecurityCheckPage() {
  const href = window.location.href || '';
  const bodyText = normalizeText(document.body?.innerText || '');
  return href.includes('_security_check') ||
    /环境存在异常|安全验证|请完成验证|验证后继续访问/.test(bodyText);
}

function isLoginPage() {
  const bodyText = normalizeText(document.body?.innerText || '');
  return /登录|login|扫码登录|账号登录/.test(bodyText) &&
    document.querySelector('input[type="password"], .login-box, .login-form, [class*="login"]');
}

function hasAlreadyChattedSignal() {
  return Array.from(document.querySelectorAll('a, button, div, span'))
    .some(element => isVisibleElement(element) && getElementText(element) === '继续沟通');
}

function getBossUnavailableReason() {
  const bodyText = normalizeText(document.body?.innerText || '');
  if (/职位已关闭|停止招聘|已停止招聘|职位不存在|职位已下线|岗位已下线|招聘已结束|该职位不存在/.test(bodyText)) {
    return '岗位不可沟通或已关闭';
  }
  return '';
}

function findBossChatTargetButton() {
  const selectors = [
    '.btn-greet',
    '.op-btn-chat',
    '[class*="greet"]',
    '[class*="chat"]',
    'a[class*="greet"]',
    'button[class*="greet"]',
    'a[class*="chat"]',
    'button[class*="chat"]'
  ];

  for (const selector of selectors) {
    const candidates = Array.from(document.querySelectorAll(selector));
    const match = candidates.find(element =>
      isVisibleElement(element) &&
      !element.disabled &&
      getElementText(element) === '立即沟通'
    );
    if (match) return match;
  }

  return Array.from(document.querySelectorAll('a, button, div, span')).find(element =>
    isVisibleElement(element) &&
    !element.disabled &&
    getElementText(element) === '立即沟通'
  ) || null;
}

async function waitForBossChatButton(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const button = findBossChatTargetButton();
    if (button) return button;
    await sleep(400);
  }
  return null;
}

function getClickableElement(element) {
  return element.closest?.('a, button, [role="button"]') || element;
}

function getViewportScreenOffset() {
  const borderX = Math.max(0, (window.outerWidth - window.innerWidth) / 2);
  const toolbarY = Math.max(0, window.outerHeight - window.innerHeight - borderX);
  return {
    x: window.screenX + borderX,
    y: window.screenY + toolbarY
  };
}

// ============ GET_CHAT_BUTTON_TARGET ============

async function getBossChatButtonTarget() {
  const urlBefore = window.location.href || '';

  if (isSecurityCheckPage()) {
    return {
      success: false,
      status: 'security_check',
      buttonText: '',
      urlBefore,
      urlAfter: urlBefore,
      reason: '当前页面是安全验证页'
    };
  }

  if (isLoginPage()) {
    return {
      success: false,
      status: 'login_required',
      buttonText: '',
      urlBefore,
      urlAfter: urlBefore,
      reason: '当前页面需要登录'
    };
  }

  if (hasAlreadyChattedSignal()) {
    return {
      success: true,
      status: 'already_chatted',
      buttonText: '继续沟通',
      urlBefore,
      urlAfter: urlBefore,
      reason: '检测到该岗位已沟通过'
    };
  }

  const button = await waitForBossChatButton(10000);
  if (!button) {
    const unavailableReason = getBossUnavailableReason();
    return {
      success: false,
      status: unavailableReason ? 'unavailable' : 'not_found',
      buttonText: '',
      urlBefore,
      urlAfter: window.location.href || '',
      reason: unavailableReason || '未找到文本严格等于"立即沟通"的按钮'
    };
  }

  const target = getClickableElement(button);
  target.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
  await sleep(300 + Math.random() * 400);

  const rect = target.getBoundingClientRect();
  const clientX = rect.left + rect.width * (0.35 + Math.random() * 0.3);
  const clientY = rect.top + rect.height * (0.35 + Math.random() * 0.3);
  const screenOffset = getViewportScreenOffset();

  // 视口异常检测
  if (window.innerHeight < 500) {
    console.warn('[BossScraper] Abnormal viewport:', window.innerWidth, 'x', window.innerHeight);
  }

  return {
    success: true,
    status: 'target_found',
    buttonText: getElementText(button),
    urlBefore,
    urlAfter: window.location.href || '',
    reason: '已定位立即沟通按钮',
    target: {
      clientX,
      clientY,
      screenX: Math.round(screenOffset.x + clientX),
      screenY: Math.round(screenOffset.y + clientY),
      rect: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height
      },
      viewport: {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        outerWidth: window.outerWidth,
        outerHeight: window.outerHeight,
        screenX: window.screenX,
        screenY: window.screenY,
        devicePixelRatio: window.devicePixelRatio || 1
      },
      element: {
        tag: target.tagName?.toLowerCase() || '',
        text: getElementText(target),
        className: String(target.className || '').slice(0, 120)
      }
    }
  };
}

// ============ OBSERVE_CHAT_CLICK_RESULT ============

function hasChatDialogSignal() {
  const dialogSelectors = [
    '.chat-wrap',
    '.chat-dialog',
    '.im-chat-dialog',
    '.geek-chat-popup'
  ];
  for (const selector of dialogSelectors) {
    const el = document.querySelector(selector);
    if (el && isVisibleElement(el)) return true;
  }
  return false;
}

function hasSuccessToastSignal() {
  const toastPattern = /沟通申请已发送|已发送沟通|发送成功|投递成功/;
  const allText = normalizeText(document.body?.innerText || '');
  if (toastPattern.test(allText)) return true;

  const toastSelectors = [
    '.toast-message',
    '.el-message',
    '.ant-message',
    '[class*="toast"]'
  ];
  for (const selector of toastSelectors) {
    const els = Array.from(document.querySelectorAll(selector));
    if (els.some(el => isVisibleElement(el) && /发送|成功|沟通/.test(normalizeText(el.innerText)))) {
      return true;
    }
  }
  return false;
}

async function observeBossChatClickResult({ urlBefore, buttonText, timeoutMs = 5000 }) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const urlAfter = window.location.href || '';

    if (isSecurityCheckPage()) {
      return {
        success: false,
        status: 'security_check',
        buttonText,
        urlBefore,
        urlAfter,
        reason: '点击后进入安全验证'
      };
    }

    if (isLoginPage()) {
      return {
        success: false,
        status: 'login_required',
        buttonText,
        urlBefore,
        urlAfter,
        reason: '点击后进入登录页'
      };
    }

    if (/\/web\/geek\/chat/.test(urlAfter) ||
        hasAlreadyChattedSignal() ||
        hasChatDialogSignal() ||
        hasSuccessToastSignal()) {
      return {
        success: true,
        status: 'clicked',
        buttonText,
        urlBefore,
        urlAfter,
        reason: '检测到聊天跳转、继续沟通按钮、聊天弹窗或成功提示'
      };
    }

    await sleep(500);
  }

  // 超时后再次检查
  const finalUrl = window.location.href || '';
  if (hasAlreadyChattedSignal() || hasChatDialogSignal() || hasSuccessToastSignal()) {
    return {
      success: true,
      status: 'clicked',
      buttonText,
      urlBefore,
      urlAfter: finalUrl,
      reason: '超时后检测到成功信号'
    };
  }

  return {
    success: false,
    status: 'clicked_unknown',
    buttonText,
    urlBefore,
    urlAfter: finalUrl,
    reason: '已点击，但未观测到明确跳转'
  };
}

// ============ DOM 点击投递（替代 Native Host 坐标点击） ============

function findBossChatButton() {
  const candidates = Array.from(
    document.querySelectorAll(
      'button, a, [role="button"], [class*="greet"], [class*="chat"]'
    )
  );

  return candidates.find(element => {
    const text = normalizeText(
      element.innerText ||
      element.textContent ||
      element.getAttribute('aria-label') ||
      ''
    );

    return (
      /^(立即沟通|继续沟通|打招呼)$/.test(text) &&
      isVisible(element) &&
      isInsideJobDetail(element)
    );
  }) || null;
}

function isInsideJobDetail(element) {
  return Boolean(
    element.closest(
      '.job-detail, .job-detail-box, .job-primary, main, [class*="job-detail"]'
    )
  );
}

function isVisible(element) {
  if (!element?.isConnected) return false;
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    Number(style.opacity) > 0
  );
}

function isElementUncovered(element) {
  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;

  const topElement = document.elementFromPoint(x, y);

  return Boolean(
    topElement &&
    (
      topElement === element ||
      element.contains(topElement) ||
      topElement.contains(element)
    )
  );
}

function inspectTopOverlay() {
  const overlays = document.querySelectorAll(
    '.dialog-container, .modal, [class*="dialog"], [class*="modal"], [class*="overlay"], [class*="popup"]'
  );
  for (const el of overlays) {
    if (isVisible(el)) {
      const text = normalizeText(el.innerText || '');
      if (/登录|验证|安全|频繁|关闭|下架/.test(text)) {
        return text.slice(0, 100);
      }
    }
  }
  return '';
}

function dispatchDomClickSequence(element) {
  const rect = element.getBoundingClientRect();
  const clientX = rect.left + rect.width / 2;
  const clientY = rect.top + rect.height / 2;

  const common = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX,
    clientY,
    button: 0,
    buttons: 1,
    view: window
  };

  element.dispatchEvent(new PointerEvent('pointerover', {
    ...common,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true
  }));

  element.dispatchEvent(new MouseEvent('mouseover', common));

  element.dispatchEvent(new PointerEvent('pointerdown', {
    ...common,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true
  }));

  element.dispatchEvent(new MouseEvent('mousedown', common));

  element.dispatchEvent(new PointerEvent('pointerup', {
    ...common,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    buttons: 0
  }));

  element.dispatchEvent(new MouseEvent('mouseup', {
    ...common,
    buttons: 0
  }));

  element.dispatchEvent(new MouseEvent('click', {
    ...common,
    buttons: 0
  }));
}

function hasRateLimitSignal() {
  const bodyText = normalizeText(document.body?.innerText || '');
  return /操作过于频繁|请稍后再试|访问太频繁/.test(bodyText);
}

function inspectBossChatState(context) {
  if (isSecurityCheckPage()) {
    return { success: false, status: 'security_check', reason: '当前页面是安全验证页' };
  }

  if (isLoginPage()) {
    return { success: false, status: 'login_required', reason: '当前页面需要登录' };
  }

  if (hasRateLimitSignal()) {
    return { success: false, status: 'rate_limited', reason: '操作过于频繁' };
  }

  if (hasAlreadyChattedSignal()) {
    return { success: true, status: 'already_chatted', reason: '检测到该岗位已沟通过' };
  }

  if (hasChatDialogSignal() || hasSuccessToastSignal()) {
    return { success: true, status: 'clicked', reason: '检测到聊天弹窗或成功提示' };
  }

  return { success: false, status: 'verification_pending' };
}

function waitForChatResult(context, timeoutMs = 10000) {
  return new Promise(resolve => {
    const startedAt = Date.now();

    const check = () => {
      const result = inspectBossChatState(context);

      if (
        result.status !== 'verification_pending' ||
        Date.now() - startedAt >= timeoutMs
      ) {
        observer.disconnect();
        resolve(
          result.status === 'verification_pending'
            ? {
                success: false,
                status: 'clicked_unknown',
                reason: '点击后未发现明确页面状态变化'
              }
            : result
        );
        return true;
      }
      return false;
    };

    const observer = new MutationObserver(check);

    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true
    });

    if (check()) return;

    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer);
      }
    }, 500);
  });
}

async function executeDomClickAndVerify() {
  const urlBefore = window.location.href || '';

  const initialState = inspectBossChatState({ urlBefore });

  if (initialState.status !== 'verification_pending') {
    return { ...initialState, urlBefore, urlAfter: urlBefore, method: 'dom' };
  }

  let button = findBossChatButton();

  if (!button) {
    return {
      success: false,
      status: 'not_found',
      reason: '未找到"立即沟通"按钮',
      urlBefore,
      urlAfter: window.location.href || '',
      method: 'dom'
    };
  }

  button = getClickableElement(button);
  button.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
  await sleep(300 + Math.random() * 200);

  // 滚动后可能重新渲染，重新获取
  button = findBossChatButton();

  if (!button || !button.isConnected) {
    return {
      success: false,
      status: 'not_found',
      reason: '滚动后按钮节点失效',
      urlBefore,
      urlAfter: window.location.href || '',
      method: 'dom'
    };
  }

  button = getClickableElement(button);

  if (!isVisible(button)) {
    return {
      success: false,
      status: 'not_found',
      reason: '按钮不可见',
      urlBefore,
      urlAfter: window.location.href || '',
      method: 'dom'
    };
  }

  if (!isElementUncovered(button)) {
    return {
      success: false,
      status: 'not_found',
      reason: '按钮被遮挡: ' + inspectTopOverlay(),
      urlBefore,
      urlAfter: window.location.href || '',
      method: 'dom'
    };
  }

  const buttonTextBefore = normalizeText(button.innerText || button.textContent || '');

  // 第一级：原生 DOM click
  HTMLElement.prototype.click.call(button);

  let result = await waitForChatResult({ urlBefore, buttonTextBefore }, 6000);

  // 第二级：完整 DOM 事件序列（fallback）
  if (
    result.status === 'clicked_unknown' &&
    button.isConnected &&
    isVisible(button)
  ) {
    await sleep(300);
    dispatchDomClickSequence(button);
    result = await waitForChatResult({ urlBefore, buttonTextBefore }, 7000);
  }

  return {
    ...result,
    method: 'dom',
    urlBefore,
    urlAfter: window.location.href || '',
    buttonTextBefore
  };
}
