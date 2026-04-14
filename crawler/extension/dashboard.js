/**
 * Dashboard 主逻辑
 * Hash 路由 + 数据渲染 + 交互
 */

import {
  fetchJobs, fetchJobDetail, selectJob, favoriteJob, setFavoriteJob, batchFavoriteJobs,
  fetchDeliveryList, uploadResume, fetchResume,
  updateResumeContent, getAIConfig, saveAIConfig,
  optimizeResume, matchJobs, exportPDFViaAPI, clearAllJobs,
  deepThink, saveDeepThinkConfig, saveSecondaryModel,
  chatWithAIAssistant, chatWithAIAssistantStream,
  getAICapabilities, getDeepThinkConfig,
} from './dashboard-api.js';

import {
  ResumeDocument,
  initResumeDocumentFromMarkdown,
  getCurrentResumeDocument,
  setResumeDocument,
  commitResumeState,
} from './resume-document-model.js';

import {
  executeBatch,
} from './resume-script-editor.js';

/* ==================== Toast ==================== */

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.textContent = message;
  container.appendChild(el);

  setTimeout(() => {
    el.classList.add('fade-out');
    el.addEventListener('animationend', () => el.remove());
  }, 3000);
}

/* ==================== 卡片入场动画（IntersectionObserver） ==================== */

let cardObserver = null;
let homeRefreshTimer = null;
let homeJobsSignature = '';
let homeHasRendered = false;
const LIVE_BATCH_GROUP_SIZE = 20;
let liveBatchSyncState = createEmptyLiveBatchSyncState();
const DASHBOARD_CLIENT_ID = `dashboard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let dashboardSessionOpened = false;

/* ==================== 批次视图状态 ==================== */

const BATCH_STORAGE_KEY = 'crawl_batch_id';
let currentBatchId = null;
let isBatchView = false;

function createEmptyLiveBatchSyncState(batchId = null) {
  return {
    batchId,
    total: 0,
    expectedGroups: 0,
    renderedGroups: 0,
    pages: new Map()
  };
}

function resetLiveBatchSync(batchId = null) {
  liveBatchSyncState = createEmptyLiveBatchSyncState(batchId);
}

/** 初始化批次视图状态：优先从 localStorage 读取 */
function initBatchState() {
  try {
    const stored = localStorage.getItem(BATCH_STORAGE_KEY);
    if (stored) {
      currentBatchId = stored;
      isBatchView = true;
    }
  } catch { /* localStorage 不可用时忽略 */ }
}

/** 设置当前批次 ID 并持久化 */
function setCurrentBatchId(batchId) {
  const previousBatchId = currentBatchId;
  currentBatchId = batchId;
  if (!batchId) {
    resetLiveBatchSync(null);
  } else if (previousBatchId !== batchId && liveBatchSyncState.batchId !== batchId) {
    resetLiveBatchSync(batchId);
  }
  try {
    if (batchId) {
      localStorage.setItem(BATCH_STORAGE_KEY, batchId);
      isBatchView = true;
    } else {
      localStorage.removeItem(BATCH_STORAGE_KEY);
      isBatchView = false;
    }
  } catch { /* localStorage 不可用时忽略 */ }
}

/** 切换到全部岗位视图 */
function switchToAllJobs() {
  setCurrentBatchId(null);
  loadJobs({ silent: false, forceRender: true });
}

/** 切换到批次视图 */
function switchToBatchView() {
  if (currentBatchId) {
    isBatchView = true;
    loadJobs({ silent: false, forceRender: true });
  }
}

initBatchState();

function initCardObserver() {
  if (cardObserver) cardObserver.disconnect();

  cardObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('vis');
        cardObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1 });

  document.querySelectorAll('.card.anim').forEach(el => cardObserver.observe(el));
}

/* ==================== Hash 路由 ==================== */

function initRouter() {
  const views = {
    '#home': document.getElementById('view-home'),
    '#crawl': document.getElementById('view-crawl'),
    '#resume': document.getElementById('view-resume'),
  };

  function navigate() {
    const hash = location.hash || '#home';

    Object.entries(views).forEach(([key, el]) => {
      el.style.display = key === hash ? 'block' : 'none';
    });

    document.querySelectorAll('.nav-tab').forEach(tab => {
      tab.classList.toggle('active', tab.getAttribute('href') === hash);
    });

    // M13-N4-WP1: 离开工作台时关闭分屏
    if (hash !== '#resume' && currentSplitJobId) {
      closeSplitView();
    }

    if (hash === '#home') {
      loadJobs();
      startHomeRefresh();
    } else {
      stopHomeRefresh();
    }
    if (hash === '#crawl') initCrawlPanel();
    if (hash === '#resume') loadResumeView();
  }

  window.addEventListener('hashchange', navigate);
  navigate();
}

function startHomeRefresh() {
  stopHomeRefresh();
  homeRefreshTimer = setInterval(() => {
    if ((location.hash || '#home') === '#home') {
      loadJobs({ silent: true });
    }
  }, 5000);
}

function stopHomeRefresh() {
  if (homeRefreshTimer) {
    clearInterval(homeRefreshTimer);
    homeRefreshTimer = null;
  }
}

/* ==================== Suprematism SVG 图形（12 个） ==================== */

const SUPREMATISM_SVG = [
  `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><circle cx="65" cy="20" r="11"/><polygon points="25,82 80,38 18,38"/><line x1="38" y1="60" x2="8" y2="94" stroke-width="5" stroke-linecap="round"/><line x1="68" y1="48" x2="94" y2="84" stroke-width="5" stroke-linecap="round"/></svg>`,
  `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><rect x="32" y="6" width="36" height="36" rx="2" transform="rotate(15 50 24)"/><rect x="36" y="38" width="28" height="52" rx="2"/><rect x="8" y="50" width="84" height="14" rx="2"/><circle cx="50" cy="94" r="6"/><line x1="64" y1="84" x2="84" y2="68" stroke-width="5" stroke-linecap="round"/></svg>`,
  `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><rect x="18" y="18" width="64" height="64" transform="rotate(45 50 50)"/><circle cx="50" cy="50" r="24"/><polygon points="50,4 64,92 36,92"/></svg>`,
  `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="16" r="12"/><rect x="36" y="30" width="28" height="46" rx="2"/><line x1="36" y1="40" x2="8" y2="12" stroke-width="6" stroke-linecap="round"/><line x1="64" y1="40" x2="92" y2="4" stroke-width="6" stroke-linecap="round"/><line x1="40" y1="76" x2="28" y2="98" stroke-width="5" stroke-linecap="round"/><line x1="60" y1="76" x2="72" y2="98" stroke-width="5" stroke-linecap="round"/><rect x="16" y="80" width="68" height="10" rx="2"/></svg>`,
  `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><circle cx="68" cy="14" r="10"/><rect x="40" y="26" width="24" height="44" rx="3" transform="rotate(-8 52 48)"/><line x1="40" y1="38" x2="12" y2="58" stroke-width="6" stroke-linecap="round"/><line x1="64" y1="44" x2="88" y2="28" stroke-width="6" stroke-linecap="round"/><line x1="44" y1="70" x2="22" y2="98" stroke-width="6" stroke-linecap="round"/><line x1="60" y1="70" x2="82" y2="94" stroke-width="6" stroke-linecap="round"/></svg>`,
  `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="42" fill="none" stroke-width="4"/><circle cx="50" cy="50" r="28" fill="none" stroke-width="4"/><circle cx="50" cy="50" r="14" fill="none" stroke-width="4"/><line x1="50" y1="4" x2="50" y2="96" stroke-width="3"/><line x1="4" y1="50" x2="96" y2="50" stroke-width="3"/><line x1="16" y1="16" x2="84" y2="84" stroke-width="2"/><line x1="84" y1="16" x2="16" y2="84" stroke-width="2"/></svg>`,
  `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><rect x="30" y="60" width="40" height="34" rx="1"/><rect x="36" y="30" width="28" height="30" rx="1"/><rect x="42" y="6" width="16" height="24" rx="1"/><line x1="50" y1="2" x2="50" y2="94" stroke-width="2" stroke-dasharray="4 3"/></svg>`,
  `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="10" width="80" height="40" rx="1" transform="rotate(-12 50 30)"/><circle cx="50" cy="72" r="20" fill="none" stroke-width="4"/><line x1="30" y1="72" x2="70" y2="72" stroke-width="3"/><line x1="50" y1="52" x2="50" y2="92" stroke-width="3"/></svg>`,
  `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><circle cx="28" cy="50" r="10"/><polygon points="50,30 95,15 70,55"/><polygon points="50,70 95,85 70,45"/><line x1="18" y1="60" x2="6" y2="80" stroke-width="4" stroke-linecap="round"/></svg>`,
  `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="20" fill="none" stroke-width="5"/><line x1="70" y1="50" x2="96" y2="50" stroke-width="6" stroke-linecap="round"/><rect x="82" y="42" width="8" height="16" rx="1" transform="rotate(20 86 50)"/><circle cx="50" cy="50" r="6"/></svg>`,
  `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><rect x="8" y="8" width="38" height="38"/><rect x="54" y="8" width="38" height="38"/><rect x="8" y="54" width="38" height="38"/><rect x="54" y="54" width="38" height="38"/><rect x="28" y="28" width="44" height="44" fill="none" stroke-width="3" transform="rotate(45 50 50)"/></svg>`,
  `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><polygon points="50,6 20,82 80,82"/><polygon points="50,94 34,70 66,70"/><circle cx="50" cy="50" r="8" fill="none" stroke-width="3"/><line x1="50" y1="42" x2="50" y2="6" stroke-width="3"/></svg>`,
];

/* ==================== 数据渲染 ==================== */

function buildJobsSignature(jobs) {
  return (jobs || [])
    .map(job => [job.id, job.updated_at || job.crawled_at || job.created_at || '', job.selected ? 1 : 0, job.is_favorite ? 1 : 0].join(':'))
    .join('|');
}

async function loadJobs(options = {}) {
  const { silent = false, forceRender = false } = options;
  const container = document.getElementById('view-home');
  if (!container) return;

  const hasReusableBatchCache = (
    isBatchView &&
    currentBatchId &&
    liveBatchSyncState.batchId === currentBatchId &&
    liveBatchSyncState.renderedGroups > 0
  );

  if ((!silent || !homeHasRendered) && !hasReusableBatchCache) {
    container.innerHTML = '<div class="loading">加载中...</div>';
  }

  try {
    if (isBatchView && currentBatchId && liveBatchSyncState.batchId === currentBatchId && liveBatchSyncState.renderedGroups > 0) {
      renderLiveBatchJobs({ forceRender });
      return;
    }

    if (isBatchView && currentBatchId) {
      await syncCurrentBatchJobs(currentBatchId, {
        flushAll: true,
        forceRender
      });
      return;
    }

    const data = await fetchAllJobPages();
    const jobs = data.jobs || [];
    const total = data.total || 0;
    const nextSignature = buildJobsSignature(jobs);

    if (silent && !forceRender && homeHasRendered && nextSignature === homeJobsSignature) {
      return;
    }

    if (jobs.length === 0) {
      const emptyMsg = isBatchView ? '本次采集暂无岗位数据' : '暂无岗位数据';
      container.innerHTML = `${renderViewSwitcher(total)}${
        isBatchView
          ? `<div class="empty-state">${emptyMsg}<div style="margin-top:16px"><button class="res-btn res-btn--g" id="btn-empty-all-jobs">查看全部岗位</button></div></div>`
          : `<div class="empty-state">${emptyMsg}</div>`
      }`;
      bindHomeViewSwitcher();
      const allJobsBtn = document.getElementById('btn-empty-all-jobs');
      if (allJobsBtn) {
        allJobsBtn.addEventListener('click', switchToAllJobs, { once: true });
      }
      homeJobsSignature = '';
      homeHasRendered = true;
      return;
    }

    container.innerHTML = `${renderViewSwitcher(total)}${renderJobGrid(jobs)}`;
    bindHomeViewSwitcher();
    homeJobsSignature = nextSignature;
    homeHasRendered = true;
    initCardObserver();
    initGridResizeObserver();
  } catch (err) {
    if (!silent || !homeHasRendered) {
      const isBackendError = err.message.includes('后端未启动') || err.message.includes('Failed to fetch');
      if (isBackendError) {
        const errorType = err.errorType || 'CONTROLLER_UNREACHABLE';
        container.innerHTML = renderBackendError(err.message, errorType, err.extensionId);

        // CONTROLLER_STARTING 是临时态，自动重试（最多10次，约20秒）
        if (errorType === 'CONTROLLER_STARTING') {
          const retryCount = (container.dataset.startingRetries || 0) + 1;
          if (retryCount <= 10) {
            container.dataset.startingRetries = retryCount;
            setTimeout(() => loadJobs({ silent: true, forceRender: true }), 2000);
          } else {
            delete container.dataset.startingRetries;
            container.innerHTML = renderBackendError(
              'Controller 启动超时，请手动检查',
              'CONTROLLER_UNREACHABLE',
              err.extensionId
            );
          }
        } else if (errorType !== 'NATIVE_HOST_NOT_INSTALLED') {
          const wakeBtn = document.getElementById('btn-wake-controller');
          if (wakeBtn) {
            wakeBtn.addEventListener('click', async () => {
              try {
                const response = await chrome.runtime.sendMessage({
                  type: 'WAKE_UP_CONTROLLER',
                  reason: 'dashboard_backend_error'
                });
                if (response && response.success) {
                  showToast('Controller 唤醒成功，正在重试', 'success');
                  await loadJobs({ silent: false, forceRender: true });
                } else {
                  showToast(`自动唤醒失败: ${response?.error || '未知错误'}`, 'error');
                }
              } catch (wakeError) {
                showToast(`自动唤醒失败: ${wakeError.message}`, 'error');
              }
            }, { once: true });
          }
        }
      } else {
        container.innerHTML = '<div class="empty-state"></div>';
        showToast(err.message, 'error');
      }
    }
  }
}

/** 渲染后端不可达时的引导页 */
function renderBackendError(errMsg, errorType, extensionId) {
  if (errorType === 'NATIVE_HOST_NOT_INSTALLED') {
    const installCmd = extensionId
      ? `bash controller/install_host.sh ${extensionId}`
      : 'bash controller/install_host.sh &lt;extension-id&gt;';
    return `<div class="empty-state empty-state--backend">
      <h3 style="color:var(--c-yellow)">自动唤醒组件未安装</h3>
      <p>浏览器无法通过 Native Messaging 自动拉起本地 Controller。</p>
      <p>请在终端执行以下命令完成注册：</p>
      <p><code>${escapeHtml(installCmd)}</code></p>
      <p style="color:var(--c-gray);font-size:12px;margin-top:8px">${escapeHtml(errMsg || '')}</p>
      <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin-top:16px">
        <button class="res-btn res-btn--clear" onclick="location.reload()">安装后刷新页面</button>
      </div>
    </div>`;
  }

  if (errorType === 'CONTROLLER_STARTING') {
    return `<div class="empty-state empty-state--backend">
      <h3 style="color:var(--c-blue)">Controller 正在启动中...</h3>
      <p>自动唤醒已触发，等待服务就绪</p>
      <div style="margin-top:12px"><span class="spinner"></span></div>
    </div>`;
  }

  return `<div class="empty-state empty-state--backend">
    <h3>Controller 服务未运行</h3>
    <p>请先在终端运行 <code>npm run start</code> 启动 Controller</p>
    <p style="color:var(--c-gray);font-size:12px;margin-top:8px">${escapeHtml(errMsg || '')}</p>
    <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin-top:16px">
      <button class="res-btn res-btn--g" id="btn-wake-controller">尝试自动唤醒</button>
      <button class="res-btn res-btn--clear" onclick="location.reload()">刷新页面重试</button>
    </div>
  </div>`;
}

/** 渲染视图切换器（批次视图 / 全库视图） */
function renderViewSwitcher(total) {
  const syncSummary = (
    isBatchView &&
    currentBatchId &&
    liveBatchSyncState.batchId === currentBatchId &&
    liveBatchSyncState.expectedGroups > 0 &&
    liveBatchSyncState.renderedGroups < liveBatchSyncState.expectedGroups
  ) ? (() => {
    const synced = Math.min(liveBatchSyncState.renderedGroups, liveBatchSyncState.expectedGroups);
    const percent = Math.min((synced / Math.max(liveBatchSyncState.expectedGroups, 1)) * 100, 100);
    const missing = Math.max(liveBatchSyncState.expectedGroups - synced, 0);
    return `<div class="batch-sync">
      <div class="batch-sync__meta">
        <span>批次同步</span>
        <span>${synced}/${liveBatchSyncState.expectedGroups} 组${missing > 0 ? `，待补 ${missing} 组` : '，已齐'}</span>
      </div>
      <div class="batch-sync__track">
        <div class="batch-sync__bar" style="width:${percent}%"></div>
      </div>
    </div>`;
  })() : '';

  if (isBatchView && currentBatchId) {
    return `<div class="view-head">
      <div class="view-head__top">
        <div class="view-switcher">
          <button class="view-switcher__btn view-switcher__btn--active" disabled>本次采集 (${total})</button>
          <button class="view-switcher__btn" id="btn-all-jobs">全部岗位</button>
        </div>
        <button class="res-btn res-btn--clear" id="btn-clear-jobs">清空岗位</button>
      </div>
      ${syncSummary}
    </div>`;
  }
  return `<div class="view-head">
    <div class="view-head__top">
      <div class="view-switcher">
        <button class="view-switcher__btn" id="btn-batch-view">本次采集</button>
        <button class="view-switcher__btn view-switcher__btn--active" disabled>全部岗位 (${total})</button>
      </div>
      <button class="res-btn res-btn--clear" id="btn-clear-jobs">清空岗位</button>
    </div>
  </div>`;
}

function bindHomeViewSwitcher() {
  const batchViewBtn = document.getElementById('btn-batch-view');
  if (batchViewBtn) {
    batchViewBtn.addEventListener('click', switchToBatchView, { once: true });
  }

  const allJobsBtn = document.getElementById('btn-all-jobs');
  if (allJobsBtn) {
    allJobsBtn.addEventListener('click', switchToAllJobs, { once: true });
  }

  const clearJobsBtn = document.getElementById('btn-clear-jobs');
  if (clearJobsBtn) {
    clearJobsBtn.addEventListener('click', async () => {
      if (isCrawling) {
        showToast('请先停止采集，再清空岗位', 'error');
        return;
      }

      const confirmed = window.confirm('确认清空全部岗位数据吗？这会删除 SQL 中的岗位记录，并清空当前页面缓存。');
      if (!confirmed) return;

      try {
        const result = await clearAllJobs();
        resetLiveBatchSync(null);
        currentBatchId = null;
        isBatchView = false;
        homeJobsSignature = '';
        homeHasRendered = false;
        try {
          localStorage.removeItem(BATCH_STORAGE_KEY);
        } catch {
          // ignore
        }
        updateCrawlStatus(`已清空岗位数据 ${result?.deleted || 0} 条`, 0);
        showToast(`已清空岗位数据 ${result?.deleted || 0} 条`, 'success');
        await loadJobs({ silent: false, forceRender: true });
      } catch (error) {
        showToast(`清空失败: ${error.message}`, 'error');
      }
    }, { once: true });
  }
}

function getLiveBatchJobs() {
  const pages = Array.from(liveBatchSyncState.pages.entries())
    .sort((a, b) => a[0] - b[0])
    .flatMap(([, jobs]) => Array.isArray(jobs) ? jobs : []);

  const deduped = [];
  const seenIds = new Set();
  for (const job of pages) {
    const key = String(job?.id || '');
    if (!key || seenIds.has(key)) continue;
    seenIds.add(key);
    deduped.push(job);
  }
  return deduped;
}

function renderLiveBatchJobs(options = {}) {
  const { forceRender = false } = options;
  const container = document.getElementById('view-home');
  if (!container) return;

  const jobs = getLiveBatchJobs();
  const total = liveBatchSyncState.total || jobs.length;
  const nextSignature = `${liveBatchSyncState.batchId || ''}|${total}|${buildJobsSignature(jobs)}`;

  if (!forceRender && homeHasRendered && nextSignature === homeJobsSignature) {
    return;
  }

  if (jobs.length === 0) {
    container.innerHTML = `${renderViewSwitcher(total)}<div class="empty-state">本次采集暂无岗位数据</div>`;
    bindHomeViewSwitcher();
    homeJobsSignature = nextSignature;
    homeHasRendered = true;
    return;
  }

  container.innerHTML = `${renderViewSwitcher(total)}${renderJobGrid(jobs)}`;
  bindHomeViewSwitcher();
  homeJobsSignature = nextSignature;
  homeHasRendered = true;
  initCardObserver();
}

async function syncCurrentBatchJobs(batchId, options = {}) {
  const { flushAll = false, forceRender = false } = options;
  if (!batchId) return null;

  if (liveBatchSyncState.batchId !== batchId) {
    resetLiveBatchSync(batchId);
  }

  const firstPage = await fetchJobs({
    batchId,
    page: 1,
    pageSize: LIVE_BATCH_GROUP_SIZE
  });
  const total = Number(firstPage.total) || 0;
  const expectedGroups = Math.ceil(total / LIVE_BATCH_GROUP_SIZE);
  const targetGroups = expectedGroups;

  const nextPages = new Map();
  if (targetGroups >= 1) {
    nextPages.set(1, Array.isArray(firstPage.jobs) ? firstPage.jobs : []);
  }

  for (let page = 2; page <= targetGroups; page++) {
    const response = await fetchJobs({
      batchId,
      page,
      pageSize: LIVE_BATCH_GROUP_SIZE
    });
    nextPages.set(page, Array.isArray(response.jobs) ? response.jobs : []);
  }

  liveBatchSyncState = {
    batchId,
    total,
    expectedGroups,
    renderedGroups: targetGroups,
    pages: nextPages
  };

  if ((location.hash || '#home') === '#home' && isBatchView && currentBatchId === batchId) {
    renderLiveBatchJobs({ forceRender });
  }

  return {
    batchId,
    total,
    expectedGroups,
    renderedGroups: targetGroups,
    missingGroups: Math.max(expectedGroups - targetGroups, 0)
  };
}

async function fetchAllJobPages(params = {}) {
  const firstPage = await fetchJobs({
    ...params,
    page: 1,
    pageSize: LIVE_BATCH_GROUP_SIZE
  });

  const total = Number(firstPage.total) || 0;
  const expectedGroups = Math.ceil(total / LIVE_BATCH_GROUP_SIZE);
  const records = Array.isArray(firstPage.jobs) ? [...firstPage.jobs] : [];

  for (let page = 2; page <= expectedGroups; page++) {
    const response = await fetchJobs({
      ...params,
      page,
      pageSize: LIVE_BATCH_GROUP_SIZE
    });
    if (Array.isArray(response.jobs) && response.jobs.length > 0) {
      records.push(...response.jobs);
    }
  }

  return {
    jobs: records,
    total,
    expectedGroups
  };
}

/* ==================== 蒙德里安布局引擎 ==================== */

const MONDRIAN_TONES = ['red', 'yellow', 'blue', 'black', 'paper'];
const MONDRIAN_SIZES = ['S', 'W', 'T']; // S=1x1, W=2x1, T=1x2

/**
 * 计算列数：根据容器宽度确定网格列数
 * @param {number} containerWidth - 容器像素宽度
 * @returns {number} 列数 (1/2/4)
 */
function calcGridColumns(containerWidth) {
  if (containerWidth <= 600) return 1;
  if (containerWidth <= 1000) return 2;
  return 4;
}

function stableHash(input) {
  const text = String(input || '');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function getStableToneOrder(job, index = 0) {
  const seed = `${job?.title || ''}|${job?.company || ''}|${job?.location || ''}|${index}`;
  const offset = stableHash(`tone:${seed}`) % MONDRIAN_TONES.length;
  return MONDRIAN_TONES.map((_, i) => MONDRIAN_TONES[(offset + i) % MONDRIAN_TONES.length]);
}

/**
 * 蒙德里安布局引擎
 * 为每张岗位卡片计算显式网格位置、规格和颜色
 * @param {Array} jobs - 岗位数组
 * @param {number} columns - 当前列数 (1/2/4)
 * @returns {Array} 布局结果数组
 */
function buildMondrianLayout(jobs, columns) {
  const n = jobs.length;

  // 短路：空或极少卡片
  if (n === 0) return [];
  if (n <= 3 || columns === 1) {
    // 少量卡片也需要邻接不同色
    const toneMatrix1 = [];
    const safeCols = Math.max(1, columns);
    for (let r = 0; r < Math.ceil(n / safeCols) + 1; r++) {
      toneMatrix1.push(new Array(safeCols).fill(null));
    }
    const res = [];
    for (let i = 0; i < n; i++) {
      const rs = Math.floor(i / safeCols) + 1;
      const cs = (i % safeCols) + 1;
      const tone = pickToneFromMatrix(jobs[i], i, toneMatrix1, rs, cs, 1, 1, safeCols, toneMatrix1.length);
      toneMatrix1[rs - 1][cs - 1] = tone;
      res.push({
        id: jobs[i].id,
        rowStart: rs,
        colStart: cs,
        rowSpan: 1,
        colSpan: 1,
        size: 'S',
        tone,
        figureVariant: stableHash(jobs[i].title || jobs[i].company || `${i}`) % 12
      });
    }
    return res;
  }

  // 生成规格池
  const specPool = buildSpecPool(jobs, columns);

  // 初始化二维占位矩阵（存 job 索引）和颜色矩阵（存 tone 字符串）
  const maxRows = Math.ceil((n + specPool.filter(s => s !== 'S').length) / columns) + 4;
  const matrix = [];
  const toneMatrix = [];
  for (let r = 0; r < maxRows; r++) {
    matrix.push(new Array(columns).fill(null));
    toneMatrix.push(new Array(columns).fill(null));
  }

  // 已放置强调卡的空间记录
  const placedEmphatics = [];

  const results = [];
  let specIndex = 0;

  for (let i = 0; i < n; i++) {
    const job = jobs[i];
    const targetSize = specPool[specIndex++] || 'S';

    // 扫描第一个可用空位
    const pos = findFirstEmpty(matrix, columns, maxRows);
    if (!pos) break;

    // 尝试放置
    const placed = tryPlace(matrix, pos.row, pos.col, targetSize, columns, maxRows, placedEmphatics);

    // 写入占位矩阵
    for (let r = placed.rowStart - 1; r < placed.rowStart - 1 + placed.rowSpan; r++) {
      for (let c = placed.colStart - 1; c < placed.colStart - 1 + placed.colSpan; c++) {
        if (r < maxRows && c < columns) {
          matrix[r][c] = i;
        }
      }
    }

    // 记录强调卡位置
    if (placed.size !== 'S') {
      placedEmphatics.push({ row: placed.rowStart, col: placed.colStart, size: placed.size });
    }

    // 从 toneMatrix 选择颜色
    const tone = pickToneFromMatrix(job, i, toneMatrix, placed.rowStart, placed.colStart, placed.rowSpan, placed.colSpan, columns, maxRows);

    // 写入颜色矩阵
    for (let r = placed.rowStart - 1; r < placed.rowStart - 1 + placed.rowSpan; r++) {
      for (let c = placed.colStart - 1; c < placed.colStart - 1 + placed.colSpan; c++) {
        if (r < maxRows && c < columns) {
          toneMatrix[r][c] = tone;
        }
      }
    }

    results.push({
      id: job.id,
      rowStart: placed.rowStart,
      colStart: placed.colStart,
      rowSpan: placed.rowSpan,
      colSpan: placed.colSpan,
      size: placed.size,
      tone,
      figureVariant: stableHash(job.title || job.company || `${i}`) % 12
    });
  }

  return results;
}

/**
 * 生成规格池：按比例分配 S/W/T
 */
function buildSpecPool(jobs, columns) {
  const total = jobs.length;
  const pool = new Array(total).fill('S');
  if (total <= 3 || columns === 1) return pool;

  const emphaticTarget = Math.max(1, Math.round(total * 0.2));
  const wideQuota = columns >= 4 ? Math.floor(emphaticTarget / 2) : 0;
  const tallQuota = emphaticTarget - wideQuota;

  // 基于岗位名称做稳定伪随机，避免尺寸分布出现机械周期。
  const ranked = jobs.map((job, index) => {
    const identity = `${job.title || ''}|${job.company || ''}|${job.location || ''}`;
    return {
      index,
      wideScore: stableHash(`wide:${identity}`),
      tallScore: stableHash(`tall:${identity}`)
    };
  });

  if (wideQuota > 0) {
    const widePicked = [...ranked]
      .sort((a, b) => a.wideScore - b.wideScore)
      .slice(0, wideQuota);
    for (const item of widePicked) pool[item.index] = 'W';
  }

  if (tallQuota > 0) {
    const tallPicked = ranked
      .filter(item => pool[item.index] === 'S')
      .sort((a, b) => a.tallScore - b.tallScore)
      .slice(0, tallQuota);
    for (const item of tallPicked) pool[item.index] = 'T';
  }

  return pool;
}

/**
 * 从左上到右下找第一个空位
 */
function findFirstEmpty(matrix, columns, maxRows) {
  for (let r = 0; r < maxRows; r++) {
    for (let c = 0; c < columns; c++) {
      if (matrix[r][c] === null) {
        return { row: r, col: c };
      }
    }
  }
  return null;
}

/**
 * 尝试在指定位置放置指定规格的卡片
 * 不满足约束时逐步降级
 */
function tryPlace(matrix, row, col, targetSize, columns, maxRows, placedEmphatics) {
  // 按优先级尝试：目标规格 -> 降级
  const candidates = [targetSize];
  if (targetSize !== 'S') {
    candidates.push('S');
  }

  for (const size of candidates) {
    const span = getSizeSpan(size);
    if (canFit(matrix, row, col, span.rowSpan, span.colSpan, columns, maxRows)) {
      if (size !== 'S' && !checkSpatialConstraints(row, col, size, placedEmphatics, columns)) {
        continue; // 空间约束不满足，尝试下一个
      }
      return {
        rowStart: row + 1,
        colStart: col + 1,
        rowSpan: span.rowSpan,
        colSpan: span.colSpan,
        size
      };
    }
  }

  // 兜底：强制 1x1
  return {
    rowStart: row + 1,
    colStart: col + 1,
    rowSpan: 1,
    colSpan: 1,
    size: 'S'
  };
}

/**
 * 获取规格对应的行列跨度
 */
function getSizeSpan(size) {
  switch (size) {
    case 'W': return { rowSpan: 1, colSpan: 2 };
    case 'T': return { rowSpan: 2, colSpan: 1 };
    default: return { rowSpan: 1, colSpan: 1 };
  }
}

/**
 * 检查指定区域是否全部为空
 */
function canFit(matrix, row, col, rowSpan, colSpan, columns, maxRows) {
  if (col + colSpan > columns) return false;
  if (row + rowSpan > maxRows) return false;
  for (let r = row; r < row + rowSpan; r++) {
    for (let c = col; c < col + colSpan; c++) {
      if (matrix[r][c] !== null) return false;
    }
  }
  return true;
}

/**
 * 检查强调卡空间约束
 * 1) 同行禁止两个强调卡
 * 2) 同列内 T 间隔至少 1 格
 * 3) 其余强调卡曼哈顿距离 >= 2
 */
function checkSpatialConstraints(row, col, size, placedEmphatics, columns) {
  for (const p of placedEmphatics) {
    // placedEmphatics 存的是 1-indexed (rowStart/colStart), row/col 是 0-indexed
    const pr = p.row - 1;
    const pc = p.col - 1;
    const manhattan = Math.abs(pr - row) + Math.abs(pc - col);

    // 规则1: 同行不允许两个强调卡
    if (pr === row && pc !== col) return false;

    // 规则2: 同列T间隔至少1格
    if (pc === col && size === 'T' && p.size === 'T' && Math.abs(pr - row) < 2) return false;

    // 规则3: 曼哈顿距离 >= 2
    if (manhattan < 2) return false;
  }
  return true;
}

/**
 * 选择颜色：基于 toneMatrix 的两阶段策略
 * 阶段1: 严格过滤——排除与邻居同色的候选
 * 阶段2: 最少违规回退——选冲突最少的颜色
 */
function pickToneFromMatrix(job, index, toneMatrix, rowStart, colStart, rowSpan, colSpan, columns, maxRows) {
  const neighborTones = getNeighborTonesFromMatrix(toneMatrix, rowStart, colStart, rowSpan, colSpan, columns, maxRows);
  const preferredOrder = getStableToneOrder(job, index);

  // 阶段1: 严格过滤
  const legal = preferredOrder.filter(t => !neighborTones.has(t));
  if (legal.length > 0) {
    return legal[0];
  }

  // 阶段2: 最少违规回退
  let bestTone = preferredOrder[0];
  let minConflicts = Infinity;
  for (const tone of preferredOrder) {
    const conflicts = [...neighborTones].filter(t => t === tone).length;
    if (conflicts < minConflicts) {
      minConflicts = conflicts;
      bestTone = tone;
    }
  }
  return bestTone;
}

/**
 * 从 toneMatrix 获取邻居颜色集合
 */
function getNeighborTonesFromMatrix(toneMatrix, rowStart, colStart, rowSpan, colSpan, columns, maxRows) {
  const tones = new Set();

  // 上方
  if (rowStart > 1) {
    for (let c = colStart - 1; c < colStart - 1 + colSpan; c++) {
      if (c < columns && toneMatrix[rowStart - 2] && toneMatrix[rowStart - 2][c]) {
        tones.add(toneMatrix[rowStart - 2][c]);
      }
    }
  }
  // 下方
  if (rowStart - 1 + rowSpan < maxRows) {
    const bRow = rowStart - 1 + rowSpan;
    for (let c = colStart - 1; c < colStart - 1 + colSpan; c++) {
      if (c < columns && toneMatrix[bRow] && toneMatrix[bRow][c]) {
        tones.add(toneMatrix[bRow][c]);
      }
    }
  }
  // 左方
  if (colStart > 1) {
    const lCol = colStart - 2;
    for (let r = rowStart - 1; r < rowStart - 1 + rowSpan; r++) {
      if (r < maxRows && toneMatrix[r] && toneMatrix[r][lCol]) {
        tones.add(toneMatrix[r][lCol]);
      }
    }
  }
  // 右方
  if (colStart - 1 + colSpan < columns) {
    const rCol = colStart - 1 + colSpan;
    for (let r = rowStart - 1; r < rowStart - 1 + rowSpan; r++) {
      if (r < maxRows && toneMatrix[r] && toneMatrix[r][rCol]) {
        tones.add(toneMatrix[r][rCol]);
      }
    }
  }

  return tones;
}

/* ==================== 渲染函数（改造后） ==================== */

// 当前布局列数
let currentGridColumns = 4;

// ResizeObserver 响应式列数管理（带防抖）
let gridResizeObserver = null;
let gridResizeTimer = null;
const GRID_RESIZE_DEBOUNCE = 150;

function initGridResizeObserver() {
  if (gridResizeObserver) gridResizeObserver.disconnect();

  gridResizeObserver = new ResizeObserver(entries => {
    for (const entry of entries) {
      const width = entry.contentRect.width;
      const newCols = calcGridColumns(width);

      if (newCols !== currentGridColumns) {
        currentGridColumns = newCols;
        clearTimeout(gridResizeTimer);
        gridResizeTimer = setTimeout(() => {
          // 重新渲染当前视图
          const container = document.getElementById('view-home');
          if (container && homeHasRendered) {
            // 触发非静默加载以重新布局
            loadJobs({ silent: true, forceRender: true });
          }
        }, GRID_RESIZE_DEBOUNCE);
      }
    }
  });

  // 监听外层持久容器，避免因 innerHTML 重建导致 Observer 频繁断开
  const viewHome = document.getElementById('view-home');
  if (viewHome) {
    gridResizeObserver.observe(viewHome);
  }
}

function renderJobGrid(jobs) {
  // 计算布局
  const layouts = buildMondrianLayout(jobs, currentGridColumns);

  return `<div class="job-grid" style="grid-template-columns:repeat(${currentGridColumns},1fr)">${layouts.map((layout, i) => {
    return renderJobCard(jobs[i], i, layout);
  }).join('')}</div>`;
}

function renderSourceLink(url, inlineStyle = '') {
  const safeUrl = String(url || '').trim();
  if (!safeUrl || !/^https?:\/\//i.test(safeUrl)) {
    return `<span class="bep bep--s bep--disabled"${inlineStyle ? ` style="${inlineStyle}"` : ''} aria-disabled="true">暂无原链接</span>`;
  }
  return `<a class="bep bep--s" href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener"${inlineStyle ? ` style="${inlineStyle}"` : ''}>查看原链接</a>`;
}

