/**
 * Service Worker - 后台调度中心
 */

// ============ 配置 ============
const FEISHU_CONFIG = {
  appId: 'your_app_id',
  appSecret: 'your_app_secret',
  appToken: 'your_app_token',
  tableId: 'your_table_id'
};

const ALERTS_CONFIG = {
  // 默认不再把系统告警写回岗位主表，避免污染采集结果视图。
  writeAlertsToMainTable: false
};

// 选项字典缓存配置
const OPTION_CACHE_KEY = 'feishu_option_dict';
const OPTION_CACHE_TTL = 24 * 60 * 60 * 1000; // 24小时
const SEEN_JOB_IDS_KEY = 'seen_job_ids';
const RUNTIME_CONFIG_KEY = 'runtime_config';
const PIPELINE_VERSION = 'pm-full-coverage-v1';
const CODE_VERSION = `crawler-extension-v${chrome.runtime.getManifest().version}-20260321-p6-qfix`;

const CONFIG = {
  // 【最小验证模式】1城市 × 1关键词 × 1条
  // 验证通过后恢复：CITIES=北京/上海/杭州/深圳，KEYWORDS=4个
  CITIES: [
    { code: '101010100', name: '北京' },
    { code: '101020100', name: '上海' },
    { code: '101210100', name: '杭州' },
    { code: '101280600', name: '深圳' }
  ],
  KEYWORDS: [
    'AI产品经理',
    '人工智能产品经理',
    '机器人产品经理',
    '大模型产品经理'
  ],
  MAX_JOBS_PER_CITY: 3,  // 每个城市最多采集3条（降低频率防反爬）
  
  // 经验要求代码：101=应届生, 102=1-3年, 103=3-5年, 104=5-10年, 105=10年以上
  EXPERIENCE: '102',  // 默认1-3年
  JOB_FILTER_MODE: 'general_pm',
  MAX_LIST_PAGES_PER_RUN: 3,
  
  // 反爬自适应策略配置
  ANTI_CRAWL: {
    MAX_CONSECUTIVE_FAILURES: 2,  // 连续失败2次触发冷却
    COOLDOWN_TIME: 30000,         // 冷却时间30秒
    BASE_DELAY: 8000,             // 基础延迟8秒（增加以降低搜索频率）
    MAX_DELAY: 20000,             // 最大延迟20秒
    DELAY_INCREMENT: 5000,        // 每次增加5秒
    ANTI_CRAWL_CODES: [35, 37]    // 反爬错误码
  },

  // 任务来源模式（P1新增）
  // hybrid: 优先控制面，不可达时回退内置队列（旧默认行为）
  // controller_only: 仅从控制面获取任务，不可达时不执行
  // internal_only: 仅使用内置队列，忽略控制面
  TASK_SOURCE_MODE: 'controller_only',  // 验收/生产环境默认

  // 扩展刷新后是否自动拉起采集（默认关闭，由 Dashboard 手动触发）
  ENABLE_AUTO_BOOTSTRAP: false,

  // 规则过滤配置
  FILTER: {
    // 硬排除：明确的校招/实习性质词汇
    TITLE_HARD_EXCLUDE: /校招|管培|校园招聘|毕业生|秋招|春招/i,
    // 经验排除：只硬排除明显过高年限；5-10年保留给 general_pm 覆盖
    // 注：在校/应届也改为软排除，让其他条件好的岗位有机会通过
    EXP_HARD_EXCLUDE: /10年以上/i,
    // 方向加分词（标题包含任一则加分）
    AI_DIRECTION_KEYWORDS: [
      'AI', '人工智能', 'AIGC', '大模型', 'LLM', '机器人', '具身智能',
      '自动化', '智能体', '自动驾驶', 'NLP', '计算机视觉',
      '机器学习', '深度学习', '多模态', '知识图谱'
    ],
    GENERAL_PM_INCLUDE: /产品经理|product manager|\bpm\b/i,
    // 最低通过分数（低于此分数的岗位被过滤）
    // 设为-2让条件较好的在校/应届岗有机会通过（如AI产品经理：+2+2-5=-1）
    MIN_SCORE: -2
  },

  // 批次调度配置
  BATCH: {
    MAX_DETAIL_REQUESTS_PER_RUN: 3  // 单次任务最多获取3条详情
  },

  // P4: 控制面地址配置（可通过环境变量或手动修改）
  CONTROLLER_BASE_URL: 'http://127.0.0.1:7893',

  // Alarm 调度配置
  // fixed: 每天固定时间触发
  // interval: 固定分钟间隔轮询，适合联调和无人值守验证
  ALARM_MODE: 'interval',
  ALARM_INTERVAL_MINUTES: 1,
  ALARM_BOOTSTRAP_DELAY_MINUTES: 1,
  IDLE_POLL_INTERVAL_MINUTES: 5
};

const RUNTIME_CONFIG_DEFAULTS = {
  EXPERIENCE: '',
  JOB_FILTER_MODE: CONFIG.JOB_FILTER_MODE,
  MAX_LIST_PAGES_PER_RUN: 0,
  MAX_LIST_PAGE_SIZE: 30,
  MAX_DETAIL_REQUESTS_PER_RUN: 0,
  EXP_HARD_EXCLUDE_SOURCE: '',
  deliveryEnabled: false,
  // 智联列表分页参数（可通过 runtime_config / popup 配置面板调整）
  MAX_LIST_PAGES: 1,              // 单次任务最多翻 N 页（默认 1，即只抓 p1）
  DETAIL_BUDGET_PER_RUN: 3,       // 单次任务详情预算
  DETAIL_REQUEST_INTERVAL_MS: 3000 // 详情请求间隔（毫秒）
};

const MANUAL_ALARM_PAUSE_MS = 10 * 60 * 1000;

// ============ 主服务 ============
class JobHunterService {
  constructor() {
    this.isRunning = false;
    // 反爬状态追踪
    this.consecutiveFailures = 0;  // 连续失败次数
    this.currentDelay = CONFIG.ANTI_CRAWL.BASE_DELAY;  // 当前动态延迟
    this.isCooldown = false;       // 是否处于冷却期
    // 本次采集统计
    this.runStats = this.createEmptyRunStats();
    this.manualAlarmPauseUntil = 0;
    this.manualVerification = {
      required: false,
      platform: null,
      platformLabel: '',
      message: '',
      validationTabId: null,
      requestedAt: null
    };
    this.manualVerificationResolver = null;
    this._51jobAreaCatalogPromise = null;
    this.activeCrawlSession = this.createEmptyCrawlSession();
    // 反爬状态机（持久化）
    this.crawlState = {
      status: 'normal',           // normal | cooldown_1h | cooldown_4h | blocked_today
      blockedUntil: null,         // 统一字段：冷却/封禁截止时间戳
      consecutiveBatchFailures: 0, // 连续批次失败次数
      lastAntiCrawlTime: null,    // 上次触发反爬的时间
      source: null                // 当前采集来源: 'manual' | 'auto' | null
    };
    // 队列长度历史（用于检测堆积）- 从 storage 加载或初始化为空
    this.queueLengthHistory = [];
    this.runtimeConfig = { ...RUNTIME_CONFIG_DEFAULTS };
    // 初始化完成标志（防止竞态）
    this.initPromise = null;
    this.init();
    // 从storage加载（串行执行，避免竞态）
    this.initPromise = this.runInitializers();
  }

  // 串行执行所有初始化，确保加载完成后再接受任务
  async runInitializers() {
    await this.loadStats();
    await this.loadCrawlState();
    await this.loadRuntimeConfig();
    await this.loadQueueLengthHistory();  // 加载队列长度历史（带时效清理）
    await this.initPendingQueue();
    console.log('[JobHunter] All initializers completed');
  }

  createEmptyRunStats() {
    return {
      totalJobs: 0,
      successWithDesc: 0,
      cardApiUsed: 0,
      detailApiUsed: 0,
      failCount: 0,
      filteredCount: 0,
      listCount: 0,
      missingEncryptJobIdCount: 0,
      detailSkippedSeenCount: 0,
      detailRequestedCount: 0,
      detailSuccessCount: 0,
      detailDescriptionNonEmptyCount: 0,
      pagedListCount: 0,
      pagesFetched: 0
    };
  }

  createEmptyCrawlSession() {
    return {
      isActive: false,
      platform: null,
      crawlBatchId: null,
      keyword: '',
      city: '',
      groupSize: 20,
      startedAt: null,
      endedAt: null
    };
  }

  setActiveCrawlSession(nextState = {}) {
    this.activeCrawlSession = {
      ...this.activeCrawlSession,
      ...nextState
    };
  }

  clearActiveCrawlSession() {
    this.activeCrawlSession = this.createEmptyCrawlSession();
  }

  getVersionInfo() {
    return {
      codeVersion: CODE_VERSION,
      pipelineVersion: PIPELINE_VERSION,
      jobFilterMode: this.getJobFilterMode(),
      maxListPagesPerRun: this.getMaxListPagesPerRun(),
      maxListPageSize: this.getMaxListPageSize()
    };
  }

  sanitizeRuntimeConfig(config = {}) {
    const next = { ...RUNTIME_CONFIG_DEFAULTS };

    if (['ai_focused', 'general_pm'].includes(config.JOB_FILTER_MODE)) {
      next.JOB_FILTER_MODE = config.JOB_FILTER_MODE;
    }

    if (typeof config.EXPERIENCE === 'string') {
      next.EXPERIENCE = config.EXPERIENCE.trim();
    }

    const maxPages = Number(config.MAX_LIST_PAGES_PER_RUN);
    if (Number.isInteger(maxPages) && maxPages >= 0) {
      next.MAX_LIST_PAGES_PER_RUN = maxPages;
    }

    const maxPageSize = Number(config.MAX_LIST_PAGE_SIZE);
    if (Number.isInteger(maxPageSize) && maxPageSize >= 1 && maxPageSize <= 30) {
      next.MAX_LIST_PAGE_SIZE = maxPageSize;
    }

    const maxDetails = Number(config.MAX_DETAIL_REQUESTS_PER_RUN);
    if (Number.isInteger(maxDetails) && maxDetails >= 0) {
      next.MAX_DETAIL_REQUESTS_PER_RUN = maxDetails;
    }

    if (typeof config.EXP_HARD_EXCLUDE_SOURCE === 'string') {
      next.EXP_HARD_EXCLUDE_SOURCE = config.EXP_HARD_EXCLUDE_SOURCE.trim();
    }

    if (typeof config.deliveryEnabled === 'boolean') {
      next.deliveryEnabled = config.deliveryEnabled;
    }

    // 智联列表分页参数
    const maxListPages = Number(config.MAX_LIST_PAGES);
    if (Number.isInteger(maxListPages) && maxListPages >= 1) {
      next.MAX_LIST_PAGES = maxListPages;
    }

    const detailBudget = Number(config.DETAIL_BUDGET_PER_RUN);
    if (Number.isInteger(detailBudget) && detailBudget >= 0) {
      next.DETAIL_BUDGET_PER_RUN = detailBudget;
    }

    const detailInterval = Number(config.DETAIL_REQUEST_INTERVAL_MS);
    if (Number.isInteger(detailInterval) && detailInterval >= 500) {
      next.DETAIL_REQUEST_INTERVAL_MS = detailInterval;
    }

    return next;
  }

  async loadRuntimeConfig() {
    try {
      const saved = await chrome.storage.local.get(RUNTIME_CONFIG_KEY);
      this.runtimeConfig = this.sanitizeRuntimeConfig(saved[RUNTIME_CONFIG_KEY] || {});
      await this.syncRuntimeConfigFromController();
      await chrome.storage.local.set({ [RUNTIME_CONFIG_KEY]: this.runtimeConfig });
    } catch (error) {
      console.warn('[JobHunter] Failed to load runtime config, using defaults:', error.message);
      this.runtimeConfig = { ...RUNTIME_CONFIG_DEFAULTS };
    }
  }

  async updateRuntimeConfig(nextConfig = {}) {
    this.runtimeConfig = this.sanitizeRuntimeConfig(nextConfig);
    await chrome.storage.local.set({ [RUNTIME_CONFIG_KEY]: this.runtimeConfig });
    await this.pushRuntimeConfigToController();
    console.log('[JobHunter] Runtime config updated:', JSON.stringify(this.runtimeConfig));
    return this.runtimeConfig;
  }

  getRuntimeConfig() {
    return { ...this.runtimeConfig };
  }

  getJobFilterMode() {
    return this.runtimeConfig.JOB_FILTER_MODE || RUNTIME_CONFIG_DEFAULTS.JOB_FILTER_MODE;
  }

  getMaxListPagesPerRun() {
    return Number.isInteger(this.runtimeConfig.MAX_LIST_PAGES_PER_RUN)
      ? this.runtimeConfig.MAX_LIST_PAGES_PER_RUN
      : RUNTIME_CONFIG_DEFAULTS.MAX_LIST_PAGES_PER_RUN;
  }

  getMaxListPageSize() {
    return this.runtimeConfig.MAX_LIST_PAGE_SIZE || RUNTIME_CONFIG_DEFAULTS.MAX_LIST_PAGE_SIZE;
  }

  getMaxDetailRequestsPerRun() {
    return Number.isInteger(this.runtimeConfig.MAX_DETAIL_REQUESTS_PER_RUN)
      ? this.runtimeConfig.MAX_DETAIL_REQUESTS_PER_RUN
      : RUNTIME_CONFIG_DEFAULTS.MAX_DETAIL_REQUESTS_PER_RUN;
  }

  // 智联分页配置访问器
  getMaxListPages() {
    return Number.isInteger(this.runtimeConfig.MAX_LIST_PAGES) && this.runtimeConfig.MAX_LIST_PAGES >= 1
      ? this.runtimeConfig.MAX_LIST_PAGES
      : RUNTIME_CONFIG_DEFAULTS.MAX_LIST_PAGES;
  }

  getDetailBudgetPerRun() {
    return Number.isInteger(this.runtimeConfig.DETAIL_BUDGET_PER_RUN) && this.runtimeConfig.DETAIL_BUDGET_PER_RUN >= 0
      ? this.runtimeConfig.DETAIL_BUDGET_PER_RUN
      : RUNTIME_CONFIG_DEFAULTS.DETAIL_BUDGET_PER_RUN;
  }

  getDetailRequestIntervalMs() {
    return Number.isInteger(this.runtimeConfig.DETAIL_REQUEST_INTERVAL_MS) && this.runtimeConfig.DETAIL_REQUEST_INTERVAL_MS >= 500
      ? this.runtimeConfig.DETAIL_REQUEST_INTERVAL_MS
      : RUNTIME_CONFIG_DEFAULTS.DETAIL_REQUEST_INTERVAL_MS;
  }

  getExperienceCode() {
    return typeof this.runtimeConfig.EXPERIENCE === 'string'
      ? this.runtimeConfig.EXPERIENCE
      : RUNTIME_CONFIG_DEFAULTS.EXPERIENCE;
  }

  isControllerDeliveryEnabled() {
    return Boolean(this.runtimeConfig.deliveryEnabled);
  }

  getExpHardExcludeRegex() {
    const source = typeof this.runtimeConfig.EXP_HARD_EXCLUDE_SOURCE === 'string'
      ? this.runtimeConfig.EXP_HARD_EXCLUDE_SOURCE
      : RUNTIME_CONFIG_DEFAULTS.EXP_HARD_EXCLUDE_SOURCE;
    return source ? new RegExp(source, 'i') : null;
  }

  async syncRuntimeConfigFromController() {
    try {
      const response = await fetch(`${CONFIG.CONTROLLER_BASE_URL}/runtime-config`);
      if (!response.ok) return false;
      const payload = await response.json();
      if (!payload.success || !payload.runtimeConfig) return false;
      this.runtimeConfig = this.sanitizeRuntimeConfig(payload.runtimeConfig);
      console.log('[JobHunter] Runtime config synced from controller:', JSON.stringify(this.runtimeConfig));
      return true;
    } catch (error) {
      console.warn('[JobHunter] Runtime config sync skipped:', error.message);
      return false;
    }
  }

