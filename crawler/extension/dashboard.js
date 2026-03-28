/**
 * Dashboard 主逻辑
 * Hash 路由 + 数据渲染 + 交互
 */

import {
  fetchJobs, fetchJobDetail, selectJob, favoriteJob,
  fetchDeliveryList, uploadResume, fetchResume,
  updateResumeContent, getAIConfig, saveAIConfig,
  optimizeResume, matchJobs, exportPDFViaAPI, clearAllJobs,
} from './dashboard-api.js';

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

  if (!silent || !homeHasRendered) {
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
  } catch (err) {
    if (!silent || !homeHasRendered) {
      const isBackendError = err.message.includes('后端未启动') || err.message.includes('Failed to fetch');
      if (isBackendError) {
        container.innerHTML = renderBackendError(err.message);
      } else {
        container.innerHTML = '<div class="empty-state"></div>';
        showToast(err.message, 'error');
      }
    }
  }
}

/** 渲染后端不可达时的引导页 */
function renderBackendError(errMsg) {
  return `<div class="empty-state empty-state--backend">
    <h3>后端未启动或连接失败</h3>
    <p>请先在终端运行 <code>npm run start</code> 启动 Controller</p>
    <button class="res-btn res-btn--g" onclick="location.reload()">刷新页面重试</button>
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
  const targetGroups = flushAll
    ? expectedGroups
    : Math.min(expectedGroups, Math.max(1, liveBatchSyncState.renderedGroups + 1));

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

function renderJobGrid(jobs) {
  return `<div class="job-grid">${jobs.map((job, i) => {
    return renderJobCard(job, i);
  }).join('')}</div>`;
}

function renderSourceLink(url, inlineStyle = '') {
  const safeUrl = String(url || '').trim();
  if (!safeUrl || !/^https?:\/\//i.test(safeUrl)) {
    return `<span class="bep bep--s bep--disabled"${inlineStyle ? ` style="${inlineStyle}"` : ''} aria-disabled="true">暂无原链接</span>`;
  }
  return `<a class="bep bep--s" href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener"${inlineStyle ? ` style="${inlineStyle}"` : ''}>查看原链接</a>`;
}