function renderJobCard(job, index = 0, layout = null) {
  const platform = escapeHtml(job.platform || 'unknown');
  const title = escapeHtml(job.title || '');
  const company = escapeHtml(job.company || '');
  const location = escapeHtml(job.location || '未知');
  const salary = escapeHtml(job.salary || '面议');
  const experience = escapeHtml(job.experience || '');
  const education = escapeHtml(job.education || '');
  const keywords = escapeHtml(job.keywords || '');

  // 平台名称映射
  const platformNames = {
    'boss': 'Boss',
    'liepin': '猎聘',
    '51job': '51job',
    'zhilian': '智联'
  };
  const platformName = platformNames[platform] || platform;

  // 构建标签列表
  const tags = [];
  if (experience) tags.push(experience);
  if (education) tags.push(education);
  if (keywords) tags.push(...keywords.split(/[,，]/).filter(k => k.trim()).slice(0, 2));

  // 卡片编号
  const num = String(index + 1).padStart(2, '0');

  // SVG 图形
  const figureVariant = layout ? layout.figureVariant : (index % 12);
  const svg = SUPREMATISM_SVG[figureVariant];

  // 布局属性
  const sizeAttr = layout ? `data-size="${layout.size}"` : '';
  const toneAttr = layout ? `data-tone="${layout.tone}"` : '';
  const gridStyle = layout
    ? `style="grid-column:${layout.colStart}/span ${layout.colSpan};grid-row:${layout.rowStart}/span ${layout.rowSpan}"`
    : '';

  return `<div class="card anim" data-id="${job.id}" ${sizeAttr} ${toneAttr} ${gridStyle}>
    <div class="card__num">${num}</div>
    <div class="card__head">
      <div class="card__title">${title}</div>
      <span class="card__plat">${platformName}</span>
    </div>
    <div class="card__meta">
      <div class="card__sal">${salary}</div>
      <div style="font-size:12px;line-height:1.4">${company} · ${location}</div>
      <div class="card__tags">${tags.map(tag => `<span class="card__tag">${tag.trim()}</span>`).join('')}</div>
    </div>
    <div class="card__fig">${svg}</div>
  </div>`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/* ==================== 居中弹窗交互 ==================== */

let curExId = null;

function openExpandDetail(id) {
  if (curExId === id) { closeExpandDetail(); return; }
  curExId = id;
  loadExDetail(id);
  const ov = document.getElementById('exOverlay');
  ov.style.display = 'flex';
  requestAnimationFrame(() => ov.classList.add('on'));
  document.body.style.overflow = 'hidden';
}

function closeExpandDetail() {
  curExId = null;
  const ov = document.getElementById('exOverlay');
  ov.classList.remove('on');
  setTimeout(() => { ov.style.display = 'none'; }, 300);
  document.body.style.overflow = '';
}

async function loadExDetail(jobId) {
  const body = document.getElementById('exBody');
  body.innerHTML = '<div class="loading">加载中...</div>';

  try {
    const job = await fetchJobDetail(jobId);

    const platformNames = {
      'boss': 'Boss直聘',
      'liepin': '猎聘',
      '51job': '前程无忧',
      'zhilian': '智联招聘'
    };

    const infoItems = [job.company, job.location, job.industry, job.scale, platformNames[job.platform] || job.platform].filter(Boolean);
    const tags = [];
    if (job.experience) tags.push(job.experience);
    if (job.education) tags.push(job.education);
    if (job.keywords) tags.push(...job.keywords.split(/[,，]/).filter(k => k.trim()));

    const isSelected = job.selected || false;
    const isFav = job.is_favorite || false;

    body.innerHTML = `
      <h2 class="extitle">${escapeHtml(job.title || '')}</h2>
      <div class="exsal">${escapeHtml(job.salary || '面议')}</div>
      <div class="exinfo">${infoItems.map(i => `<span class="exinfo-i">${escapeHtml(i)}</span>`).join('')}</div>
      ${tags.length > 0 ? `<div class="extags">${tags.map(t => `<span class="extag">${escapeHtml(t.trim())}</span>`).join('')}</div>` : ''}
      <div class="exdesc">${formatDescription(job.description) || '暂无职位描述'}</div>
      <div class="exacts">
        ${renderSourceLink(job.url)}
        <button class="bep bep--p" id="exSelectBtn" data-job-id="${jobId}">${isFav ? '☆ 取消收藏' : '★ 收藏'}</button>
      </div>
    `;

    // 绑定"收藏/取消收藏"按钮
    const selectBtn = document.getElementById('exSelectBtn');
    if (selectBtn) {
      let currentFav = isFav;
      selectBtn.addEventListener('click', async () => {
        try {
          const result = await favoriteJob(jobId);
          currentFav = result.isFavorite;
          if (currentFav) {
            selectBtn.textContent = '☆ 取消收藏';
            showToast('收藏成功', 'success');
          } else {
            selectBtn.textContent = '★ 收藏';
            showToast('已取消收藏', 'success');
          }
          homeJobsSignature = '';
          loadDeliveryList();
        } catch (err) {
          showToast('操作失败: ' + err.message, 'error');
        }
      });
    }
  } catch (err) {
    body.innerHTML = `<div class="empty-state">获取职位详情失败: ${escapeHtml(err.message)}</div>`;
  }
}

// 遮罩点击关闭
document.getElementById('exOverlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('exOverlay')) {
    closeExpandDetail();
  }
});

// 关闭按钮
document.getElementById('exClose').addEventListener('click', closeExpandDetail);

// ESC 键关闭
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    // 优先关闭分屏视图
    if (currentSplitJobId) {
      closeSplitView();
      return;
    }
    if (curExId) {
      closeExpandDetail();
    }
  }
});

function formatDescription(desc) {
  if (!desc) return '';
  // 简单的格式化处理：将换行符转为 <br>
  return escapeHtml(desc).replace(/\n/g, '<br>');
}

/* ==================== AI 配置状态检查 ==================== */

/**
 * 检查 AI 是否已配置（异步，缓存结果）
 */
async function checkAIConfigured() {
  try {
    const data = await getAIConfig();
    // 后端返回 { configs: [...] }，检查是否有激活配置
    const configs = data.configs || [];
    const active = configs.find(c => c.is_active === 1 && c.api_key_masked && c.api_key_masked !== '***');
    aiConfigured = !!active;
  } catch {
    aiConfigured = false;
  }
  return aiConfigured;
}

/* ==================== N3 WP1: 简历管理面板 ==================== */
/* ==================== N3 WP4: 简历双模式编辑 ==================== */

let resumeViewInitialized = false;
let currentResume = null;          // 当前简历数据对象
let currentResumeMode = 'view';    // 'view' | 'edit'
let aiConfigured = false;          // AI 是否已配置
let currentResumeDraftMd = '';     // 稳定简历草稿源，模板切换不修改此变量
let aiConversationHistory = [];    // AI 助手对话历史（split view 使用）
let workspaceAssistantVisible = false;

/* ==================== Workspace AI 助手状态（唯一真相） ==================== */
const wsAssistant = {
  mounted: false,
  sessionKey: 'workspace-main',
  activeRequestId: null,    // 防止旧请求覆盖新状态

  // 运行态
  phase: 'idle',            // idle | streaming | deep_think | done | error
  running: false,
  sendBtnDisabled: false,

  // 消息（唯一真相）
  // 每条: { id, role: 'user'|'assistant'|'system', text, timestamp, status: 'done'|'streaming' }
  messages: [],

  // 流式追踪（仅对 status='streaming' 的那条 message）
  streamingMsgId: null,

  // 调试/进度
  streamStatusLines: [],    // trace 日志（最多 20 条）
  recommendProgress: false,

  // 脏标记
  dirtyFavorites: false,
  dirtyResume: false,
};
let workspaceFavoriteCount = 0;
const RESUME_TEMPLATE_STORAGE_KEY = 'jobhunter_resume_template';
const RESUME_TEMPLATE_OPTIONS = [
  { id: 'structured', label: '结构版' },
  { id: 'timeline', label: '时间版' },
  { id: 'modern', label: '现代版' },
  { id: 'classic', label: '经典版' },
  { id: 'compact', label: '紧凑版' },
  { id: 'elegant', label: '优雅版' },
];
let currentResumeTemplate = readStoredResumeTemplate();

// AI 助手会话管理 - 按岗位持久化
const ASSISTANT_SESSIONS_KEY = 'zhaopin_assistant_sessions';