  async pushRuntimeConfigToController() {
    try {
      const response = await fetch(`${CONFIG.CONTROLLER_BASE_URL}/runtime-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.runtimeConfig)
      });
      if (!response.ok) {
        console.warn(`[JobHunter] Failed to persist runtime config to controller: ${response.status}`);
        return false;
      }
      return true;
    } catch (error) {
      console.warn('[JobHunter] Runtime config persist skipped:', error.message);
      return false;
    }
  }

  init() {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      this.onMessage(request, sender, sendResponse);
      return true;
    });

    chrome.runtime.onInstalled.addListener(() => {
      this.restoreAlarms();
    });

    chrome.runtime.onStartup.addListener(() => {
      this.restoreAlarms();
    });
    
    // 初始化 alarms
    this.restoreAlarms();
    
    // 监听 alarm 触发
    chrome.alarms.onAlarm.addListener((alarm) => {
      this.onAlarm(alarm);
    });
    
    console.log(
      `[JobHunter] Service initialized | CODE_VERSION=${CODE_VERSION} | PIPELINE_VERSION=${PIPELINE_VERSION} | JOB_FILTER_MODE=${this.getJobFilterMode()} | MAX_LIST_PAGES_PER_RUN=${this.getMaxListPagesPerRun()} | MAX_LIST_PAGE_SIZE=${this.getMaxListPageSize()}`
    );
  }

  // Alarm 触发处理
  async onAlarm(alarm) {
    if (!alarm.name.startsWith('crawl_')) return;

    console.log(`[JobHunter] Alarm triggered: ${alarm.name}`);

    if (Date.now() < this.manualAlarmPauseUntil) {
      const remainingMinutes = Math.ceil((this.manualAlarmPauseUntil - Date.now()) / 60000);
      console.log(`[JobHunter] Alarm ${alarm.name} skipped due to recent manual run (${remainingMinutes}min remaining)`);
      return;
    }

    // 检查 crawl_state
    const blockCheck = await this.checkBlocked();
    if (blockCheck.blocked) {
      console.log(`[JobHunter] Alarm ${alarm.name} skipped, status: ${this.crawlState.status}`);
      if (CONFIG.ALARM_MODE !== 'interval' && alarm.name !== 'crawl_bootstrap') {
        await this.reregisterAlarm(alarm.name);
      }
      return;
    }

    // 执行采集任务
    try {
      await this.executeCrawlTask();
    } catch (error) {
      console.error(`[JobHunter] Alarm task error:`, error);
    }

    // interval 模式的周期 alarm 会自动重复；bootstrap 只执行一次
    if (CONFIG.ALARM_MODE !== 'interval' && alarm.name !== 'crawl_bootstrap') {
      await this.reregisterAlarm(alarm.name);
    }
  }

  async enterIdlePolling(reason = 'idle') {
    await chrome.alarms.clearAll();
    const idleMinutes = Math.max(1, CONFIG.IDLE_POLL_INTERVAL_MINUTES);
    chrome.alarms.create('crawl_bootstrap', {
      delayInMinutes: idleMinutes
    });
    console.log(`[JobHunter] Enter idle polling (${reason}), next wake in ${idleMinutes}min`);
  }

  // 恢复/注册 alarms
  async restoreAlarms() {
    await chrome.alarms.clearAll();

    if (CONFIG.TASK_SOURCE_MODE === 'controller_only') {
      if (!CONFIG.ENABLE_AUTO_BOOTSTRAP) {
        console.log('[JobHunter] auto bootstrap disabled, skip crawl_bootstrap alarm');
        return;
      }
      chrome.alarms.create('crawl_bootstrap', {
        delayInMinutes: Math.max(1, CONFIG.ALARM_BOOTSTRAP_DELAY_MINUTES)
      });
      console.log(`[JobHunter] controller_only bootstrap scheduled in ${Math.max(1, CONFIG.ALARM_BOOTSTRAP_DELAY_MINUTES)}min`);
      const alarms = await chrome.alarms.getAll();
      console.log('[JobHunter] Alarms restored:', alarms.map(alarm => ({
        name: alarm.name,
        scheduledTime: alarm.scheduledTime ? new Date(alarm.scheduledTime).toISOString() : null,
        periodInMinutes: alarm.periodInMinutes || null
      })));
      return;
    }

    const alarmNames = ['crawl_morning', 'crawl_afternoon', 'crawl_evening', 'crawl_retry'];
    for (const name of alarmNames) {
      await this.reregisterAlarm(name);
    }

    if (CONFIG.ALARM_MODE === 'interval') {
      chrome.alarms.create('crawl_bootstrap', {
        delayInMinutes: Math.max(1, CONFIG.ALARM_BOOTSTRAP_DELAY_MINUTES)
      });
      console.log(`[JobHunter] Alarm crawl_bootstrap scheduled in ${Math.max(1, CONFIG.ALARM_BOOTSTRAP_DELAY_MINUTES)}min`);
    }

    const alarms = await chrome.alarms.getAll();
    console.log('[JobHunter] Alarms restored:', alarms.map(alarm => ({
      name: alarm.name,
      scheduledTime: alarm.scheduledTime ? new Date(alarm.scheduledTime).toISOString() : null,
      periodInMinutes: alarm.periodInMinutes || null
    })));
  }

  // 注册/重新注册 alarm
  async reregisterAlarm(alarmName) {
    await chrome.alarms.clear(alarmName);

    if (CONFIG.ALARM_MODE === 'interval') {
      const intervalMinutes = Math.max(1, CONFIG.ALARM_INTERVAL_MINUTES);
      chrome.alarms.create(alarmName, {
        delayInMinutes: intervalMinutes,
        periodInMinutes: intervalMinutes
      });
      console.log(`[JobHunter] Alarm ${alarmName} interval mode, every ${intervalMinutes}min`);
      return;
    }

    const schedule = {
      crawl_morning: { hour: 9 },
      crawl_afternoon: { hour: 13 },
      crawl_evening: { hour: 17 },
      crawl_retry: { hour: 21 }
    };

    const config = schedule[alarmName];
    if (!config) {
      console.warn(`[JobHunter] Unknown alarm ignored: ${alarmName}`);
      return;
    }

    const now = new Date();
    const target = new Date(now);
    target.setHours(config.hour, 0, 0, 0);

    if (target <= now) {
      target.setDate(target.getDate() + 1);
    }

    chrome.alarms.create(alarmName, { when: target.getTime() });
    console.log(`[JobHunter] Alarm ${alarmName} scheduled at ${target.toISOString()}`);
  }

  async onMessage(request, sender, sendResponse) {
    console.log('[JobHunter] Received:', request.type);
    
    try {
      switch (request.type) {
        case 'START_CRAWL':
          if (this.isRunning) {
            sendResponse({ success: false, error: 'Already running' });
            return;
          }
          // 记录 dashboard 传入的参数（当前采集由队列驱动，payload 仅供参考）
          if (request.payload) {
            console.log('[JobHunter] Dashboard payload:', request.payload);
          }
          // 根据请求的平台选择采集流程（Dashboard 通过 payload.platform 传入）
          const requestPlatform = request.payload?.platform || request.platform || 'boss';
          if (requestPlatform === 'all') {
            // 全平台串行采集：boss → 51job → liepin → zhaopin（依次执行，汇总结果）
            const ALL_PLATFORMS = ['boss', '51job', 'liepin', 'zhaopin'];
            // 平台显示名称映射
            const PLATFORM_LABELS = {
              boss: 'Boss直聘', '51job': '前程无忧', liepin: '猎聘', zhaopin: '智联招聘'
            };
            console.log('[JobHunter] 启动全平台串行采集:', ALL_PLATFORMS.map(p => PLATFORM_LABELS[p] || p));
            this.isRunning = true;
            this.crawlState.status = 'running';

            const byPlatform = {};
            let totalJobs = 0;
            let totalWithDesc = 0;
            const errors = [];
            let stoppedEarly = false;

            for (const platform of ALL_PLATFORMS) {
              // 每轮开始前检查停止标志
              if (!this.isRunning) {
                console.log(`[JobHunter] 全平台采集被用户停止，跳过剩余平台（已完成: ${Object.keys(byPlatform).join(', ')}）`);
                stoppedEarly = true;
                break;
              }
              const label = PLATFORM_LABELS[platform] || platform;
              console.log(`[JobHunter] [全平台 ${Object.keys(byPlatform).length + 1}/${ALL_PLATFORMS.length}] 开始采集: ${label} (${platform})`);
              try {
                let result;
                if (platform === 'boss') {
                  // boss 走原有 executeCrawlTask 逻辑（内部会设 isRunning=false）
                  result = await this.executeCrawlTask(null);
                } else if (platform === '51job') {
                  this.isRunning = true; // 重新启用，供下一轮循环检查
                  result = await this.execute51JobCrawl();
                } else if (platform === 'liepin') {
                  this.isRunning = true;
                  // 猎聘尚未实现采集器，跳过并记录
                  console.warn(`[JobHunter] ${label} 采集器尚未实现，跳过`);
                  byPlatform[platform] = { total: 0, withDescription: 0, skipped: true, reason: 'not_implemented' };
                  continue;
                } else if (platform === 'zhaopin') {
                  this.isRunning = true;
                  result = await this.executeZhaopinCrawl();
                }

                const platformTotal = result?.success ? (result.totalJobs ?? result.total ?? 0) : 0;
                const platformWithDesc = result?.withDescription ?? 0;
                byPlatform[platform] = { total: platformTotal, withDescription: platformWithDesc };
                totalJobs += platformTotal;
                totalWithDesc += platformWithDesc;
                console.log(`[JobHunter] ${label} 采集完成: ${platformTotal} 条`);
              } catch (err) {
                console.warn(`[JobHunter] ${label} 采集异常:`, err.message);
                errors.push({ platform, error: err.message });
                byPlatform[platform] = { total: 0, withDescription: 0, error: err.message };
                // 单平台失败不中断，继续下一个平台
              }
            }

            this.isRunning = false;
            this.crawlState.status = 'completed';
            const allResult = {
              success: true,
              platform: 'all',
              total: totalJobs,
              totalJobs,
              withDescription: totalWithDesc,
              totalWithDescription: totalWithDesc,
              byPlatform,
              errors: errors.length > 0 ? errors : undefined,
              stoppedEarly
            };
            console.log('[JobHunter] 全平台采集完成:', JSON.stringify(byPlatform));
            sendResponse({ success: true, data: allResult });
          } else if (requestPlatform === '51job') {
            // 51job 专用采集流程（DOM解析模式）
            console.log('[JobHunter] 启动 51job 采集流程');
            this.isRunning = true;
            this.crawlState.status = 'running';
            const result51 = await this.execute51JobCrawl(request.payload || {});

            // 51job 分页采集已在内部逐页调用 reportJobsToController 入库，无需外部重复

            this.isRunning = false;
            this.crawlState.status = 'completed';
            sendResponse({ success: true, data: result51 });
          } else if (requestPlatform === 'zhaopin') {
            // 智联招聘专用采集流程
            console.log('[JobHunter] 启动智联招聘采集流程');
            this.isRunning = true;
            this.crawlState.status = 'running';
            const resultZhaopin = await this.executeZhaopinCrawl(request.payload || {});

            // 智联分页采集已在内部逐页调用 reportJobsToController 入库，无需外部重复

            this.isRunning = false;
            this.crawlState.status = 'completed';
            sendResponse({ success: true, data: resultZhaopin });
          } else {
            let manualTask = null;
            if (request.payload?.keyword) {
              const cityName = (request.payload.city || '北京').trim() || '北京';
              const city =
                CONFIG.CITIES.find((item) => item.name === cityName) ||
                CONFIG.CITIES.find((item) => item.name.includes(cityName) || cityName.includes(item.name)) ||
                CONFIG.CITIES[0];
              manualTask = {
                city: {
                  name: cityName,
                  code: city?.code || CONFIG.CITIES[0].code
                },
                keyword: request.payload.keyword.trim(),
                taskId: `manual-${Date.now()}`,
                source: 'manual'
              };
              this.manualAlarmPauseUntil = Date.now() + MANUAL_ALARM_PAUSE_MS;
              console.log('[JobHunter] Dashboard manual task injected:', manualTask);
              console.log(`[JobHunter] Auto alarms paused for ${Math.ceil(MANUAL_ALARM_PAUSE_MS / 60000)}min due to manual run`);
            }
            const results = await this.executeCrawlTask(manualTask);
            if (results && results.success === false) {
              sendResponse({
                success: false,
                error: results.error || 'Crawl failed',
                data: results
              });
            } else {
              sendResponse({ success: true, data: results });
            }
          }
          break;

        case 'STOP_CRAWL':
          if (!this.isRunning) {
            sendResponse({ success: false, error: 'Not running' });
          } else {
            this.isRunning = false;
            this.crawlState.status = 'stopped_by_user';
            this.resolveManualVerification(false);
            sendResponse({ success: true, message: 'Crawl stopped by user' });
            console.log('[JobHunter] Crawl stopped by user via dashboard');
          }
          break;

        case 'GET_STATUS':
          sendResponse({
            success: true,
            data: {
              isRunning: this.isRunning,
              stats: this.runStats,
              verification: this.getManualVerificationState(),
              crawlSession: { ...this.activeCrawlSession },
              alarmMode: CONFIG.ALARM_MODE,
              alarmIntervalMinutes: CONFIG.ALARM_INTERVAL_MINUTES,
              runtimeConfig: this.getRuntimeConfig(),
              crawlSource: this.crawlState.source,  // 当前采集来源: 'manual' | 'auto' | null
              ...this.getVersionInfo()
            }
          });
          break;

        case 'GET_RUNTIME_CONFIG':
          sendResponse({
            success: true,
            data: this.getRuntimeConfig()
          });
          break;

        case 'UPDATE_RUNTIME_CONFIG':
          sendResponse({
            success: true,
            data: await this.updateRuntimeConfig(request.config || {})
          });
          break;

        case 'UPDATE_CONFIG':
          await chrome.storage.local.set({ config: request.config || {} });
          sendResponse({ success: true });
          break;

        case 'GET_ALARMS':
          sendResponse({
            success: true,
            data: await chrome.alarms.getAll()
          });
          break;

        case 'RESTORE_ALARMS':
          await this.restoreAlarms();
          sendResponse({
            success: true,
            data: await chrome.alarms.getAll()
          });
          break;

        case 'GET_STATS':
          const savedStats = await chrome.storage.local.get('crawl_stats');
          sendResponse({
            success: true,
            data: { current: this.runStats, history: savedStats.crawl_stats || {} }
          });
          break;

        case 'CLEAR_STATS':
          await chrome.storage.local.remove('crawl_stats');
          sendResponse({ success: true });
          break;

        case 'CLEAR_SEEN_JOB_IDS':
          await chrome.storage.local.remove(SEEN_JOB_IDS_KEY);
          sendResponse({ success: true, cleared: true });
          break;

        case 'CHECK_FEISHU':
          const feishuOk = await this.checkFeishuConnection();
          sendResponse({ success: feishuOk });
          break;

        case 'OPEN_VERIFICATION_TAB': {
          const opened = await this.focusManualVerificationTab();
          sendResponse({ success: Boolean(opened), data: { opened } });
          break;
        }

        case 'ACK_MANUAL_VERIFICATION':
          this.resolveManualVerification(true);
          sendResponse({ success: true });
          break;

        case 'CRAWL_RESULT': {
          const { platform, data } = request;
          if (scrapers[platform]) {
            scrapers[platform](data);
          } else {
            console.warn('[路由] 未支持的平台:', platform);
          }
          sendResponse({ success: true });
          break;
        }

        default:
          sendResponse({ success: false, error: 'Unknown type' });
      }
    } catch (error) {
      console.error('[JobHunter] Error:', error);
      sendResponse({ success: false, error: error.message });
    }
  }

  // ============ 核心采集流程（批次调度版） ============
  async executeCrawlTask(manualTask = null) {
    // 等待初始化完成（防止竞态：确保 queueLengthHistory 已加载）
    if (this.initPromise) {
      await this.initPromise;
    }

    await this.syncRuntimeConfigFromController();
    await chrome.storage.local.set({ [RUNTIME_CONFIG_KEY]: this.runtimeConfig });

    if (this.isRunning) {
      return { success: false, error: 'Already running' };
    }

    // 1. 检查反爬状态（手动模式：绕过冷却窗口；自动模式：阻塞返回）
    const isManualTask = !!manualTask;
    const blockCheck = await this.checkBlocked();
    if (blockCheck.blocked) {
      if (isManualTask) {
        // manual 模式正式配置：绕过反爬冷却窗口
        console.warn(
          `[JobHunter] Manual task bypassing blocked window (source=manual): status=${this.crawlState.status}, remaining=${blockCheck.remaining}min`
        );
      } else {
        console.log(`[JobHunter] Queue-stuck check suppressed during blocked window: ${this.crawlState.status}`);
        return {
          success: false,
          error: `Blocked: ${this.crawlState.status}, remaining ${blockCheck.remaining}min`,
          status: this.crawlState.status
        };
      }
    }

    // 记录采集来源到 crawlState
    this.crawlState.source = isManualTask ? 'manual' : 'auto';
    await this.saveCrawlState();

    this.isRunning = true;
    // 重置本次采集统计（含filteredCount）
    this.runStats = this.createEmptyRunStats();
    
    // 检查是否需要重置延迟（6小时无反爬才重置）
    const lastAntiCrawlTime = await chrome.storage.local.get('last_anti_crawl_time');
    const hoursSinceAntiCrawl = lastAntiCrawlTime.last_anti_crawl_time
      ? (Date.now() - lastAntiCrawlTime.last_anti_crawl_time) / 3600000
      : 999;
    if (hoursSinceAntiCrawl > 6) {
      this.currentDelay = CONFIG.ANTI_CRAWL.BASE_DELAY;
      console.log(`[JobHunter] Delay reset after ${hoursSinceAntiCrawl.toFixed(1)}h without anti-crawl`);
    } else {
      console.log(`[JobHunter] Keep delay: ${this.currentDelay}ms (${hoursSinceAntiCrawl.toFixed(1)}h since last anti-crawl)`);
    }

    // 2. 获取下一个任务（根据TASK_SOURCE_MODE决定来源）
    let task;
    let remaining;
    let fromController = false;
    if (isManualTask) {
      task = manualTask;
      remaining = 'manual';
      console.log('[JobHunter] task source: manual');
    } else {
      const controllerTask = await this.fetchQueueFromController();
      if (controllerTask) {
        // 控制面有任务
        task = controllerTask;
        remaining = '?';  // 控制面队列长度不直接可知
        fromController = true;
        console.log('[JobHunter] task source: controller');
      } else if (CONFIG.TASK_SOURCE_MODE === 'controller_only') {
        // P1：仅控制面模式 - 不可达或无任务时直接返回
        this.isRunning = false;
        // 判断是控制面不可达还是真的没任务
        try {
          const res = await fetch(`${CONFIG.CONTROLLER_BASE_URL}/status`);
          if (res.ok) {
            console.log('[JobHunter] controller_only: no task available, skip');
            await this.enterIdlePolling('controller_no_task');
          } else {
            console.warn('[JobHunter] controller_only: controller responded with error, skip');
          }
        } catch {
          console.warn('[JobHunter] controller_only: controller unreachable, skip');
        }
        return { success: true, total: 0, reason: 'controller_no_task' };
      } else if (CONFIG.TASK_SOURCE_MODE === 'internal_only') {
        // P1：仅内置队列模式
        const nextTask = await this.getNextTask();
        task = nextTask.task;
        remaining = nextTask.remaining;
        fromController = false;
        console.log('[JobHunter] task source: internal');
        if (!task) {
          this.isRunning = false;
          console.log('[JobHunter] No pending tasks, queue empty');
          return { success: true, total: 0, reason: 'queue_empty' };
        }
      } else {
        // P1：hybrid模式 - 优先控制面，回退内置队列（旧行为）
        console.log('[JobHunter] controller unavailable, fallback to internal queue (hybrid mode)');
        const nextTask = await this.getNextTask();
        task = nextTask.task;
        remaining = nextTask.remaining;
        fromController = false;
        console.log('[JobHunter] task source: internal (fallback)');
        if (!task) {
          this.isRunning = false;
          console.log('[JobHunter] No pending tasks, queue empty');
          return { success: true, total: 0, reason: 'queue_empty' };
        }
      }
    }

    const { city, keyword, taskId } = task;  // R3: 解构出 taskId
    console.log(`[JobHunter] ========================================`);
    console.log(
      `[JobHunter] Starting task: ${keyword} in ${city.name || city} (queue remaining: ${remaining}, taskId: ${taskId || 'N/A'}, CODE_VERSION=${CODE_VERSION}, PIPELINE_VERSION=${PIPELINE_VERSION})`
    );

    let antiCrawlTriggered = false;
    let lastError = null;  // 跟踪最后发生的错误（P0新增）
    let keepManualTabOpen = false;
    const deliveryBatchId = new Date().toISOString().slice(0, 16).replace(/[-T:]/g, '') +
      '-' + Math.random().toString(36).slice(2, 6);
    let incrementalInsertedCount = 0;
    const allJobs = [];
    const filteredJobs = [];
    let tab = null;

    try {
      // 3. 创建Boss标签页
      console.log('[JobHunter] Creating tab...');
      tab = await chrome.tabs.create({
        url: isManualTask
          ? this.buildBossSearchUrl(keyword, city.code)
          : 'https://www.zhipin.com/web/geek/job',
        active: isManualTask
      });

      // 4. 等待页面加载
      console.log('[JobHunter] Waiting for page load...');
      await this.waitForTabLoad(tab.id);
      
      // 5. 等待 Content Script 注入完成
      console.log('[JobHunter] Waiting for Content Script...');
      await this.waitForContentScript(tab.id);

      // 6. 执行搜索
      console.log(`[JobHunter] Searching: ${keyword} in ${city.name}`);
      
      const searchResult = await this.scrapeJobListPages(tab.id, {
        keyword,
        cityCode: city.code,
        pageSize: this.getMaxListPageSize(),
        experience: this.getExperienceCode(),
        maxPagesOverride: isManualTask ? 1 : null
      });

      // 反爬检测
      if (!searchResult.success) {
        this.consecutiveFailures++;
        const isAntiCrawl = this.isAntiCrawlError(searchResult.error);
        
        console.log(`[JobHunter] ⚠️ Search failed (${this.consecutiveFailures} consecutive)`);
        console.log(`[JobHunter] Error: ${searchResult.error}`);
        console.log(`[JobHunter] Anti-crawl detected: ${isAntiCrawl}`);

        if (isAntiCrawl || this.consecutiveFailures >= CONFIG.ANTI_CRAWL.MAX_CONSECUTIVE_FAILURES) {
          // 触发状态机升级
          await this.transitionCrawlState('anti_crawl');
          antiCrawlTriggered = true;
          // 只有内置队列任务才放回 pending_queue，控制面任务由控制面管理重试
          if (!fromController) {
            await this.putBackTask(task);
          } else {
            console.log(`[JobHunter] Controller task anti-crawl, not putting back to internal queue`);
          }
        }
        
        if (isManualTask) {
          keepManualTabOpen = true;
          try {
            await chrome.tabs.update(tab.id, { active: true });
          } catch {}
          console.warn('[JobHunter] Manual task requires in-page intervention, keeping tab open');
        }

        throw new Error(`Search failed: ${searchResult.error}`);
      }

      // 搜索成功
      if (this.consecutiveFailures > 0) {
        console.log(`[JobHunter] ✅ Search success, resetting failure count`);
        this.consecutiveFailures = 0;
      }
      await this.transitionCrawlState('success');
      this.runStats.listCount = searchResult.data.length;
      this.runStats.pagedListCount = searchResult.data.length;
      this.runStats.pagesFetched = searchResult.pagesFetched || 0;

      if (!searchResult.data || searchResult.data.length === 0) {
        console.log(`[JobHunter] No jobs found for ${keyword} in ${city.name}`);
        this.isRunning = false;
        await this.saveStats();
        // 向控制面报告结果（P0修复：提前返回也要上报）
        const result = this.buildTaskResult({
          city,
          keyword,
          taskId,
          status: 'success',
          total: 0,
          pushed: 0,
          filtered: 0,
          errorCode: null,
          errorMessage: null
        });
        await this.reportToController(result);
        if (fromController && CONFIG.TASK_SOURCE_MODE === 'controller_only') {
          await this.enterIdlePolling('controller_task_finished');
        }
        return { success: true, total: 0, reason: 'no_jobs' };
      }

      // 规则过滤
      console.log(`[JobHunter] Search returned ${searchResult.data.length} jobs:`,
        searchResult.data.map(j => `${j.jobName}[${j.jobExperience || '经验未知'}]`));
      
      const { kept, filtered, filterReasonStats } = this.filterJobs(searchResult.data, {
        manualKeyword: isManualTask ? keyword : ''
      });
      if (filtered.length > 0) {
        console.log(`[JobHunter] Filtered ${filtered.length}/${searchResult.data.length} jobs:`,
          filtered.map(j => `${j.jobName}(${j._filterReason})`));
        console.log(`[JobHunter] Filter reason breakdown:`);
        for (const [reason, jobNames] of Object.entries(filterReasonStats)) {
          console.log(`  [${jobNames.length}] ${reason}: ${jobNames.join(', ')}`);
        }
        this.runStats.filterReasonStats = filterReasonStats;
        this.runStats.filteredCount += filtered.length;
        filteredJobs.push(...filtered.map(j => ({
          ...j, city: city.name, keyword, collectedAt: new Date().toISOString()
        })));
      }

      if (kept.length === 0) {
        console.log(`[JobHunter] All ${searchResult.data.length} jobs filtered`);
        this.isRunning = false;
        await this.saveStats();
        // 向控制面报告结果（P0修复：提前返回也要上报）
        const result = this.buildTaskResult({
          city,
          keyword,
          taskId,
          status: 'success',
          total: 0,
          pushed: 0,
          filtered: filteredJobs.length,
          errorCode: null,
          errorMessage: null
        });
        await this.reportToController(result);
        if (fromController && CONFIG.TASK_SOURCE_MODE === 'controller_only') {
          await this.enterIdlePolling('controller_task_finished');
        }
        return { success: true, total: 0, filtered: filteredJobs.length, reason: 'all_filtered' };
      }

      console.log(`[JobHunter] Found ${kept.length} jobs (from ${searchResult.data.length}, filtered ${filtered.length})`);

      const seenJobIds = isManualTask ? new Set() : await this.getSeenJobIdsSet();
      const detailCandidates = this.selectDetailCandidates(kept, seenJobIds);

      if (detailCandidates.length === 0) {
        console.log(`[JobHunter] No new jobs eligible for detail harvesting (missingEncryptJobId=${this.runStats.missingEncryptJobIdCount}, seenSkipped=${this.runStats.detailSkippedSeenCount})`);
        if (isManualTask && kept.length > 0) {
          const manualJobs = kept.map((job) => ({
            ...job,
            city: city.name,
            keyword,
            collectedAt: new Date().toISOString(),
            description: job.description || ''
          }));
          allJobs.push(...manualJobs);
          this.runStats.totalJobs += manualJobs.length;
          console.log(`[JobHunter] Manual task fallback: inserting ${manualJobs.length} list jobs without details`);
        } else {
          this.isRunning = false;
          await this.saveStats();
          const result = this.buildTaskResult({
            city,
            keyword,
            taskId,
            status: 'success',
            total: 0,
            pushed: 0,
            filtered: filteredJobs.length,
            errorCode: null,
            errorMessage: null
          });
          await this.reportToController(result);
          if (fromController && CONFIG.TASK_SOURCE_MODE === 'controller_only') {
            await this.enterIdlePolling('controller_task_finished');
          }
          return { success: true, total: 0, filtered: filteredJobs.length, reason: 'no_new_jobs' };
        }
      }

      // 搜索后延迟（手动模式：3-5分钟；自动模式：原有策略）
      if (!this.isRunning) {
        console.log(`[JobHunter] Stopped by user before search cooldown, saving partial results`);
      } else {
        // 手动模式冷却窗口：3-5分钟（收编原有手动绕过冷却逻辑为正式配置）
        const MANUAL_COOLDOWN_MS = (3 + Math.random() * 2) * 60 * 1000;
        const searchCooldown = isManualTask ? MANUAL_COOLDOWN_MS : (this.currentDelay + Math.random() * 2000);
        console.log(`[JobHunter] ⏱️ Cooling down ${(searchCooldown/1000).toFixed(1)}s after search (source: ${this.crawlState.source})...`);
        await this.sleep(searchCooldown);
      }

      // 7. 获取详情（先去重，再应用预算）
      const detailBudget = isManualTask ? 3 : this.getMaxDetailRequestsPerRun();
      const maxDetails = detailBudget === 0
        ? detailCandidates.length
        : Math.min(detailCandidates.length, detailBudget);
      console.log(`[JobHunter] Fetching details for ${maxDetails}/${detailCandidates.length} new jobs (MAX_DETAIL_REQUESTS_PER_RUN=${detailBudget === 0 ? 'unlimited' : detailBudget})`);
      
      const jobsWithDetails = [];
      for (let i = 0; i < maxDetails; i++) {
        if (!this.isRunning) {
          console.log(`[JobHunter] Detail loop stopped by user at [${i}/${maxDetails}]`);
          break;
        }
        const job = detailCandidates[i];
        console.log(`[JobHunter] [${i+1}/${maxDetails}] Getting detail: ${job.jobName}`);
        
        try {
          this.runStats.detailRequestedCount++;
          const detailResult = await this.fetchJobDetailWithRetry(tab.id, job, 2);

          if (detailResult.success && detailResult.data) {
            this.runStats.detailSuccessCount++;
            if (detailResult.data._source === 'card') {
              this.runStats.cardApiUsed++;
            } else {
              this.runStats.detailApiUsed++;
            }
            if (detailResult.data.description?.length > 0) {
              this.runStats.successWithDesc++;
              this.runStats.detailDescriptionNonEmptyCount++;
            }
            const hydratedJob = {
              ...job,
              description: detailResult.data.description || '',
              hardRequirements: detailResult.data.hardRequirements || '',
              skills: detailResult.data.skills || job.skills || [],
              address: detailResult.data.address || '',
              welfareList: detailResult.data.welfareList || [],
              bossName: detailResult.data.bossName || job.bossName || '',
              bossTitle: detailResult.data.bossTitle || job.bossTitle || '',
              _source: detailResult.data._source || 'none'
            };
            jobsWithDetails.push(hydratedJob);
            await this.markJobIdSeen(job.encryptJobId, seenJobIds);
            console.log(`[JobHunter]   ✓ Description: ${detailResult.data.description?.length || 0} chars`);

            if (isManualTask) {
              const jobWithMeta = {
                ...hydratedJob,
                city: city.name,
                keyword,
                collectedAt: new Date().toISOString()
              };
              const insertResult = await this.reportJobsToController(
                [this.normalizeBossJobForBatchInsert(jobWithMeta, deliveryBatchId)],
                'boss'
              );
              incrementalInsertedCount += (insertResult.inserted || 0) + (insertResult.duplicates || 0);
            }
          } else {
            this.runStats.failCount++;
            console.log(`[JobHunter]   ✗ Failed: ${detailResult.error || 'Unknown'}`);
            
            if (this.isAntiCrawlError(detailResult.error)) {
              console.log(`[JobHunter]   ⚠️ Anti-crawl in detail API`);
              await this.increaseDelay();
              // 触发状态机
              await this.transitionCrawlState('anti_crawl');
              antiCrawlTriggered = true;
            }
            
            jobsWithDetails.push({ ...job, description: '' });
          }

          if (i < maxDetails - 1) {
            if (!this.isRunning) {
              console.log(`[JobHunter] Detail loop stopped by user before detail sleep at [${i+1}/${maxDetails}]`);
              break;
            }
            const detailDelay = this.currentDelay + Math.random() * 3000;
            console.log(`[JobHunter]   ⏱️ Waiting ${(detailDelay/1000).toFixed(1)}s...`);
            await this.sleep(detailDelay);
          }
        } catch (detailError) {
          console.error(`[JobHunter] Detail error:`, detailError);
          jobsWithDetails.push({ ...job, description: '' });
        }
      }

      // 添加元数据
      const jobsWithMeta = jobsWithDetails.map(job => ({
        ...job,
        city: city.name,
        keyword: keyword,
        collectedAt: new Date().toISOString()
      }));
      
      allJobs.push(...jobsWithMeta);
      this.runStats.totalJobs += jobsWithMeta.length;

      console.log(`[JobHunter] ========================================`);
      console.log(`[JobHunter] Task completed: ${jobsWithMeta.length} jobs collected`);

    } catch (error) {
      console.error('[JobHunter] Task error:', error);
      lastError = error;  // 记录错误用于上报（P0新增）
      // 如果是因为反爬导致的错误，任务已经放回队列
      if (antiCrawlTriggered) {
        console.log(`[JobHunter] Task put back due to anti-crawl`);
      }
    } finally {
      if (keepManualTabOpen) {
        console.log(`[JobHunter] Keeping manual task tab open: ${tab?.id}`);
      } else {
        await this.closeTabIfNeeded(tab?.id);
      }
    }

    // 9. 推送到飞书
    let pushedCount = 0;
    if (allJobs.length > 0) {
      if (isManualTask) {
        pushedCount = incrementalInsertedCount;
        if (!this.isControllerDeliveryEnabled()) {
          await this.pushToFeishu(allJobs, deliveryBatchId);
        }
      } else if (this.isControllerDeliveryEnabled()) {
        const detailReport = await this.reportDetailsToController(allJobs, taskId, deliveryBatchId);
        pushedCount = (detailReport.inserted || 0) + (detailReport.duplicates || 0);
      } else {
        pushedCount = await this.pushToFeishu(allJobs, deliveryBatchId);
        await this.reportDetailsToController(allJobs, taskId, deliveryBatchId);
      }
    }

    // 推送被过滤的岗位（可选，由开关控制）
    const PUSH_FILTERED_TO_FEISHU = false;
    if (PUSH_FILTERED_TO_FEISHU && filteredJobs.length > 0) {
      const filteredPushed = await this.pushToFeishu(filteredJobs);
      console.log(`[JobHunter] Filtered jobs pushed: ${filteredPushed}`);
    }

    this.isRunning = false;
    await this.saveStats();

    // Phase 1: queueLengthHistory 相关旧告警逻辑已停用，保留函数体仅用于回退。
    // 11. 告警检查
    await this.checkAndSendAlerts(allJobs.length, pushedCount, antiCrawlTriggered);

    // 12. 构造结果并报告给控制面
    // P0修复：区分三种状态 success / anti_crawl / failed
    let status;
    if (antiCrawlTriggered) {
      status = 'anti_crawl';
    } else if (lastError) {
      status = 'failed';
    } else {
      status = 'success';
    }
    
    const actualWithDesc = allJobs.filter(j => j.description?.length > 0).length;
    const result = this.buildTaskResult({
      city,
      keyword,
      taskId,
      status,
      total: allJobs.length,
      pushed: pushedCount,
      filtered: filteredJobs.length,
      withDescription: actualWithDesc,
      errorCode: antiCrawlTriggered ? this.crawlState.status : null,
      errorMessage: lastError ? lastError.message : null
    });
    console.log('[JobHunter] Result parity check:', {
      actualWithDescription: actualWithDesc,
      runStatsWithDescription: this.runStats.detailDescriptionNonEmptyCount,
      parity: actualWithDesc === this.runStats.detailDescriptionNonEmptyCount ? 'MATCH' : 'MISMATCH',
      successWithDesc: this.runStats.successWithDesc,
      totalJobs: allJobs.length,
      jobsWithUrl: allJobs.filter(j => Boolean(j.url)).length,
      sampleUrls: allJobs.slice(0, 3).map(j => j.url || null),
      sampleDescLengths: allJobs.slice(0, 3).map(j => (j.description || '').length)
    });
    await this.reportToController(result);
    if (fromController && CONFIG.TASK_SOURCE_MODE === 'controller_only') {
      await this.enterIdlePolling('controller_task_finished');
    }

    // 13. 返回结果
    if (antiCrawlTriggered) {
      return {
        success: true,
        total: allJobs.length,
        pushed: pushedCount,
        filtered: filteredJobs.length,
        antiCrawl: true,
        status: this.crawlState.status,
        blockedUntil: this.crawlState.blockedUntil,
        crawlBatchId: deliveryBatchId
      };
    }

    return {
      success: true,
      total: allJobs.length,
      withDescription: allJobs.filter(j => j.description?.length > 0).length,
      pushed: pushedCount,
      filtered: filteredJobs.length,
      queueRemaining: remaining,
      crawlBatchId: deliveryBatchId
    };
  }

  // 等待标签页加载
  waitForTabLoad(tabId) {
    return new Promise((resolve) => {
      const listener = (updatedTabId, info) => {
        if (updatedTabId === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  }

  // 等待 Content Script 准备就绪（带重试）
  async waitForContentScript(tabId, maxRetries = 5) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const result = await this.sendMessageToTab(tabId, { type: 'CHECK_STATUS' });
        if (result && result.success) {
          console.log(`[JobHunter] Content Script ready after ${i + 1} attempt(s)`);
          return true;
        }
      } catch (error) {
        console.log(`[JobHunter] Content Script not ready (attempt ${i + 1}/${maxRetries}): ${error.message}`);
      }
      // 等待 1 秒后重试
      await this.sleep(1000);
    }
    throw new Error('Content Script failed to initialize after ' + maxRetries + ' attempts');
  }

  // 向Content Script发送消息
  sendMessageToTab(tabId, message) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Message timeout'));
      }, 30000);

      const attemptSend = (hasRecovered = false) => chrome.tabs.sendMessage(tabId, message, async (response) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) {
          const errorMessage = chrome.runtime.lastError.message || 'Unknown runtime error';
          if (!hasRecovered && this.shouldRecoverMessagePort(errorMessage)) {
            try {
              await this.recoverContentScript(tabId, errorMessage);
              attemptSend(true);
              return;
            } catch (recoveryError) {
              reject(recoveryError);
              return;
            }
          }
          reject(new Error(errorMessage));
        } else {
          resolve(response);
        }
      });

      attemptSend(false);
    });
  }

  shouldRecoverMessagePort(errorMessage) {
    return typeof errorMessage === 'string' &&
      errorMessage.includes('Receiving end does not exist');
  }

  async recoverContentScript(tabId, reason) {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !tab.url || !tab.url.startsWith('https://www.zhipin.com/')) {
      throw new Error(`Cannot recover content script on tab ${tabId}: unsupported URL`);
    }

    console.warn(`[JobHunter] Content script missing on tab ${tabId}, reinjecting (${reason})`);
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
    await this.waitForContentScript(tabId, 3);
    console.log(`[JobHunter] Content script recovered on tab ${tabId}`);
  }

  // ============ 飞书字段适配层 ============

  // 从飞书API拉取选项字典并缓存
  async loadOptionDict() {
    // 先查缓存
    const cached = await chrome.storage.local.get(OPTION_CACHE_KEY);
    if (cached[OPTION_CACHE_KEY]) {
      const { dict, timestamp } = cached[OPTION_CACHE_KEY];
      if (Date.now() - timestamp < OPTION_CACHE_TTL) {
        console.log('[JobHunter] Using cached option dict');
        return dict;
      }
    }

    let dict = {};
    if (this.isControllerDeliveryEnabled()) {
      console.log('[JobHunter] Fetching option dict from controller...');
      dict = await this.fetchOptionDictFromController();
    }

    if (!dict || Object.keys(dict).length === 0) {
      console.log('[JobHunter] Fetching option dict from Feishu API...');
      dict = await this.fetchOptionDictFromAPI();
    }

    // 缓存
    await chrome.storage.local.set({
      [OPTION_CACHE_KEY]: { dict, timestamp: Date.now() }
    });

    return dict;
  }

  async fetchOptionDictFromController() {
    try {
      const res = await fetch(`${CONFIG.CONTROLLER_BASE_URL}/feishu/option-dict`);
      const data = await res.json();
      if (!res.ok || !data.success || !data.optionDict) {
        console.warn('[JobHunter] Controller option dict unavailable');
        return {};
      }
      console.log('[JobHunter] Option dict loaded from controller:', Object.keys(data.optionDict));
      return data.optionDict;
    } catch (error) {
      console.warn('[JobHunter] Error fetching option dict from controller:', error.message);
      return {};
    }
  }

  async fetchOptionDictFromAPI() {
    try {
      const token = await this.getFeishuToken();
      const res = await fetch(
        `https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU_CONFIG.appToken}/tables/${FEISHU_CONFIG.tableId}/fields`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      const data = await res.json();

      if (data.code !== 0) {
        console.error('[JobHunter] Failed to fetch fields:', data);
        return {};
      }

      const dict = {};
      for (const field of data.data.items) {
        if (field.property?.options) {
          dict[field.field_name] = field.property.options.map(opt => opt.name);
        }
      }

      console.log('[JobHunter] Option dict loaded:', Object.keys(dict));
      return dict;
    } catch (error) {
      console.error('[JobHunter] Error fetching option dict:', error);
      return {};
    }
  }

  async getFeishuToken() {
    const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: FEISHU_CONFIG.appId,
        app_secret: FEISHU_CONFIG.appSecret
      })
    });
    const data = await res.json();
    if (data.code !== 0) {
      throw new Error('Failed to get token');
    }
    return data.tenant_access_token;
  }

  // SingleSelect: 值必须在选项列表中，不在则返回空
  matchSingleSelect(value, options) {
    if (!value || !options || options.length === 0) return '';
    const found = options.find(opt =>
      opt.toLowerCase() === value.toLowerCase() ||
      opt.includes(value) ||
      value.includes(opt)
    );
    return found || '';
  }

  // MultiSelect: 过滤出已存在的选项
  matchMultiSelect(values, options) {
    if (!values || !Array.isArray(values) || !options || options.length === 0) return [];
    return values.filter(v =>
      options.some(opt =>
        opt.toLowerCase() === v.toLowerCase() ||
        opt.includes(v) ||
        v.includes(opt)
      )
    );
  }

  // 截断工具
  truncate(str, maxLen) {
    if (!str) return '';
    return str.length > maxLen ? str.slice(0, maxLen) : str;
  }

  // 地点拼接
  buildLocation(job) {
    let loc = job.locationName || '';
    if (job.areaDistrict && !loc.includes(job.areaDistrict)) {
      loc = loc + '·' + job.areaDistrict;
    }
    return loc;
  }

  // 数据来源映射
  mapSource(source) {
    const map = {
      'card': 'card',
      'detail': 'detail',
      'card→detail降级': 'card→detail降级'
    };
    return map[source] || 'none';
  }

  // 采集状态映射
  mapStatus(job) {
    if (job._filtered) return '已过滤';
    if (job._source === 'card→detail降级') return '描述为空';
    if (job.description && job.description.length > 0) return '成功';
    return '描述为空';
  }

  /**
   * 将Boss原始数据标准化为飞书字段格式
   * 负责: 类型转换、选项白名单过滤、空值处理、截断
   */
  normalizeForFeishu(job, optionDict, batchId) {
    // 1. SingleSelect字段: 值必须在选项列表中
    const workExp = this.matchSingleSelect(job.jobExperience, optionDict['工作经验']);
    const degree = this.matchSingleSelect(job.jobDegree, optionDict['学历要求']);
    const companyType = this.matchSingleSelect(job.brandStageName, optionDict['公司类型']);
    const sourcePlatform = this.matchSingleSelect('Boss直聘', optionDict['来源平台']);

    // 2. MultiSelect字段: 只保留已存在的选项
    const rawSkills = job.skills || [];
    const keywords = this.matchMultiSelect(rawSkills, optionDict['岗位关键词']);

    // 3. Url字段: 已实测验证：飞书Url字段必须用 {text, link} 对象格式（纯字符串会报URLFieldConvFail）
    const jobUrl = {
      text: "查看职位",
      link: `https://www.zhipin.com/job_detail/${job.encryptJobId}.html`
    };

    // 4. DateTime字段: 毫秒时间戳（飞书自动格式化为yyyy/MM/dd HH:mm）
    const crawlTime = Date.now();

    return {
      "encryptBrandId": job.encryptBrandId || null,
      "文本": `JOB-${job.encryptJobId?.slice(-8)}`,
      "职位名称": this.truncate(job.jobName, 100),
      "公司名称": this.truncate(job.brandName, 100),
      "薪资范围": this.truncate(job.salaryDesc, 50),
      "工作地点": this.buildLocation(job),
      "工作经验": workExp,
      "学历要求": degree,
      "行业领域": this.truncate(job.brandIndustry || '人工智能', 100),
      "岗位关键词": keywords,
      "职位描述": job._filterReason ? `[已过滤] ${job._filterReason}` : this.truncate(job.description || '', 5000),
      "硬性要求": this.truncate(job.hardRequirements || '', 2000),
      "公司规模": this.truncate(job.brandScaleName || '', 50),
      "公司类型": companyType,
      "来源平台": sourcePlatform,
      "HR姓名": this.truncate(job.bossName || '', 50),
      "发布时间": '',  // 暂留空，需额外API
      "公司简介": '',  // 暂留空，需额外API
      "爬取时间": crawlTime,
      "职位链接": jobUrl,
      "数据来源": this.mapSource(job._source),
      "采集状态": this.mapStatus(job),
      "采集批次": batchId || ''
    };
  }

