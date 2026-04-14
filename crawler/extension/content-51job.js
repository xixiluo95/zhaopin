/**
 * Content Script - 在前程无忧(51job)页面中运行
 * 纯 DOM 解析方式采集职位数据，无需注入页面脚本
 *
 * 搜索列表页: https://search.51job.com/list/{citycode},000000,0000000,00,9,99,+,+,+,+,+.html
 * 职位详情页: https://jobs.51job.com/{jobId}.html
 */

(function() {
  'use strict';

  console.log('[51jobScraper] Content script loaded');

  // 城市编码映射
  const CITY_CODES = {
    '北京': '010000',
    '上海': '020000',
    '深圳': '040000',
    '苏州': '060000',
    '杭州': '080200',
    '广州': '030000',
    '成都': '090200',
    '南京': '070200',
    '武汉': '180200'
  };

  // ============ 工具函数 ============

  /**
   * 薪资归一化 - 将 51job 薪资格式转为统一格式（大写K，范围分隔符 `-`）
   *
   * 转换规则：
   *   "1万-1.5万"   → "10K-15K"
   *   "1万/月"       → "10K"
   *   ".5万-1万"     → "5K-10K"
   *   "8000-12000"   → "8K-12K"
   *   "8-15千/月"    → "8K-15K"
   *   "面议"          → "面议"（保留原值）
   *
   * @param {string} raw - 原始薪资文本
   * @returns {string|null} 归一化后的薪资，无法识别时保留原始值
   */
  function normalizeSalary(raw) {
    if (!raw) return null;
    const text = raw.trim().replace(/\s+/g, '');

    // 面议直接返回
    if (text === '面议' || text === '薪酬面议') return '面议';

    try {
      // 提取数值部分和单位
      // 匹配模式: 可选小数 + 可选分隔符 + 可选小数 + 单位(万/千)
      const wanMatch = text.match(/^([\d.]+)\s*[-~至到]\s*([\d.]+)\s*万/);
      const qianMatch = text.match(/^([\d.]+)\s*[-~至到]\s*([\d.]+)\s*千/);
      const singleWanMatch = text.match(/^([\d.]+)\s*万/);
      const singleQianMatch = text.match(/^([\d.]+)\s*千/);

      if (wanMatch) {
        // "1万-1.5万" → "10K-15K"
        const low = Math.round(parseFloat(wanMatch[1]) * 10);
        const high = Math.round(parseFloat(wanMatch[2]) * 10);
        return `${low}K-${high}K`;
      }

      if (qianMatch) {
        // "8-15千" → "8K-15K"
        const low = Math.round(parseFloat(qianMatch[1]));
        const high = Math.round(parseFloat(qianMatch[2]));
        return `${low}K-${high}K`;
      }

      if (singleWanMatch) {
        // "1万/月" → "10K"
        const val = Math.round(parseFloat(singleWanMatch[1]) * 10);
        return `${val}K`;
      }

      if (singleQianMatch) {
        // "8千/月" → "8K"
        const val = Math.round(parseFloat(singleQianMatch[1]));
        return `${val}K`;
      }

      // 纯数字范围: "8000-12000" → "8K-12K"
      const numRangeMatch = text.match(/^([\d.]+)\s*[-~至到]\s*([\d.]+)$/);
      if (numRangeMatch) {
        const low = Math.round(parseFloat(numRangeMatch[1]) / 1000);
        const high = Math.round(parseFloat(numRangeMatch[2]) / 1000);
        return `${low}K-${high}K`;
      }

      // 单个纯数字: "8000" → "8K"
      const singleNumMatch = text.match(/^([\d.]+)$/);
      if (singleNumMatch) {
        const val = parseFloat(singleNumMatch[1]);
        if (val >= 1000) {
          return `${Math.round(val / 1000)}K`;
        }
      }

    } catch (e) {
      console.warn('[51jobScraper] 薪资归一化异常，保留原始值:', raw, e);
    }

    // 格式转换失败，保留原始值
    return text;
  }

  /**
   * 经验归一化 - 将中文经验描述转为统一格式
   *
   * 转换规则：
   *   "1-3年"         → "1-3年"（已是标准格式）
   *   "3-5年"         → "3-5年"
   *   "一年以上"       → "1年以上"
   *   "二年以上"       → "2年以上"
   *   "无经验要求"     → "不限"
   *   "经验不限"       → "不限"
   *   "应届毕业生"     → "应届生"
   *   "应届生"         → "应届生"
   *
   * @param {string} raw - 原始经验文本
   * @returns {string|null} 归一化后的经验描述
   */
  function normalizeExperience(raw) {
    if (!raw) return null;
    const text = raw.trim().replace(/\s+/g, '');

    // 已是标准数字格式: "1-3年", "3-5年", "10年以上"
    if (/^\d+[-~至到]\d+年$/.test(text)) return text;
    if (/^\d+年以上$/.test(text)) return text;
    if (/^\d+年以下$/.test(text)) return text;

    // 中文数字映射
    const cnNumMap = {
      '一': '1', '二': '2', '三': '3', '四': '4', '五': '5',
      '六': '6', '七': '7', '八': '8', '九': '9', '十': '10',
      '两': '2'
    };

    // "一年以上" → "1年以上"
    const cnAbove = text.match(/^([一二三四五六七八九十两]+)年以上$/);
    if (cnAbove) {
      const num = cnNumMap[cnAbove[1]];
      if (num) return `${num}年以上`;
    }

    // "一年以下" → "1年以下"
    const cnBelow = text.match(/^([一二三四五六七八九十两]+)年以下$/);
    if (cnBelow) {
      const num = cnNumMap[cnBelow[1]];
      if (num) return `${num}年以下`;
    }

    // "一年" → "1年"
    const cnExact = text.match(/^([一二三四五六七八九十两]+)年$/);
    if (cnExact) {
      const num = cnNumMap[cnExact[1]];
      if (num) return `${num}年`;
    }

    // "无经验要求" / "经验不限" / "不限" → "不限"
    if (/^无经验要求$/.test(text) || /^经验不限$/.test(text) || /^不限$/.test(text)) {
      return '不限';
    }

    // "应届毕业生" / "应届" → "应届生"
    if (/^应届毕业生?$/.test(text)) {
      return '应届生';
    }

    return text;
  }

  /**
   * 学历归一化 - 基本保持原值，处理空值
   *
   * 保留的标准值: 本科, 大专, 硕士, 博士, 中专, 高中, 不限
   *
   * @param {string} raw - 原始学历文本
   * @returns {string|null} 归一化后的学历描述
   */
  function normalizeEducation(raw) {
    if (!raw) return null;
    const text = raw.trim().replace(/\s+/g, '');

    // 空值或无意义值
    if (!text || text === '--' || text === '-') return null;

    return text;
  }

  /**
   * 关键词归一化 - 确保输出为逗号分隔的字符串
   *
   * 处理规则：
   *   已是逗号分隔 → 直接返回
   *   空格分隔    → 转为逗号分隔
   *   数组        → 逗号拼接
   *   空值        → 返回空字符串
   *
   * @param {string|Array} raw - 原始关键词
   * @returns {string} 逗号分隔的关键词字符串
   */
  function normalizeKeywords(raw) {
    if (!raw) return '';
    if (Array.isArray(raw)) {
      return raw.map(k => String(k).trim()).filter(k => k.length > 0).join(',');
    }

    const text = String(raw).trim();
    if (!text) return '';

    // 已是逗号分隔
    if (text.includes(',')) {
      return text.split(',').map(k => k.trim()).filter(k => k.length > 0).join(',');
    }

    // 空格/斜杠分隔 → 转为逗号
    if (/[\s/、|]+/.test(text)) {
      return text.split(/[\s/、|]+/).map(k => k.trim()).filter(k => k.length > 0).join(',');
    }

    return text;
  }

  /**
   * 对单条职位数据进行归一化处理
   * 纯函数，不修改原始数据对象
   *
   * @param {Object} rawJob - 原始职位数据
   * @returns {Object|null} 归一化后的职位数据；必填字段缺失时返回 null
   */
  function normalizeJob(rawJob) {
    // 必填字段校验：title 或 company 缺失则跳过
    if (!rawJob.title || !rawJob.company) {
      console.warn('[51jobScraper] 必填字段缺失，跳过:', {
        title: rawJob.title,
        company: rawJob.company
      });
      return null;
    }

    // 保留原始数据快照
    const rawPayload = JSON.parse(JSON.stringify(rawJob));

    return {
      platform: rawJob.platform || '51job',
      platformJobId: rawJob.platformJobId || '',
      title: rawJob.title,
      company: rawJob.company,
      location: rawJob.location || '',
      salary: normalizeSalary(rawJob.salary),
      experience: normalizeExperience(rawJob.experience),
      education: normalizeEducation(rawJob.education),
      keywords: normalizeKeywords(rawJob.keywords),
      description: rawJob.description || '',
      url: rawJob.url || '',
      raw_payload: rawPayload
    };
  }

  /**
   * 从职位链接中提取 jobId
   * URL 格式: https://jobs.51job.com/shanghai/123456789.html
   */
  function extractJobId(url) {
    if (!url) return '';
    const match = url.match(/(\d+)\.html/);
    return match ? match[1] : '';
  }

  /**
   * 从文本中安全获取内容，去除多余空白
   */
  function safeText(el) {
    if (!el) return '';
    return (el.textContent || '').trim().replace(/\s+/g, ' ');
  }

  /**
   * 从元素集合中提取标签文本，逗号拼接
   */
  function extractTags(container) {
    if (!container) return '';
    const tags = container.querySelectorAll('.tag, span');
    return Array.from(tags)
      .map(t => (t.textContent || '').trim())
      .filter(t => t.length > 0)
      .filter((tag, index, arr) => arr.indexOf(tag) === index)
      .join(',');
  }

  // 城市 / 区域 slug 映射表（逐步补齐）
  var CITY_SLUG_MAP = {
    '北京': 'beijing',
    '上海': 'shanghai',
    '深圳': 'shenzhen',
    '杭州': 'hangzhou',
    '广州': 'guangzhou',
    '成都': 'chengdu',
    '南京': 'nanjing',
    '武汉': 'wuhan'
  };

  var AREA_SLUG_MAP = {
    '北京·通州区': 'beijing-tzq',
    '深圳·福田区': 'shenzhen-ftq',
    '深圳·龙岗区': 'shenzhen-lgq',
    '深圳·南山区': 'shenzhen-nsq',
    '深圳·宝安区': 'shenzhen-baq',
    '深圳·龙华区': 'shenzhen-lhq',
    '上海·浦东新区': 'shanghai-pdxq',
    '上海·黄浦区': 'shanghai-hpq',
    '上海·徐汇区': 'shanghai-xhq',
    '上海·青浦区': 'shanghai-qpq',
    '广州·天河区': 'guangzhou-thq',
    '杭州·西湖区': 'hangzhou-xhq',
    '成都·武侯区': 'chengdu-whq',
    '南京·鼓楼区': 'nanjing-glq',
    // 后续根据实测数据补充...
  };

  function resolveAreaSlug(jobArea) {
    if (!jobArea) return '';
    if (AREA_SLUG_MAP[jobArea]) return AREA_SLUG_MAP[jobArea];

    var city = jobArea.split('·')[0];
    return CITY_SLUG_MAP[city] || '';
  }

  /**
   * 基于 sensorsdata 或卡片链接还原 51job 详情 URL
   * 优先基于 sensorsdata 还原数值 jobId 链接，卡片 href 仅作为兜底。
   * 实测部分卡片 href 会落到 co...html 的壳页，无法直接解析详情正文。
   *
   * @param {Object} sensors - sensorsdata 解析结果
   * @param {Element} card - 职位卡片 DOM 元素
   * @returns {string} 详情页 URL
   */
  function build51JobDetailUrl(sensors, card) {
    if (sensors && sensors.jobId) {
      var jobId = sensors.jobId;
      var pageCode = sensors.pageCode ? sensors.pageCode.replace(/\|/g, '_') : '';
      var requestId = sensors.requestId || '';
      var areaSlug = resolveAreaSlug(sensors.jobArea);

      var query = [];
      if (pageCode) query.push('s=' + encodeURIComponent(pageCode));
      query.push('t=0_0');
      if (requestId) query.push('req=' + encodeURIComponent(requestId));
      var queryString = query.length ? ('?' + query.join('&')) : '';

      if (areaSlug) {
        return 'https://jobs.51job.com/' + areaSlug + '/' + jobId + '.html' + queryString;
      }

      return 'https://jobs.51job.com/all/' + jobId + '.html' + queryString;
    }

    if (card) {
      var linkEl = card.querySelector('a.jname, a.el, a[href*="jobs.51job.com"]');
      if (linkEl) {
        var href = linkEl.getAttribute('href') || linkEl.href;
        if (href && href.indexOf('jobs.51job.com') > -1) {
          return href;
        }
      }
    }

    return '';
  }

  function parseSensorsData(el) {
    if (!el) return null;
    const raw = el.getAttribute('sensorsdata');
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (error) {
      console.warn('[51jobScraper] sensorsdata 解析失败:', error);
      return null;
    }
  }

  function detectPageState() {
    const bodyText = safeText(document.body).slice(0, 3000);
    const title = document.title || '';

    if (/访问验证|滑动验证|请拖动滑块|通过后即可继续访问网页/.test(bodyText) || /验证页面/.test(title)) {
      return {
        code: 'ANTI_BOT',
        error: '当前页面触发前程无忧访问验证，自动详情抓取会被拦截'
      };
    }

    if (/暂无相关职位|没有找到相关职位|搜索结果为空|换个关键词/.test(bodyText)) {
      return {
        code: 'NO_RESULTS',
        error: '当前搜索页已加载完成，但没有匹配职位'
      };
    }

    if (document.readyState !== 'complete') {
      return {
        code: 'NOT_READY',
        error: '页面尚未完成加载'
      };
    }

    return null;
  }

  // ============ DOM 结构签名校验 ============

  /**
   * 校验 51job 列表页 DOM 结构是否符合预期
   * 当 51job 前端改版导致选择器失效时，主动发现并告警
   *
   * @returns {boolean} true = DOM 结构正常；false = 结构已漂移
   */
  function checkDomSignature() {
    const testItem = document.querySelector('.joblist-item');
    if (!testItem) {
      console.warn('[51job] DOM signature check failed: .joblist-item not found');
      return false;
    }
    const titleEl = testItem.querySelector('.jname');
    if (!titleEl) {
      console.warn('[51job] DOM signature check failed: .jname not found inside .joblist-item');
      return false;
    }
    return true;
  }

  // ============ 搜索列表解析 ============

  /**
   * 从搜索结果页面 DOM 中解析职位列表
   * 选择器: .j_joblist .e 为单个职位卡片
   */
  function parseJobList() {
    const jobs = [];

    // 新版 51job 列表页
    let jobCards = document.querySelectorAll('.joblist-item');

    if (jobCards.length === 0) {
      console.warn('[51jobScraper] 未找到职位卡片，尝试备用选择器');
      jobCards = document.querySelectorAll('.j_joblist .e, .joblist-box .e');
    }

    if (jobCards.length === 0) {
      return jobs;
    }

    jobCards.forEach(card => {
      const job = parseJobCard(card);
      if (job) jobs.push(job);
    });

    console.log(`[51jobScraper] 解析到 ${jobs.length} 个职位`);
    return jobs;
  }

  /**
   * 解析分页信息。
   * 51job 新版搜索页通常会渲染分页组件（常见于 Vant / 自定义 pagination）。
   */
  function parsePaginationInfo() {
    let currentPage = 1;
    let totalPages = 1;

    try {
      const url = new URL(window.location.href);
      const curr = parseInt(url.searchParams.get('curr') || '', 10);
      if (Number.isInteger(curr) && curr >= 1) {
        currentPage = curr;
      }
    } catch { /* ignore */ }

    const activeEl = document.querySelector(
      '.van-pagination__item--active, .active.current, .pagination .active, [aria-current="true"]'
    );
    if (activeEl) {
      const activeNum = parseInt((activeEl.textContent || '').trim(), 10);
      if (Number.isInteger(activeNum) && activeNum >= 1) {
        currentPage = activeNum;
      }
    }

    const pageCandidates = document.querySelectorAll(
      '.van-pagination__item, [class*="pagination"] [class*="item"], [class*="pager"] a, [class*="pager"] span, [class*="pagination"] li'
    );
    const pageNumbers = Array.from(pageCandidates)
      .map((el) => parseInt((el.textContent || '').trim(), 10))
      .filter((value) => Number.isInteger(value) && value >= 1 && value <= 200);

    if (pageNumbers.length > 0) {
      totalPages = Math.max(...pageNumbers);
    }

    if (totalPages < currentPage) {
      totalPages = currentPage;
    }

    return {
      currentPage,
      totalPages,
      hasMore: currentPage < totalPages
    };
  }

  /**
   * 解析单个职位卡片
   */
  function parseJobCard(card) {
    const sensors = parseSensorsData(card.querySelector('[sensorsdata]')) || {};

    const titleEl = card.querySelector('.jname, .jobname, .jname.at, a.el');
    const title = safeText(titleEl) || sensors.jobTitle || '';

    if (!title) return null;

    const jobId = sensors.jobId || '';

    const companyEl = card.querySelector('.cname, .company_name, .cname.at');
    const company = safeText(companyEl);

    const salaryEl = card.querySelector('.sal, .salary');
    const salary = normalizeSalary(safeText(salaryEl) || sensors.jobSalary || '');

    const areaEl = card.querySelector('.area, .d.at, .d');
    const location = safeText(areaEl) || sensors.jobArea || '';

    const education =
      sensors.jobDegree ||
      Array.from(card.querySelectorAll('.dc'))
        .map(safeText)
        .find((text) => /本科|大专|硕士|博士|中专|高中|不限/.test(text)) ||
      '';

    const experience = sensors.jobYear || safeText(card.querySelector('.exp')) || '';

    const tagsContainer = card.querySelector('.tags, .info .t, .joblist-item-tags');
    const keywords = extractTags(tagsContainer);

    const url = jobId ? build51JobDetailUrl(sensors, card) : '';

    return {
      platform: '51job',
      platformJobId: jobId,
      title,
      company,
      location,
      salary,
      experience,
      education,
      keywords,
      description: '',  // 列表页无详情，需单独获取
      url
    };
  }

  // ============ 职位详情解析 ============

  /**
   * 从职位详情页 DOM 中解析完整信息
   * 页面 URL: https://jobs.51job.com/{jobId}.html
   */
  function parseJobDetail() {
    const job = {};

    const pageState = detectPageState();
    if (pageState && pageState.code === 'ANTI_BOT') {
      throw new Error(pageState.error);
    }

    const detailRoot =
      document.querySelector('.tCompanyPage') ||
      document.querySelector('main') ||
      document.body;

    const titleEl = document.querySelector(
      '.job-title, .cn .t .cn_pos, .cn .t h1, .cn .t .jobname, h1, [class*=\"job-title\"], [class*=\"position-title\"]'
    );
    job.title = safeText(titleEl);

    const companyEl = document.querySelector(
      '.company-name, .cn .t .cname a, .cn .t .company_name a, .cn .t .cname, [class*=\"company-name\"], [class*=\"company\"] a'
    );
    job.company = safeText(companyEl);

    const salaryEl = document.querySelector(
      '.salary, .cn .t .ltype, .cn .t .salary, [class*=\"salary\"]'
    );
    job.salary = normalizeSalary(safeText(salaryEl));

    const rootLines = (detailRoot.innerText || '')
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (!job.title && rootLines.length > 0) {
      job.title = rootLines[0];
    }

    if (!job.salary) {
      const salaryLine = rootLines.find((line) => /面议|千|万|元\/天|元\/月|K/i.test(line));
      if (salaryLine) {
        job.salary = normalizeSalary(salaryLine);
      }
    }

    if (!job.company) {
      const companyLine = rootLines.find((line) => {
        if (!line || line === job.title || line === job.salary) return false;
        if (/职位信息|工作职责|任职资格|公司信息/.test(line)) return false;
        if (/市|区|县|镇|经验|本科|大专|硕士|博士|应届|不限/.test(line)) return false;
        return line.length >= 4 && line.length <= 60;
      });
      if (companyLine) {
        job.company = companyLine;
      }
    }

    const infoItems = Array.from(
      document.querySelectorAll('.job-detail-box .tag, .job-tags span, .cn .t .msg')
    )
      .map(safeText)
      .filter(Boolean);
    const detailText = infoItems.join(' | ');
    const parts = detailText.split(/\s*[|·]\s*/).filter(Boolean);
    if (parts.length > 0) job.location = parts.find((text) => /市|区|县|镇|南京|上海|北京|深圳|杭州|广州|成都|武汉/.test(text)) || '';
    if (parts.length > 0) job.experience = parts.find((text) => /年|经验不限|应届/.test(text)) || '';
    if (parts.length > 0) job.education = parts.find((text) => /本科|大专|硕士|博士|中专|高中|不限/.test(text)) || '';

    const descBlocks = Array.from(
      document.querySelectorAll(
        '.job-detail-box__content, .bmsg.job_msg.inbox, .job_detail, .bmsg.inbox, .tCompanyPage section, .tCompanyPage [class*=\"content\"], .tCompanyPage [class*=\"detail\"], article section'
      )
    )
      .map(safeText)
      .filter(Boolean)
      .filter((text, index, arr) => arr.indexOf(text) === index)
      .filter((text) => text.length >= 20);

    if (descBlocks.length > 0) {
      job.description = descBlocks.join('\n\n');
    } else {
      const detailText = safeText(detailRoot);
      const sectionMatch = detailText.match(/(职位信息[\s\S]*|工作职责[\s\S]*|任职资格[\s\S]*|公司信息[\s\S]*)/);
      job.description = sectionMatch ? sectionMatch[1].trim() : '';
    }

    // 从 URL 提取 jobId
    job.platformJobId = extractJobId(window.location.href);
    job.url = window.location.href;
    job.platform = '51job';

    // 标签（详情页可能也有）
    const tagsEl = document.querySelector('.jtag .s_tag') ||
                   document.querySelector('.cn .t .tags');
    if (tagsEl) {
      job.keywords = extractTags(tagsEl);
    }

    console.log(`[51jobScraper] 解析详情: ${job.title} @ ${job.company}`);
    return job;
  }

  // ============ 消息通信 ============

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log('[51jobScraper] 收到消息:', request.type);

    switch (request.type) {
      case 'SCRAPE_JOBS':
        handleScrapeJobs(request, sendResponse);
        break;

      case 'GET_JOB_DETAIL':
        handleGetJobDetail(request, sendResponse);
        break;

      case 'CHECK_STATUS':
        handleCheckStatus(sendResponse);
        break;

      case 'NAVIGATE_TO_PAGE':
        handleNavigateToPage(request, sendResponse);
        break;

      case 'OPEN_JOB_DETAIL_FROM_LIST':
        handleOpenJobDetailFromList(request, sendResponse);
        break;

      case 'WAIT_FOR_JOB_LIST_READY':
        handleWaitForJobListReady(request, sendResponse);
        break;

      default:
        sendResponse({ success: false, error: '未知消息类型' });
    }

    return true; // 保持异步通道
  });

  /**
   * 处理职位列表采集请求
   * 51job 通过 DOM 解析当前页面，无需额外请求
   */
  function handleScrapeJobs(request, sendResponse) {
    try {
      const pagination = parsePaginationInfo();

      // DOM 结构签名校验：检测 51job 前端改版导致选择器失效
      if (!checkDomSignature()) {
        console.error('[51jobScraper] DOM 结构签名校验失败，列表页可能已改版');
        sendResponse({
          success: false,
          error: 'DOM 结构签名校验失败：.joblist-item 或 .jname 选择器未命中，页面可能已改版',
          code: 'DOM_STRUCTURE_DRIFT',
          detailErrorCode: 'dom_structure_drift'
        });
        return;
      }

      const rawJobs = parseJobList();

      if (rawJobs.length === 0) {
        const pageState = detectPageState();
        sendResponse({
          success: false,
          error: pageState ? pageState.error : '页面中未找到职位数据，可能页面尚未加载完成或页面结构已变更',
          code: pageState ? pageState.code : 'NO_DATA'
        });
        return;
      }

      // 归一化处理，过滤掉必填字段缺失的数据
      const jobs = rawJobs
        .map(job => normalizeJob(job))
        .filter(job => job !== null);

      if (jobs.length === 0) {
        sendResponse({
          success: false,
          error: '所有职位数据缺少必填字段（title/company），已全部过滤',
          code: 'NO_VALID_DATA'
        });
        return;
      }

      console.log(`[51jobScraper] 归一化完成: ${rawJobs.length} → ${jobs.length} 条有效数据`);

      // 51job 列表页只提供详情入口，详情正文通过后续补抓回填
      const jobsWithDetailStatus = jobs.map(function(job) {
        return Object.assign({}, job, {
          detailStatus: job.url ? 'pending' : 'list_only',
          detailErrorCode: job.url ? '' : 'missing_detail_url'
        });
      });

      sendResponse({
        success: true,
        data: jobsWithDetailStatus,
        totalCount: jobsWithDetailStatus.length,
        hasMore: pagination.hasMore,
        pagination
      });

    } catch (error) {
      console.error('[51jobScraper] 列表采集异常:', error);
      sendResponse({ success: false, error: error.message });
    }
  }

  /**
   * 处理职位详情采集请求
   * 51job 直接解析当前页面 DOM
   */
  function handleGetJobDetail(request, sendResponse) {
    try {
      const rawJob = parseJobDetail();

      if (!rawJob.title) {
        sendResponse({
          success: false,
          error: '页面中未找到职位详情，可能页面尚未加载完成',
          code: 'NO_DATA'
        });
        return;
      }

      // 归一化处理
      const job = normalizeJob(rawJob);

      if (!job) {
        sendResponse({
          success: false,
          error: '职位详情缺少必填字段（title/company）',
          code: 'NO_VALID_DATA'
        });
        return;
      }

      sendResponse({
        success: true,
        data: job
      });

    } catch (error) {
      console.error('[51jobScraper] 详情采集异常:', error);
      sendResponse({
        success: false,
        error: error.message,
        code: error && error.message && error.message.indexOf('访问验证') > -1
          ? 'ANTI_BOT'
          : 'DETAIL_PARSE_ERROR'
      });
    }
  }

  /**
   * 检查 content script 状态
   */
  function handleCheckStatus(sendResponse) {
    sendResponse({
      success: true,
      platform: '51job',
      ready: true,
      url: window.location.href,
      isSearchPage: window.location.hostname === 'search.51job.com' || window.location.hostname === 'we.51job.com',
      isDetailPage: window.location.hostname === 'jobs.51job.com'
    });
  }

  /**
   * 等待职位列表渲染完成（业务级就绪判定）
   * SPA 页面壳 ready 不等于职位列表 ready，必须轮询到 .joblist-item 出现且字段可读
   *
   * 就绪条件：
   *   1. .joblist-item 数量 > 0
   *   2. 第一个卡片内 .jname 文本非空
   *
   * @param {Object} request - { timeoutMs?: number } 默认 15000ms
   */
  async function handleWaitForJobListReady(request, sendResponse) {
    var timeoutMs = request.timeoutMs || 15000;
    var started = Date.now();

    function check() {
      var cards = document.querySelectorAll('.joblist-item');
      if (cards.length > 0) {
        var firstName = cards[0].querySelector('.jname, .jobname, .jname.at');
        if (firstName && safeText(firstName)) {
          return { ready: true, count: cards.length };
        }
      }
      return null;
    }

    var result = check();
    if (result) {
      console.log('[51jobScraper] 职位列表已就绪: ' + result.count + ' 条');
      sendResponse({ success: true, ready: true, count: result.count });
      return;
    }

    // 轮询等待
    var interval = 500;
    function poll() {
      if (Date.now() - started > timeoutMs) {
        console.warn('[51jobScraper] 职位列表等待超时 (' + timeoutMs + 'ms)');
        sendResponse({ success: false, ready: false, error: '职位列表渲染超时' });
        return;
      }
      var r = check();
      if (r) {
        console.log('[51jobScraper] 职位列表就绪 (轮询): ' + r.count + ' 条, 耗时 ' + (Date.now() - started) + 'ms');
        sendResponse({ success: true, ready: true, count: r.count });
        return;
      }
      setTimeout(poll, interval);
    }
    setTimeout(poll, interval);
  }

  function parseSensorsDataFromNode(node) {
    if (!node) return null;
    try {
      return JSON.parse(node.getAttribute('sensorsdata') || 'null');
    } catch {
      return null;
    }
  }

  function handleOpenJobDetailFromList(request, sendResponse) {
    const targetJobId = String(request.jobId || '').trim();
    if (!targetJobId) {
      sendResponse({ success: false, error: 'Missing jobId' });
      return;
    }

    const cards = Array.from(document.querySelectorAll('.joblist-item'));
    const card = cards.find((item) => {
      const sensorsNode = item.querySelector('[sensorsdata]');
      const sensors = parseSensorsDataFromNode(sensorsNode);
      return sensors && String(sensors.jobId || '') === targetJobId;
    });

    if (!card) {
      sendResponse({ success: false, error: `Job card not found for ${targetJobId}` });
      return;
    }

    const sensorsNode = card.querySelector('[sensorsdata]');
    const sensors = parseSensorsDataFromNode(sensorsNode);
    const detailUrl = build51JobDetailUrl(sensors, card);
    const titleText = (
      card.querySelector('.joblist-item-jobname, .jname, .jobname')?.textContent || ''
    ).trim();

    if (!detailUrl) {
      sendResponse({ success: false, error: `Detail URL not found for ${targetJobId}` });
      return;
    }

    console.log(`[51jobScraper] OPEN_JOB_DETAIL_FROM_LIST: jobId=${targetJobId}, title="${titleText}", url=${detailUrl}`);
    window.open(detailUrl, '_blank', 'noopener');
    sendResponse({ success: true, jobId: targetJobId, title: titleText, url: detailUrl });
  }

  /**
   * 处理页内点击翻页请求（SPA 模式）
   * 找到目标页码按钮并点击，等待 DOM 更新确认翻页成功
   */
  async function handleNavigateToPage(request, sendResponse) {
    const targetPage = request.page;
    console.log(`[51jobScraper] NAVIGATE_TO_PAGE: 目标页码 ${targetPage}`);

    const paginationRoot = document.querySelector('.el-pagination, .jpag, .jpages, [class*="pagination"], [class*="pager"]');
    if (!paginationRoot) {
      sendResponse({ success: false, error: 'Pagination root not found' });
      return;
    }

    const activePageEl = paginationRoot.querySelector('.el-pager .number.active, .number.active, [aria-current="true"]');
    const currentPage = Number((activePageEl?.textContent || '').trim()) || 1;

    // 51job 当前站点分页是真实的 li.number / button.btn-next，不是 a 标签
    const directPageBtn = Array.from(
      paginationRoot.querySelectorAll('.el-pager .number, .number, [data-page], .van-pagination__item, [class*="item"]')
    ).find((btn) => (btn.textContent || '').trim() === String(targetPage));

    let clicked = false;

    if (directPageBtn) {
      directPageBtn.click();
      clicked = true;
      console.log(`[51jobScraper] 已点击页码按钮: current=${currentPage} target=${targetPage}`);
    } else if (targetPage === currentPage + 1) {
      const nextBtn = paginationRoot.querySelector('.btn-next:not([disabled]), .el-pagination button.btn-next:not([disabled]), [class*="next"]:not([disabled])');
      if (nextBtn) {
        nextBtn.click();
        clicked = true;
        console.log(`[51jobScraper] 已点击下一页按钮: current=${currentPage} target=${targetPage}`);
      }
    } else if (targetPage === currentPage - 1) {
      const prevBtn = paginationRoot.querySelector('.btn-prev:not([disabled]), .el-pagination button.btn-prev:not([disabled]), [class*="prev"]:not([disabled])');
      if (prevBtn) {
        prevBtn.click();
        clicked = true;
        console.log(`[51jobScraper] 已点击上一页按钮: current=${currentPage} target=${targetPage}`);
      }
    }

    if (!clicked) {
      console.warn(`[51jobScraper] 未找到页码 ${targetPage} 的按钮 (current=${currentPage})`);
      sendResponse({ success: false, error: `Page ${targetPage} button not found (current=${currentPage})` });
      return;
    }

    // 等待 SPA 状态更新
    const updated = await waitForPageChange(targetPage, 10000);
    console.log(`[51jobScraper] 翻页${updated ? '成功' : '超时'}: p${targetPage}`);
    sendResponse({ success: updated, page: targetPage });
  }

  /**
   * 等待 SPA 翻页生效
   * 检查 sensorsdata.pageNum 或活跃分页按钮确认页码已切换
   *
   * @param {number} expectedPage - 期望的页码
   * @param {number} maxWaitMs - 最大等待毫秒数
   * @returns {Promise<boolean>} 是否在超时前确认翻页成功
   */
  function waitForPageChange(expectedPage, maxWaitMs = 10000) {
    return new Promise(resolve => {
      const start = Date.now();
      const check = () => {
        // 策略1: 检查 sensorsdata.pageNum
        const cards = document.querySelectorAll('.joblist-item, [sensorsdata]');
        for (const card of cards) {
          const sd = card.getAttribute('sensorsdata');
          if (sd) {
            try {
              const data = JSON.parse(sd);
              if (data.pageNum == expectedPage) {
                resolve(true);
                return;
              }
            } catch (e) { /* 忽略解析失败 */ }
          }
        }

        // 策略2: 检查 DOM 中 active 分页按钮
        const activeBtn = document.querySelector(
          '.van-pagination__item--active, .active.current, [aria-current="true"], .jpages a.active'
        );
        if (activeBtn) {
          const num = parseInt((activeBtn.textContent || '').trim(), 10);
          if (num === expectedPage) {
            resolve(true);
            return;
          }
        }

        // 超时检查
        if (Date.now() - start > maxWaitMs) {
          resolve(false);
          return;
        }
        setTimeout(check, 500);
      };
      setTimeout(check, 500);
    });
  }

})();