function loadAssistantSessions() {
  try {
    const raw = localStorage.getItem(ASSISTANT_SESSIONS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function normalizeAssistantSessionKey(target) {
  if (target === null || target === undefined || target === '') {
    return 'workspace-main';
  }
  return String(target);
}

function saveAssistantSession(target, messages) {
  try {
    const sessions = loadAssistantSessions();
    sessions[normalizeAssistantSessionKey(target)] = {
      messages: messages.slice(-50), // 最多保留50条
      updatedAt: Date.now(),
    };
    localStorage.setItem(ASSISTANT_SESSIONS_KEY, JSON.stringify(sessions));
  } catch (e) { console.warn('[AI Session] save failed:', e); }
}

function loadAssistantSession(target) {
  const sessions = loadAssistantSessions();
  return sessions[normalizeAssistantSessionKey(target)]?.messages || [];
}

function clearAssistantSession(target) {
  try {
    const sessions = loadAssistantSessions();
    delete sessions[normalizeAssistantSessionKey(target)];
    localStorage.setItem(ASSISTANT_SESSIONS_KEY, JSON.stringify(sessions));
  } catch {}
}

function clearAllAssistantSessions() {
  try { localStorage.removeItem(ASSISTANT_SESSIONS_KEY); } catch {}
}

// 统一简历状态入口
function getCurrentResumeDraft() {
  // 如果有编辑中的 textarea，以它为准
  const splitEdit = document.getElementById('sp-resume-edit');
  if (splitEdit) {
    const ta = splitEdit.querySelector('textarea');
    if (ta && ta.value.trim() && splitEdit.style.display !== 'none') {
      return ta.value;
    }
  }
  const defEdit = document.getElementById('def-resume-edit');
  if (defEdit) {
    const ta = defEdit.querySelector('textarea');
    if (ta && ta.value.trim() && defEdit.style.display !== 'none') {
      return ta.value;
    }
  }
  return currentResumeDraftMd || (currentResume ? currentResume.content_md || '' : '');
}

function refreshAllResumeViews() {
  const md = currentResumeDraftMd;
  if (!md) return;

  // 刷新 split center view
  const spView = document.getElementById('sp-resume-view');
  if (spView) {
    spView.innerHTML = renderResumePreviewShell(md, currentResumeTemplate, { editable: false, viewMode: 'split' });
    initializeResumePreviewShells(spView);
  }

  // 刷新 split center edit textarea
  const spEdit = document.getElementById('sp-resume-edit');
  if (spEdit) {
    const ta = spEdit.querySelector('textarea');
    if (ta) ta.value = md;
  }

  // 刷新 workspace (default) view
  const defView = document.getElementById('def-resume-view');
  if (defView) {
    defView.innerHTML = renderResumePreviewShell(md, currentResumeTemplate, { editable: false, viewMode: 'default' });
    initializeResumePreviewShells(defView);
  }

  // 刷新 workspace edit textarea
  const defEdit = document.getElementById('def-resume-edit');
  if (defEdit) {
    const ta = defEdit.querySelector('textarea');
    if (ta) ta.value = md;
  }
}

function readStoredResumeTemplate() {
  try {
    const saved = localStorage.getItem(RESUME_TEMPLATE_STORAGE_KEY);
    return RESUME_TEMPLATE_OPTIONS.some(option => option.id === saved) ? saved : 'structured';
  } catch (_) {
    return 'structured';
  }
}

function persistResumeTemplate(templateId) {
  currentResumeTemplate = RESUME_TEMPLATE_OPTIONS.some(option => option.id === templateId)
    ? templateId
    : 'structured';
  try {
    localStorage.setItem(RESUME_TEMPLATE_STORAGE_KEY, currentResumeTemplate);
  } catch (_) {
    // ignore storage failures
  }
}

function renderResumeTemplateSelector(viewMode = 'default') {
  const idPrefix = viewMode === 'default' ? 'def' : 'exp';
  const options = RESUME_TEMPLATE_OPTIONS.map((option) => `
    <option value="${option.id}" ${option.id === currentResumeTemplate ? 'selected' : ''}>
      ${option.label}
    </option>
  `).join('');

  return `
    <label class="resume-template-switch" for="${idPrefix}-resume-template">
      <span>模板</span>
      <select class="resume-template-switch__select" id="${idPrefix}-resume-template" data-view="${viewMode}">
        ${options}
      </select>
    </label>
  `;
}

function escapeResumeAttr(value) {
  return escapeHtml(String(value == null ? '' : value)).replace(/"/g, '&quot;');
}

/**
 * 清洗文本中残余的 Markdown 内联格式标记
 */
function stripInlineMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

function normalizeResumeSource(markdown) {
  let text = String(markdown || '').replace(/\r/g, '\n');
  text = text.replace(/(^|\n)\s*[\u25a1\uF0B7\u2022\u25CF\u25E6\u00B7▪■◆★☆►▶]+\s*/g, '$1- ');
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/\s*(个人信息|个人概况|求职意向|教育背景|工作经历|实习经历|项目经历|校园经历|技能特长|专业技能|核心技能|自我评价|荣誉奖项|获奖经历|证书|语言能力)\s*/g, '\n$1\n');
  text = text.replace(/\s*(姓名[:：]|性别[:：]|出生年月[:：]|电话[:：]|联系电话[:：]|手机[:：]|邮箱[:：]|电子邮件[:：]|微信[:：]|现居地[:：]|所在地[:：]|毕业院校[:：]|学校[:：]|学历[:：]|专业[:：])\s*/g, '\n$1');
  text = text.replace(/((?:19|20)\d{2}[./年-]?\d{0,2}(?:月)?\s*(?:[-~—至到]\s*(?:至今|现在|(?:19|20)\d{2}[./年-]?\d{0,2}(?:月)?)))/g, '\n$1');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

function extractLabelValue(text, labels) {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`${escaped}\\s*[:：]\\s*([^\\n]+)`);
    const match = text.match(regex);
    if (match && match[1]) {
      return match[1].trim();
    }
  }
  return '';
}

function splitResumeSentences(text) {
  return String(text || '')
    .split(/[\n；;。]/)
    .map(item => item.trim())
    .filter(Boolean);
}

function parseResumeStructure(markdown) {
  const normalized = normalizeResumeSource(markdown);
  const lines = normalized.split('\n').map(line => line.trim()).filter(Boolean);
  const knownSections = new Set([
    '个人信息', '个人概况', '求职意向', '教育背景', '工作经历', '实习经历',
    '项目经历', '校园经历', '技能特长', '专业技能', '核心技能', '自我评价',
    '荣誉奖项', '获奖经历', '证书', '语言能力'
  ]);

  const model = {
    name: '',
    headline: '',
    meta: [],
    summary: '',
    sections: [],
    rawLines: lines,
  };

  if (!lines.length) {
    return model;
  }

  const joined = lines.join('\n');
  model.name = stripInlineMarkdown(extractLabelValue(joined, ['姓名']) || '');
  if (!model.name) {
    const firstLine = lines[0].replace(/^#\s*/, '');
    if (firstLine && !knownSections.has(firstLine) && firstLine.length <= 24) {
      model.name = stripInlineMarkdown(firstLine);
    }
  }

  const titleLine = extractLabelValue(joined, ['求职意向', '目标岗位', '应聘岗位']);
  if (titleLine) {
    model.headline = stripInlineMarkdown(titleLine);
  } else {
    const secondLine = lines.find(line => /产品|运营|开发|设计|数据|经理|工程师|实习|分析/.test(line));
    model.headline = secondLine && secondLine !== model.name ? stripInlineMarkdown(secondLine) : '';
  }

  const metaPairs = [
    ['电话', ['联系电话', '电话', '手机']],
    ['邮箱', ['邮箱', '电子邮件']],
    ['微信', ['微信']],
    ['现居地', ['现居地', '所在地', '居住地']],
    ['学历', ['学历']],
    ['专业', ['专业']],
    ['学校', ['毕业院校', '学校', '在读院校']],
    ['出生年月', ['出生年月']],
    ['性别', ['性别']],
  ];

  model.meta = metaPairs
    .map(([label, keys]) => {
      const value = extractLabelValue(joined, keys);
      return value ? `${label}：${value}` : '';
    })
    .filter(Boolean);

  let currentSection = null;
  const headerBuffer = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/^#{1,6}\s*/, '').trim();
    if (!line) continue;

    if (knownSections.has(line)) {
      currentSection = { title: stripInlineMarkdown(line), items: [] };
      model.sections.push(currentSection);
      continue;
    }

    if (!currentSection) {
      headerBuffer.push(line);
      continue;
    }

    splitResumeSentences(line).forEach((item) => {
      currentSection.items.push(stripInlineMarkdown(item));
    });
  }

  if (!model.summary) {
    const summaryCandidates = headerBuffer.filter(line => (
      line !== model.name &&
      line !== model.headline &&
      !/^姓名[:：]|^电话[:：]|^联系电话[:：]|^邮箱[:：]|^电子邮件[:：]|^微信[:：]|^现居地[:：]|^所在地[:：]|^学历[:：]|^专业[:：]|^学校[:：]|^毕业院校[:：]/.test(line)
    ));
    model.summary = stripInlineMarkdown(summaryCandidates.slice(0, 3).join(' '));
  }

  if (!model.sections.length) {
    const fallbackItems = splitResumeSentences(lines.join('\n')).map(stripInlineMarkdown);
    model.sections.push({
      title: '简历内容',
      items: fallbackItems,
    });
  }

  model.sections = model.sections
    .map(section => ({
      title: section.title,
      items: section.items.filter(Boolean),
    }))
    .filter(section => section.items.length > 0);

  return model;
}

function renderResumeSectionItems(section, templateId) {
  if (templateId === 'timeline') {
    return section.items.map((item) => {
      const isPeriod = /(?:19|20)\d{2}.*(?:至今|现在|[-~—至到])/.test(item);
      return `
        <div class="resume-block resume-block--timeline${isPeriod ? ' is-period' : ''}">
          <div class="resume-block__marker"></div>
          <div class="resume-block__content">${escapeHtml(item)}</div>
        </div>
      `;
    }).join('');
  }

  if (templateId === 'modern') {
    return section.items.map((item) => `
      <div class="resume-card">${escapeHtml(item)}</div>
    `).join('');
  }

  if (templateId === 'classic') {
    return `
      <ol class="resume-ordered-list">
        ${section.items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}
      </ol>
    `;
  }

  if (templateId === 'compact') {
    return `
      <div class="resume-compact-items">
        ${section.items.map(item => `<span class="resume-compact-item">${escapeHtml(item)}</span>`).join('')}
      </div>
    `;
  }

  if (templateId === 'elegant') {
    return section.items.map((item) => `
      <div class="resume-elegant-item">${escapeHtml(item)}</div>
    `).join('');
  }

  // structured 模板：检测经历条目（公司/时间），结构化渲染
  const isEntryHeader = (item) =>
    /(?:19|20)\d{2}.*(?:至今|现在|[-~—至到])/.test(item) ||
    /[｜|]\s*(?:19|20)\d{2}/.test(item);

  const hasEntries = section.items.some(isEntryHeader);
  if (!hasEntries) {
    return `
      <ul class="resume-list">
        ${section.items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}
      </ul>
    `;
  }

  // 将条目分组：标题行 + 子项
  const entries = [];
  let cur = null;
  for (const item of section.items) {
    if (isEntryHeader(item)) {
      cur = { header: item, subs: [] };
      entries.push(cur);
    } else if (cur) {
      cur.subs.push(item);
    } else {
      entries.push({ header: null, subs: [item] });
    }
  }

  return entries.map((entry) => {
    if (!entry.header) {
      return `<ul class="resume-list">${entry.subs.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ul>`;
    }
    const parts = entry.header.split(/[｜|]/);
    const company = (parts[0] || '').trim();
    const dateRange = (parts[1] || '').trim();
    // 第一个子项如果是 **职位** 格式，提升为副标题
    let positionHtml = '';
    let bulletStart = 0;
    if (entry.subs.length && /^\*\*/.test(entry.subs[0])) {
      positionHtml = `<div class="resume-entry__position">${escapeHtml(entry.subs[0].replace(/\*\*/g, ''))}</div>`;
      bulletStart = 1;
    }
    const bulletsHtml = entry.subs.length > bulletStart
      ? `<ul class="resume-entry__list">${entry.subs.slice(bulletStart).map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ul>`
      : '';
    return `
      <div class="resume-entry">
        <div class="resume-entry__header">
          <span class="resume-entry__company">${escapeHtml(company)}</span>
          ${dateRange ? `<span class="resume-entry__date">${escapeHtml(dateRange)}</span>` : ''}
        </div>
        ${positionHtml}
        ${bulletsHtml}
      </div>
    `;
  }).join('');
}

function renderResumeStructuredBody(model, templateId = currentResumeTemplate) {
  const name = model.name || '简历预览';
  const metaHtml = model.meta.length
    ? `<div class="resume-meta">${model.meta.map(item => `<span class="resume-meta__item">${escapeHtml(item)}</span>`).join('')}</div>`
    : '';
  const summaryHtml = model.summary
    ? `<div class="resume-summary">${escapeHtml(model.summary)}</div>`
    : '';
  const sectionsHtml = model.sections.map((section) => `
    <section class="resume-section">
      <div class="resume-section__title">${escapeHtml(section.title)}</div>
      <div class="resume-section__body">
        ${renderResumeSectionItems(section, templateId)}
      </div>
    </section>
  `).join('');

  return `
    <article class="resume-sheet resume-sheet--${escapeResumeAttr(templateId)}">
      <header class="resume-sheet__header">
        <div class="resume-sheet__name">${escapeHtml(name)}</div>
        ${model.headline ? `<div class="resume-sheet__headline">${escapeHtml(model.headline)}</div>` : ''}
        ${metaHtml}
        ${summaryHtml}
      </header>
      <div class="resume-sheet__body">
        ${sectionsHtml}
      </div>
    </article>
  `;
}

function buildResumeDocumentHTML(markdown, templateId = currentResumeTemplate, { fragment = false } = {}) {
  const safeTemplateId = RESUME_TEMPLATE_OPTIONS.some(option => option.id === templateId)
    ? templateId
    : 'structured';
  const model = parseResumeStructure(markdown);
  const body = renderResumeStructuredBody(model, safeTemplateId);

  if (fragment) {
    return body;
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>简历</title>
  <style>${RESUME_DOCUMENT_CSS}</style>
</head>
<body class="resume-doc-shell">${body}</body>
</html>`;
}

function loadResumeView() {
  const container = document.getElementById('view-resume');
  if (!container) return;

  if (!resumeViewInitialized) {
    container.innerHTML = `
      <div class="ws">
        <div class="ws-del">
          <h3 class="ws-del__title">收藏列表 <span id="delivery-count" class="ws-del__count"></span></h3>
          <div id="delivery-content"></div>
        </div>
        <div class="ws-res" id="wsResPanel">
          <div class="ws-res__head">
            <h3 class="ws-res__title">简历预览</h3>
            <button class="res-btn res-btn--ai" id="ws-ai-toggle-btn" type="button">AI 助手</button>
          </div>
          <div id="resume-content"></div>
          <div class="upload-btn" id="btn-upload-inline" style="display:none">&#128196; 简历上传</div>
        </div>
        <div class="ws-ai" id="wsAiPanel" style="display:none">
          <div id="ws-ai-content" class="ws-ai__content"></div>
        </div>
      </div>
    `;

    bindWorkspaceAssistantToggle();
    resumeViewInitialized = true;
  }

  loadResume();
  loadDeliveryList();
  checkAIConfigured();
  applyWorkspaceLayoutState();
}

function bindWorkspaceAssistantToggle() {
  const btn = document.getElementById('ws-ai-toggle-btn');
  if (!btn) return;

  btn.addEventListener('click', () => {
    if (currentSplitJobId) {
      closeSplitView();
    }
    workspaceAssistantVisible = !workspaceAssistantVisible;
    applyWorkspaceLayoutState();
  });
}

function applyWorkspaceLayoutState() {
  const ws = document.querySelector('#view-resume .ws');
  const btn = document.getElementById('ws-ai-toggle-btn');
  const aiPanel = document.getElementById('wsAiPanel');
  const resumePanel = document.getElementById('wsResPanel');
  const aiContainer = document.getElementById('ws-ai-content');
  if (!ws || !btn || !aiPanel || !resumePanel || !aiContainer) return;

  ws.classList.toggle('ws--assistant', workspaceAssistantVisible);
  ws.classList.remove('ws--assistant-no-favorites');
  aiPanel.style.display = workspaceAssistantVisible ? 'flex' : 'none';
  resumePanel.style.display = '';
  btn.textContent = workspaceAssistantVisible ? '关闭 AI' : 'AI 助手';
  btn.classList.toggle('is-active', workspaceAssistantVisible);

  if (workspaceAssistantVisible) {
    if (!wsAssistant.mounted) {
      mountWorkspaceAssistant(aiContainer);
    }
    // 从 state 恢复渲染（不重建面板）
    renderWorkspaceAssistant();
    // 恢复按钮/输入状态
    const sendBtn = document.getElementById('sendBtn');
    if (sendBtn) sendBtn.disabled = wsAssistant.sendBtnDisabled;
    const aiInput = document.getElementById('aiInput');
    if (aiInput && wsAssistant.running) aiInput.disabled = false;
  }
}

/** workspace AI 助手首次挂载（只执行一次） */
function mountWorkspaceAssistant(container) {
  container.innerHTML = buildAssistantPanelShell({ mode: 'workspace' });
  wsAssistant.mounted = true;

  // 恢复历史消息到 state
  const saved = loadAssistantSession(wsAssistant.sessionKey);
  if (saved.length > 0) {
    wsAssistant.messages = saved.map((m, i) => ({
      id: Date.now() + i,
      role: m.role,
      text: m.text,
      timestamp: getAIChatTime(),
      status: 'done',
    }));
  } else {
    wsAssistant.messages = [{
      id: 1,
      role: 'assistant',
      text: '你好！我是你的简历优化助手。\n你可以发送消息让我帮你优化简历、分析岗位匹配度，或者直接提问。',
      timestamp: getAIChatTime(),
      status: 'done',
    }];
  }

  // 绑定事件（只绑一次）
  bindWorkspaceAssistantEvents();

  // 加载 AI 配置 + 能力探测
  loadSplitAIConfig();
  getAICapabilities().then(caps => {
    const dtToggle = document.getElementById('sp-dt-toggle');
    if (dtToggle) dtToggle.disabled = !caps.deep_think;
    window.__aiCapabilities = caps;
  }).catch(() => {
    window.__aiCapabilities = { assistant_chat: true, deep_think: false };
  });
}

/** workspace AI 助手事件绑定（只执行一次） */
function bindWorkspaceAssistantEvents() {
  const sendBtn = document.getElementById('sendBtn');
  const aiInput = document.getElementById('aiInput');
  const settingsBtn = document.getElementById('btn-ai-settings');
  const closeSettingsBtn = document.getElementById('btn-close-settings');
  const clearChatBtn = document.getElementById('btn-clear-chat');
  const settingsPanel = document.getElementById('aiSettingsPanel');
  const aiSaveBtn = document.getElementById('sp-ai-save-btn');
  const spProvider = document.getElementById('sp-ai-provider');

  // 发送 → 顶层 sendAIMessage（带防重入）
  if (sendBtn) sendBtn.addEventListener('click', () => sendAIMessage());
  if (aiInput) {
    aiInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); sendAIMessage(); }
    });
  }

  // 设置面板切换
  if (settingsBtn) settingsBtn.addEventListener('click', () => { if (settingsPanel) settingsPanel.classList.toggle('is-open'); });
  if (closeSettingsBtn) closeSettingsBtn.addEventListener('click', () => { if (settingsPanel) settingsPanel.classList.remove('is-open'); });

  // 清空对话
  if (clearChatBtn) {
    clearChatBtn.addEventListener('click', () => {
      wsAssistant.messages = [{
        id: Date.now(),
        role: 'assistant',
        text: '对话已清空。有什么可以帮你的吗？',
        timestamp: getAIChatTime(),
        status: 'done',
      }];
      wsAssistant.streamStatusLines = [];
      wsAssistant.recommendProgress = false;
      clearAssistantSession(wsAssistant.sessionKey);
      scheduleAssistantRender(true);
    });
  }

  // AI Provider 切换
  if (spProvider) {
    spProvider.addEventListener('change', () => {
      const provider = spProvider.value;
      const defaults = AI_PROVIDER_DEFAULTS[provider];
      if (!defaults) return;
      const baseUrlInput = document.getElementById('sp-ai-base-url');
      const modelInput = document.getElementById('sp-ai-model');
      if (baseUrlInput) baseUrlInput.value = defaults.base_url;
      if (modelInput) modelInput.value = defaults.model;
    });
  }

  // AI 配置保存按钮
  if (aiSaveBtn) {
    aiSaveBtn.addEventListener('click', async () => {
      const provider = document.getElementById('sp-ai-provider')?.value;
      const apiKey = document.getElementById('sp-ai-api-key')?.value.trim();
      const baseUrl = document.getElementById('sp-ai-base-url')?.value.trim();
      const model = document.getElementById('sp-ai-model')?.value.trim();
      if (!apiKey) { showToast('请输入 API Key', 'error'); return; }
      if (!baseUrl) { showToast('请输入 Base URL', 'error'); return; }
      if (!model) { showToast('请输入模型名称', 'error'); return; }
      aiSaveBtn.disabled = true;
      aiSaveBtn.textContent = '保存中...';
      try {
        await saveAIConfig({ provider, api_key: apiKey, base_url: baseUrl, model_name: model });
        showToast('AI 配置已保存', 'success');
        aiConfigured = true;
        loadInlineAIConfig();
      } catch (err) {
        showToast('保存 AI 配置失败: ' + err.message, 'error');
      } finally {
        aiSaveBtn.disabled = false;
        aiSaveBtn.textContent = '保存配置';
      }
    });
  }

  // 深度思考开关
  const spDtToggle = document.getElementById('sp-dt-toggle');
  if (spDtToggle) {
    spDtToggle.addEventListener('change', async () => {
      try {
        await saveDeepThinkConfig({ enabled: spDtToggle.checked });
        showToast(spDtToggle.checked ? '深度思考已开启' : '深度思考已关闭', 'success');
      } catch (err) {
        showToast('保存深度思考配置失败: ' + err.message, 'error');
        spDtToggle.checked = !spDtToggle.checked;
      }
    });
  }

  // 第二模型折叠 + 保存
  const spSecToggle = document.getElementById('sp-sec-model-toggle');
  const spSecBody = document.getElementById('sp-sec-model-body');
  if (spSecToggle && spSecBody) {
    spSecToggle.addEventListener('click', () => {
      const open = spSecBody.style.display !== 'none';
      spSecBody.style.display = open ? 'none' : '';
      spSecToggle.textContent = (open ? '▶' : '▼') + ' 第二模型配置';
    });
  }
  const spSecSaveBtn = document.getElementById('sp-sec-save-btn');
  if (spSecSaveBtn) {
    spSecSaveBtn.addEventListener('click', async () => {
      await handleSecondaryModelSave('sp');
    });
  }

  // 文件上传（静默）
  const fileUpload = document.getElementById('aiFileUpload');
  if (fileUpload) {
    fileUpload.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        showToast(`已选择 ${e.target.files.length} 个文件`, 'info');
      }
    });
  }
}

/**
 * 加载简历数据并渲染默认视图
 */
async function loadResume() {
  const container = document.getElementById('resume-content');
  if (!container) return;

  container.innerHTML = '<div class="loading">加载中...</div>';

  try {
    const data = await fetchResume();
    const resume = data.resume;

    if (!resume) {
      currentResume = null;
      currentResumeMode = 'view';
      container.innerHTML = renderResumeNoContent();
      initUploadButton(container);
      return;
    }

    currentResume = resume;
    currentResumeMode = 'view';

    const contentMd = resume.content_md || '';
    currentResumeDraftMd = contentMd;
    container.innerHTML = renderResumeDualMode(contentMd, 'default');
    bindResumeDualModeEvents(container, 'default');
    initializeResumePreviewShells(container);
  } catch (err) {
    currentResume = null;
    container.innerHTML = renderResumeNoContent();
    initUploadButton(container);
    showToast('加载简历失败: ' + err.message, 'error');
  }
}

/* ==================== 简历双模式渲染 ==================== */

/**
 * 简历双模式容器（查看 + 编辑切换）
 * @param {string} contentMd Markdown 内容
 * @param {'default'|'expanded'} viewMode 视图模式
 */
function renderResumeDualMode(contentMd, viewMode = 'default') {
  const idPrefix = viewMode === 'default' ? 'def' : 'exp';
  return `
    <div class="resume-dual-mode">
      <div class="res-bar" id="${idPrefix}-res-bar">
        <button class="res-btn res-btn--active" id="${idPrefix}-btn-view" data-mode="view" data-view="${viewMode}">查看</button>
        <button class="res-btn res-btn--g" id="${idPrefix}-btn-edit" data-mode="edit" data-view="${viewMode}">编辑</button>
        <button class="res-btn res-btn--g" id="${idPrefix}-btn-save" data-view="${viewMode}">保存</button>
        ${renderResumeTemplateSelector(viewMode)}
        <button class="res-btn btn-outline" id="${idPrefix}-btn-upload" title="上传简历文件(.md/.txt/.json)">上传简历</button>
        <div class="export-dropdown" id="${idPrefix}-export-dropdown">
          <button class="res-btn res-btn--export btn-export" id="${idPrefix}-btn-export-resume"
                  ${!currentResume ? 'disabled title="请先上传简历"' : ''}>
            下载简历
          </button>
          <div class="export-menu" id="${idPrefix}-export-menu">
            <button data-format="md">Markdown (.md)</button>
            <button data-format="html">HTML (.html)</button>
            <button data-format="pdf">PDF (.pdf)</button>
            <button data-format="docx">Word (.docx)</button>
          </div>
        </div>
      </div>
      <div class="resume-dual-mode__view" id="${idPrefix}-resume-view">
        ${renderResumePreviewShell(contentMd, currentResumeTemplate, { editable: false, viewMode })}
      </div>
      <div class="resume-dual-mode__edit" id="${idPrefix}-resume-edit" style="display:none">
        ${renderResumeEdit(contentMd, viewMode)}
      </div>
    </div>
  `;
}

/**
 * 无简历时的简化上传界面（只保留上传按钮）
 */
function renderResumeNoContent() {
  return `
    <div class="resume-no-content">
      <div class="resume-no-content__text">暂无简历</div>
      <button class="upload-btn-simple" id="btn-upload-resume">&#128196; 上传简历</button>
    </div>
  `;
}

/**
 * 简化上传按钮的事件绑定
 */
function initUploadButton(container) {
  const btn = container.querySelector('#btn-upload-resume');
  if (!btn) return;
  btn.addEventListener('click', () => triggerFileInput());
}

/**
 * 结构化 HTML 渲染：将 Markdown 简单解析为 Constructivism 风格 HTML
 * @param {string} markdown Markdown 原始文本
 * @returns {string} HTML 字符串
 */
function renderResumeHTML(markdown, templateId = currentResumeTemplate) {
  if (!markdown || !markdown.trim()) {
    return '<div class="resume-empty">暂无简历内容</div>';
  }
  return buildResumeDocumentHTML(markdown, templateId, { fragment: true });
}

function renderResumePreviewShell(markdown, templateId = currentResumeTemplate, options = {}) {
  const { editable = false, viewMode = 'default' } = options;
  return `
    <div class="resume-preview-shell" data-editable="${editable ? 'true' : 'false'}" data-view-mode="${escapeResumeAttr(viewMode)}">
      <div class="resume-preview-guides"></div>
      <div class="resume-preview-stage">
        ${renderResumeHTML(markdown, templateId)}
      </div>
    </div>
  `;
}

function serializeResumePreviewToMarkdown(previewRoot) {
  if (!previewRoot) return '';
  const sheet = previewRoot.querySelector('.resume-sheet');
  if (!sheet) return '';

  const lines = [];
  const name = sheet.querySelector('.resume-sheet__name')?.innerText.trim();
  const headline = sheet.querySelector('.resume-sheet__headline')?.innerText.trim();
  if (name) lines.push(name);
  if (headline) lines.push(headline);

  const metaItems = [...sheet.querySelectorAll('.resume-meta__item')]
    .map(el => el.innerText.trim())
    .filter(Boolean);
  if (metaItems.length) lines.push(...metaItems);

  const summary = sheet.querySelector('.resume-summary')?.innerText.trim();
  if (summary) {
    lines.push('');
    lines.push('个人概况');
    lines.push(summary);
  }

  const sections = [...sheet.querySelectorAll('.resume-section')];
  for (const section of sections) {
    const title = section.querySelector('.resume-section__title')?.innerText.trim();
    const items = [
      ...section.querySelectorAll('.resume-list li, .resume-block__content')
    ].map(el => el.innerText.trim()).filter(Boolean);
    if (!title && !items.length) continue;
    lines.push('');
    if (title) lines.push(title);
    for (const item of items) lines.push(`- ${item}`);
  }

  return normalizeResumeSource(lines.join('\n'));
}

function syncResumeEditorDraft(editEl) {
  if (!editEl) return '';
  const previewEl = editEl.querySelector('.resume-edit-dual__preview');
  const ta = editEl.querySelector('textarea');
  const contentMd = serializeResumePreviewToMarkdown(previewEl);
  if (ta) ta.value = contentMd;
  return contentMd;
}

function updateResumePageGuides(shell) {
  if (!shell) return;
  const stage = shell.querySelector('.resume-preview-stage');
  const sheet = shell.querySelector('.resume-sheet');
  const guides = shell.querySelector('.resume-preview-guides');
  if (!stage || !sheet || !guides) return;

  const pageHeight = Math.max(1, Math.round(sheet.offsetWidth * Math.SQRT2));
  const totalHeight = Math.max(stage.scrollHeight, sheet.offsetHeight);
  guides.innerHTML = '';

  for (let y = pageHeight; y < totalHeight; y += pageHeight) {
    const line = document.createElement('div');
    line.className = 'resume-page-guide';
    line.style.top = `${y}px`;
    line.innerHTML = `<span>PDF 第 ${Math.round(y / pageHeight) + 1} 页起点</span>`;
    guides.appendChild(line);
  }
}

function initializeResumePreviewShells(root = document) {
  root.querySelectorAll('.resume-preview-shell').forEach((shell) => {
    const editable = shell.dataset.editable === 'true';
    const stage = shell.querySelector('.resume-preview-stage');
    const sheet = shell.querySelector('.resume-sheet');
    if (!stage || !sheet) return;

    if (editable) {
      sheet.setAttribute('contenteditable', 'true');
      sheet.setAttribute('spellcheck', 'false');
      if (!sheet.dataset.editorBound) {
        const sync = () => {
          const editEl = shell.closest('.resume-dual-mode__edit');
          syncResumeEditorDraft(editEl);
          updateResumePageGuides(shell);
        };
        sheet.addEventListener('input', sync);
        sheet.addEventListener('blur', sync, true);
        sheet.dataset.editorBound = 'true';
      }
    } else {
      sheet.removeAttribute('contenteditable');
    }

    updateResumePageGuides(shell);
  });
}

/**
 * Markdown 编辑模式：textarea 显示原始 Markdown
 * @param {string} contentMd Markdown 原始文本
 * @returns {string} HTML 字符串
 */
function renderResumeEdit(contentMd, viewMode = 'default') {
  const isSplit = viewMode === 'split';
  const idPrefix = viewMode === 'default' ? 'def' : (isSplit ? 'sp' : 'exp');
  const taId = isSplit ? 'sp-resume-edit-ta' : (viewMode === 'default' ? 'resume-edit-ta' : 'resume-edit-ta-exp');
  const previewId = `${idPrefix}-resume-edit-preview`;
  return `
    <div class="resume-edit-dual" style="display:flex;flex-direction:column;gap:16px;align-items:stretch;">
      <div class="resume-edit-dual__input" style="display:none">
        <textarea class="res-ta resume-source-buffer" id="${taId}">${escapeHtml(contentMd || '')}</textarea>
      </div>
      <div class="resume-edit-dual__preview" id="${previewId}" style="flex:1;min-width:0;overflow-y:auto;">
        ${renderResumePreviewShell(contentMd, currentResumeTemplate, { editable: true, viewMode })}
      </div>
    </div>`;
}

/**
 * 切换简历查看/编辑模式
 * ⚠️ 只管理 view/edit 互斥激活态，其他按钮不参与。
 * 后续若引入按钮开关态（如 AI 配置面板展开指示），
 * 须使用独立状态类（如 res-btn--toggled），不得复用 res-btn--active。
 * @param {string} mode 'view' | 'edit'
 * @param {'default'|'expanded'} viewMode 视图模式
 */
function toggleResumeMode(mode, viewMode = 'default') {
  const idPrefix = viewMode === 'default' ? 'def' : 'exp';
  const viewEl = document.getElementById(`${idPrefix}-resume-view`);
  const editEl = document.getElementById(`${idPrefix}-resume-edit`);
  const btnView = document.getElementById(`${idPrefix}-btn-view`);
  const btnEdit = document.getElementById(`${idPrefix}-btn-edit`);

  if (!viewEl || !editEl) return;

  // 防御：清理非 mode 按钮上误加的 --active
  const bar = document.getElementById(`${idPrefix}-res-bar`);
  if (bar) {
    bar.querySelectorAll('.res-btn--active').forEach(btn => {
      if (!btn.id.endsWith('-btn-view') && !btn.id.endsWith('-btn-edit')) {
        btn.classList.remove('res-btn--active');
      }
    });
  }

  if (mode === 'edit') {
    viewEl.style.display = 'none';
    editEl.style.display = 'block';
    if (btnView) { btnView.classList.remove('res-btn--active'); }
    if (btnEdit) { btnEdit.classList.add('res-btn--active'); }
    initializeResumePreviewShells(editEl);
  } else {
    // 切换到查看模式时，从 textarea 读取并更新 currentResumeDraftMd
    const ta = editEl.querySelector('textarea');
    if (ta && ta.value.trim()) {
      currentResumeDraftMd = ta.value;
    }
    const newMd = currentResumeDraftMd || (currentResume ? currentResume.content_md || '' : '');
    viewEl.innerHTML = renderResumePreviewShell(newMd, currentResumeTemplate, { editable: false, viewMode });
    viewEl.style.display = 'block';
    editEl.style.display = 'none';
    if (btnView) { btnView.classList.add('res-btn--active'); }
    if (btnEdit) { btnEdit.classList.remove('res-btn--active'); }
    initializeResumePreviewShells(viewEl);
  }

  currentResumeMode = mode;
}

/**
 * 保存简历内容到后端
 * @param {'default'|'expanded'} viewMode 视图模式
 */
async function saveResumeContent(viewMode = 'default') {
  const ID_PREFIX_MAP = { default: 'def', expanded: 'exp', split: 'sp' };
  const idPrefix = ID_PREFIX_MAP[viewMode] || 'def';
  const editEl = document.getElementById(`${idPrefix}-resume-edit`);
  const ta = editEl ? editEl.querySelector('textarea') : null;
  const saveBtn = document.getElementById(`${idPrefix}-btn-save`);

  if (!ta) {
    showToast('未找到编辑区域', 'error');
    return;
  }

  const contentMd = ta.value || currentResumeDraftMd;
  if (!contentMd.trim()) {
    showToast('简历内容不能为空', 'error');
    return;
  }

  // 更新稳定草稿源
  currentResumeDraftMd = contentMd;

  const originalSaveLabel = saveBtn ? saveBtn.textContent : '';

  try {
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = '保存中...';
    }
    await updateResumeContent(contentMd);
    showToast('简历保存成功', 'success');

    // 更新本地缓存
    if (currentResume) {
      currentResume.content_md = contentMd;
    }

    // 切换到查看模式
    toggleResumeMode('view', viewMode);
  } catch (err) {
    // 404 表示没有简历记录，提示用户先上传
    if (err.message && err.message.includes('No resume record found')) {
      showToast('请先上传简历', 'error');
    } else {
      showToast('保存失败: ' + err.message, 'error');
    }
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = originalSaveLabel || '保存';
    }
  }
}

/**
 * AI 优化简历处理
 * @param {HTMLElement} btn 触发按钮
 * @param {'default'|'expanded'} viewMode 视图模式
 */
async function handleAIOptimize(btn, viewMode = 'default') {
  if (!aiConfigured) {
    showToast('请先配置 AI', 'error');
    return;
  }

  if (!currentResume) {
    showToast('请先上传简历', 'error');
    return;
  }

  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = '优化中...';

  try {
    // 从收藏列表获取第一个岗位 ID 作为目标岗位
    const deliveryData = await fetchDeliveryList();
    const deliveryJobs = deliveryData.jobs || [];
    const targetJobId = deliveryJobs.length > 0 ? deliveryJobs[0].id : null;

    if (!targetJobId) {
      showToast('请先收藏岗位', 'error');
      btn.textContent = originalText;
      btn.disabled = false;
      return;
    }

    const data = await optimizeResume(targetJobId, '');

    // 用 AI 返回的内容更新编辑器
    const optimizedContent = data.optimized_content_md || data.content_md || data.content || data.optimized_resume;
    if (optimizedContent) {
      const idPrefix = viewMode === 'default' ? 'def' : 'exp';
      const editEl = document.getElementById(`${idPrefix}-resume-edit`);
      const ta = editEl ? editEl.querySelector('textarea') : null;
      const previewEl = editEl ? editEl.querySelector('.resume-edit-dual__preview') : null;

      if (ta) {
        ta.value = optimizedContent;
      }
      if (previewEl) {
        previewEl.innerHTML = renderResumePreviewShell(optimizedContent, currentResumeTemplate, { editable: true, viewMode });
        initializeResumePreviewShells(editEl);
      }

      // 更新本地缓存
      if (currentResume) {
        currentResume.content_md = optimizedContent;
      }

      // 切换到编辑模式以便用户查看和修改
      toggleResumeMode('edit', viewMode);
      showToast('AI 优化完成，请查看编辑器内容', 'success');
    } else {
      showToast('AI 返回结果为空', 'error');
    }
  } catch (err) {
    showToast('AI 优化失败: ' + err.message, 'error');
  } finally {
    btn.textContent = originalText;
    btn.disabled = !aiConfigured;
  }
}

/* ==================== M5: 深度思考 ==================== */

/**
 * 处理深度思考按钮点击
 */
async function handleDeepThink(btn, viewMode = 'default') {
  if (!aiConfigured) {
    showToast('请先配置 AI', 'error');
    return;
  }

  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = '思考中...';

  try {
    let targetJobId;
    if (viewMode === 'split') {
      targetJobId = currentSplitJobId;
    } else {
      const deliveryData = await fetchDeliveryList();
      const deliveryJobs = deliveryData.jobs || [];
      targetJobId = deliveryJobs.length > 0 ? deliveryJobs[0].id : null;
    }

    if (!targetJobId) {
      showToast('请先选择或收藏岗位', 'error');
      btn.textContent = originalText;
      btn.disabled = false;
      return;
    }

    const data = await deepThink('分析候选人与岗位匹配度', targetJobId);
    const result = data.result || data;

    renderDeepThinkPanel(result, viewMode);
    showToast('深度思考完成', 'success');
  } catch (err) {
    showToast('深度思考失败: ' + err.message, 'error');
  } finally {
    btn.textContent = originalText;
    btn.disabled = !aiConfigured;
  }
}

/**
 * 渲染深度思考结果面板
 */
function renderDeepThinkPanel(result, viewMode) {
  const containerId = viewMode === 'split' ? 'sp-resume-view' : (viewMode === 'default' ? 'def-resume-view' : 'exp-resume-view');
  const container = document.getElementById(containerId);
  if (!container) return;

  const panelId = viewMode === 'split' ? 'sp-dt-panel' : (viewMode === 'default' ? 'def-dt-panel' : 'exp-dt-panel');
  let panel = document.getElementById(panelId);
  if (panel) panel.remove();

  const finalAnswer = result.final_answer || result.answer || '暂无结果';
  const logs = result.logs || result.trace || [];
  const modeUsed = result.mode_used || '';
  const roundsUsed = result.rounds_used || '';
  const stopReason = result.stop_reason || '';

  const logsHtml = Array.isArray(logs) ? logs.map((log, i) =>
    `<div class="deep-think-panel__log-item"><strong>Round ${i + 1}:</strong> ${typeof log === 'string' ? log : JSON.stringify(log)}</div>`
  ).join('') : `<pre>${typeof logs === 'string' ? logs : JSON.stringify(logs, null, 2)}</pre>`;

  const metaHtml = [
    modeUsed ? `模式: ${modeUsed}` : '',
    roundsUsed ? `轮次: ${roundsUsed}` : '',
    stopReason ? `停止原因: ${stopReason}` : '',
  ].filter(Boolean).join(' · ');

  const panelHtml = `
    <div class="deep-think-panel" id="${panelId}">
      <div class="deep-think-panel__header">
        <h4 class="deep-think-panel__title">🧠 深度思考结果</h4>
        ${metaHtml ? `<span class="deep-think-panel__meta">${metaHtml}</span>` : ''}
        <button class="deep-think-panel__close" data-dt-close="${panelId}">&times;</button>
      </div>
      <div class="deep-think-panel__answer">${finalAnswer.replace(/\n/g, '<br>')}</div>
      ${logs.length ? `
        <div class="deep-think-panel__trace">
          <button class="deep-think-panel__trace-toggle" data-dt-trace="${panelId}">▶ 思考过程</button>
          <div class="deep-think-panel__trace-body" style="display:none">${logsHtml}</div>
        </div>
      ` : ''}
    </div>
  `;

  container.insertAdjacentHTML('afterbegin', panelHtml);

  const newPanel = document.getElementById(panelId);
  if (newPanel) {
    const closeBtn = newPanel.querySelector(`[data-dt-close="${panelId}"]`);
    if (closeBtn) {
      closeBtn.addEventListener('click', () => newPanel.remove());
    }
    const traceToggle = newPanel.querySelector(`[data-dt-trace="${panelId}"]`);
    if (traceToggle) {
      traceToggle.addEventListener('click', () => {
        const body = newPanel.querySelector('.deep-think-panel__trace-body');
        if (!body) return;
        const open = body.style.display !== 'none';
        body.style.display = open ? 'none' : '';
        traceToggle.textContent = (open ? '▶' : '▼') + ' 思考过程';
      });
    }
  }
}

/**
 * 保存第二模型配置
 */
async function handleSecondaryModelSave(prefix) {
  const provider = document.getElementById(`${prefix}-sec-provider`)?.value;
  const apiKey = document.getElementById(`${prefix}-sec-api-key`)?.value.trim();
  const baseUrl = document.getElementById(`${prefix}-sec-base-url`)?.value.trim();
  const model = document.getElementById(`${prefix}-sec-model`)?.value.trim();
  const saveBtn = document.getElementById(`${prefix}-sec-save-btn`);

  if (!apiKey) { showToast('请输入第二模型 API Key', 'error'); return; }
  if (!baseUrl) { showToast('请输入第二模型 Base URL', 'error'); return; }
  if (!model) { showToast('请输入第二模型名称', 'error'); return; }

  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '保存中...'; }

  try {
    await saveSecondaryModel({ provider, api_key: apiKey, base_url: baseUrl, model_name: model });
    showToast('第二模型配置已保存', 'success');
  } catch (err) {
    showToast('保存第二模型配置失败: ' + err.message, 'error');
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存第二模型'; }
  }
}

/* ==================== M9-N1-WP1: 简历导出 ==================== */

/**
 * 触发文件下载（Blob 下载触发器）
 * @param {Blob} blob 文件内容
 * @param {string} filename 文件名
 */
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* --- HTML 导出模板（Constructivism 风格，与 WP3 后端共用） --- */

const RESUME_DOCUMENT_CSS = `
@page {
  size: A4;
  margin: 15mm;
}
@media print {
  body.resume-doc-shell {
    padding: 0;
    background: white;
  }
  .resume-sheet {
    border: none;
    box-shadow: none;
    overflow: visible;
    max-width: none;
  }
  .resume-sheet__header {
    page-break-inside: avoid;
    page-break-after: avoid;
  }
  .resume-section {
    /* Allow sections to break across pages - this fixes BUG-01 */
    page-break-inside: auto;
  }
  .resume-section__title {
    page-break-after: avoid;
  }
  .resume-entry {
    page-break-inside: avoid;
  }
  .resume-block {
    page-break-inside: avoid;
  }
  .resume-list li {
    page-break-inside: avoid;
  }
  h1, h2, h3 {
    page-break-after: avoid;
  }
  /* Ensure reasonable orphans/widows */
  p {
    orphans: 3;
    widows: 3;
  }
}
  :root {
    --resume-bg: #f7f3ec;
    --resume-ink: #1a1a1a;
    --resume-accent: #e4432c;
    --resume-accent-soft: #ffcc33;
    --resume-border: #222;
    --resume-muted: #666;
    --resume-paper: #fffdf9;
  }

  * { box-sizing: border-box; }

  body.resume-doc-shell {
    margin: 0;
    padding: 24px;
    background: var(--resume-bg);
    color: var(--resume-ink);
    font-family: 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif;
  }

  .resume-sheet {
    width: 100%;
    max-width: 980px;
    margin: 0 auto;
    background: var(--resume-paper);
    border: 3px solid var(--resume-border);
    box-shadow: 14px 14px 0 rgba(26, 26, 26, 0.08);
    overflow: visible;
  }

  .resume-sheet--structured .resume-sheet__header {
    padding: 36px 42px 24px;
    background:
      linear-gradient(135deg, rgba(228, 67, 44, 0.08), transparent 42%),
      linear-gradient(0deg, #fffdf9, #fffdf9);
    border-bottom: 4px solid var(--resume-accent);
  }

  .resume-sheet--timeline .resume-sheet__header {
    padding: 38px 42px 30px;
    background: #171717;
    color: #fffaf0;
    border-bottom: 6px solid var(--resume-accent-soft);
  }

  .resume-sheet__name {
    margin: 0;
    font-size: 34px;
    line-height: 1.15;
    font-weight: 900;
    letter-spacing: 1px;
  }

  .resume-sheet__headline {
    margin-top: 10px;
    font-size: 15px;
    font-weight: 700;
    color: var(--resume-accent);
  }

  .resume-sheet--timeline .resume-sheet__headline {
    color: var(--resume-accent-soft);
  }

  .resume-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 16px;
  }

  .resume-meta__item {
    display: inline-flex;
    align-items: center;
    min-height: 30px;
    padding: 4px 10px;
    border: 2px solid var(--resume-border);
    background: rgba(255, 255, 255, 0.88);
    font-size: 12px;
    font-weight: 700;
  }

  .resume-sheet--timeline .resume-meta__item {
    color: #fffaf0;
    border-color: var(--resume-accent-soft);
    background: transparent;
  }

  .resume-summary {
    margin-top: 18px;
    font-size: 14px;
    line-height: 1.8;
    color: var(--resume-muted);
  }

  .resume-sheet--timeline .resume-summary {
    color: rgba(255, 250, 240, 0.82);
  }

  .resume-sheet__body {
    padding: 28px 42px 36px;
    display: grid;
    gap: 18px;
  }

  .resume-sheet--timeline .resume-sheet__body {
    background:
      linear-gradient(90deg, rgba(255, 204, 51, 0.16) 0, rgba(255, 204, 51, 0.16) 4px, transparent 4px, transparent 100%);
  }

  .resume-section {
    border: 2px solid var(--resume-border);
    padding: 18px 20px;
    background: #fff;
  }

  .resume-sheet--timeline .resume-section {
    background: rgba(255, 255, 255, 0.96);
    margin-left: 18px;
  }

  .resume-section__title {
    display: inline-block;
    margin-bottom: 14px;
    padding: 0 0 6px;
    border-bottom: 4px solid var(--resume-accent);
    font-size: 14px;
    font-weight: 900;
    letter-spacing: 1px;
    text-transform: uppercase;
  }

  /* 结构化经历条目 */
  .resume-entry { margin-bottom: 16px; }
  .resume-entry:last-child { margin-bottom: 0; }
  .resume-entry__header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 2px; }
  .resume-entry__company { font-weight: 700; font-size: 15px; color: #1a1a1a; }
  .resume-entry__date { font-size: 13px; color: #666; flex-shrink: 0; margin-left: 12px; }
  .resume-entry__position { font-size: 14px; font-weight: 600; color: var(--resume-accent, #e62b1e); margin-bottom: 4px; }
  .resume-entry__list { list-style: none; margin: 4px 0 0; padding: 0; display: grid; gap: 6px; }
  .resume-entry__list li { position: relative; padding-left: 16px; font-size: 14px; line-height: 1.7; color: #333; white-space: pre-wrap; word-break: break-word; }
  .resume-entry__list li::before { content: ''; position: absolute; left: 0; top: 11px; width: 7px; height: 3px; background: var(--resume-accent, #e62b1e); }

  .resume-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 10px;
  }

  .resume-list li {
    position: relative;
    padding-left: 16px;
    font-size: 14px;
    line-height: 1.8;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .resume-list li::before {
    content: '';
    position: absolute;
    left: 0;
    top: 11px;
    width: 8px;
    height: 3px;
    background: var(--resume-accent);
  }

  .resume-block {
    position: relative;
    padding-left: 24px;
    margin-bottom: 12px;
  }

  .resume-block:last-child {
    margin-bottom: 0;
  }

  .resume-block__marker {
    position: absolute;
    left: 0;
    top: 8px;
    width: 10px;
    height: 10px;
    border: 2px solid var(--resume-border);
    background: var(--resume-accent-soft);
  }

  .resume-block.is-period .resume-block__marker {
    background: var(--resume-accent);
  }

  .resume-block__content {
    font-size: 14px;
    line-height: 1.8;
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* === modern 模板 === */
  .resume-sheet.resume-sheet--modern {
    background: #ffffff;
    color: #2c3e50;
    border: none;
    border-radius: 12px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08);
  }

  .resume-sheet--modern .resume-sheet__header {
    padding: 32px 36px 24px;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: #ffffff;
    border-bottom: none;
    border-radius: 12px 12px 0 0;
  }

  .resume-sheet--modern .resume-sheet__name {
    font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif;
    letter-spacing: 2px;
  }

  .resume-sheet--modern .resume-sheet__headline {
    color: rgba(255, 255, 255, 0.9);
  }

  .resume-sheet--modern .resume-meta__item {
    border: none;
    background: rgba(255, 255, 255, 0.2);
    color: #ffffff;
    border-radius: 20px;
    font-size: 11px;
  }

  .resume-sheet--modern .resume-summary {
    color: rgba(255, 255, 255, 0.85);
  }

  .resume-sheet--modern .resume-sheet__body {
    padding: 24px 36px 32px;
  }

  .resume-sheet--modern .resume-section {
    border: none;
    background: #f8f9fa;
    border-radius: 8px;
    padding: 18px 20px;
  }

  .resume-sheet--modern .resume-section__title {
    color: #667eea;
    border-bottom-color: #667eea;
  }

  .resume-card {
    padding: 10px 14px;
    margin-bottom: 6px;
    border-left: 3px solid #667eea;
    background: #ffffff;
    font-size: 13px;
    line-height: 1.8;
    border-radius: 0 6px 6px 0;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .resume-sheet--modern .resume-list li::before {
    background: #667eea;
    border-radius: 50%;
    width: 5px;
    height: 5px;
    top: 12px;
  }

  /* === classic 模板 === */
  .resume-sheet.resume-sheet--classic {
    background: #ffffff;
    color: #333333;
    border: 2px solid #999;
    box-shadow: none;
  }

  .resume-sheet--classic .resume-sheet__header {
    padding: 30px 36px 22px;
    border-bottom: 2px solid #333;
    background: #ffffff;
    text-align: center;
  }

  .resume-sheet--classic .resume-sheet__name {
    font-family: 'SimSun', 'STSong', serif;
    font-size: 32px;
    letter-spacing: 6px;
  }

  .resume-sheet--classic .resume-sheet__headline {
    color: #555;
    font-weight: 400;
    font-size: 14px;
  }

  .resume-sheet--classic .resume-meta {
    justify-content: center;
  }

  .resume-sheet--classic .resume-meta__item {
    border: 1px solid #999;
    background: transparent;
    font-size: 12px;
  }

  .resume-sheet--classic .resume-summary {
    text-align: center;
    color: #666;
  }

  .resume-sheet--classic .resume-sheet__body {
    padding: 20px 36px 30px;
  }

  .resume-sheet--classic .resume-section {
    border: none;
    border-bottom: 1px solid #ddd;
    background: transparent;
    padding: 14px 0;
  }

  .resume-sheet--classic .resume-section:last-child {
    border-bottom: none;
  }

  .resume-sheet--classic .resume-section__title {
    color: #333;
    border-bottom: 2px solid #333;
    font-size: 14px;
    letter-spacing: 2px;
  }

  .resume-ordered-list {
    margin: 0;
    padding: 0 0 0 22px;
    display: grid;
    gap: 6px;
  }

  .resume-ordered-list li {
    font-size: 13px;
    line-height: 1.8;
    white-space: pre-wrap;
    word-break: break-word;
    color: #444;
  }

  /* === compact 模板 === */
  .resume-sheet.resume-sheet--compact {
    background: #fafafa;
    color: #2d2d2d;
    border: 2px solid #e0e0e0;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
  }

  .resume-sheet--compact .resume-sheet__header {
    padding: 16px 22px 12px;
    background: #2d2d2d;
    color: #ffffff;
    border-bottom: 3px solid #ff6b35;
  }

  .resume-sheet--compact .resume-sheet__name {
    font-size: 22px;
    letter-spacing: 0;
  }

  .resume-sheet--compact .resume-sheet__headline {
    color: #ff6b35;
    font-size: 12px;
    margin-top: 4px;
  }

  .resume-sheet--compact .resume-meta__item {
    border: 1px solid rgba(255, 255, 255, 0.3);
    background: transparent;
    color: #ddd;
    font-size: 10px;
    min-height: 22px;
    padding: 2px 8px;
  }

  .resume-sheet--compact .resume-summary {
    color: rgba(255, 255, 255, 0.7);
    font-size: 11px;
    margin-top: 8px;
  }

  .resume-sheet--compact .resume-sheet__body {
    padding: 12px 22px 16px;
    gap: 8px;
  }

  .resume-sheet--compact .resume-section {
    border: 1px solid #e0e0e0;
    padding: 10px 14px;
    background: #ffffff;
  }

  .resume-sheet--compact .resume-section__title {
    font-size: 11px;
    margin-bottom: 6px;
    padding-bottom: 2px;
    border-bottom-width: 2px;
    border-bottom-color: #ff6b35;
    color: #ff6b35;
  }

  .resume-compact-items {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .resume-compact-item {
    display: inline-block;
    padding: 4px 10px;
    font-size: 11px;
    line-height: 1.6;
    background: #f5f5f5;
    border: 1px solid #e8e8e8;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .resume-sheet--compact .resume-list li {
    font-size: 11px;
    line-height: 1.6;
    padding-left: 10px;
  }

  .resume-sheet--compact .resume-list li::before {
    width: 4px;
    height: 4px;
    top: 9px;
    border-radius: 50%;
    background: #ff6b35;
  }

  /* === elegant 模板 === */
  .resume-sheet.resume-sheet--elegant {
    background: #fef9f3;
    color: #3a2e2a;
    border: 1px solid #d4c5b0;
    box-shadow: 0 6px 20px rgba(100, 80, 60, 0.08);
  }

  .resume-sheet--elegant .resume-sheet__header {
    padding: 36px 40px 26px;
    background: linear-gradient(180deg, #f5ebe0 0%, #fef9f3 100%);
    border-bottom: 1px solid #d4c5b0;
    text-align: center;
  }

  .resume-sheet--elegant .resume-sheet__name {
    font-family: 'STKaiti', 'KaiTi', 'STSong', serif;
    font-size: 36px;
    font-weight: 400;
    letter-spacing: 8px;
    color: #5a3e36;
  }

  .resume-sheet--elegant .resume-sheet__headline {
    color: #b08968;
    font-weight: 400;
    font-size: 14px;
    letter-spacing: 3px;
  }

  .resume-sheet--elegant .resume-meta {
    justify-content: center;
    gap: 6px;
  }

  .resume-sheet--elegant .resume-meta__item {
    border: none;
    border-bottom: 1px solid #d4c5b0;
    background: transparent;
    font-size: 12px;
    color: #7a6560;
    padding: 4px 8px;
  }

  .resume-sheet--elegant .resume-summary {
    text-align: center;
    color: #8a7a72;
    font-style: italic;
  }

  .resume-sheet--elegant .resume-sheet__body {
    padding: 24px 40px 36px;
  }

  .resume-sheet--elegant .resume-section {
    border: none;
    background: transparent;
    padding: 14px 0;
    border-bottom: 1px dashed #d4c5b0;
  }

  .resume-sheet--elegant .resume-section:last-child {
    border-bottom: none;
  }

  .resume-sheet--elegant .resume-section__title {
    color: #b08968;
    border-bottom: 2px solid #b08968;
    font-size: 13px;
    letter-spacing: 3px;
    text-transform: none;
  }

  .resume-elegant-item {
    padding: 6px 0;
    font-size: 13px;
    line-height: 2;
    color: #5a4e48;
    border-bottom: 1px dotted #e8ddd0;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .resume-elegant-item:last-child {
    border-bottom: none;
  }

  .resume-sheet--elegant .resume-list li {
    color: #5a4e48;
  }

  .resume-sheet--elegant .resume-list li::before {
    background: #b08968;
    border-radius: 50%;
    width: 5px;
    height: 5px;
    top: 12px;
  }

  @media print {
    body.resume-doc-shell {
      padding: 0;
      background: #fff;
    }

    .resume-sheet {
      border: none;
      box-shadow: none;
      max-width: none;
    }
  }
`;

/**
 * 简单 Markdown 转 HTML（零依赖，覆盖简历常用语法）
 * @param {string} md Markdown 原文
 * @returns {string} HTML 字符串
 */
function markdownToHtml(md) {
  if (!md) return '';
  let html = md;

  // 转义 HTML 特殊字符（在处理 Markdown 标记之前）
  html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // 代码块（```...```），先处理避免被后续规则干扰
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><code class="language-${lang}">${code.trim()}</code></pre>`;
  });

  // 行内代码
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // 标题 h1-h6
  html = html.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>');
  html = html.replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>');
  html = html.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

  // 分割线
  html = html.replace(/^---$/gm, '<hr>');

  // 粗体和斜体
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // 图片
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">');

  // 链接
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // 无序列表
  html = html.replace(/^(\s*)[-*+]\s+(.+)$/gm, (match, indent, content) => {
    const level = Math.floor(indent.length / 2);
    return `${indent}<li>${content}</li>`;
  });
  // 包裹连续的 li 为 ul
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>\n$1</ul>\n');

  // 有序列表
  html = html.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');

  // 引用块
  html = html.replace(/^&gt;\s+(.+)$/gm, '<blockquote>$1</blockquote>');
  // 合并连续的 blockquote
  html = html.replace(/<\/blockquote>\n<blockquote>/g, '<br>');

  // 表格
  const lines = html.split('\n');
  let inTable = false;
  let tableRows = [];
  const result = [];
  for (const line of lines) {
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      const cells = line.split('|').slice(1, -1).map(c => c.trim());
      // 跳过分隔行（|---|---|）
      if (cells.every(c => /^[-:]+$/.test(c))) continue;
      if (!inTable) {
        inTable = true;
        tableRows = [];
      }
      tableRows.push(cells);
    } else {
      if (inTable) {
        // 输出表格
        const headerCells = tableRows[0];
        let table = '<table><thead><tr>';
        headerCells.forEach(c => { table += `<th>${c}</th>`; });
        table += '</tr></thead><tbody>';
        for (let i = 1; i < tableRows.length; i++) {
          table += '<tr>';
          tableRows[i].forEach(c => { table += `<td>${c}</td>`; });
          table += '</tr>';
        }
        table += '</tbody></table>';
        result.push(table);
        inTable = false;
        tableRows = [];
      }
      result.push(line);
    }
  }
  // 处理文件末尾的表格
  if (inTable && tableRows.length) {
    const headerCells = tableRows[0];
    let table = '<table><thead><tr>';
    headerCells.forEach(c => { table += `<th>${c}</th>`; });
    table += '</tr></thead><tbody>';
    for (let i = 1; i < tableRows.length; i++) {
      table += '<tr>';
      tableRows[i].forEach(c => { table += `<td>${c}</td>`; });
      table += '</tr>';
    }
    table += '</tbody></table>';
    result.push(table);
  }
  html = result.join('\n');

  // 段落：将非标签行包裹为 <p>
  html = html.replace(/^(?!<[a-z/])(.*\S.*)$/gm, '<p>$1</p>');
  // 移除空 <p></p>
  html = html.replace(/<p>\s*<\/p>/g, '');

  return html;
}

/**
 * 从简历文件名提取基础名（去除扩展名）
 * @param {string} fileName 原始文件名
 * @returns {string} 基础名
 */
function extractBaseName(fileName) {
  if (!fileName) return '简历';
  // 去除 .docx, .doc, .pdf, .md 等扩展名
  return fileName.replace(/\.(docx?|pdf|md|txt|html?)$/i, '');
}

/**
 * 导出为 Markdown
 * @param {string} contentMd Markdown 原文
 * @param {string} fileName 文件基础名
 */
function exportResumeAsMarkdown(contentMd, fileName) {
  const baseName = extractBaseName(fileName);
  const blob = new Blob([contentMd], { type: 'text/markdown;charset=utf-8' });
  triggerDownload(blob, `${baseName}.md`);
  showToast('Markdown 文件已下载', 'success');
}

/**
 * 导出为 HTML（Constructivism 风格，内联 CSS）
 * @param {string} contentMd Markdown 原文
 * @param {string} fileName 文件基础名
 */
function exportResumeAsHTML(contentMd, fileName) {
  const baseName = extractBaseName(fileName);
  const fullHtml = buildResumeDocumentHTML(contentMd, currentResumeTemplate);
  const blob = new Blob([fullHtml], { type: 'text/html;charset=utf-8' });
  triggerDownload(blob, `${baseName}.html`);
  showToast('HTML 文件已下载', 'success');
}

/**
 * 导出为 PDF（通过后端 Puppeteer API）
 */
async function exportResumeAsPDF(contentMd, fileName) {
  showToast('正在生成 PDF...', 'info');
  try {
    const blob = await exportPDFViaAPI({
      content_md: contentMd,
      content_html: buildResumeDocumentHTML(contentMd, currentResumeTemplate),
      template_id: currentResumeTemplate,
    });
    const baseName = extractBaseName(fileName);
    triggerDownload(blob, `${baseName}.pdf`);
    showToast('PDF 文件已下载', 'success');
  } catch (err) {
    showToast('PDF 生成失败：' + err.message, 'error');
  }
}

/**
 * 解析行内格式（**粗体** 和 *斜体*）为 TextRun 数组
 * @param {string} text 原始文本
 * @returns {Array} TextRun 实例数组
 */
function parseInlineFormatting(text) {
  const { TextRun } = window.docx;
  const runs = [];
  // 匹配 **粗体** 或 *斜体*
  const regex = /\*\*(.+?)\*\*|\*(.+?)\*/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    // 普通文本
    if (match.index > lastIndex) {
      runs.push(new TextRun({ text: text.slice(lastIndex, match.index) }));
    }
    if (match[1]) {
      // **粗体**
      runs.push(new TextRun({ text: match[1], bold: true }));
    } else if (match[2]) {
      // *斜体*
      runs.push(new TextRun({ text: match[2], italics: true }));
    }
    lastIndex = regex.lastIndex;
  }
  // 尾部剩余文本
  if (lastIndex < text.length) {
    runs.push(new TextRun({ text: text.slice(lastIndex) }));
  }
  return runs.length > 0 ? runs : [new TextRun({ text })];
}

/**
 * 将 Markdown 文本转为 docx Paragraph 元素数组
 * @param {string} markdown Markdown 原文
 * @returns {Array} Paragraph 实例数组
 */
function parseMarkdownToDocxElements(markdown) {
  const { Paragraph, TextRun, HeadingLevel, BorderStyle } = window.docx;
  const lines = markdown.split('\n');
  const elements = [];

  for (const line of lines) {
    if (line.startsWith('### ')) {
      elements.push(new Paragraph({
        children: [new TextRun({ text: line.slice(4), bold: true, size: 26, color: '1A1A1A' })],
        heading: HeadingLevel.HEADING_3,
        spacing: { before: 200, after: 100 },
      }));
    } else if (line.startsWith('## ')) {
      elements.push(new Paragraph({
        children: [new TextRun({ text: line.slice(3), bold: true, size: 28, color: '1A1A1A' })],
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 300, after: 100 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 2, color: '333333' } },
      }));
    } else if (line.startsWith('# ')) {
      elements.push(new Paragraph({
        children: [new TextRun({ text: line.slice(2), bold: true, size: 32, color: 'E62B1E' })],
        spacing: { after: 100 },
      }));
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      elements.push(new Paragraph({
        children: parseInlineFormatting(line.slice(2)),
        bullet: { level: 0 },
        spacing: { before: 40, after: 40 },
      }));
    } else if (line.trim() === '') {
      // 空行跳过
    } else {
      // 普通段落，处理行内格式
      elements.push(new Paragraph({
        children: parseInlineFormatting(line),
        spacing: { before: 40, after: 40 },
      }));
    }
  }

  return elements;
}

/**
 * 导出为 Word (.docx)
 * @param {string} contentMd Markdown 原文
 * @param {string} fileName 文件基础名
 */
async function exportResumeAsDocx(contentMd, fileName) {
  const { Document, Packer, HeadingLevel } = window.docx;
  showToast('正在生成 Word 文档...', 'info');

  try {
    const elements = parseMarkdownToDocxElements(contentMd);
    const baseName = extractBaseName(fileName);

    const doc = new Document({
      sections: [{
        properties: {
          page: {
            margin: { top: 720, bottom: 720, left: 720, right: 720 },
          },
        },
        children: elements,
      }],
      styles: {
        default: {
          document: {
            run: {
              font: 'Microsoft YaHei',
              size: 22, // 11pt
            },
          },
        },
        paragraphStyles: [
          {
            id: 'Heading1',
            name: 'Heading 1',
            run: {
              font: 'Microsoft YaHei',
              size: 32,
              bold: true,
              color: 'E62B1E',
            },
          },
          {
            id: 'Heading2',
            name: 'Heading 2',
            run: {
              font: 'Microsoft YaHei',
              size: 28,
              bold: true,
              color: '1A1A1A',
            },
          },
          {
            id: 'Heading3',
            name: 'Heading 3',
            run: {
              font: 'Microsoft YaHei',
              size: 26,
              bold: true,
              color: '1A1A1A',
            },
          },
        ],
      },
    });

    const blob = await Packer.toBlob(doc);
    triggerDownload(blob, `${baseName}.docx`);
    showToast('Word 文件已下载', 'success');
  } catch (err) {
    console.error('[DOCX 导出失败]', err);
    showToast('Word 导出失败：' + err.message, 'error');
  }
}

/**
 * 根据格式分发导出逻辑
 * @param {string} format 导出格式 (md/html/pdf/docx)
 */
function dispatchExport(format) {
  const contentMd = getCurrentResumeDraft();
  if (!contentMd.trim()) {
    showToast('暂无简历内容可导出', 'error');
    return;
  }

  const fileName = currentResume ? currentResume.file_name || '' : '';

  switch (format) {
    case 'md':
      exportResumeAsMarkdown(contentMd, fileName);
      break;
    case 'html':
      exportResumeAsHTML(contentMd, fileName);
      break;
    case 'pdf':
      exportResumeAsPDF(contentMd, fileName);
      break;
    case 'docx':
      exportResumeAsDocx(contentMd, fileName);
      break;
    default:
      showToast('不支持的导出格式', 'error');
  }
}

/**
 * 绑定导出下拉菜单事件
 * @param {HTMLElement} container 父容器
 * @param {'default'|'expanded'} viewMode 视图模式
 */
function bindExportDropdownEvents(container, viewMode = 'default') {
  const idPrefix = viewMode === 'default' ? 'def' : 'exp';
  const dropdown = container.querySelector(`#${idPrefix}-export-dropdown`);
  const exportBtn = container.querySelector(`#${idPrefix}-btn-export-resume`);
  const exportMenu = container.querySelector(`#${idPrefix}-export-menu`);

  if (!dropdown || !exportBtn || !exportMenu) return;

  // 点击导出按钮 → 切换下拉菜单
  exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    // 关闭其他打开的导出菜单
    document.querySelectorAll('.export-menu.is-visible').forEach(menu => {
      if (menu !== exportMenu) menu.classList.remove('is-visible');
    });
    exportMenu.classList.toggle('is-visible');
  });

  // 点击菜单项 → 执行导出并关闭菜单
  exportMenu.addEventListener('click', (e) => {
    const item = e.target.closest('.export-menu button[data-format]');
    if (!item) return;
    e.stopPropagation();
    const format = item.dataset.format;
    exportMenu.classList.remove('is-visible');
    dispatchExport(format);
  });

  // 点击菜单外部 → 关闭所有导出菜单
  document.addEventListener('click', () => {
    document.querySelectorAll('.export-menu.is-visible').forEach(menu => {
      menu.classList.remove('is-visible');
    });
  });
}

/**
 * 绑定双模式按钮事件
 * @param {HTMLElement} container 父容器
 * @param {'default'|'expanded'} viewMode 视图模式
 */
function bindResumeDualModeEvents(container, viewMode = 'default') {
  // 绑定导出下拉菜单事件
  bindExportDropdownEvents(container, viewMode);

  const idPrefix = viewMode === 'default' ? 'def' : 'exp';
  const templateSelect = container.querySelector(`#${idPrefix}-resume-template`);

  if (templateSelect) {
    templateSelect.addEventListener('change', () => {
      persistResumeTemplate(templateSelect.value);
      const viewEl = document.getElementById(`${idPrefix}-resume-view`);
      const editEl = document.getElementById(`${idPrefix}-resume-edit`);
      // 使用 currentResumeDraftMd 作为数据源（不从 DOM 反序列化）
      const contentMd = currentResumeDraftMd || (currentResume ? currentResume.content_md || '' : '');
      if (viewEl) {
        viewEl.innerHTML = renderResumePreviewShell(contentMd, currentResumeTemplate, { editable: false, viewMode });
        initializeResumePreviewShells(viewEl);
      }
      const editPreview = editEl ? editEl.querySelector('.resume-edit-dual__preview') : null;
      if (editPreview) {
        editPreview.innerHTML = renderResumePreviewShell(contentMd, currentResumeTemplate, { editable: true, viewMode });
        initializeResumePreviewShells(editEl);
      }
      // 同步分屏中心面板的模板选择器
      const splitSelect = document.getElementById('sp-resume-template');
      if (splitSelect) {
        splitSelect.value = currentResumeTemplate;
      }
      const splitView = document.getElementById('sp-resume-view');
      const splitEdit = document.getElementById('sp-resume-edit');
      if (splitView) {
        splitView.innerHTML = renderResumePreviewShell(contentMd, currentResumeTemplate, { editable: false, viewMode: 'split' });
        initializeResumePreviewShells(splitView);
      }
      const splitEditPreview = splitEdit ? splitEdit.querySelector('.resume-edit-dual__preview') : null;
      if (splitEditPreview) {
        splitEditPreview.innerHTML = renderResumePreviewShell(contentMd, currentResumeTemplate, { editable: true, viewMode: 'split' });
        initializeResumePreviewShells(splitEdit);
      }
    });
  }

  container.addEventListener('click', async (e) => {
    const btn = e.target.closest('.res-btn');
    if (!btn) return;

    // 导出按钮由 bindExportDropdownEvents 处理，此处跳过
    if (btn.id.includes('btn-export-resume')) return;
    if (btn.id.includes('btn-upload')) { triggerFileInput(); return; }

    const mode = btn.dataset.mode;
    const view = btn.dataset.view;
    if (view !== viewMode) return;

    if (mode === 'view' || mode === 'edit') {
      toggleResumeMode(mode, view);
    } else if (btn.id.includes('btn-save')) {
      saveResumeContent(view);
    }
  });
}

/* ==================== 简历上传逻辑 ==================== */

function triggerFileInput() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.pdf,.doc,.docx';
  input.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleResumeUpload(e.target.files[0]);
    }
  });
  input.click();
}