  // 发送告警记录到飞书
  async sendAlertToFeishu(alertType, details) {
    if (!ALERTS_CONFIG.writeAlertsToMainTable) {
      console.warn(`[JobHunter] Alert suppressed from main table: ${alertType}`);
      return;
    }

    const timestamp = new Date().toISOString().slice(0, 16).replace(/[-T:]/g, '');
    const alertId = `ALERT-${timestamp}-${Math.random().toString(36).slice(2, 6)}`;
    
    const alertRecord = {
      fields: {
        "文本": alertId,
        "职位名称": `⚠️ 采集异常告警: ${alertType}`,
        "公司名称": "（系统告警）",
        "职位描述": details,
        "采集状态": "接口失败",
        "来源平台": "Boss直聘",
        "采集批次": alertId.split('-').slice(0, 3).join('-')
      }
    };

    try {
      const token = await this.getFeishuToken();
      const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU_CONFIG.appToken}/tables/${FEISHU_CONFIG.tableId}/records`;
      
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ fields: alertRecord.fields })
      });
      
      const data = await res.json();
      if (data.code === 0) {
        console.log(`[JobHunter] Alert sent: ${alertId}`);
      } else {
        console.error(`[JobHunter] Failed to send alert:`, data);
      }
    } catch (error) {
      console.error(`[JobHunter] Alert send error:`, error);
    }
  }

  // 检查并发送告警
  async checkAndSendAlerts(totalJobs, pushedCount, antiCrawlTriggered) {
    const alerts = [];

    // 条件1: 反爬触发
    if (antiCrawlTriggered) {
      alerts.push({
        type: '反爬触发',
        details: `状态: ${this.crawlState.status}\n连续失败: ${this.crawlState.consecutiveBatchFailures}\n延迟: ${this.currentDelay}ms\n时间: ${new Date().toISOString()}`
      });
    }

    // 条件2: 有数据但写入失败
    if (totalJobs > 0 && pushedCount === 0) {
      alerts.push({
        type: '飞书写入失败',
        details: `采集: ${totalJobs}条\n写入: ${pushedCount}条\n状态: 全部写入失败\n时间: ${new Date().toISOString()}`
      });
    }

    // 条件3: 详情获取成功率低于30%
    const successRate = this.runStats.totalJobs > 0 
      ? (this.runStats.successWithDesc / this.runStats.totalJobs) 
      : 1;
    if (successRate < 0.3 && this.runStats.totalJobs > 0) {
      alerts.push({
        type: '详情获取率低',
        details: `详情成功率: ${(successRate * 100).toFixed(1)}%\n成功: ${this.runStats.successWithDesc}\n总计: ${this.runStats.totalJobs}\n时间: ${new Date().toISOString()}`
      });
    }

    // 条件4: 当天被封
    if (this.crawlState.status === 'blocked_today') {
      alerts.push({
        type: '当日封禁',
        details: `状态: blocked_today\n解封时间: ${new Date(this.crawlState.blockedUntil).toISOString()}\n时间: ${new Date().toISOString()}`
      });
    }

    // Phase 1: 旧的 queueLengthHistory / 队列堆积告警已停止调用，改由 controller 基于 delivery_queue 负责。

    // 发送所有告警
    for (const alert of alerts) {
      await this.sendAlertToFeishu(alert.type, alert.details);
    }
  }

  // 检查队列是否堆积（连续3次未减少）
  checkQueueStuck() {
    if (this.crawlState.status !== 'normal') {
      return null;
    }

    // 需要至少3条记录
    if (this.queueLengthHistory.length < 3) {
      return null;
    }
    // 取最近3次
    const recent = this.queueLengthHistory.slice(-3);

    // 只基于真实的剩余待处理量判断，不再把“连续3次控制面任务”误判为堆积。
    const validRecords = recent.filter(q => Number.isInteger(q.length) && q.length >= 0);
    if (validRecords.length < 3) {
      return null;
    }

    const lengths = validRecords.map(q => q.length);
    const allPositive = lengths.every(length => length > 0);
    const nonDecreasing = lengths.every((length, index) => index === 0 || length >= lengths[index - 1]);

    if (allPositive && nonDecreasing) {
      const source = validRecords.every(q => q.fromController) ? '控制面' : '内置队列';
      return {
        type: '队列堆积',
        details: `${source}连续3次待处理量未下降，当前长度: ${lengths[lengths.length - 1]}\n历史: ${lengths.join(' -> ')}\n时间: ${new Date().toISOString()}`
      };
    }

    return null;
  }

  // 检查并发送队列堆积告警（专用函数，用于提前返回路径）
  // 只做两件事：1) 调 checkQueueStuck() 2) 如命中则调 sendAlertToFeishu()
  async checkAndSendQueueStuckAlert() {
    const queueAlert = this.checkQueueStuck();
    if (!queueAlert) {
      return;
    }

    // 去重检查：相同签名30分钟内不重复发
    const shouldSend = await this.shouldSendQueueStuckAlert(queueAlert);
    if (!shouldSend) {
      console.log('[JobHunter] Queue stuck alert deduplicated:', queueAlert.type);
      return;
    }

    await this.sendAlertToFeishu(queueAlert.type, queueAlert.details);
    
    // 记录本次告警签名
    await this.recordQueueStuckAlert(queueAlert);
  }

  // 生成队列堆积告警签名（用于去重）
  getQueueStuckAlertSignature(alert) {
    // 取最近3条历史记录的摘要
    const recentHistory = this.queueLengthHistory.slice(-3);
    const historyDigest = recentHistory.map(q => 
      `${q.length}:${q.fromController ? 'c' : 'i'}`
    ).join(',');
    
    return {
      type: alert.type,
      historyDigest: historyDigest,
      windowStart: Math.floor(Date.now() / (30 * 60 * 1000)) // 30分钟时间窗口
    };
  }

  // 检查是否应该发送队列堆积告警（去重逻辑）
  async shouldSendQueueStuckAlert(alert) {
    try {
      const result = await chrome.storage.local.get('last_queue_stuck_alert');
      const lastAlert = result.last_queue_stuck_alert;
      
      if (!lastAlert) {
        return true;
      }

      const currentSignature = this.getQueueStuckAlertSignature(alert);
      
      // 检查签名是否相同（type + historyDigest + 时间窗口）
      const sameType = lastAlert.type === currentSignature.type;
      const sameDigest = lastAlert.historyDigest === currentSignature.historyDigest;
      const sameWindow = lastAlert.windowStart === currentSignature.windowStart;
      
      // 相同签名在30分钟窗口内不重复发
      if (sameType && sameDigest && sameWindow) {
        return false;
      }
      
      return true;
    } catch (error) {
      console.error('[JobHunter] Error checking alert dedup:', error);
      return true; // 出错时允许发送，避免漏告警
    }
  }

  // 记录队列堆积告警到 storage
  async recordQueueStuckAlert(alert) {
    try {
      const signature = this.getQueueStuckAlertSignature(alert);
      await chrome.storage.local.set({
        'last_queue_stuck_alert': signature
      });
    } catch (error) {
      console.error('[JobHunter] Error recording queue stuck alert:', error);
    }
  }

  // 记录队列长度
  // remaining: 内置队列剩余长度；fromController: 是否来自控制面
  async recordQueueLength(remaining, fromController = false) {
    const numericRemaining = Number(remaining);
    if (!Number.isInteger(numericRemaining) || numericRemaining < 0) {
      return;
    }

    this.queueLengthHistory.push({
      length: numericRemaining,
      fromController,
      timestamp: Date.now()
    });

    // 只保留最近10条
    if (this.queueLengthHistory.length > 10) {
      this.queueLengthHistory.shift();
    }

    // 持久化到 storage（MV3 Service Worker 会被回收）
    await this.saveQueueLengthHistory();
  }

  // 推送到飞书
  async pushToFeishu(jobs, batchId = null) {
    console.log(`[JobHunter] Pushing ${jobs.length} jobs to Feishu...`);

    try {
      // 1. 加载选项字典
      const optionDict = await this.loadOptionDict();

      // 2. 生成采集批次ID
      const resolvedBatchId = batchId || (
        new Date().toISOString().slice(0, 16).replace(/[-T:]/g, '') +
        '-' + Math.random().toString(36).slice(2, 6)
      );
      console.log(`[JobHunter] Batch ID: ${resolvedBatchId}`);

      // 3. 标准化每条数据
      const records = [];
      for (const job of jobs) {
        const fields = this.normalizeForFeishu(job, optionDict, resolvedBatchId);
        records.push({ fields });
      }

      // 4. 批量写入（分批，每批最多50条）
      const results = await this.batchCreateRecords(records);
      const totalPushed = results.reduce((sum, r) => sum + (r.count || 0), 0);
      console.log(`[JobHunter] Total pushed: ${totalPushed} jobs`);
      return totalPushed;

    } catch (error) {
      console.error('[JobHunter] Push error:', error);
      return 0;
    }
  }

  async reportDetailsToController(jobs, taskId, batchId) {
    if (!jobs || jobs.length === 0) {
      return { inserted: 0, duplicates: 0, errors: [], attempted: 0 };
    }

    try {
      const optionDict = await this.loadOptionDict();
      const payloadJobs = jobs
        .filter(job => job && job.encryptJobId)
        .map(job => ({
          encryptJobId: job.encryptJobId,
          payload: this.normalizeForFeishu(job, optionDict, batchId)
        }));

      if (payloadJobs.length === 0) {
        console.warn('[JobHunter] Detail report skipped: no jobs with encryptJobId');
        return { inserted: 0, duplicates: 0, errors: [], attempted: 0 };
      }

      const response = await fetch(`${CONFIG.CONTROLLER_BASE_URL}/report-detail`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: taskId || null,
          batchId: batchId || null,
          jobs: payloadJobs
        })
      });

      if (!response.ok) {
        console.warn(`[JobHunter] Detail report failed: ${response.status}`);
        return {
          inserted: 0,
          duplicates: 0,
          errors: [{ error: `HTTP_${response.status}` }],
          attempted: payloadJobs.length
        };
      }

      const result = await response.json();
      console.log(`[JobHunter] Detail report: inserted=${result.inserted || 0}, dupes=${result.duplicates || 0}, errors=${Array.isArray(result.errors) ? result.errors.length : 0}`);
      return {
        inserted: result.inserted || 0,
        duplicates: result.duplicates || 0,
        errors: Array.isArray(result.errors) ? result.errors : [],
        attempted: payloadJobs.length
      };
    } catch (error) {
      // 镜像上报是尽力而为，不阻断主流程
      console.warn(`[JobHunter] Detail report error: ${error.message}`);
      return {
        inserted: 0,
        duplicates: 0,
        errors: [{ error: error.message }],
        attempted: Array.isArray(jobs) ? jobs.length : 0
      };
    }
  }

  // 分批创建记录
  async batchCreateRecords(records) {
    const results = [];
    const batchSize = 50;

    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      console.log(`[JobHunter] Pushing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(records.length / batchSize)} (${batch.length} records)...`);

      try {
        const token = await this.getFeishuToken();
        const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU_CONFIG.appToken}/tables/${FEISHU_CONFIG.tableId}/records/batch_create`;

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ records: batch })
        });

        const result = await response.json();

        if (result.code === 0) {
          const count = result.data?.records?.length || 0;
          console.log(`[JobHunter] Batch pushed: ${count} jobs`);
          results.push({ success: true, count });
        } else {
          console.error('[JobHunter] Batch push failed:', result);
          results.push({ success: false, count: 0, error: result });
        }
      } catch (error) {
        console.error('[JobHunter] Batch push error:', error);
        results.push({ success: false, count: 0, error: error.message });
      }
    }

    return results;
  }

  // 检查飞书连接是否正常
  async checkFeishuConnection() {
    try {
      await this.getFeishuToken();
      return true;
    } catch {
      return false;
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async closeTabIfNeeded(tabId) {
    if (!tabId) {
      return;
    }
    try {
      await chrome.tabs.remove(tabId);
      console.log(`[JobHunter] Closed task tab: ${tabId}`);
    } catch {
      console.log('[JobHunter] Tab already closed');
    }
  }

  async getSeenJobIdsSet() {
    const stored = await chrome.storage.local.get(SEEN_JOB_IDS_KEY);
    return new Set(Array.isArray(stored[SEEN_JOB_IDS_KEY]) ? stored[SEEN_JOB_IDS_KEY] : []);
  }

  async markJobIdSeen(encryptJobId, seenJobIds = null) {
    if (!encryptJobId) {
      return;
    }
    const localSeenJobIds = seenJobIds || await this.getSeenJobIdsSet();
    localSeenJobIds.add(encryptJobId);
    await chrome.storage.local.set({
      [SEEN_JOB_IDS_KEY]: Array.from(localSeenJobIds)
    });
  }

  selectDetailCandidates(jobs, seenJobIds) {
    const candidates = [];

    for (const job of jobs) {
      if (!job.encryptJobId) {
        this.runStats.missingEncryptJobIdCount++;
        console.log(`[JobHunter] Skipping job without encryptJobId: ${job.jobName}`);
        continue;
      }

      if (seenJobIds.has(job.encryptJobId)) {
        this.runStats.detailSkippedSeenCount++;
        console.log(`[JobHunter] Skipping seen job detail: ${job.jobName} (${job.encryptJobId})`);
        continue;
      }

      candidates.push(job);
    }

    console.log(`[JobHunter] Detail candidates: ${candidates.length}/${jobs.length}, missingEncryptJobId=${this.runStats.missingEncryptJobIdCount}, seenSkipped=${this.runStats.detailSkippedSeenCount}`);
    return candidates;
  }

  async scrapeJobListPages(tabId, { keyword, cityCode, pageSize, experience, maxPagesOverride = null }) {
    const mergedJobs = [];
    const seenListJobKeys = new Set();
    let lastError = null;
    let pagesFetched = 0;

    const maxPagesPerRun = Number.isInteger(maxPagesOverride)
      ? maxPagesOverride
      : this.getMaxListPagesPerRun();

    for (let page = 1; ; page += 1) {
      if (!this.isRunning) {
        console.log(`[JobHunter] List pagination stopped by user at page ${page}`);
        break;
      }
      if (maxPagesPerRun !== 0 && page > maxPagesPerRun) {
        break;
      }

      console.log(`[JobHunter] Fetching list page ${page}/${maxPagesPerRun === 0 ? 'unlimited' : maxPagesPerRun} for ${keyword}`);

      const pageResult = await this.sendMessageToTab(tabId, {
        type: 'SCRAPE_JOBS',
        keyword,
        cityCode,
        pageSize,
        experience,
        page
      });

      if (!pageResult.success) {
        lastError = pageResult.error;
        if (typeof pageResult.error === 'string' && pageResult.error.includes('Security check required')) {
          return {
            success: false,
            error: pageResult.error,
            code: pageResult.code,
            pagesFetched
          };
        }
        if (this.isAntiCrawlError(pageResult.error)) {
          console.warn(`[JobHunter] List page ${page} hit anti-crawl, stop pagination`);
        } else {
          console.warn(`[JobHunter] List page ${page} failed, stop pagination: ${pageResult.error}`);
        }

        if (page === 1 && mergedJobs.length === 0) {
          return {
            success: false,
            error: pageResult.error,
            code: pageResult.code,
            pagesFetched
          };
        }

        break;
      }

      const pageJobs = Array.isArray(pageResult.data) ? pageResult.data : [];
      pagesFetched += 1;
      console.log(`[JobHunter] List page ${page} returned ${pageJobs.length} jobs`);

      for (const job of pageJobs) {
        const dedupeKey = job.encryptJobId || job.securityId || `${job.jobName}::${job.brandName}::${job.salaryDesc}`;
        if (seenListJobKeys.has(dedupeKey)) continue;
        seenListJobKeys.add(dedupeKey);
        mergedJobs.push(job);
      }

      console.log(`[JobHunter] Paged list aggregate after page ${page}: ${mergedJobs.length} jobs`);

      if (pageJobs.length === 0 || pageJobs.length < pageSize) {
        console.log(`[JobHunter] List page ${page} indicates end of results, stop pagination`);
        break;
      }

      if (maxPagesPerRun === 0 || page < maxPagesPerRun) {
        if (!this.isRunning) {
          console.log(`[JobHunter] List pagination stopped by user before sleep`);
          break;
        }
        const pageDelay = this.currentDelay + Math.random() * 2000;
        console.log(`[JobHunter]   ⏱️ Waiting ${(pageDelay / 1000).toFixed(1)}s before next list page...`);
        await this.sleep(pageDelay);
      }
    }

    if (lastError) {
      console.log(`[JobHunter] Pagination finished with partial data after error: ${lastError}`);
    }

    return {
      success: true,
      data: mergedJobs,
      total: mergedJobs.length,
      pagesFetched,
      partial: Boolean(lastError),
      partialReason: lastError
    };
  }

  buildTaskResult({ city, keyword, taskId, status, total, pushed, filtered, errorCode, errorMessage, withDescription }) {
    return {
      task: {
        city: city.name || city,
        keyword,
        taskId: taskId || null
      },
      ...this.getVersionInfo(),
      status,
      total,
      withDescription: withDescription ?? this.runStats.detailDescriptionNonEmptyCount,
      pushed,
      filtered,
      errorCode,
      errorMessage,
      crawlState: this.crawlState.status,
      listCount: this.runStats.listCount,
      missingEncryptJobIdCount: this.runStats.missingEncryptJobIdCount,
      detailSkippedSeenCount: this.runStats.detailSkippedSeenCount,
      detailRequestedCount: this.runStats.detailRequestedCount,
      detailSuccessCount: this.runStats.detailSuccessCount,
      detailDescriptionNonEmptyCount: this.runStats.detailDescriptionNonEmptyCount,
      pagesFetched: this.runStats.pagesFetched,
      filterReasonStats: this.runStats.filterReasonStats || null,
      timestamp: Date.now()
    };
  }

  buildBossSearchUrl(keyword, cityCode) {
    const params = new URLSearchParams({
      query: keyword,
      city: cityCode
    });
    return `https://www.zhipin.com/web/geek/jobs?${params.toString()}`;
  }

  // 带重试机制的详情获取
  async fetchJobDetailWithRetry(tabId, job, maxRetries = 2) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const detailResult = await this.sendMessageToTab(tabId, {
          type: 'GET_JOB_DETAIL',
          securityId: job.securityId,
          lid: job.lid
        });

        if (detailResult.success && detailResult.data?.description?.length > 0) {
          return detailResult;
        }

        // 如果是最后一次尝试，返回失败结果
        if (attempt === maxRetries) {
          return detailResult;
        }

        // 失败时增加延迟再重试
        const retryDelay = 8000 + Math.random() * 5000;
        console.log(`[JobHunter]   🔄 Retry ${attempt + 1} for ${job.jobName} after ${(retryDelay/1000).toFixed(1)}s...`);
        await this.sleep(retryDelay);

      } catch (error) {
        if (attempt === maxRetries) {
          throw error;
        }
        console.log(`[JobHunter]   🔄 Retry ${attempt + 1} after error: ${error.message}`);
        await this.sleep(8000);
      }
    }
  }

  // ============ 规则过滤 ============

  /**
   * 轻量规则评分：对岗位打分，低于阈值则过滤
   * 返回 { score, reason }，reason为空表示通过
   */
  scoreJob(job, options = {}) {
    let score = 0;
    const title = job.jobName || '';
    const exp = job.jobExperience || '';
    const titleLower = title.toLowerCase();
    const filterMode = this.getJobFilterMode();
    const expHardExclude = this.getExpHardExcludeRegex();
    const manualKeyword = (options.manualKeyword || '').trim();

    // 硬排除：标题命中明确的校招性质词
    if (CONFIG.FILTER.TITLE_HARD_EXCLUDE.test(title)) {
      const match = title.match(CONFIG.FILTER.TITLE_HARD_EXCLUDE);
      return { score: -10, reason: `标题包含"${match[0]}"` };
    }
    
    // 软排除：实习/应届（但"接受实习/应届"不触发，因为是接受多种经验）
    if (!/接受.*实习|接受.*应届/.test(title)) {
      // 不是"接受实习"的情况，检查是否是纯实习/应届岗位
      if (/实习生|应届生|^实习[^接受]|^应届[^接受]/.test(title)) {
        return { score: -5, reason: '标题含实习/应届（非接受多种经验）' };
      }
    }

    // 硬排除：经验年限过长
    if (expHardExclude && expHardExclude.test(exp)) {
      const match = exp.match(expHardExclude);
      return { score: -10, reason: `经验"${match[0]}"` };
    }
    
    // 软排除：在校/应届（减分但不直接排除）
    if (/在校|应届/.test(exp)) {
      score -= 5;
    }

    if (manualKeyword) {
      if (!this.matchesManualKeyword(title, manualKeyword)) {
        return { score: -10, reason: `标题不匹配关键词"${manualKeyword}"` };
      }
    } else if (filterMode === 'general_pm' && !CONFIG.FILTER.GENERAL_PM_INCLUDE.test(title)) {
      return { score: -10, reason: '标题不属于产品经理岗位' };
    }

    if (filterMode === 'ai_focused') {
      // 方向加分：标题包含AI方向关键词
      for (const kw of CONFIG.FILTER.AI_DIRECTION_KEYWORDS) {
        if (titleLower.includes(kw.toLowerCase())) {
          score += 2;
          break;
        }
      }
    }

    // 产品经理加分
    if (titleLower.includes('产品') || titleLower.includes('product')) score += 2;

    // 经验加分：1-3年
    if (/1-3年|1~3年/.test(exp)) score += 2;
    
    // 经验不限减分（但不硬排除）
    if (/经验不限/.test(exp)) score -= 1;

    // 资深减分
    if (/总监|负责人|专家|leader|head|vp/i.test(title)) score -= 3;

    // 低于阈值则过滤
    if (score < CONFIG.FILTER.MIN_SCORE) {
      return { score, reason: `评分${score}，低于阈值${CONFIG.FILTER.MIN_SCORE}` };
    }

    return { score, reason: '' };
  }

  /**
   * 过滤岗位列表
   * 返回 { kept, filtered, filterReasonStats }
   *   filterReasonStats: { "原因摘要": [count, "岗位列表"] }
   */
  filterJobs(jobs, options = {}) {
    const kept = [];
    const filtered = [];
    const filterReasonStats = {};

    for (const job of jobs) {
      const { score, reason } = this.scoreJob(job, options);
      if (reason) {
        filtered.push({ ...job, _filtered: true, _filterReason: reason, _score: score });
        if (!filterReasonStats[reason]) filterReasonStats[reason] = [];
        filterReasonStats[reason].push(`${job.jobName}[${job.jobExperience || '经验未知'}]`);
      } else {
        kept.push(job);
      }
    }

    return { kept, filtered, filterReasonStats };
  }

  matchesManualKeyword(title, keyword) {
    const normalizedTitle = String(title || '').toLowerCase().replace(/\s+/g, '');
    const normalizedKeyword = String(keyword || '').toLowerCase().replace(/\s+/g, '');
    if (!normalizedKeyword) return true;

    const tokens = normalizedKeyword
      .split(/[+/,&|，、\s]+/)
      .map(token => token.trim())
      .filter(Boolean);

    if (tokens.length > 0) {
      return tokens.every(token => normalizedTitle.includes(token));
    }

    return normalizedTitle.includes(normalizedKeyword);
  }

  // ============ 采集统计 ============

  // 加载历史统计
  async loadStats() {
    try {
      const saved = await chrome.storage.local.get('crawl_stats');
      this.runStats = saved.crawl_stats?.latest || this.runStats;
    } catch (e) {
      // storage可能还没准备好
    }
  }

  // 保存统计（累计历史记录）
  async saveStats() {
    try {
      const saved = await chrome.storage.local.get('crawl_stats');
      const history = saved.crawl_stats || {};
      // 记录本次运行
      const runRecord = {
        ...this.runStats,
        timestamp: new Date().toISOString(),
        successRate: this.runStats.totalJobs > 0
          ? ((this.runStats.successWithDesc / this.runStats.totalJobs) * 100).toFixed(1) + '%'
          : 'N/A'
      };
      // 保留最近30次记录
      const runs = history.runs || [];
      runs.push(runRecord);
      if (runs.length > 30) runs.shift();

      await chrome.storage.local.set({
        crawl_stats: { latest: this.runStats, runs }
      });
      console.log('[JobHunter] Stats saved:', JSON.stringify(runRecord));
    } catch (e) {
      console.warn('[JobHunter] Failed to save stats:', e);
    }
  }

  // ============ 反爬状态机 + 批次调度 ============

  // 加载队列长度历史（用于堆积检测）
  // 带时效清理：只保留最近1小时的记录，避免跨会话/跨天误报
  async loadQueueLengthHistory() {
    try {
      const saved = await chrome.storage.local.get('queue_length_history');
      if (saved.queue_length_history) {
        const now = Date.now();
        const ONE_HOUR = 60 * 60 * 1000;
        // 过滤掉超过1小时的旧记录
        const validRecords = saved.queue_length_history.filter(r =>
          r.timestamp &&
          (now - r.timestamp) < ONE_HOUR &&
          Number.isInteger(r.length) &&
          r.length >= 0
        );
        this.queueLengthHistory = validRecords;
        if (validRecords.length < saved.queue_length_history.length) {
          console.log(`[JobHunter] Queue length history loaded: ${validRecords.length}/${saved.queue_length_history.length} (filtered ${saved.queue_length_history.length - validRecords.length} expired records)`);
        } else {
          console.log('[JobHunter] Queue length history loaded:', validRecords.length);
        }
      }
    } catch (e) {
      console.warn('[JobHunter] Failed to load queue length history:', e);
    }
  }

  // 保存队列长度历史
  async saveQueueLengthHistory() {
    try {
      await chrome.storage.local.set({
        queue_length_history: this.queueLengthHistory
      });
    } catch (e) {
      console.warn('[JobHunter] Failed to save queue length history:', e);
    }
  }

  // 加载反爬状态
  async loadCrawlState() {
    try {
      const saved = await chrome.storage.local.get('crawl_state');
      if (saved.crawl_state) {
        this.crawlState = { ...this.crawlState, ...saved.crawl_state };
        console.log('[JobHunter] Crawl state loaded:', this.crawlState.status);
      }
    } catch (e) {
      console.warn('[JobHunter] Failed to load crawl state:', e);
    }
  }

  // 保存反爬状态
  async saveCrawlState() {
    try {
      await chrome.storage.local.set({ crawl_state: this.crawlState });
    } catch (e) {
      console.warn('[JobHunter] Failed to save crawl state:', e);
    }
  }

  // 状态机转换
  async transitionCrawlState(trigger) {
    const oldStatus = this.crawlState.status;
    let newStatus = oldStatus;
    let blockedUntil = null;

    if (trigger === 'anti_crawl') {
      // 连续触发反爬，逐级升级
      if (oldStatus === 'normal') {
        newStatus = 'cooldown_1h';
        blockedUntil = Date.now() + 60 * 60 * 1000;  // 1小时
      } else if (oldStatus === 'cooldown_1h') {
        newStatus = 'cooldown_4h';
        blockedUntil = Date.now() + 4 * 60 * 60 * 1000;  // 4小时
      } else if (oldStatus === 'cooldown_4h') {
        newStatus = 'blocked_today';
        // 次日0点
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(0, 0, 0, 0);
        blockedUntil = tomorrow.getTime();
      }
      this.crawlState.consecutiveBatchFailures++;
      this.crawlState.lastAntiCrawlTime = Date.now();
      this.queueLengthHistory = [];
      await this.saveQueueLengthHistory();
      await chrome.storage.local.remove('last_queue_stuck_alert');
    } else if (trigger === 'success') {
      // 成功则重置连续失败计数（但不自动降级状态，等待时间到期）
      this.crawlState.consecutiveBatchFailures = 0;
    }

    this.crawlState.status = newStatus;
    this.crawlState.blockedUntil = blockedUntil;
    await this.saveCrawlState();

    if (oldStatus !== newStatus) {
      console.log(`[JobHunter] State transition: ${oldStatus} → ${newStatus}, blockedUntil: ${blockedUntil ? new Date(blockedUntil).toISOString() : 'null'}`);
    }
  }

  // 检查是否被阻塞
  async checkBlocked() {
    if (this.crawlState.blockedUntil && Date.now() < this.crawlState.blockedUntil) {
      const remaining = Math.ceil((this.crawlState.blockedUntil - Date.now()) / 60000);
      console.log(`[JobHunter] ⛔ Blocked: status=${this.crawlState.status}, remaining=${remaining}min`);
      return { blocked: true, remaining };
    }
    // 到期自动恢复
    if (this.crawlState.status !== 'normal') {
      console.log(`[JobHunter] ✅ Auto-resumed from ${this.crawlState.status} to normal`);
      this.crawlState.status = 'normal';
      this.crawlState.blockedUntil = null;
      await this.saveCrawlState();
    }
    return { blocked: false };
  }

  // 获取队列长度信息（用于早返回分支的堆积检测）
  async getQueueLengthInfo() {
    try {
      // 先检查控制面
      const res = await fetch(`${CONFIG.CONTROLLER_BASE_URL}/status`);
      if (res.ok) {
        const status = await res.json();
        // 控制面返回 pendingCount（包含 pending + urgent + failed）
        return {
          remaining: status.pendingCount || 0,
          fromController: true
        };
      }
    } catch {
      // 控制面不可达，回退到内置队列
    }
    // 内置队列
    const stored = await chrome.storage.local.get('pending_queue');
    const queueLength = stored.pending_queue ? stored.pending_queue.length : 0;
    return {
      remaining: queueLength,
      fromController: false
    };
  }

  // 初始化待处理队列
  async initPendingQueue() {
    try {
      const stored = await chrome.storage.local.get('pending_queue');
      if (!stored.pending_queue || stored.pending_queue.length === 0) {
        // 生成完整的城市×关键词队列（16个组合）
        const queue = [];
        for (const city of CONFIG.CITIES) {
          for (const keyword of CONFIG.KEYWORDS) {
            queue.push({ city, keyword });
          }
        }
        await chrome.storage.local.set({ pending_queue: queue });
        console.log('[JobHunter] Pending queue initialized:', queue.length);
        return queue;
      }
      return stored.pending_queue;
    } catch (e) {
      console.warn('[JobHunter] Failed to init pending queue:', e);
      return [];
    }
  }

  // 获取下一个任务
  async getNextTask() {
    const queue = await this.initPendingQueue();
    if (queue.length === 0) return { task: null, remaining: 0 };
    const task = queue.shift();
    await chrome.storage.local.set({ pending_queue: queue });
    return { task, remaining: queue.length };
  }

  // 任务放回队列头部（反爬中断时）
 async putBackTask(task) {
    const stored = await chrome.storage.local.get('pending_queue');
    const queue = stored.pending_queue || [];
    queue.unshift(task);
    await chrome.storage.local.set({ pending_queue: queue });
    console.log(`[JobHunter] Task put back to queue: ${task.keyword} in ${task.city.name}`);
  }

  // ============ HTTP 控制面交互 ============

  // 从控制面拉取队列
  async fetchQueueFromController() {
    try {
      const res = await fetch(`${CONFIG.CONTROLLER_BASE_URL}/status`);
      if (!res.ok) return null;
      const status = await res.json();

      if (status.paused) {
        console.log('[JobHunter] Controller is paused, skipping');
        return null;
      }

      const queueRes = await fetch(`${CONFIG.CONTROLLER_BASE_URL}/queue`);
      const queue = await queueRes.json();

      // 按优先级获取任务：urgent > pending > failed/blocked_retry（重试）
      // urgent: 用户标记的紧急任务
      // pending: 正常等待的任务
      // failed/blocked_retry: 之前失败或反爬阻断，需要重试的任务
      const urgentTasks = queue.filter(t => t.status === 'urgent');
      const pendingTasks = queue.filter(t => t.status === 'pending');
      const retryTasks = queue.filter(t => t.status === 'failed' || t.status === 'blocked_retry');

      let task = null;
      let taskType = '';

      if (urgentTasks.length > 0) {
        task = urgentTasks[0];
        taskType = 'urgent';
      } else if (pendingTasks.length > 0) {
        task = pendingTasks[0];
        taskType = 'pending';
      } else if (retryTasks.length > 0) {
        task = retryTasks[0];
        taskType = 'retry';
      }

      if (task) {
        // P0新增：向控制面声明领取任务
        // R3: 使用 taskId 精确匹配
        try {
          await fetch(`${CONFIG.CONTROLLER_BASE_URL}/claim`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              taskId: task.id,        // R3: 用 taskId 领取
              city: task.city.name || task.city,
              keyword: task.keyword,
              claimedBy: 'extension'
            })
          });
        } catch (e) {
          console.warn('[JobHunter] Failed to claim task:', e.message);
        }
        console.log(`[JobHunter] Controller task [${taskType}]: ${task.keyword} in ${task.city.name || task.city} (id: ${task.id})`);
        return {
          city: task.city,
          keyword: task.keyword,
          taskId: task.id,        // R3: 存储 taskId
          fromController: true
        };
      }
      return null;
    } catch (error) {
      // 控制面未启动或不可达，返回 null 以回退到内置队列
      return null;
    }
  }

  // 向控制面报告结果
  async reportToController(result) {
    try {
      const response = await fetch(`${CONFIG.CONTROLLER_BASE_URL}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(result)
      });
      if (!response.ok) {
        const errorText = await response.text();
        console.warn(`[JobHunter] Controller report rejected: ${response.status} ${errorText}`);
      }
    } catch (error) {
      console.warn('[JobHunter] Failed to report to controller:', error.message);
    }
  }

  /**
   * 将采集数据批量写入控制面 scraped_jobs 表
   * 适用于 51job 等非 Boss 平台的数据入库
   *
   * @param {Array<Object>} jobs - 归一化后的职位数据数组
   * @param {string} platform - 平台标识（如 '51job'）
   * @returns {Object} { inserted, duplicates, errors }
   */
  async reportJobsToController(jobs, platform, options = {}) {
    if (!jobs || jobs.length === 0) {
      return { inserted: 0, duplicates: 0, errors: [] };
    }

    try {
      const crawlBatchId = options.crawlBatchId || null;
      const normalizedJobs = crawlBatchId
        ? jobs.map((job) => (
          job && !job.crawlBatchId
            ? { ...job, crawlBatchId }
            : job
        ))
        : jobs;
      const response = await fetch(`${CONFIG.CONTROLLER_BASE_URL}/api/jobs/batch-insert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform,
          crawlBatchId,
          jobs: normalizedJobs
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[JobHunter] batch-insert rejected: ${response.status} ${errorText}`);
        return { inserted: 0, duplicates: 0, errors: [{ error: `HTTP_${response.status}` }] };
      }

      const result = await response.json();
      console.log(
        `[JobHunter] batch-insert: platform=${platform}, ` +
        `inserted=${result.inserted || 0}, duplicates=${result.duplicates || 0}`
      );
      return {
        inserted: result.inserted || 0,
        duplicates: result.duplicates || 0,
        errors: Array.isArray(result.errors) ? result.errors : []
      };
    } catch (error) {
      console.warn(`[JobHunter] batch-insert error: ${error.message}`);
      return { inserted: 0, duplicates: 0, errors: [{ error: error.message }] };
    }
  }

  async syncJobDetailStatusToController(job, platform) {
    if (!job || !platform || !job.platformJobId || !job.detailStatus || job.detailStatus === 'pending') {
      return false;
    }

    try {
      const response = await fetch(`${CONFIG.CONTROLLER_BASE_URL}/api/jobs/detail-status-update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform,
          platformJobId: job.platformJobId,
          detailStatus: job.detailStatus,
          description: job.description || '',
          errorCode: job.detailErrorCode || ''
        })
      });

      if (!response.ok) {
        return false;
      }
      return true;
    } catch (error) {
      console.warn(`[JobHunter] Failed to sync detail status for ${platform}/${job.platformJobId}: ${error.message}`);
      return false;
    }
  }

  normalizeBossJobForBatchInsert(job, batchId = null) {
    const location = [job.locationName, job.areaDistrict].filter(Boolean).join(' ');
    const keywords = Array.isArray(job.skills) ? job.skills.join(', ') : (job.skills || '');
    const experience = job.experience || job.jobExperience || '';
    const education = job.education || job.jobDegree || '';
    const resolvedUrl = job.url || null;
    return {
      platform: 'boss',
      platformJobId: job.encryptJobId || '',
      title: job.jobName || '',
      company: job.brandName || '',
      location: location || job.city || null,
      url: resolvedUrl,
      keywords,
      salary: job.salaryDesc || null,
      experience: experience || null,
      education: education || null,
      crawlBatchId: batchId || null,
      crawlMode: 'dashboard_manual',
      rawPayload: job
    };
  }

  // ============ 51job 采集调度（DOM解析模式） ============

  async get51JobAreaCatalog() {
    if (this._51jobAreaCatalogPromise) {
      return this._51jobAreaCatalogPromise;
    }

    this._51jobAreaCatalogPromise = (async () => {
      const response = await fetch('https://js.51jobcdn.com/in/js/2023/dd/dd_area_translation.json');
      if (!response.ok) {
        throw new Error(`51job area dictionary request failed: HTTP ${response.status}`);
      }

      const rows = await response.json();
      if (!Array.isArray(rows)) {
        throw new Error('51job area dictionary format invalid');
      }

      return rows
        .filter((item) => item && item.code && item.value && (item.codeType === '1' || item.codeType === '2'))
        .map((item) => ({
          code: String(item.code),
          name: String(item.value).trim(),
          type: item.codeType === '1' ? 'province' : 'city',
          parentProvinceCode: item.parentProvinceCode || '',
          childCityCodeList: Array.isArray(item.childCityCodeList) ? item.childCityCodeList : []
        }));
    })();

    try {
      return await this._51jobAreaCatalogPromise;
    } catch (error) {
      this._51jobAreaCatalogPromise = null;
      throw error;
    }
  }

  /**
   * 51job 专用采集流程
   * 通过 chrome.tabs 打开搜索页 → 向 content-51job.js 发送 SCRAPE_JOBS → 收集返回数据
   * 与 Boss 的 executeCrawlTask() 完全独立，互不干扰
   *
   * @returns {Object} { success, totalJobs, cityDetails }
   */
  async execute51JobCrawl(options = {}) {
    const areaCatalog = await this.get51JobAreaCatalog();
    const requestedCity = typeof options.city === 'string' ? options.city.trim() : '';
    const requestedKeyword = typeof options.keyword === 'string' ? options.keyword.trim() : '';
    const normalizeRequestedCity = (value) => String(value || '')
      .trim()
      .replace(/\s+/g, '')
      .replace(/市$/u, '')
      .replace(/省$/u, '')
      .toLowerCase();
    const normalizedRequestedCity = normalizeRequestedCity(requestedCity);
    const cities = requestedCity
      ? areaCatalog.filter((item) => {
        const normalizedName = normalizeRequestedCity(item.name);
        return normalizedName === normalizedRequestedCity ||
          normalizedName.includes(normalizedRequestedCity) ||
          normalizedRequestedCity.includes(normalizedName);
      })
      : areaCatalog.filter((item) => ['北京', '上海', '深圳', '杭州'].includes(item.name));
    const keywords = requestedKeyword ? [requestedKeyword] : (CONFIG.KEYWORDS || ['AI产品经理']);
    const allJobs = [];
    const cityDetails = [];
    const crawlBatchId = new Date().toISOString().slice(0, 16).replace(/[-T:]/g, '') +
      '-' + Math.random().toString(36).slice(2, 6);
    this.setActiveCrawlSession({
      isActive: true,
      platform: '51job',
      crawlBatchId,
      keyword: requestedKeyword || '',
      city: requestedCity || '',
      groupSize: 20,
      startedAt: Date.now(),
      endedAt: null
    });

    // 分页配置（复用智联的 MAX_LIST_PAGES 配置）
    const maxPages = this.getMaxListPages();
    const detailBudget = this.getDetailBudgetPerRun();
    const detailInterval = this.getDetailRequestIntervalMs();

    console.log(
      `[51job] 开始采集: ${cities.length} 城市 x ${keywords.length} 关键词, ` +
      `maxPages=${maxPages}, detailBudget=${detailBudget}, detailInterval=${detailInterval}ms`
    );

    try {
      if (cities.length === 0) {
        return {
          success: false,
          totalJobs: 0,
          cityDetails: [],
          jobs: [],
          error: `不支持的前程无忧城市: ${requestedCity}`
        };
      }

      let totalInserted = 0;

      for (const city of cities) {
        for (const keyword of keywords) {
          // 检查是否被用户停止
          if (!this.isRunning) {
            console.log('[51job] 采集被用户中断');
            break;
          }

          const crawlResult = await this._51jobCrawlCityKeyword(city, keyword, {
            maxPages,
            detailBudget,
            detailInterval,
            crawlBatchId
          });

          if (crawlResult.jobs.length > 0) {
            allJobs.push(...crawlResult.jobs);
          }
          cityDetails.push(crawlResult.detail);
          totalInserted += crawlResult.detail?.totalNew || 0;
        }

        // 外层中断检查
        if (!this.isRunning) break;
      }

      console.log(`[51job] 采集完成: 共 ${allJobs.length} 条职位`);

      return {
        success: true,
        totalJobs: allJobs.length,
        inserted: totalInserted,
        withDescription: allJobs.filter(job => Boolean(job.description && job.description.trim())).length,
        crawlBatchId,
        cityDetails,
        jobs: allJobs
      };
    } finally {
      this.setActiveCrawlSession({
        isActive: false,
        crawlBatchId,
        platform: '51job',
        endedAt: Date.now()
      });
    }
  }

  /**
   * 执行单个 city + keyword 的 51job 分页采集
   *
   * 调度流程（与智联 _zhaopinCrawlCityKeyword 同构）：
   * 1. 通过控制面 API 创建 p1 ~ pN 页码任务（platform='51job'）
   * 2. 逐页查询 pending 任务 → 标记 running → 采集 → 入库去重 → 标记 done
   * 3. 每页采集后检查终止条件
   * 4. 翻页 URL: https://we.51job.com/pc/search?jobArea={code}&keyword={kw}&curr={pageNum}
   *
   * @param {Object} city - { code, name }
   * @param {string} keyword - 搜索关键词
   * @param {Object} config - { maxPages, detailBudget, detailInterval }
   * @returns {Object} { jobs: Array, detail: Object }
   */
  async _51jobCrawlCityKeyword(city, keyword, config) {
    const { maxPages, detailBudget = 0, detailInterval = 3000, crawlBatchId = null } = config;
    const jobs = [];
    let consecutiveNoNewPages = 0;
    let totalFound = 0;
    let totalNew = 0;
    let effectiveMaxPages = maxPages;
    let remainingDetailBudget = detailBudget;

    const pageTaskResolution = await this._resolve51jobPageTasks(city, keyword, maxPages);
    let pendingTasks = pageTaskResolution.tasks;
    const usingControllerPageTasks = pageTaskResolution.usingController;

    // 按 page_number 排序
    pendingTasks.sort((a, b) => a.page_number - b.page_number);

    // SPA 模式：复用同一个 tab，p1 打开搜索页，p2+ 通过点击翻页
    let sharedTabId = null;
    const baseUrl =
      `https://we.51job.com/pc/search?jobArea=${city.code}` +
      `&keyword=${encodeURIComponent(keyword)}&searchType=2&keywordType=`;

    try {
      for (let taskIndex = 0; taskIndex < pendingTasks.length; taskIndex++) {
        // 检查是否被用户停止
        if (!this.isRunning) {
          console.log('[51job] 分页采集中断');
          break;
        }

        const task = pendingTasks[taskIndex];
        const pageNum = task.page_number;

        // 2a. 标记为 running
        if (usingControllerPageTasks && task.id) {
          try {
            await fetch(`${CONFIG.CONTROLLER_BASE_URL}/api/page-tasks/update`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: task.id, status: 'running' })
            });
          } catch (err) {
            console.warn(`[51job] 更新任务状态失败 (task#${task.id}): ${err.message}`);
          }
        }

        let pageJobs = [];
        let pageError = null;
        let pageMeta = null;

        try {
          if (pageNum === 1) {
            // p1: 打开搜索页（不带 curr 参数，避免 SPA 仍显示 p1 的问题）
            const tab = await this.createTabWithRetry({ url: baseUrl, active: false });
            sharedTabId = tab.id;
            console.log(`[51job] 打开标签页 ${sharedTabId}: ${city.name} - ${keyword} - p1`);
            await this.sleep(5000);
          } else {
            // p2+: 在同一个 tab 内通过 content script 点击翻页
            console.log(`[51job] 页内翻页: ${city.name} - ${keyword} - p${pageNum}`);
            const navResponse = await this.sendTabMessageWithRetry(
              sharedTabId,
              { type: 'NAVIGATE_TO_PAGE', page: pageNum }
            );
            if (!navResponse || !navResponse.success) {
              const navError = navResponse ? (navResponse.error || '翻页超时') : '无响应';
              console.warn(`[51job] 页内翻页失败 p${pageNum}: ${navError}`);
              pageError = navError;
              // 翻页失败视为空页，触发终止条件
            } else {
              // 翻页成功后短暂等待 DOM 渲染
              await this.sleep(3000);
            }
          }

          // 如果翻页没有失败，发送 SCRAPE_JOBS 采集当前页数据
          if (!pageError) {
            const response = await this.sendTabMessageWithRetry(sharedTabId, { type: 'SCRAPE_JOBS' });

            if (response && response.success && response.data && response.data.length > 0) {
              pageJobs = response.data;
              pageMeta = response.pagination || null;
              console.log(`[51job] ${city.name} ${keyword} p${pageNum}: 采集 ${pageJobs.length} 条`);
            } else {
              pageError = response ? (response.error || '无数据') : '无响应';
              pageMeta = response && response.pagination ? response.pagination : null;
              console.warn(`[51job] ${city.name} ${keyword} p${pageNum}: ${pageError}`);
            }
          }

          // 更新运行时统计
          this.runStats.pagesFetched++;
        } catch (err) {
          pageError = err.message;
          console.warn(`[51job] ${city.name} ${keyword} p${pageNum} 采集失败: ${err.message}`);
        }

        if (pageJobs.length > 0 && remainingDetailBudget > 0) {
          const detailResult = await this.enrich51JobDetails(pageJobs, {
            budget: remainingDetailBudget,
            interval: detailInterval,
            searchTabId: sharedTabId
          });
          remainingDetailBudget -= detailResult.consumed;
        }

        if (pageJobs.length > 0 && crawlBatchId) {
          for (const job of pageJobs) {
            if (job && !job.crawlBatchId) {
              job.crawlBatchId = crawlBatchId;
            }
          }
        }

        // 2c. 入库并统计新/重（复用 platform + platformJobId 唯一约束去重）
        let inserted = 0;
        let duplicated = 0;
        if (pageJobs.length > 0) {
          try {
            const insertResult = await this.reportJobsToController(pageJobs, '51job', { crawlBatchId });
            inserted = insertResult.inserted || 0;
            duplicated = insertResult.duplicates || 0;
            for (const job of pageJobs) {
              if (job?.detailStatus && job.detailStatus !== 'pending') {
                await this.syncJobDetailStatusToController(job, '51job');
              }
            }
          } catch (err) {
            console.warn(`[51job] 入库失败: ${err.message}`);
          }
          jobs.push(...pageJobs);
        }

        totalFound += pageJobs.length;
        totalNew += inserted;

        if (pageMeta && Number.isInteger(pageMeta.totalPages) && pageMeta.totalPages > effectiveMaxPages) {
          const previousMaxPages = effectiveMaxPages;
          effectiveMaxPages = pageMeta.totalPages;
          const existingPages = new Set(pendingTasks.map((item) => item.page_number));
          for (let nextPage = previousMaxPages + 1; nextPage <= effectiveMaxPages; nextPage++) {
            if (existingPages.has(nextPage)) continue;
            pendingTasks.push({
              id: null,
              page_number: nextPage,
              source: 'auto-pagination'
            });
          }
          pendingTasks.sort((a, b) => a.page_number - b.page_number);
          console.log(
            `[51job] 检测到真实分页 ${pageMeta.totalPages} 页，已从 ${previousMaxPages} 页扩展到 ${effectiveMaxPages} 页`
          );
        }

        // 2d. 更新任务状态为 done
        if (usingControllerPageTasks && task.id) {
          try {
            await fetch(`${CONFIG.CONTROLLER_BASE_URL}/api/page-tasks/update`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                id: task.id,
                status: pageJobs.length === 0 && pageError ? 'failed' : 'done',
                jobsFound: pageJobs.length,
                jobsNew: inserted,
                error: pageError || undefined
              })
            });
          } catch (err) {
            console.warn(`[51job] 更新任务完成状态失败 (task#${task.id}): ${err.message}`);
          }
        }

        // 2e. 检查页终止条件（复用智联的终止逻辑）
        const stopReason = this._checkPageStopCondition(pageJobs, inserted, consecutiveNoNewPages, pageNum, effectiveMaxPages);
        if (stopReason) {
          console.log(`[51job] 页终止条件触发: ${stopReason} (p${pageNum})`);
          break;
        }

        // 更新连续无新计数
        if (inserted === 0) {
          consecutiveNoNewPages++;
        } else {
          consecutiveNoNewPages = 0;
        }

        // 防反爬间隔（3-8秒随机延迟）
        const delay = 3000 + Math.random() * 5000;
        await this.sleep(delay);
      }
    } finally {
      // 所有页完成后关闭 tab（无论成功或异常）
      if (sharedTabId) {
        try { await chrome.tabs.remove(sharedTabId); } catch (e) { /* 忽略 */ }
        console.log(`[51job] 已关闭标签页 ${sharedTabId}`);
      }
    }

    return {
      jobs,
      detail: {
        city: city.name,
        keyword,
        count: jobs.length,
        totalFound,
        totalNew,
        withDescription: jobs.filter(job => Boolean(job.description && job.description.trim())).length
      }
    };
  }

  async createTabWithRetry(createProperties, maxAttempts = 3) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await chrome.tabs.create(createProperties);
      } catch (error) {
        lastError = error;
        const message = error && error.message ? error.message : String(error);
        const isTransient = /Tabs cannot be edited right now|dragging a tab/i.test(message);
        if (!isTransient || attempt === maxAttempts) {
          throw error;
        }
        console.warn(`[JobHunter] createTab transient failure (${attempt}/${maxAttempts}): ${message}`);
        await this.sleep(1200 * attempt);
      }
    }
    throw lastError || new Error('Failed to create tab');
  }

  async sendTabMessageWithRetry(tabId, message, maxAttempts = 3) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await chrome.tabs.sendMessage(tabId, message);
      } catch (error) {
        lastError = error;
        const text = error && error.message ? error.message : String(error);
        const isTransient = /Receiving end does not exist|message port closed|No tab with id/i.test(text);
        if (!isTransient || attempt === maxAttempts) {
          throw error;
        }
        console.warn(`[JobHunter] sendMessage transient failure (${attempt}/${maxAttempts}): ${text}`);
        await this.sleep(1000 * attempt);
      }
    }
    throw lastError || new Error('Failed to send tab message');
  }

  getPlatformLabel(platform) {
    const labels = {
      boss: 'Boss直聘',
      '51job': '前程无忧',
      liepin: '猎聘',
      zhaopin: '智联招聘'
    };
    return labels[platform] || platform || '目标平台';
  }

  getManualVerificationState() {
    return {
      required: Boolean(this.manualVerification.required),
      platform: this.manualVerification.platform || null,
      platformLabel: this.manualVerification.platformLabel || '',
      message: this.manualVerification.message || '',
      validationTabId: this.manualVerification.validationTabId || null,
      requestedAt: this.manualVerification.requestedAt || null
    };
  }

  setManualVerificationState(nextState = {}) {
    this.manualVerification = {
      ...this.manualVerification,
      ...nextState
    };
  }

  async focusManualVerificationTab() {
    const tabId = this.manualVerification.validationTabId;
    if (!tabId) return false;
    try {
      const tab = await chrome.tabs.get(tabId);
      await chrome.tabs.update(tab.id, { active: true });
      if (typeof tab.windowId === 'number') {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
      return true;
    } catch (error) {
      console.warn(`[JobHunter] Failed to focus verification tab ${tabId}: ${error.message}`);
      return false;
    }
  }

  async prepareManualVerificationTab({ platform, sourceTabId, currentUrl, duplicateFromSource = false }) {
    const label = this.getPlatformLabel(platform);
    let validationTabId = null;

    if (duplicateFromSource || !sourceTabId) {
      const tab = await this.createTabWithRetry({
        url: currentUrl,
        active: true
      });
      validationTabId = tab.id;
    } else {
      validationTabId = sourceTabId;
      await chrome.tabs.update(validationTabId, { active: true });
      try {
        const existingTab = await chrome.tabs.get(validationTabId);
        if (typeof existingTab.windowId === 'number') {
          await chrome.windows.update(existingTab.windowId, { focused: true });
        }
      } catch (error) {
        console.warn(`[JobHunter] Failed to focus ${label} verification window: ${error.message}`);
      }
    }

    this.setManualVerificationState({
      required: true,
      platform,
      platformLabel: label,
      message: `请在新打开的 ${label} 标签页中完成滑块验证，然后回到采集页点击“已验证”继续。`,
      validationTabId,
      requestedAt: Date.now()
    });

    return validationTabId;
  }

  async waitForManualVerification({ platform, sourceTabId, currentUrl, duplicateFromSource = false }) {
    if (this.manualVerification.required && this.manualVerification.platform === platform && this.manualVerificationResolver) {
      await this.focusManualVerificationTab();
      return new Promise((resolve) => {
        const previousResolver = this.manualVerificationResolver;
        this.manualVerificationResolver = (verified) => {
          previousResolver(verified);
          resolve(verified);
        };
      });
    }

    const validationTabId = await this.prepareManualVerificationTab({
      platform,
      sourceTabId,
      currentUrl,
      duplicateFromSource
    });

    return new Promise((resolve) => {
      this.manualVerificationResolver = (verified) => {
        this.manualVerificationResolver = null;
        this.setManualVerificationState({
          required: false,
          platform: null,
          platformLabel: '',
          message: '',
          validationTabId: null,
          requestedAt: null
        });
        resolve({ verified, validationTabId });
      };
    });
  }

  resolveManualVerification(verified) {
    if (!this.manualVerificationResolver) {
      this.setManualVerificationState({
        required: false,
        platform: null,
        platformLabel: '',
        message: '',
        validationTabId: null,
        requestedAt: null
      });
      return;
    }
    const resolver = this.manualVerificationResolver;
    this.manualVerificationResolver = null;
    this.setManualVerificationState({
      required: false,
      platform: null,
      platformLabel: '',
      message: '',
      validationTabId: null,
      requestedAt: null
    });
    resolver(Boolean(verified));
  }

  async waitForTabComplete(tabId, timeoutMs = 15000) {
    try {
      const currentTab = await chrome.tabs.get(tabId);
      if (currentTab && currentTab.status === 'complete') {
        return currentTab;
      }
    } catch (error) {
      throw new Error(`Tab ${tabId} not available: ${error.message}`);
    }

    return new Promise((resolve, reject) => {
      let timeoutId = null;

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        chrome.tabs.onUpdated.removeListener(listener);
      };

      const listener = (updatedTabId, info, tab) => {
        if (updatedTabId !== tabId) return;
        if (info.status === 'complete') {
          cleanup();
          resolve(tab);
        }
      };

      timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for tab ${tabId} to complete`));
      }, timeoutMs);

      chrome.tabs.onUpdated.addListener(listener);
    });
  }

  isMatching51JobDetailUrl(url, { expectedUrl = '', platformJobId = '' } = {}) {
    const candidate = String(url || '').trim();
    if (!candidate) return false;

    let parsed = null;
    try {
      parsed = new URL(candidate);
    } catch (error) {
      return false;
    }

    if (!/^jobs\.51job\.com$/i.test(parsed.hostname)) {
      return false;
    }

    if (platformJobId) {
      const escapedJobId = String(platformJobId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`/${escapedJobId}\\.html(?:$|[?#])`, 'i').test(parsed.pathname + parsed.search + parsed.hash)) {
        return true;
      }
    }

    if (!expectedUrl) return true;

    try {
      const expected = new URL(expectedUrl);
      return parsed.origin === expected.origin && parsed.pathname === expected.pathname;
    } catch (error) {
      return false;
    }
  }

  waitFor51JobDetailTab(searchTabId, {
    expectedUrl = '',
    platformJobId = '',
    knownTabIds = [],
    timeoutMs = 30000
  } = {}) {
    let cleanupRef = null;
    const promise = new Promise((resolve, reject) => {
      let timeoutId = null;
      let intervalId = null;
      let settled = false;
      const knownIds = new Set(Array.isArray(knownTabIds) ? knownTabIds.filter(Number.isFinite) : []);

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        if (intervalId) clearInterval(intervalId);
        chrome.tabs.onCreated.removeListener(handleCreated);
        chrome.tabs.onUpdated.removeListener(handleUpdated);
      };
      cleanupRef = cleanup;

      const maybeResolve = async (tabId, url, reusedSearchTab = false) => {
        if (settled) return;
        const candidateUrl = String(url || '').trim();
        if (!this.isMatching51JobDetailUrl(candidateUrl, { expectedUrl, platformJobId })) return;
        settled = true;
        cleanup();
        resolve({ tabId, url: candidateUrl, reusedSearchTab });
      };

      const handleCreated = (tab) => {
        if (!tab) return;
        maybeResolve(tab.id, tab.pendingUrl || tab.url || '', false);
      };

      const handleUpdated = (tabId, changeInfo, tab) => {
        const candidateUrl = changeInfo.url || tab?.pendingUrl || tab?.url || '';
        if (tabId === searchTabId) {
          maybeResolve(tabId, candidateUrl, true);
          return;
        }
        maybeResolve(tabId, candidateUrl, false);
      };

      const scanTabs = async () => {
        if (settled) return;
        if (searchTabId) {
          const searchTab = await chrome.tabs.get(searchTabId).catch(() => null);
          if (searchTab) {
            await maybeResolve(searchTabId, searchTab.pendingUrl || searchTab.url || '', true);
            if (settled) return;
          }
        }

        const tabs = await chrome.tabs.query({}).catch(() => []);
        for (const tab of tabs) {
          if (!tab || !Number.isFinite(tab.id)) continue;
          if (knownIds.has(tab.id)) continue;
          await maybeResolve(tab.id, tab.pendingUrl || tab.url || '', false);
          if (settled) return;
        }
      };

      timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for 51job detail tab from search tab ${searchTabId}`));
      }, timeoutMs);

      chrome.tabs.onCreated.addListener(handleCreated);
      chrome.tabs.onUpdated.addListener(handleUpdated);
      intervalId = setInterval(() => {
        scanTabs().catch(() => null);
      }, 500);
      scanTabs().catch(() => null);
    });

    return {
      promise,
      cancel: () => {
        if (cleanupRef) cleanupRef();
      }
    };
  }

  extract51JobPlatformJobId(job) {
    if (job && job.platformJobId) {
      return String(job.platformJobId).trim();
    }
    const url = job && job.url ? String(job.url) : '';
    const match = url.match(/\/(\d+)\.html/i);
    return match ? match[1] : '';
  }

  async fetch51JobDetailViaListClick(searchTabId, job) {
    const platformJobId = this.extract51JobPlatformJobId(job);
    if (!searchTabId || !platformJobId) {
      return null;
    }

    const existingTabs = await chrome.tabs.query({}).catch(() => []);
    const detailTabWaiter = this.waitFor51JobDetailTab(searchTabId, {
      expectedUrl: job.url || '',
      platformJobId,
      knownTabIds: existingTabs.map((tab) => tab && tab.id).filter(Number.isFinite),
      timeoutMs: 35000
    });
    let clickResponse = null;
    try {
      clickResponse = await this.sendTabMessageWithRetry(searchTabId, {
        type: 'OPEN_JOB_DETAIL_FROM_LIST',
        jobId: platformJobId
      });
    } catch (error) {
      detailTabWaiter.cancel();
      throw error;
    }

    if (!clickResponse || !clickResponse.success) {
      detailTabWaiter.cancel();
      throw new Error(clickResponse?.error || `Failed to open 51job detail from list for ${platformJobId}`);
    }

    const detailTab = await detailTabWaiter.promise;
    await this.waitForTabComplete(detailTab.tabId, 20000);
    await this.sleep(6000);
    await this.waitForContentScript(detailTab.tabId, 8);

    const response = await this.sendTabMessageWithRetry(detailTab.tabId, { type: 'GET_JOB_DETAIL' });
    return {
      response,
      tabId: detailTab.tabId,
      reusedSearchTab: detailTab.reusedSearchTab
    };
  }

  async recover51JobSearchTab(searchTabId) {
    if (!searchTabId) return;
    try {
      await chrome.tabs.goBack(searchTabId);
      await this.sleep(5000);
      await this.waitForTabComplete(searchTabId, 15000);
      await this.waitForContentScript(searchTabId, 6);
    } catch (error) {
      console.warn(`[51job] Failed to recover search tab ${searchTabId}: ${error.message}`);
    }
  }

  async enrich51JobDetails(pageJobs, { budget, interval, searchTabId = null }) {
    const targetJobs = pageJobs.filter(job => job && job.url && (!job.description || !job.description.trim())).slice(0, budget);
    let consumed = 0;

    for (const job of targetJobs) {
      if (!this.isRunning) break;

      let tabId = null;
      let reusedSearchTab = false;
      let response = null;
      try {
        if (searchTabId) {
          try {
            const clickResult = await this.fetch51JobDetailViaListClick(searchTabId, job);
            if (clickResult) {
              tabId = clickResult.tabId;
              reusedSearchTab = clickResult.reusedSearchTab;
              response = clickResult.response;
            }
          } catch (clickError) {
            console.warn(`[51job] 列表点击详情失败 (${this.extract51JobPlatformJobId(job)}): ${clickError.message}`);
          }
        }

        if (!response) {
          const tab = await this.createTabWithRetry({ url: job.url, active: false });
          tabId = tab.id;
          reusedSearchTab = false;
          await this.sleep(4000);
          response = await this.sendTabMessageWithRetry(tabId, { type: 'GET_JOB_DETAIL' });
        }

        if ((!response || response.code === 'ANTI_BOT') && tabId) {
          const currentTab = await chrome.tabs.get(tabId).catch(() => null);
          const currentUrl = currentTab?.url || job.url;
          const verificationResult = await this.waitForManualVerification({
            platform: '51job',
            sourceTabId: tabId,
            currentUrl,
            duplicateFromSource: reusedSearchTab
          });

          if (reusedSearchTab) {
            await this.recover51JobSearchTab(searchTabId);
            reusedSearchTab = false;
          }

          if (verificationResult && verificationResult.verified) {
            tabId = verificationResult.validationTabId || tabId;
            await this.waitForTabComplete(tabId, 20000).catch(() => null);
            await this.sleep(3000);
            response = await this.sendTabMessageWithRetry(tabId, { type: 'GET_JOB_DETAIL' }).catch(() => null);
          }
        }

        if (response && response.success && response.data && response.data.description) {
          job.description = response.data.description;
          if (response.data.location) job.location = job.location || response.data.location;
          if (response.data.salary) job.salary = job.salary || response.data.salary;
          if (response.data.education) job.education = job.education || response.data.education;
          if (response.data.experience) job.experience = job.experience || response.data.experience;
          if (response.data.keywords) job.keywords = job.keywords || response.data.keywords;
          job.detailStatus = 'success';
          job.detailErrorCode = '';
        } else if (response && response.success && response.data) {
          job.detailStatus = 'empty';
          job.detailErrorCode = 'empty_description';
        } else {
          const detailCode = response && response.code ? String(response.code) : '';
          if (detailCode === 'ANTI_BOT') {
            job.detailStatus = 'anti_bot';
            job.detailErrorCode = 'anti_bot';
          } else if (detailCode === 'NO_DATA' || detailCode === 'NO_VALID_DATA') {
            job.detailStatus = 'empty';
            job.detailErrorCode = detailCode.toLowerCase();
          } else {
            job.detailStatus = 'error';
            job.detailErrorCode = detailCode ? detailCode.toLowerCase() : 'detail_fetch_failed';
          }
        }
      } catch (error) {
        console.warn(`[51job] 详情补抓失败 (${job.url}): ${error.message}`);
        job.detailStatus = 'error';
        job.detailErrorCode = 'detail_fetch_exception';
      } finally {
        if (tabId) {
          if (reusedSearchTab) {
            await this.recover51JobSearchTab(searchTabId);
          } else {
            try { await chrome.tabs.remove(tabId); } catch (e) { /* ignore */ }
          }
        }
      }

      consumed++;
      if (interval > 0) {
        await this.sleep(interval);
      }
    }

    return { consumed };
  }

  /**
   * 智联招聘专用采集流程（分页调度版）
   * 通过 crawl_page_tasks 表驱动 p1→pN 分页
   *
   * 分页调度逻辑:
   * 1. 为每个 city + keyword 组合创建 crawl_page_tasks 记录（status = pending）
   * 2. 逐页执行：按页码排序查询 status = pending 的任务
   * 3. 每页：更新 status = running → 打开标签页采集 → 更新 status = done
   * 4. 页终止条件（满足任一即停止翻页）：
   *    - 空页：当前页返回 0 条岗位
   *    - 高重复率：当前页新岗位占比 < 10%
   *    - 连续无新：连续 2 页无任何新岗位
   *    - 硬上限：单次任务最多翻 MAX_LIST_PAGES 页（默认 1）
   *
   * 与 Boss / 51job 完全独立，互不干扰
   *
   * @returns {Object} { success, totalJobs, cityDetails, jobs }
   */
  async executeZhaopinCrawl(options = {}) {
    // 智联招聘城市编码（与 content-zhaopin.js 保持一致）
    const cityCatalog = [
      { code: '530', name: '北京' },
      { code: '538', name: '上海' },
      { code: '765', name: '深圳' },
      { code: '653', name: '杭州' },
      { code: '763', name: '广州' },
      { code: '801', name: '成都' },
      { code: '635', name: '南京' },
      { code: '736', name: '武汉' },
      { code: '854', name: '西安' },
      { code: '636', name: '苏州' }
    ];
    const requestedCity = typeof options.city === 'string' ? options.city.trim() : '';
    const requestedKeyword = typeof options.keyword === 'string' ? options.keyword.trim() : '';
    const cities = requestedCity
      ? cityCatalog.filter((item) => item.name === requestedCity)
      : cityCatalog.filter((item) => ['北京', '上海', '深圳', '杭州'].includes(item.name));
    const keywords = requestedKeyword ? [requestedKeyword] : (CONFIG.KEYWORDS || ['AI产品经理']);
    const allJobs = [];
    const cityDetails = [];

    // 分页配置（均从 runtime_config 读取，可配置化）
    const maxPages = this.getMaxListPages();
    const detailBudget = this.getDetailBudgetPerRun();
    const detailInterval = this.getDetailRequestIntervalMs();

    // 详情降级计数器
    let consecutiveDetailFailCount = 0;
    let detailDegraded = false;

    console.log(
      `[zhaopin] 开始采集: ${cities.length} 城市 x ${keywords.length} 关键词, ` +
      `maxPages=${maxPages}, detailBudget=${detailBudget}, detailInterval=${detailInterval}ms`
    );

    if (cities.length === 0) {
      return {
        success: false,
        totalJobs: 0,
        cityDetails: [],
        jobs: [],
        error: `不支持的智联城市: ${requestedCity}`
      };
    }

    for (const city of cities) {
      for (const keyword of keywords) {
        // 检查是否被用户停止
        if (!this.isRunning) {
          console.log('[zhaopin] 采集被用户中断');
          break;
        }

        const crawlResult = await this._zhaopinCrawlCityKeyword(city, keyword, {
          maxPages, detailBudget, detailInterval
        });

        if (crawlResult.jobs.length > 0) {
          allJobs.push(...crawlResult.jobs);
        }
        cityDetails.push(crawlResult.detail);
      }

      // 外层中断检查
      if (!this.isRunning) break;
    }

    // ===== 详情 backlog 消费（列表采集完成后） =====
    let detailBacklogConsumed = 0;
    let detailBacklogSuccess = 0;

    if (detailBudget > 0 && this.isRunning) {
      try {
        const backlogResult = await this._zhaopinConsumeDetailBacklog({
          budget: detailBudget,
          interval: detailInterval,
          onFail: () => { consecutiveDetailFailCount++; },
          onSuccess: () => { consecutiveDetailFailCount = 0; },
          shouldStop: () => consecutiveDetailFailCount >= 2 || !this.isRunning
        });
        detailBacklogConsumed = backlogResult.consumed;
        detailBacklogSuccess = backlogResult.successCount;

        if (consecutiveDetailFailCount >= 2) {
          detailDegraded = true;
          console.warn(
            `[Zhaopin] Detail degradation triggered after ${consecutiveDetailFailCount} consecutive failures`
          );
        }
      } catch (err) {
        console.warn(`[zhaopin] Detail backlog consumption error: ${err.message}`);
      }
    }

    console.log(
      `[zhaopin] 采集完成: 共 ${allJobs.length} 条职位, ` +
      `详情补抓 consumed=${detailBacklogConsumed} success=${detailBacklogSuccess}` +
      (detailDegraded ? ' [DEGRADED]' : '')
    );

    return {
      success: true,
      totalJobs: allJobs.length,
      cityDetails,
      jobs: allJobs,
      detailBacklogConsumed,
      detailBacklogSuccess,
      detailDegraded
    };
  }

  /**
   * 执行单个 city + keyword 的分页采集
   *
   * 调度流程：
   * 1. 通过控制面 API 创建 p1 ~ pN 页码任务
   * 2. 逐页查询 pending 任务 → 标记 running → 采集 → 标记 done
   * 3. 每页采集后检查终止条件
   *
   * @param {Object} city - { code, name }
   * @param {string} keyword - 搜索关键词
   * @param {Object} config - { maxPages, detailBudget, detailInterval }
   * @returns {Object} { jobs: Array, detail: Object }
   */
  async _zhaopinCrawlCityKeyword(city, keyword, config) {
    const { maxPages } = config;
    const jobs = [];
    let consecutiveNoNewPages = 0;
    let totalFound = 0;
    let totalNew = 0;
    let effectiveMaxPages = maxPages;

    const pageTaskResolution = await this._resolveZhaopinPageTasks(city, keyword, maxPages);
    let pendingTasks = pageTaskResolution.tasks;
    const usingControllerPageTasks = pageTaskResolution.usingController;

    // 按 page_number 排序
    pendingTasks.sort((a, b) => a.page_number - b.page_number);

    for (let taskIndex = 0; taskIndex < pendingTasks.length; taskIndex++) {
      // 检查是否被用户停止
      if (!this.isRunning) {
        console.log('[zhaopin] 分页采集中断');
        break;
      }

      const task = pendingTasks[taskIndex];
      const pageNum = task.page_number;

      // 2a. 标记为 running
      if (usingControllerPageTasks && task.id) {
        try {
          await fetch(`${CONFIG.CONTROLLER_BASE_URL}/api/page-tasks/update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: task.id, status: 'running' })
          });
        } catch (err) {
          console.warn(`[zhaopin] 更新任务状态失败 (task#${task.id}): ${err.message}`);
        }
      }

      // 2b. 构建翻页 URL 并采集
      const searchUrl = `https://www.zhaopin.com/sou/jl${city.code}/kw${encodeURIComponent(keyword)}/p${pageNum}`;
      let tabId = null;
      let pageJobs = [];
      let pageError = null;
      let pageMeta = null;

      try {
        const tab = await chrome.tabs.create({ url: searchUrl, active: false });
        tabId = tab.id;
        console.log(`[zhaopin] 打开标签页 ${tabId}: ${city.name} - ${keyword} - p${pageNum}`);

        // 等待页面加载 + content script 注入
        await this.sleep(5000);

        const response = await chrome.tabs.sendMessage(tabId, { type: 'SCRAPE_JOBS' });

        if (response && response.success && response.data && response.data.length > 0) {
          pageJobs = response.data;
          pageMeta = response.pagination || null;
          console.log(`[zhaopin] ${city.name} ${keyword} p${pageNum}: 采集 ${pageJobs.length} 条`);
        } else {
          pageError = response ? (response.error || '无数据') : '无响应';
          pageMeta = response && response.pagination ? response.pagination : null;
          console.warn(`[zhaopin] ${city.name} ${keyword} p${pageNum}: ${pageError}`);
        }

        // 更新运行时统计
        this.runStats.pagesFetched++;
      } catch (err) {
        pageError = err.message;
        console.warn(`[zhaopin] ${city.name} ${keyword} p${pageNum} 采集失败: ${err.message}`);
      }

      // 关闭标签页
      if (tabId) {
        try { await chrome.tabs.remove(tabId); } catch (e) { /* 忽略 */ }
      }

      // 2c. 入库并统计新/重
      let inserted = 0;
      let duplicated = 0;
      if (pageJobs.length > 0) {
        try {
          const insertResult = await this.reportJobsToController(pageJobs, 'zhaopin');
          inserted = insertResult.inserted || 0;
          duplicated = insertResult.duplicates || 0;
        } catch (err) {
          console.warn(`[zhaopin] 入库失败: ${err.message}`);
        }
        jobs.push(...pageJobs);
      }

      totalFound += pageJobs.length;
      totalNew += inserted;

      if (!usingControllerPageTasks && pageMeta && Number.isInteger(pageMeta.totalPages) && pageMeta.totalPages > effectiveMaxPages) {
        const previousMaxPages = effectiveMaxPages;
        effectiveMaxPages = pageMeta.totalPages;
        for (let nextPage = previousMaxPages + 1; nextPage <= effectiveMaxPages; nextPage++) {
          pendingTasks.push({
            id: null,
            page_number: nextPage,
            source: 'auto-pagination'
          });
        }
        pendingTasks.sort((a, b) => a.page_number - b.page_number);
        console.log(
          `[zhaopin] 检测到真实分页 ${pageMeta.totalPages} 页，已从 ${previousMaxPages} 页扩展到 ${effectiveMaxPages} 页`
        );
      }

      // 2d. 更新任务状态为 done
      if (usingControllerPageTasks && task.id) {
        try {
          await fetch(`${CONFIG.CONTROLLER_BASE_URL}/api/page-tasks/update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: task.id,
              status: 'done',
              jobsFound: pageJobs.length,
              jobsNew: inserted
            })
          });
        } catch (err) {
          console.warn(`[zhaopin] 更新任务完成状态失败 (task#${task.id}): ${err.message}`);
        }
      }

      // 2e. 检查页终止条件
      const stopReason = this._checkPageStopCondition(pageJobs, inserted, consecutiveNoNewPages, pageNum, effectiveMaxPages);
      if (stopReason) {
        console.log(`[zhaopin] 页终止条件触发: ${stopReason} (p${pageNum})`);
        break;
      }

      // 更新连续无新计数
      if (inserted === 0) {
        consecutiveNoNewPages++;
      } else {
        consecutiveNoNewPages = 0;
      }

      // 防反爬间隔
      const delay = 5000 + Math.random() * 3000;
      await this.sleep(delay);
    }

    return {
      jobs,
      detail: {
        city: city.name,
        keyword,
        count: jobs.length,
        totalFound,
        totalNew
      }
    };
  }

  async _resolve51jobPageTasks(city, keyword, maxPages) {
    const localTasks = Array.from({ length: maxPages }, (_, index) => ({
      id: null,
      page_number: index + 1,
      source: 'local-fallback'
    }));

    let controllerApiAvailable = true;

    for (let p = 1; p <= maxPages; p++) {
      try {
        const resp = await fetch(`${CONFIG.CONTROLLER_BASE_URL}/api/page-tasks/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            platform: '51job',
            city: city.name,
            keyword,
            pageNumber: p
          })
        });

        if (!resp.ok) {
          controllerApiAvailable = false;
          console.warn(`[51job] page-tasks/create unavailable (${resp.status}), fallback to local pagination`);
          break;
        }

        const result = await resp.json();
        if (!result.success) {
          controllerApiAvailable = false;
          console.warn(`[51job] page-tasks/create returned failure (${result.error || 'unknown'}), fallback to local pagination`);
          break;
        }
      } catch (err) {
        controllerApiAvailable = false;
        console.warn(`[51job] 创建页码任务失败: ${err.message}, fallback to local pagination`);
        break;
      }
    }

    if (!controllerApiAvailable) {
      return { usingController: false, tasks: localTasks };
    }

    try {
      const pendingResp = await fetch(
        `${CONFIG.CONTROLLER_BASE_URL}/api/page-tasks/pending?platform=51job&city=${encodeURIComponent(city.name)}&keyword=${encodeURIComponent(keyword)}&limit=${maxPages}`
      );

      if (!pendingResp.ok) {
        console.warn(`[51job] page-tasks/pending unavailable (${pendingResp.status}), fallback to local pagination`);
        return { usingController: false, tasks: localTasks };
      }

      const pendingResult = await pendingResp.json();
      const pendingTasks = pendingResult.success ? (pendingResult.tasks || []) : [];

      if (pendingTasks.length === 0) {
        console.warn(`[51job] No pending page tasks for ${city.name}/${keyword}, fallback to local pagination`);
        return { usingController: false, tasks: localTasks };
      }

      return { usingController: true, tasks: pendingTasks };
    } catch (err) {
      console.warn(`[51job] 查询待执行页码任务失败: ${err.message}, fallback to local pagination`);
      return { usingController: false, tasks: localTasks };
    }
  }

  async _resolveZhaopinPageTasks(city, keyword, maxPages) {
    const localTasks = Array.from({ length: maxPages }, (_, index) => ({
      id: null,
      page_number: index + 1,
      source: 'local-fallback'
    }));

    let controllerApiAvailable = true;

    for (let p = 1; p <= maxPages; p++) {
      try {
        const resp = await fetch(`${CONFIG.CONTROLLER_BASE_URL}/api/page-tasks/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            platform: 'zhaopin',
            city: city.name,
            keyword,
            pageNumber: p
          })
        });

        if (!resp.ok) {
          controllerApiAvailable = false;
          console.warn(
            `[zhaopin] page-tasks/create unavailable (${resp.status}), fallback to local pagination`
          );
          break;
        }

        const result = await resp.json();
        if (!result.success) {
          controllerApiAvailable = false;
          console.warn(
            `[zhaopin] page-tasks/create returned failure (${result.error || 'unknown'}), fallback to local pagination`
          );
          break;
        }
      } catch (err) {
        controllerApiAvailable = false;
        console.warn(`[zhaopin] 创建页码任务失败: ${err.message}, fallback to local pagination`);
        break;
      }
    }

    if (!controllerApiAvailable) {
      return { usingController: false, tasks: localTasks };
    }

    try {
      const pendingResp = await fetch(
        `${CONFIG.CONTROLLER_BASE_URL}/api/page-tasks/pending?platform=zhaopin&city=${encodeURIComponent(city.name)}&keyword=${encodeURIComponent(keyword)}&limit=${maxPages}`
      );

      if (!pendingResp.ok) {
        console.warn(
          `[zhaopin] page-tasks/pending unavailable (${pendingResp.status}), fallback to local pagination`
        );
        return { usingController: false, tasks: localTasks };
      }

      const pendingResult = await pendingResp.json();
      const pendingTasks = pendingResult.success ? (pendingResult.tasks || []) : [];

      if (pendingTasks.length === 0) {
        console.warn(
          `[zhaopin] No pending page tasks for ${city.name}/${keyword}, fallback to local pagination`
        );
        return { usingController: false, tasks: localTasks };
      }

      return { usingController: true, tasks: pendingTasks };
    } catch (err) {
      console.warn(`[zhaopin] 查询待执行页码任务失败: ${err.message}, fallback to local pagination`);
      return { usingController: false, tasks: localTasks };
    }
  }

  /**
   * 检查分页终止条件
   *
   * 终止条件（满足任一即返回停止原因）：
   * - 空页：当前页返回 0 条岗位
   * - 高重复率：当前页新岗位占比 < 10%（且至少有 5 条以上数据才有意义）
   * - 连续无新：连续 2 页无任何新岗位
   * - 硬上限：已达最大页数
   *
   * @param {Array} pageJobs - 当前页采集到的职位
   * @param {number} inserted - 当前页新入库的职位数
   * @param {number} consecutiveNoNewPages - 已连续无新页数
   * @param {number} currentPage - 当前页码
   * @param {number} maxPages - 最大页数
   * @returns {string|null} 终止原因，null 表示继续翻页
   */
  _checkPageStopCondition(pageJobs, inserted, consecutiveNoNewPages, currentPage, maxPages) {
    // 空页：当前页 0 条岗位
    if (pageJobs.length === 0) {
      return '空页: 当前页返回 0 条岗位';
    }

    // 高重复率：新岗位占比 < 10%
    if (currentPage > 1 && pageJobs.length >= 5) {
      const newRatio = inserted / pageJobs.length;
      if (newRatio < 0.1) {
        return `高重复率: 新岗位占比 ${(newRatio * 100).toFixed(1)}% < 10%`;
      }
    }

    // 连续无新：连续 2 页无新岗位
    if (consecutiveNoNewPages >= 2) {
      return `连续无新: 已连续 ${consecutiveNoNewPages} 页无新岗位`;
    }

    // 硬上限：已达到最大页数
    if (currentPage >= maxPages) {
      return `硬上限: 已达最大页数 ${maxPages}`;
    }

    return null;
  }

  /**
   * 消费智联详情 backlog 队列
   *
   * 从控制器 API 获取待补详情的岗位列表，逐个打开详情页抓取正文，
   * 更新 detail_status。支持连续失败自动降级。
   *
   * @param {Object} config
   * @param {number} config.budget - 本轮详情预算（最大补抓数）
   * @param {number} config.interval - 详情请求间隔（毫秒）
   * @param {Function} config.onFail - 单次失败回调
   * @param {Function} config.onSuccess - 单次成功回调
   * @param {Function} config.shouldStop - 是否应停止消费（降级检查）
   * @returns {Object} { consumed, successCount }
   */
  async _zhaopinConsumeDetailBacklog({ budget, interval, onFail, onSuccess, shouldStop }) {
    let consumed = 0;
    let successCount = 0;

    if (budget <= 0) return { consumed: 0, successCount: 0 };

    // 从控制器 API 获取 backlog 队列
    let backlogJobs = [];
    try {
      const resp = await fetch(
        `${CONFIG.CONTROLLER_BASE_URL}/api/jobs/detail-backlog?platform=zhaopin&limit=${budget}`
      );
      const result = await resp.json();
      if (result.success && Array.isArray(result.jobs)) {
        backlogJobs = result.jobs;
      }
    } catch (err) {
      console.warn(`[zhaopin] Failed to fetch detail backlog: ${err.message}`);
      return { consumed: 0, successCount: 0 };
    }

    if (backlogJobs.length === 0) {
      console.log('[zhaopin] Detail backlog is empty, nothing to consume');
      return { consumed: 0, successCount: 0 };
    }

    console.log(`[zhaopin] Detail backlog: ${backlogJobs.length} jobs to process (budget=${budget})`);

    for (const job of backlogJobs) {
      // 降级检查
      if (shouldStop()) {
        console.log(`[zhaopin] Detail backlog stopped early (degradation or user stop)`);
        break;
      }

      if (!job.url) {
        console.warn(`[zhaopin] Skipping backlog job without URL: ${job.platformJobId}`);
        continue;
      }

      let tabId = null;
      let detailResponse = null;

      try {
        const tab = await chrome.tabs.create({ url: job.url, active: false });
        tabId = tab.id;
        console.log(`[zhaopin] Detail backlog: opening ${job.platformJobId} (${tabId})`);

        // 等待详情页加载
        await this.sleep(5000);

        detailResponse = await chrome.tabs.sendMessage(tabId, { type: 'GET_JOB_DETAIL' });
      } catch (err) {
        console.warn(`[zhaopin] Detail backlog fetch failed for ${job.platformJobId}: ${err.message}`);
        detailResponse = null;
      }

      // 关闭标签页
      if (tabId) {
        try { await chrome.tabs.remove(tabId); } catch (e) { /* 忽略 */ }
      }

      // 解析详情结果并更新状态
      const updatePayload = {
        platform: 'zhaopin',
        platformJobId: job.platformJobId
      };

      if (detailResponse && detailResponse.success && detailResponse.detailStatus === 'success') {
        // 详情成功
        updatePayload.detailStatus = 'success';
        updatePayload.description = detailResponse.data?.description || '';
        successCount++;
        if (onSuccess) onSuccess();
        console.log(`[zhaopin] Detail backlog success: ${job.platformJobId}`);
      } else if (detailResponse && detailResponse.detailStatus === 'anti_bot') {
        // 风控拦截
        updatePayload.detailStatus = 'anti_bot';
        updatePayload.errorCode = detailResponse.detailErrorCode || 'anti_bot';
        if (onFail) onFail();
        console.warn(`[zhaopin] Detail backlog anti_bot: ${job.platformJobId}`);
      } else if (detailResponse && detailResponse.detailStatus === 'empty') {
        // 正文为空
        updatePayload.detailStatus = 'empty';
        updatePayload.errorCode = detailResponse.detailErrorCode || 'empty_content';
        if (onFail) onFail();
        console.warn(`[zhaopin] Detail backlog empty: ${job.platformJobId}`);
      } else if (detailResponse && !detailResponse.success) {
        // 解析失败
        updatePayload.detailStatus = 'error';
        updatePayload.errorCode = detailResponse.detailErrorCode || detailResponse.code || 'unknown_error';
        if (onFail) onFail();
        console.warn(`[zhaopin] Detail backlog error: ${job.platformJobId} - ${detailResponse.error}`);
      } else {
        // 无响应（标签页打开失败等）
        updatePayload.detailStatus = 'error';
        updatePayload.errorCode = 'no_response';
        if (onFail) onFail();
        console.warn(`[zhaopin] Detail backlog no response: ${job.platformJobId}`);
      }

      // 通过控制器 API 更新 detail_status
      try {
        await fetch(`${CONFIG.CONTROLLER_BASE_URL}/api/jobs/detail-status-update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updatePayload)
        });
      } catch (err) {
        console.warn(`[zhaopin] Failed to update detail status for ${job.platformJobId}: ${err.message}`);
      }

      consumed++;

      // 间隔等待
      if (consumed < backlogJobs.length && !shouldStop()) {
        const jitter = Math.random() * 1000;
        await this.sleep(interval + jitter);
      }
    }

    return { consumed, successCount };
  }

  // ============ 反爬自适应策略 ============

  // 检测是否是反爬错误
  isAntiCrawlError(errorMessage) {
    if (!errorMessage) return false;
    
    // 检查错误码
    for (const code of CONFIG.ANTI_CRAWL.ANTI_CRAWL_CODES) {
      if (errorMessage.includes(`code=${code}`) || errorMessage.includes(`code: ${code}`)) {
        return true;
      }
    }
    
    // 检查关键词
    const antiCrawlKeywords = ['环境异常', '环境存在异常', '操作频繁', '请稍后重试', '访问过快'];
    return antiCrawlKeywords.some(keyword => errorMessage.includes(keyword));
  }
  
  // 触发冷却期
  async triggerCooldown() {
    this.isCooldown = true;
    console.log(`[JobHunter] 🧊 TRIGGERING COOLDOWN for ${CONFIG.ANTI_CRAWL.COOLDOWN_TIME/1000}s...`);
    console.log(`[JobHunter] 🧊 Too many consecutive failures, cooling down...`);
    
    await this.sleep(CONFIG.ANTI_CRAWL.COOLDOWN_TIME);
    
    this.isCooldown = false;
    this.consecutiveFailures = 0;
    // 优化：保持增加后的延迟，不要重置为BASE_DELAY（Boss反爬有记忆效应）
    // this.currentDelay = CONFIG.ANTI_CRAWL.BASE_DELAY;
    console.log(`[JobHunter] ✅ Cooldown finished, resuming with delay: ${this.currentDelay}ms`);
  }
  
  // 动态增加延迟
  async increaseDelay() {
    const oldDelay = this.currentDelay;
    this.currentDelay = Math.min(
      this.currentDelay + CONFIG.ANTI_CRAWL.DELAY_INCREMENT,
      CONFIG.ANTI_CRAWL.MAX_DELAY
    );
    
    console.log(`[JobHunter] 📈 Delay increased: ${oldDelay}ms → ${this.currentDelay}ms`);
    
    // 记录反爬时间
    await chrome.storage.local.set({ last_anti_crawl_time: Date.now() });
    
    // 立即执行一次额外等待
    const extraWait = 5000 + Math.random() * 3000;
    console.log(`[JobHunter] ⏱️ Extra wait ${(extraWait/1000).toFixed(1)}s due to anti-crawl...`);
    await this.sleep(extraWait);
  }
}

// 启动服务
const service = new JobHunterService();

// ============ 平台爬虫路由 ============
const scrapers = {
  boss: (data) => {
    service.pushToFeishu(Array.isArray(data) ? data : [data]);
  },
  '51job': (data) => {
    const jobs = Array.isArray(data) ? data : [data];
    console.log(`[路由] 51job 数据已接收，共 ${jobs.length} 条，写入 scraped_jobs`);
    service.reportJobsToController(jobs, '51job');
  },
  zhaopin: (data) => {
    const jobs = Array.isArray(data) ? data : [data];
    console.log(`[路由] 智联招聘数据已接收，共 ${jobs.length} 条，写入 scraped_jobs`);
    service.reportJobsToController(jobs, 'zhaopin');
  }
};