function renderJobCard(job, index = 0) {
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

  // 卡片编号（两位数）
  const num = String(index + 1).padStart(2, '0');

  // SVG 图形（12 个循环）
  const svgIndex = index % 12;
  const svg = SUPREMATISM_SVG[svgIndex];

  // 跨行/跨列由 CSS nth-child 接管，不再需要 spanClass 逻辑

  return `<div class="card anim" data-id="${job.id}">
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

function loadResumeView() {
  const container = document.getElementById('view-resume');
  if (!container) return;

  if (!resumeViewInitialized) {
    // 预生成 Provider 下拉选项
    const providerOptions = Object.entries(AI_PROVIDER_DEFAULTS).map(
      ([key, val]) => `<option value="${key}">${val.label}</option>`
    ).join('');

    container.innerHTML = `
      <div class="vlabel">SOVT</div>
      <div class="ws">
        <div class="ws-del">
          <h3 class="ws-del__title">收藏列表 <span id="delivery-count" class="ws-del__count"></span></h3>
          <div id="delivery-content"></div>
        </div>
        <div class="ws-res" id="wsResPanel">
          <h3 class="ws-res__title">简历预览</h3>
          <div id="resume-content"></div>
          <div class="upload-btn" id="btn-upload-inline" style="display:none">&#128196; 简历上传</div>
          <div class="aicfg" id="wsAICfg">
            <h4>AI 配置</h4>
            <div class="aif">
              <label>Provider</label>
              <select class="aiinp" id="ws-ai-provider" style="cursor:pointer">
                ${providerOptions}
              </select>
            </div>
            <div class="aif">
              <label>API Base URL</label>
              <input class="aiinp" id="ws-ai-base-url" placeholder="https://open.bigmodel.cn/api/coding/paas/v4">
            </div>
            <div class="aif">
              <label>API Key</label>
              <input class="aiinp" type="password" id="ws-ai-api-key" placeholder="输入你的 API Key" autocomplete="off">
            </div>
            <div class="aif">
              <label>模型名称</label>
              <input class="aiinp" id="ws-ai-model" placeholder="glm-5">
            </div>
            <button class="res-btn" id="ws-ai-save-btn" style="margin-top:6px">保存配置</button>
          </div>
        </div>
      </div>
    `;

    // 绑定内嵌 AI 配置面板事件
    bindInlineAIConfigEvents();

    resumeViewInitialized = true;
  }

  loadResume();
  loadDeliveryList();
  checkAIConfigured();
  loadInlineAIConfig();
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
    container.innerHTML = renderResumeDualMode(contentMd, 'default');
    bindResumeDualModeEvents(container, 'default');
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
      <div class="res-bar">
        <button class="res-btn" id="${idPrefix}-btn-view" data-mode="view" data-view="${viewMode}">查看</button>
        <button class="res-btn res-btn--g res-btn--active" id="${idPrefix}-btn-edit" data-mode="edit" data-view="${viewMode}">编辑</button>
        <button class="res-btn res-btn--g" id="${idPrefix}-btn-save" data-view="${viewMode}">保存</button>
        <button class="res-btn res-btn--ai" id="${idPrefix}-btn-ai-optimize" data-view="${viewMode}"
                ${!aiConfigured ? 'disabled title="请先配置 AI"' : ''}>
          AI 优化简历
        </button>
        <button class="res-btn res-btn--g" id="${idPrefix}-btn-ai-cfg" data-view="${viewMode}">AI 配置</button>
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
        ${renderResumeHTML(contentMd)}
      </div>
      <div class="resume-dual-mode__edit" id="${idPrefix}-resume-edit" style="display:none">
        ${renderResumeEdit(contentMd)}
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
function renderResumeHTML(markdown) {
  if (!markdown || !markdown.trim()) {
    return '<div class="resume-empty">暂无简历内容</div>';
  }

  const lines = markdown.split('\n');
  const sections = [];   // 收集各个 section 的 HTML 片段
  let currentItems = [];  // 当前正在收集的列表项
  let currentTexts = [];  // 当前正在收集的文本行
  let sectionTitle = '';  // 当前 section 标题（## 或 #）
  let sectionType = '';   // 'name' | 'section' | ''
  let inH1 = false;       // 是否在一级标题（姓名）section 内

  // 将列表项/文本刷新为 HTML 并追加到当前 section
  function flushContent() {
    if (currentItems.length > 0) {
      sections.push(`<ul class="rsec-list">${currentItems.map(t => `<li>${t}</li>`).join('')}</ul>`);
      currentItems = [];
    }
    if (currentTexts.length > 0) {
      sections.push(currentTexts.map(t => `<p class="rsec-text">${t}</p>`).join(''));
      currentTexts = [];
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 一级标题 → 姓名
    if (/^#\s+(.+)/.test(line)) {
      flushContent();
      if (inH1) {
        // 关闭前一个 H1 section
        sections.push('</div>');
      }
      sectionTitle = escapeHtml(RegExp.$1.trim());
      sectionType = 'name';
      inH1 = true;
      sections.push(`<div class="rsec"><div class="rsec-name">${sectionTitle}</div>`);
      continue;
    }

    // 二级标题 → 章节标题
    if (/^##\s+(.+)/.test(line)) {
      flushContent();
      if (inH1) {
        // 关闭 H1 section
        sections.push('</div>');
        inH1 = false;
      } else if (sectionType === 'section') {
        // 关闭前一个普通 section
        sections.push('</div>');
      }
      sectionTitle = escapeHtml(RegExp.$1.trim());
      sectionType = 'section';
      sections.push(`<div class="rsec"><div class="rsec-hd">${sectionTitle}</div>`);
      continue;
    }

    // 三级标题 → 子标题
    if (/^###\s+(.+)/.test(line)) {
      flushContent();
      const text = escapeHtml(RegExp.$1.trim());
      sections.push(`<div class="rsec-name" style="font-size:16px">${text}</div>`);
      continue;
    }

    // 无序列表项
    if (/^-\s+(.+)/.test(line)) {
      currentTexts = [];  // 列表优先，清空文本缓冲
      currentItems.push(escapeHtml(RegExp.$1.trim()));
      continue;
    }

    // 空行 → 忽略（同时刷新缓冲）
    if (line.trim() === '') {
      if (currentItems.length > 0 || currentTexts.length > 0) {
        flushContent();
      }
      continue;
    }

    // 普通文本
    currentItems = [];  // 文本优先，清空列表缓冲
    currentTexts.push(escapeHtml(line.trim()));
  }

  // 刷新最后的内容
  flushContent();

  // 关闭最后一个未闭合的 section
  if (inH1 || sectionType === 'section') {
    sections.push('</div>');
  }

  return sections.join('');
}

/**
 * Markdown 编辑模式：textarea 显示原始 Markdown
 * @param {string} contentMd Markdown 原始文本
 * @returns {string} HTML 字符串
 */
function renderResumeEdit(contentMd) {
  return `<textarea class="res-ta" id="resume-edit-ta">${escapeHtml(contentMd || '')}</textarea>`;
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
  } else {
    // 切换到查看模式时，从 textarea 同步内容到 HTML 渲染
    const ta = editEl.querySelector('textarea');
    const newMd = ta ? ta.value : (currentResume ? currentResume.content_md || '' : '');
    viewEl.innerHTML = renderResumeHTML(newMd);
    viewEl.style.display = 'block';
    editEl.style.display = 'none';
    if (btnView) { btnView.classList.add('res-btn--active'); }
    if (btnEdit) { btnEdit.classList.remove('res-btn--active'); }
  }

  currentResumeMode = mode;
}

/**
 * 保存简历内容到后端
 * @param {'default'|'expanded'} viewMode 视图模式
 */
async function saveResumeContent(viewMode = 'default') {
  const idPrefix = viewMode === 'default' ? 'def' : 'exp';
  const editEl = document.getElementById(`${idPrefix}-resume-edit`);
  const ta = editEl ? editEl.querySelector('textarea') : null;

  if (!ta) {
    showToast('未找到编辑区域', 'error');
    return;
  }

  const contentMd = ta.value;
  if (!contentMd.trim()) {
    showToast('简历内容不能为空', 'error');
    return;
  }

  try {
    const data = await updateResumeContent(contentMd);
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

      if (ta) {
        ta.value = optimizedContent;
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

const RESUME_HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>简历</title>
  <style>
    /* Constructivism（构成主义）色彩体系 */
    :root {
      --c-red: #E62B1E;
      --c-black: #1A1A1A;
      --c-paper: #F4F0EA;
      --c-yellow: #FFC72C;
      --c-gray: #8E8E8E;
      --c-white: #FFFFFF;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--c-paper);
      color: var(--c-black);
      line-height: 1.7;
      padding: 48px 60px;
      max-width: 900px;
      margin: 0 auto;
    }

    h1, h2, h3, h4, h5, h6 {
      font-family: 'Courier New', 'Noto Sans SC', monospace;
      text-transform: uppercase;
      letter-spacing: 1px;
      font-weight: 900;
      border-bottom: 3px solid var(--c-black);
      padding-bottom: 6px;
      margin: 28px 0 14px;
    }
    h1 { font-size: 28px; margin-top: 0; border-bottom-width: 4px; }
    h2 { font-size: 22px; color: var(--c-red); }
    h3 { font-size: 18px; }
    h4 { font-size: 16px; }

    p { margin: 8px 0; }

    ul, ol { margin: 8px 0 8px 24px; }
    li { margin: 4px 0; }

    strong, b { color: var(--c-red); font-weight: 700; }

    a { color: var(--c-red); text-decoration: none; border-bottom: 2px solid var(--c-yellow); }
    a:hover { border-bottom-color: var(--c-red); }

    blockquote {
      border-left: 4px solid var(--c-black);
      padding: 8px 16px;
      margin: 12px 0;
      background: var(--c-white);
      font-style: italic;
    }

    code {
      font-family: 'Courier New', monospace;
      background: var(--c-black);
      color: var(--c-yellow);
      padding: 2px 6px;
      font-size: 0.9em;
    }

    pre {
      background: var(--c-black);
      color: var(--c-paper);
      padding: 16px;
      margin: 12px 0;
      overflow-x: auto;
      font-family: 'Courier New', monospace;
      font-size: 13px;
      line-height: 1.5;
    }
    pre code { background: none; color: inherit; padding: 0; }

    hr {
      border: none;
      border-top: 3px solid var(--c-black);
      margin: 24px 0;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      margin: 12px 0;
    }
    th, td {
      border: 2px solid var(--c-black);
      padding: 8px 12px;
      text-align: left;
    }
    th {
      background: var(--c-black);
      color: var(--c-paper);
      font-weight: 700;
    }

    @media print {
      body { padding: 0; max-width: none; }
      h1, h2, h3, h4, h5, h6 { page-break-after: avoid; }
    }
  </style>
</head>
<body>
{BODY}
</body>
</html>`;

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
  const bodyHtml = markdownToHtml(contentMd);
  const fullHtml = RESUME_HTML_TEMPLATE.replace('{BODY}', bodyHtml);
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
    const blob = await exportPDFViaAPI(contentMd);
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
  const contentMd = currentResume ? currentResume.content_md || '' : '';
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

  // 绑定 AI 配置切换按钮
  const idPrefix = viewMode === 'default' ? 'def' : 'exp';
  const aiCfgBtn = container.querySelector(`#${idPrefix}-btn-ai-cfg`);
  if (aiCfgBtn) {
    aiCfgBtn.addEventListener('click', () => {
      const cfgPanel = document.getElementById('wsAICfg');
      if (cfgPanel) cfgPanel.classList.toggle('on');
    });
  }

  container.addEventListener('click', async (e) => {
    const btn = e.target.closest('.res-btn');
    if (!btn) return;

    // 导出按钮由 bindExportDropdownEvents 处理，此处跳过
    if (btn.id.includes('btn-export-resume')) return;

    const mode = btn.dataset.mode;
    const view = btn.dataset.view;
    if (view !== viewMode) return;

    if (mode === 'view' || mode === 'edit') {
      toggleResumeMode(mode, view);
    } else if (btn.id.includes('btn-save')) {
      saveResumeContent(view);
    } else if (btn.id.includes('btn-ai-optimize')) {
      await handleAIOptimize(btn, view);
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

    if (countEl) {
      countEl.textContent = jobs.length > 0 ? `${jobs.length}` : '';
      countEl.style.display = jobs.length > 0 ? 'inline-block' : 'none';
    }

    if (jobs.length === 0) {
      container.innerHTML = '<div class="empty-state">暂无收藏岗位</div>';
      return;
    }

    container.innerHTML = `<div class="delivery-list">${jobs.map(job => renderDeliveryItem(job)).join('')}</div>`;
    bindDeliveryEvents(container);
  } catch (err) {
    container.innerHTML = '<div class="empty-state"></div>';
    if (countEl) { countEl.textContent = ''; countEl.style.display = 'none'; }
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
  const wsContainer = document.querySelector('.ws');
  const splitEl = document.getElementById('splitView');
  if (wsContainer) wsContainer.style.display = 'none';
  if (splitEl) splitEl.classList.add('on');

  // 加载左栏岗位详情
  await loadSplitLeft(jobId);
  // 加载右栏简历
  loadSplitRight();
}

/**
 * 关闭 50/50 分屏视图，恢复 7:3 工作台
 */
function closeSplitView() {
  currentSplitJobId = null;
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
 * 加载分屏右栏：简历编辑 + AI 功能 + 下载栏
 */
function loadSplitRight() {
  const container = document.getElementById('splitRight');
  if (!container) return;

  const providerOptions = Object.entries(AI_PROVIDER_DEFAULTS).map(
    ([key, val]) => `<option value="${key}">${val.label}</option>`
  ).join('');

  container.innerHTML = `
    <h3>简历内容</h3>
    <div class="res-bar" id="splitResBar">
      <button class="res-btn" id="sp-btn-view" data-mode="view">查看</button>
      <button class="res-btn res-btn--g res-btn--active" id="sp-btn-edit" data-mode="edit">编辑</button>
      <button class="res-btn res-btn--g" id="sp-btn-save">保存</button>
      <button class="res-btn res-btn--ai" id="sp-btn-ai-optimize"
              ${!aiConfigured ? 'disabled title="请先配置 AI"' : ''}>AI 优化</button>
      <button class="res-btn res-btn--g" id="sp-btn-ai-cfg">AI 配置</button>
    </div>
    <div id="sp-resume-view" class="resume-dual-mode__view"></div>
    <div id="sp-resume-edit" class="resume-dual-mode__edit" style="display:none"></div>
    <div class="dl-bar" id="sp-dl-bar">
      <span style="font-size:10px;font-weight:700;text-transform:uppercase;color:#8E8E8E;letter-spacing:.5px">下载格式：</span>
      <select class="dl-sel" id="sp-dl-format">
        <option value="md">.md (Markdown)</option>
        <option value="html">.html (HTML)</option>
        <option value="pdf">.pdf (PDF)</option>
        <option value="docx">.docx (Word)</option>
      </select>
      <button class="dl-btn" id="sp-dl-btn">下载简历</button>
    </div>
    <div class="aicfg" id="spAICfg">
      <h4>AI 配置</h4>
      <div class="aif"><label>Provider</label><select class="aiinp" id="sp-ai-provider">${providerOptions}</select></div>
      <div class="aif"><label>API Base URL</label><input class="aiinp" id="sp-ai-base-url" placeholder="https://open.bigmodel.cn/api/coding/paas/v4"></div>
      <div class="aif"><label>API Key</label><input class="aiinp" type="password" id="sp-ai-api-key" placeholder="输入你的 API Key" autocomplete="off"></div>
      <div class="aif"><label>模型名称</label><input class="aiinp" id="sp-ai-model" placeholder="glm-5"></div>
      <button class="res-btn" id="sp-ai-save-btn" style="margin-top:6px">保存配置</button>
    </div>
  `;

  // 加载简历内容
  loadSplitResume();
  // 绑定事件
  bindSplitEvents();
  // 回显 AI 配置到分屏面板
  loadSplitAIConfig();
}

/**
 * 加载分屏右栏的简历数据
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
      viewEl.innerHTML = '<div class="resume-empty">暂无简历内容，请先上传简历</div>';
      return;
    }

    // 同步全局简历数据
    currentResume = resume;
    const contentMd = resume.content_md || '';

    // 查看模式渲染
    viewEl.innerHTML = renderResumeHTML(contentMd);
    // 编辑模式填充
    editEl.innerHTML = `<textarea class="res-ta">${escapeHtml(contentMd || '')}</textarea>`;
  } catch (err) {
    viewEl.innerHTML = `<div class="resume-empty">加载简历失败: ${escapeHtml(err.message)}</div>`;
  }
}

/**
 * 绑定分屏右栏的所有事件
 */
function bindSplitEvents() {
  const viewBtn = document.getElementById('sp-btn-view');
  const editBtn = document.getElementById('sp-btn-edit');
  const saveBtn = document.getElementById('sp-btn-save');
  const aiOptBtn = document.getElementById('sp-btn-ai-optimize');
  const aiCfgBtn = document.getElementById('sp-btn-ai-cfg');
  const dlBtn = document.getElementById('sp-dl-btn');
  const dlFormat = document.getElementById('sp-dl-format');
  const aiSaveBtn = document.getElementById('sp-ai-save-btn');
  const spProvider = document.getElementById('sp-ai-provider');

  // 查看 / 编辑模式切换
  if (viewBtn && editBtn) {
    viewBtn.addEventListener('click', () => {
      const viewEl = document.getElementById('sp-resume-view');
      const editEl = document.getElementById('sp-resume-edit');
      if (!viewEl || !editEl) return;

      // 从 textarea 同步到查看视图
      const ta = editEl.querySelector('textarea');
      const newMd = ta ? ta.value : (currentResume ? currentResume.content_md || '' : '');
      viewEl.innerHTML = renderResumeHTML(newMd);

      viewEl.style.display = '';
      editEl.style.display = 'none';
      viewBtn.classList.add('res-btn--active');
      editBtn.classList.remove('res-btn--active');
    });

    editBtn.addEventListener('click', () => {
      const viewEl = document.getElementById('sp-resume-view');
      const editEl = document.getElementById('sp-resume-edit');
      if (!viewEl || !editEl) return;

      viewEl.style.display = 'none';
      editEl.style.display = '';
      editBtn.classList.add('res-btn--active');
      viewBtn.classList.remove('res-btn--active');
    });
  }

  // 保存按钮
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const editEl = document.getElementById('sp-resume-edit');
      const ta = editEl ? editEl.querySelector('textarea') : null;
      if (!ta) { showToast('未找到编辑区域', 'error'); return; }

      const contentMd = ta.value;
      if (!contentMd.trim()) { showToast('简历内容不能为空', 'error'); return; }

      try {
        await updateResumeContent(contentMd);
        showToast('简历保存成功', 'success');
        if (currentResume) currentResume.content_md = contentMd;

        // 切换到查看模式
        const viewEl = document.getElementById('sp-resume-view');
        if (viewEl) {
          viewEl.innerHTML = renderResumeHTML(contentMd);
          viewEl.style.display = '';
          editEl.style.display = 'none';
          if (viewBtn) viewBtn.classList.add('res-btn--active');
          if (editBtn) editBtn.classList.remove('res-btn--active');
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

  // AI 优化按钮（围绕 currentSplitJobId 对应的岗位）
  if (aiOptBtn) {
    aiOptBtn.addEventListener('click', async () => {
      if (!aiConfigured) { showToast('请先配置 AI', 'error'); return; }
      if (!currentResume) { showToast('请先上传简历', 'error'); return; }

      aiOptBtn.disabled = true;
      const originalText = aiOptBtn.textContent;
      aiOptBtn.textContent = '优化中...';

      try {
        const targetJobId = currentSplitJobId;
        if (!targetJobId) {
          showToast('未选择目标岗位', 'error');
          return;
        }

        const data = await optimizeResume(targetJobId, '');
        const optimizedContent = data.optimized_content_md || data.content_md || data.content || data.optimized_resume;

        if (optimizedContent) {
          const editEl = document.getElementById('sp-resume-edit');
          const ta = editEl ? editEl.querySelector('textarea') : null;
          if (ta) ta.value = optimizedContent;
          if (currentResume) currentResume.content_md = optimizedContent;

          // 切换到编辑模式
          const viewEl = document.getElementById('sp-resume-view');
          if (viewEl) viewEl.style.display = 'none';
          if (editEl) editEl.style.display = '';
          if (editBtn) editBtn.classList.add('res-btn--active');
          if (viewBtn) viewBtn.classList.remove('res-btn--active');

          showToast('AI 优化完成，请查看编辑器内容', 'success');
        } else {
          showToast('AI 返回结果为空', 'error');
        }
      } catch (err) {
        showToast('AI 优化失败: ' + err.message, 'error');
      } finally {
        aiOptBtn.textContent = originalText;
        aiOptBtn.disabled = !aiConfigured;
      }
    });
  }

  // AI 配置切换按钮
  if (aiCfgBtn) {
    aiCfgBtn.addEventListener('click', () => {
      const cfgPanel = document.getElementById('spAICfg');
      if (cfgPanel) cfgPanel.classList.toggle('on');
    });
  }

  // 下载按钮（WP4：内嵌 .dl-bar）
  if (dlBtn && dlFormat) {
    dlBtn.addEventListener('click', () => {
      const format = dlFormat.value;
      dispatchExport(format);
    });
  }

  // AI 配置 Provider 切换
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
        // 同步到工作台内嵌面板
        loadInlineAIConfig();
      } catch (err) {
        showToast('保存 AI 配置失败: ' + err.message, 'error');
      } finally {
        aiSaveBtn.disabled = false;
        aiSaveBtn.textContent = '保存配置';
      }
    });
  }
}

/**
 * 从后端加载 AI 配置到分屏面板
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
  initRouter();
  bindCardClickEvents();
}

initDashboard();