async function handleResumeUpload(file) {
  // 文件大小校验（10MB）
  if (file.size > 10 * 1024 * 1024) {
    showToast('文件大小超过 10MB 限制', 'error');
    return;
  }

  // 文件类型校验
  const allowed = ['.pdf', '.doc', '.docx'];
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  if (!allowed.includes(ext)) {
    showToast('仅支持 PDF、DOC、DOCX 格式', 'error');
    return;
  }

  try {
    await uploadResume(file);
    showToast('简历上传成功', 'success');
    loadResume();
  } catch (err) {
    showToast('上传失败: ' + err.message, 'error');
  }
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
}

/* ==================== N3 WP2: 收藏列表 ==================== */

let currentSplitJobId = null;

async function loadDeliveryList() {
  const container = document.getElementById('delivery-content');
  const countEl = document.getElementById('delivery-count');
  if (!container) return;

  container.innerHTML = '<div class="loading">加载中...</div>';

  try {
    const data = await fetchDeliveryList();
    const jobs = data.jobs || [];
    workspaceFavoriteCount = jobs.length;

    if (countEl) {
      countEl.textContent = jobs.length > 0 ? `${jobs.length}` : '';
      countEl.style.display = jobs.length > 0 ? 'inline-block' : 'none';
    }

    if (jobs.length === 0) {
      container.innerHTML = '<div class="empty-state">暂无收藏岗位</div>';
      applyWorkspaceLayoutState();
      return;
    }

    container.innerHTML = `<div class="delivery-list">${jobs.map(job => renderDeliveryItem(job)).join('')}</div>`;
    bindDeliveryEvents(container);
    applyWorkspaceLayoutState();
  } catch (err) {
    container.innerHTML = '<div class="empty-state"></div>';
    workspaceFavoriteCount = 0;
    if (countEl) { countEl.textContent = ''; countEl.style.display = 'none'; }
    applyWorkspaceLayoutState();
    showToast('加载收藏列表失败: ' + err.message, 'error');
  }
}

function renderDeliveryItem(job) {
  const title = escapeHtml(job.title || '');
  const company = escapeHtml(job.company || '');
  const platform = escapeHtml(job.platform || '');
  const salary = escapeHtml(job.salary || '面议');
  const location = escapeHtml(job.location || '未知');
  const experience = escapeHtml(job.experience || '');
  const education = escapeHtml(job.education || '');

  const platformNames = {
    'boss': 'Boss',
    'liepin': '猎聘',
    '51job': '51job',
    'zhilian': '智联',
  };
  const tagName = platformNames[platform] || platform;

  return `<div class="ws-item" data-id="${job.id}">
    <div class="ws-item-main">
      <div><div class="ws-i1">${title}</div><div class="ws-i2">${company} · ${location}</div></div>
      <span class="ws-badge">${tagName}</span>
    </div>
    <div class="ws-item-detail" style="display:none">
      <div class="delivery-detail__info">
        <p>薪资：${salary}</p>
        ${experience ? `<p>经验：${experience}</p>` : ''}
        ${education ? `<p>学历：${education}</p>` : ''}
      </div>
      <div class="delivery-detail__actions">
        <button class="btn-cancel-select" data-id="${job.id}">取消收藏</button>
        <button class="btn-ai-match" data-id="${job.id}"
                ${!aiConfigured ? 'disabled title="请先配置 AI"' : 'title="AI 智能匹配"'}>AI 智能匹配</button>
      </div>
    </div>
  </div>`;
}

function bindDeliveryEvents(container) {
  container.addEventListener('click', async (e) => {
    // 点击 .ws-item-main 区域 → 打开 50/50 分屏
    const mainArea = e.target.closest('.ws-item-main');
    if (mainArea && !e.target.closest('.btn-cancel-select') && !e.target.closest('.btn-ai-match')) {
      const wsItem = mainArea.closest('.ws-item');
      if (wsItem && wsItem.dataset.id) {
        const jobId = parseInt(wsItem.dataset.id, 10);
        openSplitView(jobId);
      }
      return;
    }

    // 取消收藏按钮
    const cancelBtn = e.target.closest('.btn-cancel-select');
    if (cancelBtn) {
      const jobId = parseInt(cancelBtn.dataset.id, 10);
      if (!jobId) return;

      cancelBtn.disabled = true;
      cancelBtn.textContent = '取消中...';

      try {
        await favoriteJob(jobId);
        showToast('已取消收藏', 'success');
        // 联动更新：关闭当前 50/50 分屏
        if (currentSplitJobId) {
          closeSplitView();
        }
        loadDeliveryList();
        loadJobs();
      } catch (err) {
        showToast('取消收藏失败: ' + err.message, 'error');
        cancelBtn.disabled = false;
        cancelBtn.textContent = '取消收藏';
      }
      return;
    }

    // AI 智能匹配按钮
    const matchBtn = e.target.closest('.btn-ai-match');
    if (matchBtn) {
      if (!aiConfigured) {
        showToast('请先配置 AI', 'error');
        return;
      }

      const jobId = parseInt(matchBtn.dataset.id, 10);
      if (!jobId) return;

      matchBtn.disabled = true;
      matchBtn.textContent = '匹配中...';

      try {
        const data = await matchJobs([jobId]);
        // 后端返回 { success: true, matches: [{ job_id, score, reason }] }
        // 兼容多种返回格式
        const matchResults = data.matches || data.results || [];
        const firstMatch = Array.isArray(matchResults) && matchResults.length > 0 ? matchResults[0] : null;
        const score = data.score != null ? data.score : (firstMatch ? (firstMatch.score != null ? firstMatch.score : firstMatch.match_score) : null);
        if (score != null) {
          const displayScore = Math.round(score * 100);
          const reason = firstMatch?.reason || '';
          showToast(`匹配成功，匹配度：${displayScore}%${reason ? ' - ' + reason : ''}`, 'success');
          const scoreEl = document.createElement('span');
          scoreEl.className = 'ai-match-score';
          scoreEl.textContent = `${displayScore}%`;
          matchBtn.parentNode.insertBefore(scoreEl, matchBtn.nextSibling);
        } else {
          showToast('匹配完成', 'success');
        }
        matchBtn.textContent = 'AI 智能匹配';
      } catch (err) {
        showToast('匹配失败: ' + err.message, 'error');
        matchBtn.textContent = 'AI 智能匹配';
      } finally {
        matchBtn.disabled = !aiConfigured;
      }
    }
  });
}

/* ==================== M10-N3-WP2/WP3/WP4: 50/50 分屏 ==================== */

/**
 * 打开 50/50 分屏视图
 * @param {number} jobId 岗位 ID
 */
async function openSplitView(jobId) {
  currentSplitJobId = jobId;
  document.body.classList.remove('ai-active');
  workspaceAssistantVisible = false;
  applyWorkspaceLayoutState();
  const wsContainer = document.querySelector('.ws');
  const splitEl = document.getElementById('splitView');
  if (wsContainer) wsContainer.style.display = 'none';
  if (splitEl) splitEl.classList.add('on');

  // 加载左栏岗位详情
  await loadSplitLeft(jobId);
  // 加载中栏简历
  loadSplitCenterResume();
  // 加载右栏 AI 助手
  loadSplitRightAssistant(jobId);
}

/**
 * 关闭 50/50 分屏视图，恢复 7:3 工作台
 */
function closeSplitView() {
  currentSplitJobId = null;
  document.body.classList.remove('ai-active');
  const wsContainer = document.querySelector('.ws');
  const splitEl = document.getElementById('splitView');
  if (splitEl) splitEl.classList.remove('on');
  if (wsContainer) wsContainer.style.display = '';
}

/**
 * 加载分屏左栏：岗位详情
 * @param {number} jobId 岗位 ID
 */
async function loadSplitLeft(jobId) {
  const container = document.getElementById('splitLeft');
  if (!container) return;
  container.innerHTML = '<div class="loading">加载中...</div>';

  try {
    const job = await fetchJobDetail(jobId);
    const platformNames = {
      'boss': 'Boss直聘', 'liepin': '猎聘',
      '51job': '前程无忧', 'zhilian': '智联招聘'
    };
    const metaItems = [job.company, job.location, job.industry, job.scale, platformNames[job.platform] || job.platform].filter(Boolean);
    const tags = [];
    if (job.experience) tags.push(job.experience);
    if (job.education) tags.push(job.education);
    if (job.keywords) tags.push(...job.keywords.split(/[,，]/).filter(k => k.trim()));

    container.innerHTML = `
      <button class="btn-back" id="btnBackToList">&larr; 返回列表</button>
      <h2 style="margin-top:20px">${escapeHtml(job.title || '')}</h2>
      <div class="sp-sal">${escapeHtml(job.salary || '面议')}</div>
      <div class="sp-meta">${metaItems.map(i => escapeHtml(i)).join(' · ')}</div>
      <div class="sp-desc">${formatDescription(job.description) || '暂无职位描述'}</div>
      ${tags.length > 0 ? `<div class="sp-tags">${tags.map(t => `<span class="sp-tag">${escapeHtml(t.trim())}</span>`).join('')}</div>` : ''}
      <div class="sp-acts">
        ${renderSourceLink(job.url, 'text-decoration:none;color:inherit;')}
        <button class="bep bep--p" id="btnApplyJob">取消收藏</button>
      </div>
    `;

    // 绑定返回按钮
    const backBtn = document.getElementById('btnBackToList');
    if (backBtn) backBtn.addEventListener('click', closeSplitView);

    // 绑定取消收藏按钮
    const applyBtn = document.getElementById('btnApplyJob');
    if (applyBtn) {
      applyBtn.addEventListener('click', async () => {
        try {
          await favoriteJob(jobId);
          showToast('已取消收藏', 'success');
          closeSplitView();
          loadDeliveryList();
          loadJobs();
        } catch (err) {
          showToast('取消收藏失败: ' + err.message, 'error');
        }
      });
    }
  } catch (err) {
    container.innerHTML = `<div class="empty-state">获取岗位详情失败: ${escapeHtml(err.message)}</div>`;
  }
}

/**
 * 加载分屏中栏：简历编辑（不含 AI 功能）
 */
function loadSplitCenterResume() {
  const container = document.getElementById('splitCenter');
  if (!container) return;

  container.innerHTML = `
    <div class="res-bar" id="splitResBar">
      <button class="res-btn res-btn--active" id="sp-btn-view" data-mode="view">查看</button>
      <button class="res-btn res-btn--g" id="sp-btn-edit" data-mode="edit">编辑</button>
      <button class="res-btn res-btn--g" id="sp-btn-save">保存</button>
      <label class="resume-template-switch" for="sp-resume-template">
        <span>模板</span>
        <select class="resume-template-switch__select" id="sp-resume-template">
          ${RESUME_TEMPLATE_OPTIONS.map(option => `
            <option value="${option.id}" ${option.id === currentResumeTemplate ? 'selected' : ''}>${option.label}</option>
          `).join('')}
        </select>
      </label>
      <button class="res-btn btn-outline" id="sp-btn-upload" title="上传简历文件(.md/.txt/.json/.docx)">上传简历</button>
      <div class="export-dropdown" id="sp-export-dropdown">
        <button class="res-btn res-btn--export btn-export" id="sp-btn-export-resume"
                ${!currentResume ? 'disabled title="请先上传简历"' : ''}>
          下载简历
        </button>
        <div class="export-menu" id="sp-export-menu">
          <button data-format="md">Markdown (.md)</button>
          <button data-format="html">HTML (.html)</button>
          <button data-format="pdf">PDF (.pdf)</button>
          <button data-format="docx">Word (.docx)</button>
        </div>
      </div>
      <button class="btn-ai-vertical" id="sp-btn-ai-toggle" title="AI 助手">AI</button>
    </div>
    <div id="sp-resume-view" class="resume-dual-mode__view"></div>
    <div id="sp-resume-edit" class="resume-dual-mode__edit" style="display:none"></div>
  `;

  // 加载简历内容
  loadSplitResume();
  // 绑定中栏事件
  bindSplitCenterEvents();
}

/**
 * 加载分屏中栏的简历数据
 */
async function loadSplitResume() {
  const viewEl = document.getElementById('sp-resume-view');
  const editEl = document.getElementById('sp-resume-edit');
  if (!viewEl || !editEl) return;

  viewEl.innerHTML = '<div class="loading">加载中...</div>';
  editEl.style.display = 'none';

  try {
    const data = await fetchResume();
    const resume = data.resume;

    if (!resume) {
      viewEl.innerHTML = `
        <div class="resume-empty">
          <p>暂无简历内容</p>
          <button class="upload-btn-simple" id="sp-btn-upload-resume">📄 上传简历</button>
        </div>`;
      const uploadBtn = document.getElementById('sp-btn-upload-resume');
      if (uploadBtn) {
        uploadBtn.addEventListener('click', () => triggerFileInput());
      }
      return;
    }

    // 同步全局简历数据
    currentResume = resume;
    const contentMd = resume.content_md || '';
    currentResumeDraftMd = contentMd;

    // 查看模式渲染
    viewEl.innerHTML = renderResumePreviewShell(contentMd, currentResumeTemplate, { editable: false, viewMode: 'split' });
    // 编辑模式填充
    editEl.innerHTML = renderResumeEdit(contentMd, 'split');
    initializeResumePreviewShells(viewEl);
    initializeResumePreviewShells(editEl);
  } catch (err) {
    viewEl.innerHTML = `<div class="resume-empty">加载简历失败: ${escapeHtml(err.message)}</div>`;
  }
}

/**
 * 绑定分屏中栏的所有事件
 */
function bindSplitCenterEvents() {
  const viewBtn = document.getElementById('sp-btn-view');
  const editBtn = document.getElementById('sp-btn-edit');
  const saveBtn = document.getElementById('sp-btn-save');
  const templateSelect = document.getElementById('sp-resume-template');

  // 查看 / 编辑模式切换
  if (viewBtn && editBtn) {
    viewBtn.addEventListener('click', () => {
      const viewEl = document.getElementById('sp-resume-view');
      const editEl = document.getElementById('sp-resume-edit');
      if (!viewEl || !editEl) return;

      // 从 textarea 读取并更新 currentResumeDraftMd
      const ta = editEl.querySelector('textarea');
      if (ta && ta.value.trim()) {
        currentResumeDraftMd = ta.value;
      }
      const newMd = currentResumeDraftMd || (currentResume ? currentResume.content_md || '' : '');
      viewEl.innerHTML = renderResumePreviewShell(newMd, currentResumeTemplate, { editable: false, viewMode: 'split' });

      viewEl.style.display = '';
      editEl.style.display = 'none';
      viewBtn.classList.add('res-btn--active');
      editBtn.classList.remove('res-btn--active');
      initializeResumePreviewShells(viewEl);
    });

    editBtn.addEventListener('click', () => {
      const viewEl = document.getElementById('sp-resume-view');
      const editEl = document.getElementById('sp-resume-edit');
      if (!viewEl || !editEl) return;

      viewEl.style.display = 'none';
      editEl.style.display = '';
      editBtn.classList.add('res-btn--active');
      viewBtn.classList.remove('res-btn--active');
      initializeResumePreviewShells(editEl);
    });
  }

  // 保存按钮
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const editEl = document.getElementById('sp-resume-edit');
      const ta = editEl ? editEl.querySelector('textarea') : null;
      if (!ta) { showToast('未找到编辑区域', 'error'); return; }

      const contentMd = ta.value || currentResumeDraftMd;
      if (!contentMd.trim()) { showToast('简历内容不能为空', 'error'); return; }

      currentResumeDraftMd = contentMd;

      try {
        await updateResumeContent(contentMd);
        showToast('简历保存成功', 'success');
        if (currentResume) currentResume.content_md = contentMd;

        // 切换到查看模式
        const viewEl = document.getElementById('sp-resume-view');
        if (viewEl) {
          viewEl.innerHTML = renderResumePreviewShell(contentMd, currentResumeTemplate, { editable: false, viewMode: 'split' });
          viewEl.style.display = '';
          editEl.style.display = 'none';
          if (viewBtn) viewBtn.classList.add('res-btn--active');
          if (editBtn) editBtn.classList.remove('res-btn--active');
          initializeResumePreviewShells(viewEl);
        }
      } catch (err) {
        if (err.message && err.message.includes('No resume record found')) {
          showToast('请先上传简历', 'error');
        } else {
          showToast('保存失败: ' + err.message, 'error');
        }
      }
    });
  }

  // 模板切换
  if (templateSelect) {
    templateSelect.addEventListener('change', () => {
      persistResumeTemplate(templateSelect.value);
      const defaultSelect = document.getElementById('def-resume-template');
      if (defaultSelect) {
        defaultSelect.value = currentResumeTemplate;
      }
      // 使用 currentResumeDraftMd 作为数据源
      const contentMd = currentResumeDraftMd || (currentResume ? currentResume.content_md || '' : '');
      const viewEl = document.getElementById('sp-resume-view');
      const editEl = document.getElementById('sp-resume-edit');
      if (viewEl) {
        viewEl.innerHTML = renderResumePreviewShell(contentMd, currentResumeTemplate, { editable: false, viewMode: 'split' });
        initializeResumePreviewShells(viewEl);
      }
      const editPreview = editEl ? editEl.querySelector('.resume-edit-dual__preview') : null;
      if (editPreview) {
        editPreview.innerHTML = renderResumePreviewShell(contentMd, currentResumeTemplate, { editable: true, viewMode: 'split' });
        initializeResumePreviewShells(editEl);
      }
      // 也同步主视图
      const mainView = document.getElementById('def-resume-view');
      const mainEdit = document.getElementById('def-resume-edit');
      if (mainView) {
        mainView.innerHTML = renderResumePreviewShell(contentMd, currentResumeTemplate, { editable: false, viewMode: 'default' });
        initializeResumePreviewShells(mainView);
      }
      const mainEditPreview = mainEdit ? mainEdit.querySelector('.resume-edit-dual__preview') : null;
      if (mainEditPreview) {
        mainEditPreview.innerHTML = renderResumePreviewShell(contentMd, currentResumeTemplate, { editable: true, viewMode: 'default' });
        initializeResumePreviewShells(mainEdit);
      }
    });
  }

  // 导出下拉菜单
  const exportDropdown = document.getElementById('sp-export-dropdown');
  const exportBtn = document.getElementById('sp-btn-export-resume');
  const exportMenu = document.getElementById('sp-export-menu');
  if (exportDropdown && exportBtn && exportMenu) {
    exportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.export-menu.is-visible').forEach(menu => {
        if (menu !== exportMenu) menu.classList.remove('is-visible');
      });
      exportMenu.classList.toggle('is-visible');
    });
    exportMenu.addEventListener('click', (e) => {
      const item = e.target.closest('.export-menu button[data-format]');
      if (!item) return;
      e.stopPropagation();
      const format = item.dataset.format;
      exportMenu.classList.remove('is-visible');
      dispatchExport(format);
    });
  }

  // 上传按钮
  const spUploadBtn = document.getElementById('sp-btn-upload');
  if (spUploadBtn) {
    spUploadBtn.addEventListener('click', () => triggerFileInput());
  }

  // AI 切换按钮（竖向）
  const aiToggleBtn = document.getElementById('sp-btn-ai-toggle');
  if (aiToggleBtn) {
    aiToggleBtn.addEventListener('click', () => {
      document.body.classList.toggle('ai-active');
      const isActive = document.body.classList.contains('ai-active');
      aiToggleBtn.textContent = isActive ? '✕' : 'AI';
      aiToggleBtn.classList.toggle('is-active', isActive);
    });
  }
}

/**
 * 加载分屏右栏：AI 助手面板
 * @param {number|null} jobId 目标岗位 ID
 * @param {{ containerId?: string, sessionKey?: string }} options
 */
/**
 * 构建 AI 助手面板 HTML 骨架（workspace 和 split view 共用）
 * @param {{ mode?: 'workspace' | 'split' }} options
 * @returns {string}
 */
function buildAssistantPanelShell({ mode = 'workspace' } = {}) {
  const providerOptions = Object.entries(AI_PROVIDER_DEFAULTS).map(
    ([key, val]) => `<option value="${key}">${val.label}</option>`
  ).join('');

  const welcomeText = mode === 'workspace'
    ? ''  // workspace 模式下欢迎语由 state 驱动，不写死在模板里
    : `<div class="message ai">
        <div class="message-avatar ai-avatar">🤖</div>
        <div class="message-body">
          <div class="message-meta">
            <span class="message-sender">AI 助手</span>
            <span class="message-time">${getAIChatTime()}</span>
          </div>
          <div class="message-bubble">
            <div class="message-text">
              你好！我是你的简历优化助手。<br>
              你可以发送消息让我帮你优化简历、分析岗位匹配度，或者直接提问。
            </div>
          </div>
        </div>
      </div>`;

  return `
    <div class="ai-panel-shell">
      <div class="ai-panel-header">
        <div class="ai-panel-title">AI 助手</div>
        <div class="ai-panel-actions">
          <button class="ai-panel-btn" id="btn-ai-settings">⚙️ 设置</button>
          <button class="ai-panel-btn" id="btn-clear-chat">清空</button>
        </div>
      </div>
      <div class="ai-panel-overlay-zone">
        <div class="ai-settings-panel" id="aiSettingsPanel">
          <div class="ai-settings-header">
            <span>AI 配置</span>
            <button class="ai-settings-close" id="btn-close-settings">✕</button>
          </div>
          <div class="ai-settings-content">
            <div class="ai-setting-item">
              <label class="ai-setting-label">Provider</label>
              <select class="ai-setting-select" id="sp-ai-provider">
                ${providerOptions}
              </select>
            </div>
            <div class="ai-setting-item">
              <label class="ai-setting-label">API Base URL</label>
              <input type="text" class="ai-setting-input" id="sp-ai-base-url" placeholder="https://open.bigmodel.cn/api/coding/paas/v4">
            </div>
            <div class="ai-setting-item">
              <label class="ai-setting-label">API Key</label>
              <input type="password" class="ai-setting-input" id="sp-ai-api-key" placeholder="输入你的 API Key" autocomplete="off">
            </div>
            <div class="ai-setting-item">
              <label class="ai-setting-label">模型名称</label>
              <input type="text" class="ai-setting-input" id="sp-ai-model" placeholder="glm-5">
            </div>
            <button class="ai-setting-save" id="sp-ai-save-btn">保存配置</button>
            <div class="ai-deep-think-toggle" style="margin-top:12px">
              <label class="ai-dt-toggle-label">
                <span>深度思考</span>
                <input type="checkbox" id="sp-dt-toggle" class="ai-dt-toggle-input">
                <span class="ai-dt-toggle-slider"></span>
              </label>
            </div>
            <div class="ai-secondary-model-section" id="sp-secondary-model">
              <button class="ai-secondary-model-toggle" id="sp-sec-model-toggle" type="button">▶ 第二模型配置</button>
              <div class="ai-secondary-model-body" id="sp-sec-model-body" style="display:none">
                <div class="ai-setting-item"><label class="ai-setting-label">Provider</label><select class="ai-setting-select" id="sp-sec-provider">${providerOptions}</select></div>
                <div class="ai-setting-item"><label class="ai-setting-label">API Base URL</label><input class="ai-setting-input" id="sp-sec-base-url" placeholder="https://api.openai.com/v1"></div>
                <div class="ai-setting-item"><label class="ai-setting-label">API Key</label><input class="ai-setting-input" type="password" id="sp-sec-api-key" placeholder="输入第二模型 API Key" autocomplete="off"></div>
                <div class="ai-setting-item"><label class="ai-setting-label">模型名称</label><input class="ai-setting-input" id="sp-sec-model" placeholder="gpt-4o"></div>
                <button class="ai-setting-save" id="sp-sec-save-btn">保存第二模型</button>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="ai-panel-main">
        <div class="ai-messages" id="aiMessages">
          ${welcomeText}
          <div class="typing-indicator" id="typingIndicator" style="display: none;">
            <span></span><span></span><span></span>
          </div>
          <div class="ai-stream-status" id="aiStreamStatus" style="display: none;"></div>
        </div>
        <div class="ai-input-minimal ai-input-bar">
          <label class="upload-minimal-btn" title="上传图片或文件">
            +
            <input type="file" id="aiFileUpload" accept="image/*,.pdf,.doc,.docx,.txt,.md" multiple>
          </label>
          <input type="text" class="ai-input-field" id="aiInput" placeholder="输入消息...">
          <button class="send-minimal-btn" id="sendBtn">➤</button>
        </div>
      </div>
    </div>
  `;
}

function loadSplitRightAssistant(jobId, options = {}) {
  const containerId = options.containerId || 'splitRight';
  const sessionKey = options.sessionKey || jobId;
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = buildAssistantPanelShell({ mode: 'split' });

  // 恢复历史消息
  const savedMessages = loadAssistantSession(sessionKey);
  if (savedMessages.length > 0) {
    aiConversationHistory = savedMessages;
    const msgContainer = document.getElementById('aiMessages');
    if (msgContainer) {
      for (const msg of savedMessages) {
        if (msg.role === 'user') {
          addAIUserMessage(msg.text);
        } else if (msg.role === 'assistant') {
          addAIResponseMessage(msg.text);
        }
      }
    }
  }

  // 绑定 AI 助手事件
  bindSplitRightAssistantEvents(jobId, { sessionKey });
  // 加载 AI 配置
  loadSplitAIConfig();

  // 能力探测
  getAICapabilities().then(caps => {
    const dtToggle = document.getElementById('sp-dt-toggle');
    if (dtToggle) {
      if (!caps.deep_think) {
        dtToggle.disabled = true;
        dtToggle.closest('.ai-deep-think-toggle').title = '深度思考能力未就绪';
      } else {
        dtToggle.disabled = false;
      }
    }
    window.__aiCapabilities = caps;
  }).catch(e => {
    console.warn('能力探测失败:', e.message);
    window.__aiCapabilities = { assistant_chat: true, deep_think: false };
  });
}

function getAIChatTime() {
  const now = new Date();
  return `${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')}`;
}

/* ==================== Workspace AI 助手渲染函数 ==================== */

/** 构建单条消息 HTML */
function buildMsgHtml(msg) {
  if (msg.role === 'user') {
    return `<div class="message user" data-msg-id="${msg.id}">
      <div class="message-body">
        <div class="message-meta">
          <span class="message-sender">你</span>
          <span class="message-time">${msg.timestamp || ''}</span>
        </div>
        <div class="message-bubble">
          <div class="message-text">${escapeHtml(msg.text)}</div>
        </div>
      </div>
      <div class="message-avatar user-avatar">👤</div>
    </div>`;
  }
  if (msg.role === 'system') {
    return `<div class="message ai" data-msg-id="${msg.id}">
      <div class="message-avatar ai-avatar">⚙️</div>
      <div class="message-body">
        <div class="message-meta">
          <span class="message-sender">系统</span>
          <span class="message-time">${msg.timestamp || ''}</span>
        </div>
        <div class="message-bubble">
          <div class="message-text">${msg.text.replace(/\n/g, '<br>')}</div>
        </div>
      </div>
    </div>`;
  }
  // assistant
  const cursor = msg.status === 'streaming' ? '<span class="streaming-cursor">▊</span>' : '';
  return `<div class="message ai" data-msg-id="${msg.id}">
    <div class="message-avatar ai-avatar">🤖</div>
    <div class="message-body">
      <div class="message-meta">
        <span class="message-sender">AI 助手</span>
        <span class="message-time">${msg.timestamp || ''}</span>
      </div>
      <div class="message-bubble">
        <div class="message-text">${msg.text.replace(/\n/g, '<br>')}${cursor}</div>
      </div>
    </div>
  </div>`;
}

/** workspace 消息区全量渲染（只操作 #aiMessages 内部，不碰面板结构） */
function renderWorkspaceAssistant() {
  const aiMessages = document.getElementById('aiMessages');
  if (!aiMessages) return;

  let html = wsAssistant.messages.map(msg => buildMsgHtml(msg)).join('');

  // 追加进度状态
  if (wsAssistant.streamStatusLines.length > 0) {
    html += `<div class="ai-stream-status" style="display:block">`;
    html += wsAssistant.streamStatusLines.slice(-8).map(l => `<div class="ai-stream-line">${l}</div>`).join('');
    html += `</div>`;
  }

  // 推荐进度
  if (wsAssistant.recommendProgress) {
    html += `<div class="ai-recommend-progress"><span class="recommend-spinner"></span> 正在智能匹配岗位...</div>`;
  }

  // typing indicator
  html += `<div class="typing-indicator" id="typingIndicator" style="display: ${wsAssistant.running ? 'flex' : 'none'}"><span></span><span></span><span></span></div>`;

  aiMessages.innerHTML = html;
  aiMessages.scrollTop = aiMessages.scrollHeight;
}

/** 流式期间增量更新（按 streamingMsgId 精确定位） */
function patchStreamingMessage() {
  const aiMessages = document.getElementById('aiMessages');
  if (!aiMessages) return;

  const targetEl = aiMessages.querySelector(`[data-msg-id="${wsAssistant.streamingMsgId}"]`);
  if (!targetEl) {
    renderWorkspaceAssistant(); // 降级全量渲染
    return;
  }

  const msg = wsAssistant.messages.find(m => m.id === wsAssistant.streamingMsgId);
  if (msg) {
    const textEl = targetEl.querySelector('.message-text');
    if (textEl) textEl.innerHTML = msg.text.replace(/\n/g, '<br>') + '<span class="streaming-cursor">▊</span>';
  }

  // 更新 status lines
  const statusEl = aiMessages.querySelector('.ai-stream-status');
  if (statusEl && wsAssistant.streamStatusLines.length > 0) {
    statusEl.innerHTML = wsAssistant.streamStatusLines.slice(-8).map(l => `<div class="ai-stream-line">${l}</div>`).join('');
    statusEl.style.display = 'block';
  }

  aiMessages.scrollTop = aiMessages.scrollHeight;
}

/** RAF 防抖渲染调度 */
let assistantRenderRAF = null;

function scheduleAssistantRender(forceFull = false) {
  if (assistantRenderRAF) cancelAnimationFrame(assistantRenderRAF);
  assistantRenderRAF = requestAnimationFrame(() => {
    if (forceFull || wsAssistant.phase !== 'streaming') {
      renderWorkspaceAssistant();
    } else {
      patchStreamingMessage();
    }
    assistantRenderRAF = null;
  });
}

/** SSE 事件 → state 更新（不碰 DOM） */
function applyAssistantEventToState(event) {
  if (event.type === 'trace' && event.message) {
    const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const extra = [];
    if (event.tool) extra.push(`工具: ${event.tool}`);
    if (event.file) extra.push(`文件: ${event.file}`);
    wsAssistant.streamStatusLines.push(`[${ts}] ${event.message}${extra.length ? ` | ${extra.join(' | ')}` : ''}`);
    if (wsAssistant.streamStatusLines.length > 20) wsAssistant.streamStatusLines = wsAssistant.streamStatusLines.slice(-20);
  }
  if (event.type === 'tool' && event.tool === 'smart_job_recommend') {
    wsAssistant.recommendProgress = true;
  }
  // job_recommendations → 保存到 state 供渲染
  if (event.type === 'job_recommendations' && Array.isArray(event.jobs)) {
    window.__lastRecommendations = event;
  }
}

/** 简历 ops 实时应用（独立于 AI 面板 DOM） */
function applyResumeOpsRealtime(ops) {
  try {
    if (!getCurrentResumeDocument() && currentResumeDraftMd) {
      initResumeDocumentFromMarkdown(currentResumeDraftMd);
    }
    const doc = getCurrentResumeDocument();
    if (doc) {
      executeBatch(ops, 'direct');
      const newMd = doc.toMarkdown();
      currentResumeDraftMd = newMd;
      if (currentResume) currentResume.content_md = newMd;
      refreshAllResumeViews();
    }
  } catch (e) {
    console.warn('[AI] 实时 ops 应用失败:', e.message);
  }
}

function addAIUserMessage(text) {
  const aiMessages = document.getElementById('aiMessages');
  const typingIndicator = document.getElementById('typingIndicator');
  if (!aiMessages) return;

  const messageDiv = document.createElement('div');
  messageDiv.className = 'message user';
  messageDiv.innerHTML = `
    <div class="message-body">
      <div class="message-meta">
        <span class="message-sender">你</span>
        <span class="message-time">${getAIChatTime()}</span>
      </div>
      <div class="message-bubble">
        <div class="message-text">${escapeHtml(text)}</div>
      </div>
    </div>
    <div class="message-avatar user-avatar">👤</div>
  `;

  if (typingIndicator) {
    aiMessages.insertBefore(messageDiv, typingIndicator);
  } else {
    aiMessages.appendChild(messageDiv);
  }
  aiMessages.scrollTop = aiMessages.scrollHeight;
}

/**
 * 渲染 AI 推荐岗位卡片到聊天区域
 */
function renderJobRecommendationCards(data) {
  const aiMessages = document.getElementById('aiMessages');
  if (!aiMessages) return;

  const cardsContainer = document.createElement('div');
  cardsContainer.className = 'ai-recommend-cards';
  cardsContainer.innerHTML = `
    <div class="recommend-header">
      <span class="recommend-icon">🎯</span>
      <span class="recommend-title">智能推荐岗位</span>
      <button class="recommend-action-btn recommend-select-all" onclick="selectAllRecommendedJobs(this)">
        全部加入工作台
      </button>
    </div>
    <div class="recommend-list" id="recommendJobList">
      <p class="recommend-loading">岗位推荐数据将在 AI 回复中展示</p>
    </div>
  `;

  const lastMessage = aiMessages.querySelector('.message.ai:last-of-type');
  if (lastMessage) {
    lastMessage.after(cardsContainer);
  } else {
    aiMessages.appendChild(cardsContainer);
  }
  aiMessages.scrollTop = aiMessages.scrollHeight;
}

/**
 * 渲染单个推荐岗位卡片
 */
function renderSingleRecommendCard(job) {
  const scoreClass = job.score >= 80 ? 'high' : job.score >= 60 ? 'medium' : 'low';
  const reasons = (job.reasons || []).map(r => `<span class="reason-tag">${escapeHtml(r)}</span>`).join('');

  return `
    <div class="recommend-job-card" data-job-id="${job.id}">
      <div class="recommend-card-header">
        <span class="recommend-score score-${scoreClass}">${job.score}分</span>
        <span class="recommend-job-title">${escapeHtml(job.title || '')}</span>
        <button class="recommend-select-btn" onclick="selectRecommendedJob(${job.id}, this)" title="加入工作台">
          ➕
        </button>
      </div>
      <div class="recommend-card-body">
        <span class="recommend-company">${escapeHtml(job.company || '')}</span>
        <span class="recommend-salary">${escapeHtml(job.salary || '')}</span>
        <span class="recommend-location">${escapeHtml(job.location || '')}</span>
      </div>
      ${reasons ? `<div class="recommend-reasons">${reasons}</div>` : ''}
    </div>
  `;
}

/**
 * 选中单个推荐岗位
 */
async function selectRecommendedJob(jobId, btnEl) {
  try {
    btnEl.disabled = true;
    btnEl.textContent = '⏳';
    await setFavoriteJob(jobId, true);
    btnEl.textContent = '✅';
    btnEl.classList.add('selected');
    workspaceFavoriteCount += 1;
    loadDeliveryList();
  } catch (e) {
    console.error('[推荐] 选中失败:', e);
    btnEl.textContent = '❌';
    btnEl.disabled = false;
  }
}

/**
 * 全部加入工作台
 */
async function selectAllRecommendedJobs(btnEl) {
  const cards = document.querySelectorAll('.recommend-job-card');
  const jobIds = Array.from(cards).map(c => Number(c.dataset.jobId)).filter(Boolean);
  if (jobIds.length === 0) return;

  btnEl.disabled = true;
  btnEl.textContent = '⏳ 导入中...';

  let successCount = 0;
  try {
    const result = await batchFavoriteJobs(jobIds, true);
    successCount = Number(result.updated) || 0;
  } catch (e) {
    console.error('[推荐] 批量加入工作台失败:', e);
  }

  btnEl.textContent = `✅ 已导入 ${successCount}/${jobIds.length}`;
  loadDeliveryList();

  cards.forEach(card => {
    const btn = card.querySelector('.recommend-select-btn');
    if (btn) {
      btn.textContent = '✅';
      btn.classList.add('selected');
      btn.disabled = true;
    }
  });
}

function addAIResponseMessage(text, sender = 'AI 助手') {
  const aiMessages = document.getElementById('aiMessages');
  const typingIndicator = document.getElementById('typingIndicator');
  if (!aiMessages) return;

  const messageDiv = document.createElement('div');
  messageDiv.className = 'message ai';
  messageDiv.innerHTML = `
    <div class="message-avatar ai-avatar">🤖</div>
    <div class="message-body">
      <div class="message-meta">
        <span class="message-sender">${escapeHtml(sender)}</span>
        <span class="message-time">${getAIChatTime()}</span>
      </div>
      <div class="message-bubble">
        <div class="message-text">${text.replace(/\n/g, '<br>')}</div>
      </div>
    </div>
  `;

  if (typingIndicator) {
    aiMessages.insertBefore(messageDiv, typingIndicator);
  } else {
    aiMessages.appendChild(messageDiv);
  }
  aiMessages.scrollTop = aiMessages.scrollHeight;
}

function showAITyping() {
  const indicator = document.getElementById('typingIndicator');
  const aiMessages = document.getElementById('aiMessages');
  if (indicator) indicator.style.display = 'flex';
  if (aiMessages) aiMessages.scrollTop = aiMessages.scrollHeight;
}

function hideAITyping() {
  const indicator = document.getElementById('typingIndicator');
  if (indicator) {
    indicator.style.display = 'none';
    indicator.innerHTML = '<span></span><span></span><span></span>';
  }
}

/**
 * 格式化深度思考结果为结构化卡片
 */
function formatDeepThinkItem(item) {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return String(item || '');
  return item.content || item.text || item.issue || item.summary || item.reason || item.message || JSON.stringify(item, null, 2);
}

function formatDeepThinkReply(dtData) {
  if (!dtData) return '深度思考执行失败';

  const result = dtData.result || dtData;
  if (typeof result === 'string') return result;

  const modeLabel = { single: '单模型', dual: '双模型', auto: '自动' };
  const stopLabel = {
    max_rounds: '达到最大轮次',
    no_new_info: '连续多轮无新增信息',
    api_error: 'API错误',
    critic_stop: '评审建议停止',
    critic_suggests_stop: '评审认为信息已充分',
    stable_conclusions: '结论已稳定',
    config_error: '配置错误',
    no_primary_model: '未配置主模型'
  };

  const mode = modeLabel[result.mode_used] || result.mode_used || '未知';
  const rounds = result.rounds_used || 0;
  const stopReason = stopLabel[result.stop_reason] || result.stop_reason || '完成';
  const degraded = result.degraded || false;
  const answer = result.final_answer || result.answer || result.summary || '';

  const state = result.state || {};
  const conclusions = (state.verified_conclusions || []).map(c => formatDeepThinkItem(c)).filter(Boolean);
  const openQuestions = (state.open_questions || []).map(q => formatDeepThinkItem(q)).filter(Boolean);
  const logs = result.logs || [];

  // 如果没有结构化数据，回退到纯文本拼接
  if (!answer && !conclusions.length && !logs.length) {
    const parts = [];
    if (result.final_answer) parts.push(result.final_answer);
    if (result.summary) parts.push(result.summary);
    if (result.analysis) parts.push(result.analysis);
    if (result.rounds && Array.isArray(result.rounds)) {
      parts.push('**思考过程：**');
      result.rounds.forEach((r, i) => {
        if (r.reasoning) parts.push(`第${i+1}轮：${r.reasoning}`);
      });
    }
    if (parts.length > 0) return parts.join('\n\n');
    return JSON.stringify(result, null, 2);
  }

  let html = `<div class="dt-result-card">`;

  html += `<div class="dt-card-header">
    <span class="dt-card-icon">🧠</span>
    <span class="dt-card-title">深度思考分析</span>
    <div class="dt-card-meta">
      <span class="dt-meta-tag">${mode}</span>
      <span class="dt-meta-tag">${rounds} 轮</span>
      <span class="dt-meta-tag">${stopReason}</span>
      ${degraded ? '<span class="dt-meta-tag dt-degraded">⚠ 已降级</span>' : ''}
    </div>
  </div>`;

  if (answer) {
    html += `<div class="dt-card-section">
      <div class="dt-section-title">📋 分析结论</div>
      <div class="dt-section-body">${escapeHtml(answer).replace(/\n/g, '<br>')}</div>
    </div>`;
  }

  if (conclusions.length > 0) {
    html += `<div class="dt-card-section">
      <div class="dt-section-title">✅ 关键发现 (${conclusions.length})</div>
      <ul class="dt-conclusion-list">
        ${conclusions.map(c => `<li>${escapeHtml(c)}</li>`).join('')}
      </ul>
    </div>`;
  }

  if (openQuestions.length > 0) {
    html += `<div class="dt-card-section">
      <div class="dt-section-title">❓ 待探讨 (${openQuestions.length})</div>
      <ul class="dt-conclusion-list">
        ${openQuestions.map(q => `<li>${escapeHtml(q)}</li>`).join('')}
      </ul>
    </div>`;
  }

  if (logs.length > 0) {
    // 按轮次分组
    const roundMap = new Map();
    logs.forEach(log => {
      const round = (typeof log === 'object' && log.round) || 0;
      if (!roundMap.has(round)) roundMap.set(round, []);
      roundMap.get(round).push(log);
    });

    const totalRoundCount = roundMap.size;
    html += `<div class="dt-card-section dt-trace-section">
      <button class="dt-trace-toggle" onclick="this.parentElement.classList.toggle('dt-trace-open')">
        ▶ 思考过程 (${totalRoundCount} 轮, ${logs.length} 条记录)
      </button>
      <div class="dt-trace-body">`;

    for (const [roundNum, roundLogs] of roundMap) {
      const roundLabel = roundNum === 0 ? '初始化' : `第 ${roundNum} 轮`;
      html += `<div class="dt-round-group">
        <div class="dt-round-header" onclick="this.parentElement.classList.toggle('dt-round-open')">
          ▶ ${roundLabel}
        </div>
        <div class="dt-round-body">`;

      roundLogs.forEach(log => {
        const phase = (typeof log === 'object' && log.phase) || '';
        const phaseLabel = { analyst: '🔍 分析师', critic: '⚖️ 评审', summarizer: '📝 总结', init: '🚀 初始化', compress: '🗜️ 压缩' }[phase] || phase;
        const msg = formatDeepThinkItem(log);
        const levelClass = (typeof log === 'object' && log.level === 'error') ? ' dt-trace-error' : '';
        html += `<div class="dt-trace-item${levelClass}">`;
        if (phaseLabel) html += `<span class="dt-trace-phase">${phaseLabel}</span> `;
        html += `${escapeHtml(msg)}</div>`;
      });

      html += `</div></div>`;
    }

    html += `</div></div>`;
  }

  html += `</div>`;
  return html;
}

/* ==================== 顶层：深度思考判断 + 发送消息 + 完成处理 ==================== */

/** 判断是否触发深度思考（从闭包提取为顶层函数） */
function shouldTriggerDeepThink(text, context) {
  const msg = String(text || '').trim();
  if (!msg) return false;
  if (msg.length < 10) return false;
  const greetings = ['你好', '您好', 'hi', 'hello', '在吗', '嗨', '你是谁', '谢谢', '好的', '嗯', 'ok', 'thanks', '再见', 'bye'];
  if (greetings.includes(msg.toLowerCase())) return false;
  if (msg.length < 20 && (msg.endsWith('？') || msg.endsWith('?'))) return false;
  const explicitKeywords = ['深度分析', '深度思考', '深入分析', '多轮推理', '全面分析', '详细拆解', '根本原因', '深入思考'];
  if (explicitKeywords.some(k => msg.includes(k))) return true;
  const analysisKeywords = ['分析', '对比', '评估', '匹配', '差距', '优化', '策略', '建议', '改进', '诊断', '问题'];
  const hasAnalysis = analysisKeywords.some(k => msg.includes(k));
  if (hasAnalysis && msg.length >= 15) return true;
  if (context?.jobId && msg.length >= 40) return true;
  return false;
}

/** 处理 SSE 完成，更新占位消息为最终结果 */
function processAssistantDone(data, assistantMsgId) {
  let reply = data.reply || data.message || data.response || '（无回复）';
  if (typeof reply === 'string' && reply.trim().startsWith('{')) {
    try {
      const leaked = JSON.parse(reply.trim());
      if (leaked.reply) reply = leaked.reply;
      else if (leaked.action && leaked.content) reply = leaked.content;
    } catch {}
  }

  const resumeContentMd = data.resume_updated_content_md;
  // 在 delete 之前提取，避免后续判断时字段已丢失
  const toolTrace = data.tool_trace || [];
  delete data.memory_update_reason;
  delete data.tool_trace;
  delete data.resume_updated_content_md;

  // 把占位消息改为最终回复
  const msg = wsAssistant.messages.find(m => m.id === assistantMsgId);
  if (msg) {
    msg.text = reply;
    msg.status = 'done';
  }

  // 脏标记（基于提取的 toolTrace 局部变量）
  for (const t of toolTrace) {
    if (['batch_select_jobs', 'batch_deselect_jobs', 'clear_all_favorites', 'filter_favorites'].includes(t.tool)) {
      wsAssistant.dirtyFavorites = true;
    }
    if (t.tool === 'smart_job_recommend' && t.result && t.result.auto_selected) {
      wsAssistant.dirtyFavorites = true;
    }
  }

  // 处理 resume 更新
  if (data.resume_updated) {
    if (data.resume_ops && Array.isArray(data.resume_ops) && data.resume_ops.length > 0) {
      try {
        if (!getCurrentResumeDocument() && currentResumeDraftMd) {
          initResumeDocumentFromMarkdown(currentResumeDraftMd);
        }
        const doc = getCurrentResumeDocument();
        if (doc) {
          executeBatch(data.resume_ops, 'direct');
          const newMd = doc.toMarkdown();
          currentResumeDraftMd = newMd;
          if (currentResume) currentResume.content_md = newMd;
          updateResumeContent(newMd).catch(e => console.warn('[AI] 保存失败:', e.message));
          refreshAllResumeViews();
        }
      } catch {
        if (resumeContentMd) {
          currentResumeDraftMd = resumeContentMd;
          if (currentResume) currentResume.content_md = resumeContentMd;
          refreshAllResumeViews();
        }
      }
      const summary = data.resume_change_summary;
      let summaryText = summary && summary.changed_sections
        ? `简历已更新：修改了 ${summary.changed_sections.join('、')}`
        : '简历已根据 AI 建议更新，请查看中栏';
      wsAssistant.messages.push({ id: Date.now(), role: 'system', text: summaryText, timestamp: getAIChatTime(), status: 'done' });
    } else if (resumeContentMd) {
      currentResumeDraftMd = resumeContentMd;
      if (currentResume) currentResume.content_md = resumeContentMd;
      refreshAllResumeViews();
      wsAssistant.messages.push({ id: Date.now(), role: 'system', text: '简历已根据 AI 建议更新', timestamp: getAIChatTime(), status: 'done' });
    }
  }

  // 脏视图刷新
  if (wsAssistant.dirtyFavorites) { loadDeliveryList(); wsAssistant.dirtyFavorites = false; }

  wsAssistant.phase = 'done';
  wsAssistant.recommendProgress = false;
  wsAssistant.streamingMsgId = null;
  saveAssistantSession(wsAssistant.sessionKey, wsAssistant.messages.filter(m => m.status === 'done').map(m => ({ role: m.role, text: m.text })));
  scheduleAssistantRender(true);
}

/** workspace 路径：发送 AI 消息（顶层函数，防重入 + activeRequestId 校验 + 只写 state） */
async function sendAIMessage() {
  if (wsAssistant.running) return;

  const input = document.getElementById('aiInput');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;

  input.value = '';

  const requestId = Date.now();
  wsAssistant.activeRequestId = requestId;
  wsAssistant.running = true;
  wsAssistant.sendBtnDisabled = true;
  wsAssistant.phase = 'streaming';
  wsAssistant.streamStatusLines = [];
  wsAssistant.recommendProgress = false;

  // 追加用户消息到 state
  wsAssistant.messages.push({ id: requestId, role: 'user', text, timestamp: getAIChatTime(), status: 'done' });

  // 插入占位 assistant 消息（status='streaming'）
  const assistantMsgId = requestId + 1;
  wsAssistant.streamingMsgId = assistantMsgId;
  wsAssistant.messages.push({ id: assistantMsgId, role: 'assistant', text: '', timestamp: getAIChatTime(), status: 'streaming' });

  saveAssistantSession(wsAssistant.sessionKey, wsAssistant.messages.filter(m => m.status === 'done').map(m => ({ role: m.role, text: m.text })));
  scheduleAssistantRender(true);

  try {
    const dtToggle = document.getElementById('sp-dt-toggle');
    const deepThinkEnabled = dtToggle && dtToggle.checked;
    const shouldDT = deepThinkEnabled && shouldTriggerDeepThink(text, { jobId: null, resumeReady: !!currentResumeDraftMd });

    let data;
    if (shouldDT) {
      wsAssistant.phase = 'deep_think';
      scheduleAssistantRender(true);
      data = await deepThink(text, null);
      data = { reply: formatDeepThinkReply(data), resume_updated: false };
    } else {
      data = await chatWithAIAssistantStream(null, text,
        wsAssistant.messages.filter(m => m.status === 'done').map(m => ({ role: m.role, text: m.text })),
        (event) => {
          if (wsAssistant.activeRequestId !== requestId) return;

          applyAssistantEventToState(event);

          if (event.type === 'text_delta' && event.text) {
            const msg = wsAssistant.messages.find(m => m.id === assistantMsgId);
            if (msg) msg.text += event.text;
          }

          if (event.type === 'resume_ops_batch' && Array.isArray(event.ops)) {
            applyResumeOpsRealtime(event.ops);
          }

          scheduleAssistantRender();
        }
      );
    }

    if (wsAssistant.activeRequestId !== requestId) return;
    processAssistantDone(data, assistantMsgId);
  } catch (err) {
    if (wsAssistant.activeRequestId !== requestId) return;
    const msg = wsAssistant.messages.find(m => m.id === assistantMsgId);
    if (msg) {
      msg.text = '请求失败: ' + err.message;
      msg.status = 'done';
      msg.role = 'system';
    }
    wsAssistant.phase = 'error';
    wsAssistant.running = false;
    wsAssistant.sendBtnDisabled = false;
    scheduleAssistantRender(true);
  } finally {
    if (wsAssistant.activeRequestId === requestId) {
      wsAssistant.running = false;
      wsAssistant.sendBtnDisabled = false;
      const sendBtn = document.getElementById('sendBtn');
      if (sendBtn) sendBtn.disabled = false;
      scheduleAssistantRender();
    }
  }
}

/**
 * 绑定 AI 助手面板的所有事件
 * @param {number|null} jobId 目标岗位 ID
 * @param {{ sessionKey?: string }} options
 */
function bindSplitRightAssistantEvents(jobId, options = {}) {
  const sessionKey = options.sessionKey || jobId;
  const aiInput = document.getElementById('aiInput');
  const sendBtn = document.getElementById('sendBtn');
  const settingsBtn = document.getElementById('btn-ai-settings');
  const closeSettingsBtn = document.getElementById('btn-close-settings');
  const clearChatBtn = document.getElementById('btn-clear-chat');
  const settingsPanel = document.getElementById('aiSettingsPanel');
  const aiSaveBtn = document.getElementById('sp-ai-save-btn');
  const spProvider = document.getElementById('sp-ai-provider');

  // 发送消息


  async function sendAIMessage() {
    if (!aiInput) return;
    const text = aiInput.value.trim();
    if (!text) return;

    addAIUserMessage(text);
    aiInput.value = '';
    aiConversationHistory.push({ role: 'user', text });
    saveAssistantSession(sessionKey, aiConversationHistory);

    showAITyping();
    if (sendBtn) sendBtn.disabled = true;

    try {
      // 检查深度思考开关
      const dtToggle = document.getElementById('sp-dt-toggle');
      const deepThinkEnabled = dtToggle && dtToggle.checked;
      const dtContext = { jobId, resumeReady: !!currentResumeDraftMd };
      const shouldDT = deepThinkEnabled && shouldTriggerDeepThink(text, dtContext);
      let data;
      if (shouldDT) {
        // 能力检查
        const caps = window.__aiCapabilities || {};
        if (!caps.deep_think) {
          hideAITyping();
          if (sendBtn) sendBtn.disabled = false;
          addAIResponseMessage('⚠️ 深度思考能力未就绪，请先在设置中配置AI模型。');
          return;
        }

        // 深度思考模式
        const dtData = await deepThink(text, jobId);
        data = {
          reply: formatDeepThinkReply(dtData),
          resume_updated: false,
        };
      } else {
        // SSE streaming with fallback
        const statusEl = document.querySelector('#aiStreamStatus');
        let traceLines = [];
        let traceTimer = null;
        const renderTraceLog = () => {
          if (!statusEl) return;
          const latest = traceLines.slice(-8);
          statusEl.innerHTML = latest.map(line => `<div class="ai-stream-line">${line}</div>`).join('');
          statusEl.style.display = 'block';
        };
        let pendingOps = [];
        try {
          data = await chatWithAIAssistantStream(jobId, text, aiConversationHistory, (event) => {
            if (statusEl && event.message) {
              statusEl.textContent = event.message;
              statusEl.style.display = 'block';
            }
            if (event.type === 'trace' && event.message) {
              const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
              const extra = [];
              if (event.tool) extra.push(`工具: ${event.tool}`);
              if (event.file) extra.push(`文件: ${event.file}`);
              traceLines.push(`[${ts}] ${event.message}${extra.length ? ` | ${extra.join(' | ')}` : ''}`);
              if (traceTimer) clearTimeout(traceTimer);
              renderTraceLog();
              traceTimer = setTimeout(renderTraceLog, 50);
            }
            // 捕获推荐岗位进度
            if (event.type === 'tool' && event.tool === 'smart_job_recommend') {
              const progressDiv = document.getElementById('aiRecommendProgress');
              if (!progressDiv) {
                const container = document.createElement('div');
                container.id = 'aiRecommendProgress';
                container.className = 'ai-recommend-progress';
                container.innerHTML = '<span class="recommend-spinner"></span> 正在智能匹配岗位，请稍候...';
                const aiMessages = document.getElementById('aiMessages');
                const typingIndicator = document.getElementById('typingIndicator');
                if (aiMessages && typingIndicator) {
                  aiMessages.insertBefore(container, typingIndicator);
                } else if (aiMessages) {
                  aiMessages.appendChild(container);
                }
              }
            }
            // 捕获推荐岗位结果
            if (event.type === 'job_recommendations' && Array.isArray(event.jobs)) {
              const progress = document.getElementById('aiRecommendProgress');
              if (progress) progress.remove();

              window.__lastRecommendations = event;

              const aiMessages = document.getElementById('aiMessages');
              if (aiMessages && event.jobs.length > 0) {
                const cardsContainer = document.createElement('div');
                cardsContainer.className = 'ai-recommend-cards';

                const summary = event.summary || {};
                const summaryText = summary.total_scanned
                  ? `扫描 ${summary.total_scanned} 个岗位，过滤后 ${summary.after_hard_filter} 个，推荐 ${summary.recommended} 个`
                  : `推荐 ${event.jobs.length} 个匹配岗位`;

                cardsContainer.innerHTML = `
                  <div class="recommend-header">
                    <span class="recommend-icon">🎯</span>
                    <span class="recommend-title">智能推荐岗位</span>
                    <span class="recommend-summary">${summaryText}</span>
                    <button class="recommend-action-btn recommend-select-all" onclick="selectAllRecommendedJobs(this)">
                      全部加入工作台
                    </button>
                  </div>
                  <div class="recommend-list">
                    ${event.jobs.map(job => renderSingleRecommendCard(job)).join('')}
                  </div>
                `;

                const typingIndicator = document.getElementById('typingIndicator');
                if (typingIndicator) {
                  aiMessages.insertBefore(cardsContainer, typingIndicator);
                } else {
                  aiMessages.appendChild(cardsContainer);
                }
                aiMessages.scrollTop = aiMessages.scrollHeight;
              }
            }
            // 实时应用结构化操作到简历预览
            if (event.type === 'resume_ops_batch' && Array.isArray(event.ops)) {
              pendingOps.push(...event.ops);
              try {
                // 初始化 ResumeDocument（如果还没有）
                if (!getCurrentResumeDocument() && currentResumeDraftMd) {
                  initResumeDocumentFromMarkdown(currentResumeDraftMd);
                }
                const doc = getCurrentResumeDocument();
                if (doc) {
                  const results = executeBatch(event.ops, 'direct');
                  const newMd = doc.toMarkdown();
                  currentResumeDraftMd = newMd;
                  if (currentResume) currentResume.content_md = newMd;
                  refreshAllResumeViews();
                }
              } catch (opsErr) {
                console.warn('[AI] 实时 ops 应用失败，等待最终结果:', opsErr.message);
              }
            }
          });
        } catch (sseErr) {
          console.warn('[AI] SSE failed, falling back:', sseErr.message);
          data = await chatWithAIAssistant(jobId, text, aiConversationHistory);
        }
        if (statusEl) statusEl.style.display = 'none';
      }
      hideAITyping();

      // Sanitize: strip any leaked JSON protocol
      let displayReply = data.reply || data.message || data.response || '（无回复）';
      if (typeof displayReply === 'string' && displayReply.trim().startsWith('{')) {
        try {
          const leaked = JSON.parse(displayReply.trim());
          if (leaked.reply) displayReply = leaked.reply;
          else if (leaked.action && leaked.content) displayReply = leaked.content;
        } catch (e) { /* not JSON, use as-is */ }
      }
      // Never expose internal fields to the UI
      const resumeContentMd = data.resume_updated_content_md;
      // 在 delete 之前提取，避免后续判断时字段已丢失
      const toolTrace = data.tool_trace || [];
      delete data.memory_update_reason;
      delete data.tool_trace;
      delete data.resume_updated_content_md;

      const reply = displayReply;
      addAIResponseMessage(reply);
      // 渲染推荐岗位卡片（如果本轮有推荐结果）
      if (toolTrace.some(t => t.tool === 'smart_job_recommend')) {
        try {
          renderJobRecommendationCards(data);
        } catch (renderErr) {
          console.warn('[AI] 推荐卡片渲染失败:', renderErr.message);
        }
      }
      // 收藏列表同步：检查本轮是否有工具实际修改了收藏状态
      if (toolTrace.some(t => {
        if (t.tool === 'batch_select_jobs' || t.tool === 'batch_deselect_jobs' || t.tool === 'clear_all_favorites' || t.tool === 'filter_favorites') return true;
        if (t.tool === 'smart_job_recommend' && t.result && t.result.auto_selected) return true;
        return false;
      })) {
        loadDeliveryList();
      }
      // 清理进度条
      const progressEl = document.getElementById('aiRecommendProgress');
      if (progressEl) progressEl.remove();
      aiConversationHistory.push({ role: 'assistant', text: reply });
      saveAssistantSession(sessionKey, aiConversationHistory);

      // 处理 AI 修改简历的写回
      if (data.resume_updated) {
        // 优先使用 resume_ops 结构化操作模式
        if (data.resume_ops && Array.isArray(data.resume_ops) && data.resume_ops.length > 0) {
          try {
            if (!getCurrentResumeDocument() && currentResumeDraftMd) {
              initResumeDocumentFromMarkdown(currentResumeDraftMd);
            }
            const doc = getCurrentResumeDocument();
            if (doc) {
              executeBatch(data.resume_ops, 'direct');
              const newMd = doc.toMarkdown();
              currentResumeDraftMd = newMd;
              if (currentResume) currentResume.content_md = newMd;
              // 保存到后端
              updateResumeContent(newMd).catch(e => console.warn('[AI] 保存失败:', e.message));
              refreshAllResumeViews();
            }
          } catch (opsErr) {
            console.warn('[AI] resume_ops 执行失败，降级到全量覆盖:', opsErr.message);
            if (resumeContentMd) {
              currentResumeDraftMd = resumeContentMd;
              if (currentResume) currentResume.content_md = resumeContentMd;
              refreshAllResumeViews();
            }
          }
          // 显示变更摘要（含撤销按钮）
          const summary = data.resume_change_summary;
          const undoBtnId = `undo-resume-${Date.now()}`;
          let summaryText;
          if (summary && summary.changed_sections) {
            summaryText = `✅ 简历已更新：修改了 ${summary.changed_sections.join('、')}（共 ${summary.changed_items_count || '若干'} 处）`;
          } else {
            summaryText = '✅ 简历已根据 AI 建议更新，请查看中栏';
          }
          summaryText += `<br><button id="${undoBtnId}" class="btn-undo-resume" title="撤销本次修改">↩ 撤销</button>`;
          addAIResponseMessage(summaryText, '系统');
          // 绑定撤销按钮
          const undoBtn = document.getElementById(undoBtnId);
          if (undoBtn) {
            const prevMd = currentResumeDraftMd; // 保存当前状态作为回退目标
            undoBtn.addEventListener('click', () => {
              const doc = getCurrentResumeDocument();
              if (doc && typeof doc.rollback === 'function') {
                doc.rollback();
                const rolledBackMd = doc.toMarkdown();
                currentResumeDraftMd = rolledBackMd;
                if (currentResume) currentResume.content_md = rolledBackMd;
                updateResumeContent(rolledBackMd).catch(e => console.warn('[AI] 撤销保存失败:', e.message));
                refreshAllResumeViews();
                addAIResponseMessage('↩ 已撤销本次 AI 编辑', '系统');
                undoBtn.disabled = true;
                undoBtn.textContent = '已撤销';
              }
            });
          }
        } else if (resumeContentMd) {
          // 兜底：整篇 Markdown 覆盖
          currentResumeDraftMd = resumeContentMd;
          if (currentResume) {
            currentResume.content_md = resumeContentMd;
          }
          refreshAllResumeViews();
          addAIResponseMessage('✅ 简历已根据 AI 建议更新，请查看中栏', '系统');
        }
      }
    } catch (err) {
      hideAITyping();
      addAIResponseMessage('请求失败: ' + err.message, '系统');
    } finally {
      if (sendBtn) sendBtn.disabled = false;
    }
  }

  if (sendBtn) sendBtn.addEventListener('click', sendAIMessage);
  if (aiInput) {
    aiInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        sendAIMessage();
      }
    });
  }

  // 设置面板切换
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      if (settingsPanel) settingsPanel.classList.toggle('is-open');
    });
  }
  if (closeSettingsBtn) {
    closeSettingsBtn.addEventListener('click', () => {
      if (settingsPanel) settingsPanel.classList.remove('is-open');
    });
  }

  // 清空对话
  if (clearChatBtn) {
    clearChatBtn.addEventListener('click', () => {
      aiConversationHistory = [];
      clearAssistantSession(sessionKey);
      const aiMessages = document.getElementById('aiMessages');
      if (aiMessages) {
        aiMessages.innerHTML = `
          <div class="message ai">
            <div class="message-avatar ai-avatar">🤖</div>
            <div class="message-body">
              <div class="message-meta">
                <span class="message-sender">AI 助手</span>
                <span class="message-time">${getAIChatTime()}</span>
              </div>
              <div class="message-bubble">
                <div class="message-text">对话已清空。有什么可以帮你的吗？</div>
              </div>
            </div>
          </div>
          <div class="typing-indicator" id="typingIndicator" style="display: none;">
            <span></span><span></span><span></span>
          </div>
        `;
      }
    });
  }

  // AI Provider 切换
  if (spProvider) {
    spProvider.addEventListener('change', () => {
      const provider = spProvider.value;
      const defaults = AI_PROVIDER_DEFAULTS[provider];
      if (!defaults) return;
      const baseUrlInput = document.getElementById('sp-ai-base-url');
      const modelInput = document.getElementById('sp-ai-model');
      if (baseUrlInput) baseUrlInput.value = defaults.base_url;
      if (modelInput) modelInput.value = defaults.model;
    });
  }

  // AI 配置保存按钮
  if (aiSaveBtn) {
    aiSaveBtn.addEventListener('click', async () => {
      const provider = document.getElementById('sp-ai-provider')?.value;
      const apiKey = document.getElementById('sp-ai-api-key')?.value.trim();
      const baseUrl = document.getElementById('sp-ai-base-url')?.value.trim();
      const model = document.getElementById('sp-ai-model')?.value.trim();

      if (!apiKey) { showToast('请输入 API Key', 'error'); return; }
      if (!baseUrl) { showToast('请输入 Base URL', 'error'); return; }
      if (!model) { showToast('请输入模型名称', 'error'); return; }

      aiSaveBtn.disabled = true;
      aiSaveBtn.textContent = '保存中...';

      try {
        await saveAIConfig({ provider, api_key: apiKey, base_url: baseUrl, model_name: model });
        showToast('AI 配置已保存', 'success');
        aiConfigured = true;
        loadInlineAIConfig();
      } catch (err) {
        showToast('保存 AI 配置失败: ' + err.message, 'error');
      } finally {
        aiSaveBtn.disabled = false;
        aiSaveBtn.textContent = '保存配置';
      }
    });
  }

  // 深度思考开关
  const spDtToggle = document.getElementById('sp-dt-toggle');
  if (spDtToggle) {
    spDtToggle.addEventListener('change', async () => {
      try {
        await saveDeepThinkConfig({ enabled: spDtToggle.checked });
        showToast(spDtToggle.checked ? '深度思考已开启' : '深度思考已关闭', 'success');
        const wsDtToggle = document.getElementById('ws-dt-toggle');
        if (wsDtToggle) wsDtToggle.checked = spDtToggle.checked;
      } catch (err) {
        showToast('保存深度思考配置失败: ' + err.message, 'error');
        spDtToggle.checked = !spDtToggle.checked;
      }
    });
  }

  // 第二模型折叠 + 保存
  const spSecToggle = document.getElementById('sp-sec-model-toggle');
  const spSecBody = document.getElementById('sp-sec-model-body');
  if (spSecToggle && spSecBody) {
    spSecToggle.addEventListener('click', () => {
      const open = spSecBody.style.display !== 'none';
      spSecBody.style.display = open ? 'none' : '';
      spSecToggle.textContent = (open ? '▶' : '▼') + ' 第二模型配置';
    });
  }
  const spSecSaveBtn = document.getElementById('sp-sec-save-btn');
  if (spSecSaveBtn) {
    spSecSaveBtn.addEventListener('click', async () => {
      await handleSecondaryModelSave('sp');
    });
  }

  // 文件上传（静默处理）
  const fileUpload = document.getElementById('aiFileUpload');
  if (fileUpload) {
    fileUpload.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        showToast(`已选择 ${e.target.files.length} 个文件`, 'info');
      }
    });
  }
}

/**
 * 从后端加载 AI 配置到 AI 助手面板
 */
async function loadSplitAIConfig() {
  try {
    const data = await getAIConfig();
    if (!data) return;

    const configs = data.configs || [];
    const activeConfig = configs.find(c => c.is_active === 1) || configs[0] || {};

    const providerSelect = document.getElementById('sp-ai-provider');
    const apiKeyInput = document.getElementById('sp-ai-api-key');
    const baseUrlInput = document.getElementById('sp-ai-base-url');
    const modelInput = document.getElementById('sp-ai-model');

    if (providerSelect && activeConfig.provider) providerSelect.value = activeConfig.provider;
    if (apiKeyInput && activeConfig.api_key_masked) apiKeyInput.value = activeConfig.api_key_masked;
    if (baseUrlInput && activeConfig.base_url) baseUrlInput.value = activeConfig.base_url;
    if (modelInput && activeConfig.model_name) modelInput.value = activeConfig.model_name;
  } catch {
    // 静默失败
  }
}

/* ==================== 收藏交互 ==================== */

/**
 * 切换收藏状态（首页卡片）
 * @param {HTMLElement} starBtn - 五角星按钮元素
 * @param {number} jobId - 职位 ID
 */
/* ==================== 事件绑定 ==================== */

function bindCardClickEvents() {
  const container = document.getElementById('view-home');
  if (!container) return;

  container.addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (card && card.dataset.id) {
      openExpandDetail(parseInt(card.dataset.id, 10));
    }
  });
}

/* ==================== M8-N3-WP3: AI 配置面板 ==================== */

/**
 * 厂商默认配置
 */
const AI_PROVIDER_DEFAULTS = {
  'zhipu': {
    label: '智谱AI',
    base_url: 'https://open.bigmodel.cn/api/coding/paas/v4',
    model: 'glm-5',
  },
  'kimi': {
    label: 'Kimi',
    base_url: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
  },
  'openai': {
    label: 'OpenAI',
    base_url: 'https://api.openai.com/v1',
    model: 'gpt-4o',
  },
  'groq': {
    label: 'Groq',
    base_url: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
  },
  'deepseek': {
    label: 'DeepSeek',
    base_url: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  },
  'doubao': {
    label: '豆包(火山引擎)',
    base_url: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-pro-32k',
  },
  'siliconflow': {
    label: 'SiliconFlow',
    base_url: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-V3',
  },
  'custom': {
    label: '自定义',
    base_url: '',
    model: '',
  },
};

/* ==================== M10-N2-WP3: 内嵌 AI 配置面板 ==================== */

/**
 * 绑定内嵌 AI 配置面板事件（Provider 切换 + 保存按钮）
 */
function bindInlineAIConfigEvents() {
  // Provider 切换时自动填充默认值
  const wsProviderSelect = document.getElementById('ws-ai-provider');
  if (wsProviderSelect) {
    wsProviderSelect.addEventListener('change', () => {
      const provider = wsProviderSelect.value;
      const defaults = AI_PROVIDER_DEFAULTS[provider];
      if (!defaults) return;
      const baseUrlInput = document.getElementById('ws-ai-base-url');
      const modelInput = document.getElementById('ws-ai-model');
      if (baseUrlInput) baseUrlInput.value = defaults.base_url;
      if (modelInput) modelInput.value = defaults.model;
    });
  }

  // 保存按钮
  const wsSaveBtn = document.getElementById('ws-ai-save-btn');
  if (wsSaveBtn) {
    wsSaveBtn.addEventListener('click', () => {
      handleInlineAISave();
    });
  }

  // 深度思考开关
  const wsDtToggle = document.getElementById('ws-dt-toggle');
  if (wsDtToggle) {
    wsDtToggle.addEventListener('change', async () => {
      try {
        await saveDeepThinkConfig({ enabled: wsDtToggle.checked });
        showToast(wsDtToggle.checked ? '深度思考已开启' : '深度思考已关闭', 'success');
        const spDtToggle = document.getElementById('sp-dt-toggle');
        if (spDtToggle) spDtToggle.checked = wsDtToggle.checked;
      } catch (err) {
        showToast('保存深度思考配置失败: ' + err.message, 'error');
        wsDtToggle.checked = !wsDtToggle.checked;
      }
    });
  }

  // 第二模型折叠切换
  const wsSecToggle = document.getElementById('ws-sec-model-toggle');
  const wsSecBody = document.getElementById('ws-sec-model-body');
  if (wsSecToggle && wsSecBody) {
    wsSecToggle.addEventListener('click', () => {
      const open = wsSecBody.style.display !== 'none';
      wsSecBody.style.display = open ? 'none' : '';
      wsSecToggle.textContent = (open ? '▶' : '▼') + ' 第二模型配置';
    });
  }

  // 第二模型保存
  const wsSecSaveBtn = document.getElementById('ws-sec-save-btn');
  if (wsSecSaveBtn) {
    wsSecSaveBtn.addEventListener('click', async () => {
      await handleSecondaryModelSave('ws');
    });
  }
}

/**
 * 内嵌 AI 配置面板的保存逻辑（复用 saveAIConfig 但针对内嵌面板 ID）
 */
async function handleInlineAISave() {
  const provider = document.getElementById('ws-ai-provider')?.value;
  const apiKey = document.getElementById('ws-ai-api-key')?.value.trim();
  const baseUrl = document.getElementById('ws-ai-base-url')?.value.trim();
  const model = document.getElementById('ws-ai-model')?.value.trim();
  const saveBtn = document.getElementById('ws-ai-save-btn');

  if (!apiKey) {
    showToast('请输入 API Key', 'error');
    document.getElementById('ws-ai-api-key')?.focus();
    return;
  }

  if (!baseUrl) {
    showToast('请输入 Base URL', 'error');
    document.getElementById('ws-ai-base-url')?.focus();
    return;
  }

  if (!model) {
    showToast('请输入模型名称', 'error');
    document.getElementById('ws-ai-model')?.focus();
    return;
  }

  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中...';
  }

  try {
    await saveAIConfig({ provider, api_key: apiKey, base_url: baseUrl, model_name: model });
    showToast('AI 配置已保存', 'success');
    aiConfigured = true;
  } catch (err) {
    showToast('保存 AI 配置失败: ' + err.message, 'error');
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = '保存配置';
    }
  }
}

/**
 * 从后端加载 AI 配置到内嵌面板
 */
async function loadInlineAIConfig() {
  try {
    const data = await getAIConfig();
    if (!data) return;

    const configs = data.configs || [];
    const activeConfig = configs.find(c => c.is_active === 1) || configs[0] || {};

    const providerSelect = document.getElementById('ws-ai-provider');
    const apiKeyInput = document.getElementById('ws-ai-api-key');
    const baseUrlInput = document.getElementById('ws-ai-base-url');
    const modelInput = document.getElementById('ws-ai-model');

    if (providerSelect && activeConfig.provider) providerSelect.value = activeConfig.provider;
    if (apiKeyInput && activeConfig.api_key_masked) apiKeyInput.value = activeConfig.api_key_masked;
    if (baseUrlInput && activeConfig.base_url) baseUrlInput.value = activeConfig.base_url;
    if (modelInput && activeConfig.model_name) modelInput.value = activeConfig.model_name;
  } catch {
    // 静默失败
  }
}

/* ==================== M11-N2-WP2/WP3: 采集控制面板逻辑 ==================== */

let isCrawling = false;
let crawlPanelInited = false;
let crawlPollTimer = null;  // 状态轮询定时器
let verificationPromptVisible = false;

function showVerificationPrompt(verification) {
  const overlay = document.getElementById('verifyOverlay');
  const text = document.getElementById('verifyText');
  if (!overlay || !text) return;

  const platformLabel = verification?.platformLabel || verification?.platform || '目标平台';
  text.textContent = verification?.message || `请在新打开的 ${platformLabel} 标签页中完成验证，然后回到采集页点击“已验证”。`;
  overlay.style.display = 'flex';
  verificationPromptVisible = true;
}

function hideVerificationPrompt() {
  const overlay = document.getElementById('verifyOverlay');
  if (!overlay) return;
  overlay.style.display = 'none';
  verificationPromptVisible = false;
}

/** 更新采集状态栏和进度条 */
function updateCrawlStatus(message, progress) {
  const statusEl = document.getElementById('crawl-status');
  const textEl = document.getElementById('crawl-status-text');
  const barEl = document.getElementById('crawl-progress-bar');

  if (statusEl) statusEl.style.display = 'block';
  if (textEl) textEl.textContent = message;
  if (barEl && typeof progress === 'number') {
    barEl.style.width = Math.min(progress, 100) + '%';
  }

  // 关键状态通过 Toast 反馈
  if (message.includes('开始') || message.includes('完成') || message.includes('失败') || message.includes('停止')) {
    showToast(message, message.includes('失败') ? 'error' : 'success');
  }
}

/** 切换开始/停止按钮的可用状态 */
function setCrawlButtons(crawling) {
  isCrawling = crawling;
  const startBtn = document.getElementById('crawl-start-btn');
  const stopBtn = document.getElementById('crawl-stop-btn');
  if (startBtn) startBtn.disabled = crawling;
  if (stopBtn) stopBtn.disabled = !crawling;
}

/** 启动状态轮询（每2秒查询一次 GET_STATUS） */
function startCrawlPolling() {
  stopCrawlPolling();  // 先清除旧的定时器
  crawlPollTimer = setInterval(async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
      if (!response || !response.success) return;

      const { isRunning, stats, verification, crawlSession } = response.data;
      let liveSync = null;

      if (crawlSession && crawlSession.crawlBatchId) {
        setCurrentBatchId(crawlSession.crawlBatchId);
        liveSync = await syncCurrentBatchJobs(crawlSession.crawlBatchId, {
          flushAll: !isRunning,
          forceRender: !isRunning
        }).catch(() => null);
      }

      if (verification && verification.required) {
        showVerificationPrompt(verification);
        updateCrawlStatus(`等待${verification.platformLabel || verification.platform || '平台'}人工验证...`, 0);
      } else if (verificationPromptVisible) {
        hideVerificationPrompt();
      }

      if (!isRunning && isCrawling) {
        // 采集已结束（background 完成）
        stopCrawlPolling();
        const count = stats ? stats.totalJobs : 0;
        onCrawlComplete(count, liveSync);
        return;
      }

      // 根据采集阶段更新进度
      if (stats) {
        const progress = calculateCrawlProgress(stats);
        const syncSuffix = liveSync
          ? ` | 已同步 ${liveSync.renderedGroups}/${liveSync.expectedGroups || 0} 组`
          : '';
        updateCrawlStatus(`${formatCrawlStatusMessage(stats)}${syncSuffix}`, progress);
      }
    } catch {
      // 轮询失败静默处理，下次继续
    }
  }, 2000);
}

/** 停止状态轮询 */
function stopCrawlPolling() {
  if (crawlPollTimer) {
    clearInterval(crawlPollTimer);
    crawlPollTimer = null;
  }
}

/** 根据采集统计计算进度百分比 */
function calculateCrawlProgress(stats) {
  if (!stats) return 0;
  // 基于详情采集进度估算：detailSuccessCount / max(detailRequestedCount, 1)
  if (stats.detailRequestedCount > 0) {
    return Math.min(
      (stats.detailSuccessCount / Math.max(stats.detailRequestedCount, 1)) * 100,
      95  // 最高95%，留5%给最终完成
    );
  }
  // 搜索阶段，给一个较低的进度
  return stats.pagesFetched > 0 ? Math.min(stats.pagesFetched * 15, 50) : 5;
}

/** 格式化采集状态消息 */
function formatCrawlStatusMessage(stats) {
  if (!stats) return '采集中...';
  const parts = [];
  if (stats.totalJobs > 0) parts.push(`岗位 ${stats.totalJobs}`);
  if (stats.detailSuccessCount > 0) parts.push(`详情 ${stats.detailSuccessCount}`);
  if (stats.successWithDesc > 0) parts.push(`含描述 ${stats.successWithDesc}`);
  if (stats.failCount > 0) parts.push(`失败 ${stats.failCount}`);
  return parts.length > 0 ? `采集中: ${parts.join(' | ')}` : '采集中...';
}

/** 采集完成处理：刷新首页 Grid 并自动导航 */
function onCrawlComplete(count, liveSync = null) {
  stopCrawlPolling();
  hideVerificationPrompt();
  const syncSuffix = liveSync
    ? `；已同步 ${liveSync.renderedGroups}/${liveSync.expectedGroups || 0} 组` +
      (liveSync.missingGroups > 0 ? `，待补 ${liveSync.missingGroups} 组` : '')
    : '';
  updateCrawlStatus(`采集完成，共 ${count} 条${syncSuffix}`, 100);
  setCrawlButtons(false);

  // 延迟后刷新首页并导航
  setTimeout(() => {
    loadJobs({ silent: true, forceRender: true });
    location.hash = '#home';
  }, 800);
}

/** 采集失败处理 */
function onCrawlError(errorMsg) {
  stopCrawlPolling();
  hideVerificationPrompt();
  updateCrawlStatus(`采集失败：${errorMsg}`, 0);
  setCrawlButtons(false);
}

function summarizeFilterReasons(filterReasonStats) {
  if (!filterReasonStats || typeof filterReasonStats !== 'object') return '';
  const reasons = Object.entries(filterReasonStats)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 2)
    .map(([reason, jobs]) => `${reason} ${jobs.length}条`);
  return reasons.join('；');
}

function buildCrawlResultMessage(result, keyword) {
  if (!result) {
    return {
      text: `采集完成：${keyword || '本次任务'}无结果`,
      progress: 100
    };
  }

  const totalCount = result.total ?? result.totalJobs ?? 0;
  const insertedCount = result.inserted ?? result.totalNew ?? 0;
  const withDescriptionCount = result.withDescription ?? result.totalWithDescription ?? 0;

  if (totalCount > 0) {
    return {
      text: insertedCount > 0
        ? `采集完成：入库 ${insertedCount} 条，含描述 ${withDescriptionCount} 条`
        : `采集完成：采集到 ${totalCount} 条，含描述 ${withDescriptionCount} 条`,
      progress: 100
    };
  }

  if (result.reason === 'all_filtered' || result.filtered > 0) {
    const filterSummary = summarizeFilterReasons(result.filterReasonStats);
    return {
      text: `采集完成：列表 ${result.listCount || 0} 条，过滤 ${result.filtered || 0} 条${filterSummary ? `，原因：${filterSummary}` : ''}`,
      progress: 100
    };
  }

  if (result.reason === 'no_jobs') {
    return {
      text: `采集完成：关键词“${keyword}”未返回岗位`,
      progress: 100
    };
  }

  if (result.reason === 'no_new_jobs') {
    return {
      text: `采集完成：列表 ${result.listCount || 0} 条，但没有新的可入库岗位`,
      progress: 100
    };
  }

  return {
    text: `采集完成：共 ${totalCount} 条`,
    progress: 100
  };
}

/** 初始化采集面板（首次进入时绑定事件） */
function initCrawlPanel() {
  if (crawlPanelInited) return;
  crawlPanelInited = true;

  const startBtn = document.getElementById('crawl-start-btn');
  const stopBtn = document.getElementById('crawl-stop-btn');

  if (startBtn) {
    startBtn.addEventListener('click', async () => {
      const platform = document.getElementById('crawl-platform').value;
      const keyword = document.getElementById('crawl-keyword').value.trim();
      const city = document.getElementById('crawl-city').value.trim();

      // 校验必填项
      if (!keyword) {
        showToast('请输入搜索关键词', 'error');
        document.getElementById('crawl-keyword').focus();
        return;
      }

      setCrawlButtons(true);
      updateCrawlStatus(`开始采集 ${keyword}...`, 0);
      startCrawlPolling();

      // 发送采集指令到后台
      try {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
          const response = await chrome.runtime.sendMessage({
            type: 'START_CRAWL',
            payload: { platform, keyword, city }
          });

          if (response && response.success) {
            const result = response.data || {};
            // 记录当前采集批次 ID 到全局状态和 localStorage
            if (result.crawlBatchId) {
              setCurrentBatchId(result.crawlBatchId);
            }
            const summary = buildCrawlResultMessage(result, keyword);
            updateCrawlStatus(summary.text, summary.progress);
            hideVerificationPrompt();
            setCrawlButtons(false);
            stopCrawlPolling();
            if ((location.hash || '#home') === '#home') {
              loadJobs({ silent: true, forceRender: true });
            }
          } else {
            // 启动失败
            const errMsg = response?.error || response?.data?.errorMessage || '后台无响应';
            onCrawlError(errMsg);
          }
        } else {
          // 非 Extension 环境的模拟行为
          updateCrawlStatus('正在采集中...', 30);
          setTimeout(() => {
            onCrawlComplete(0);
          }, 2000);
        }
      } catch (err) {
        onCrawlError(err.message);
      }
    });
  }

  if (stopBtn) {
    stopBtn.addEventListener('click', async () => {
      stopCrawlPolling();
      hideVerificationPrompt();
      updateCrawlStatus('正在停止采集...', 0);

      try {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
          const response = await chrome.runtime.sendMessage({ type: 'STOP_CRAWL' });
          if (response && response.success) {
            updateCrawlStatus('采集已停止', 0);
          } else {
            updateCrawlStatus(`停止失败：${response ? response.error : '未知错误'}`, 0);
          }
        }
        setCrawlButtons(false);
      } catch (err) {
        updateCrawlStatus(`停止异常：${err.message}`, 0);
        setCrawlButtons(false);
      }
    });
  }

  // 监听来自 background 的消息（补充轮询之外的实时通知）
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message) => {
      if (!message || !message.type) return;

      switch (message.type) {
        case 'CRAWL_PROGRESS':
          // background 主动推送的进度更新
          if (message.data && message.data.stats) {
            const progress = calculateCrawlProgress(message.data.stats);
            updateCrawlStatus(formatCrawlStatusMessage(message.data.stats), progress);
          }
          break;
        case 'CRAWL_COMPLETE':
          // background 主动推送的完成通知
          const count = message.data ? message.data.totalJobs || 0 : 0;
          onCrawlComplete(count);
          break;
        case 'CRAWL_ERROR':
          // background 主动推送的错误通知
          onCrawlError(message.data ? message.data.error : '未知错误');
          break;
        case 'MANUAL_VERIFICATION_REQUIRED':
          showVerificationPrompt(message.data || {});
          break;
      }
    });
  }

  const verifyOpenBtn = document.getElementById('verify-open-btn');
  const verifyConfirmBtn = document.getElementById('verify-confirm-btn');

  if (verifyOpenBtn) {
    verifyOpenBtn.addEventListener('click', async () => {
      try {
        await chrome.runtime.sendMessage({ type: 'OPEN_VERIFICATION_TAB' });
      } catch (error) {
        showToast(`打开验证页失败: ${error.message}`, 'error');
      }
    });
  }

  if (verifyConfirmBtn) {
    verifyConfirmBtn.addEventListener('click', async () => {
      try {
        await chrome.runtime.sendMessage({ type: 'ACK_MANUAL_VERIFICATION' });
        hideVerificationPrompt();
        updateCrawlStatus('已收到验证确认，正在继续采集...', 10);
      } catch (error) {
        showToast(`确认验证失败: ${error.message}`, 'error');
      }
    });
  }
}

/* ==================== 初始化 ==================== */

export function initDashboard() {
  openDashboardSession()
    .catch((error) => {
      console.warn('[Dashboard] Failed to notify ui_open:', error.message);
    })
    .finally(() => {
      initRouter();
      bindCardClickEvents();
    });
}

initDashboard();

async function notifyControllerSessionEvent(event) {
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
    return;
  }

  await chrome.runtime.sendMessage({
    type: 'CONTROLLER_SESSION_EVENT',
    event,
    clientId: DASHBOARD_CLIENT_ID,
    source: 'dashboard'
  });
}

async function openDashboardSession() {
  if (dashboardSessionOpened) return;
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      await chrome.runtime.sendMessage({
        type: 'WAKE_UP_CONTROLLER',
        reason: 'dashboard_open'
      });
    }
  } catch (error) {
    console.warn('[Dashboard] Failed to wake Controller on open:', error.message);
  }

  dashboardSessionOpened = true;
  await notifyControllerSessionEvent('ui_open');
}

function closeDashboardSession() {
  if (!dashboardSessionOpened) return;
  dashboardSessionOpened = false;
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
    return;
  }

  chrome.runtime.sendMessage({
    type: 'CONTROLLER_SESSION_EVENT',
    event: 'ui_close',
    clientId: DASHBOARD_CLIENT_ID,
    source: 'dashboard'
  }).catch(() => {});
}

window.addEventListener('pagehide', closeDashboardSession);
