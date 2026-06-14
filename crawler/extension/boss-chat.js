/**
 * BossChatEngine - Boss直聘批量投递引擎
 * 设计原则：纯函数，所有外部依赖通过参数传入
 */

// ============ 常量 ============
const BOSS_CHAT = {
  QUEUE_KEY: 'boss_chat_queue',
  STATE_KEY: 'boss_chat_state',
  ALARM_NAME: 'boss_chat_queue',
  MIN_DELAY_MS: 5 * 1000,       // 队列最小间隔（进一步调快）
  MAX_DELAY_MS: 8 * 1000,       // 队列最大间隔（进一步调快）
  TAB_READ_DELAY_MIN: 2000,     // 页面阅读最小延迟（进一步调快）
  TAB_READ_DELAY_MAX: 3000,     // 页面阅读最大延迟（进一步调快）
  OBSERVE_TIMEOUT_MS: 10000,    // 点击结果观察超时
  MAX_RETRIES: 3,               // 单条最大重试次数
  RETRY_DELAY_MS: 5000,         // 重试间隔
  MAX_QUEUE_SIZE: 200,          // 队列最大长度
  COORDINATE_DIAGNOSTICS: true  // 坐标诊断开关
};

// ============ 状态机 ============
const ChatStatus = {
  PENDING: 'pending',               // 队列中等待
  RUNNING: 'running',               // 正在处理
  TARGET_FOUND: 'target_found',     // 找到按钮
  CLICKED: 'clicked',               // 确认点击成功
  ALREADY_CHATTED: 'already_chatted', // 已沟通过
  NATIVE_CLICK_FAILED: 'native_click_failed', // 系统点击失败
  SECURITY_CHECK: 'security_check', // 安全验证
  LOGIN_REQUIRED: 'login_required', // 需要登录
  UNAVAILABLE: 'unavailable',       // 岗位不可用
  NOT_FOUND: 'not_found',           // 未找到按钮
  CLICKED_UNKNOWN: 'clicked_unknown', // 点击后状态未知
  FAILED: 'failed',                 // 处理失败
  RATE_LIMITED: 'rate_limited',     // 频率限制
  RETRYING: 'retrying'              // 准备重试
};

// ============ 工具函数 ============
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomBetween(min, max) {
  return min + Math.floor(Math.random() * (max - min));
}

function nowISO() {
  return new Date().toISOString();
}

// ============ 队列管理（纯函数） ============
async function loadQueue(storage) {
  const data = await storage.get([BOSS_CHAT.QUEUE_KEY, BOSS_CHAT.STATE_KEY]);
  const rawQueue = data[BOSS_CHAT.QUEUE_KEY];
  // 兼容旧格式：{jobs: [], createdAt, updatedAt} -> 提取 jobs 数组
  const queue = Array.isArray(rawQueue)
    ? rawQueue
    : (rawQueue && Array.isArray(rawQueue.jobs) ? rawQueue.jobs : []);
  return {
    queue,
    state: data[BOSS_CHAT.STATE_KEY] || { lastProcessedAt: 0, totalProcessed: 0, totalSuccess: 0 }
  };
}

async function saveQueue(storage, queue, state) {
  await storage.set({
    [BOSS_CHAT.QUEUE_KEY]: queue,
    [BOSS_CHAT.STATE_KEY]: state
  });
}

async function clearQueue(storage) {
  await storage.remove([BOSS_CHAT.QUEUE_KEY, BOSS_CHAT.STATE_KEY]);
}

// ============ Alarm 管理 ============
async function setQueueAlarm(alarms, delayMs) {
  await alarms.create(BOSS_CHAT.ALARM_NAME, {
    delayInMinutes: Math.max(0.5, delayMs / 60000)
  });
}

async function clearQueueAlarm(alarms) {
  await alarms.clear(BOSS_CHAT.ALARM_NAME);
}

// ============ 坐标诊断 ============
function buildCoordinateDiagnostics(targetResult) {
  if (!targetResult || !targetResult.target) return null;
  const t = targetResult.target;
  const v = t.viewport || {};
  const dpr = Number(v.devicePixelRatio) || 1;

  return {
    rawScreenX: t.screenX,
    rawScreenY: t.screenY,
    devicePixelRatio: dpr,
    estimatedPhysicalX: Math.round((t.screenX || 0) * dpr),
    estimatedPhysicalY: Math.round((t.screenY || 0) * dpr),
    viewport: {
      innerWidth: v.innerWidth,
      innerHeight: v.innerHeight,
      outerWidth: v.outerWidth,
      outerHeight: v.outerHeight,
      screenX: v.screenX,
      screenY: v.screenY
    },
    element: t.element,
    rect: t.rect
  };
}

// ============ 核心投递流程 ============
class BossChatEngine {
  constructor(deps = {}) {
    this.sendTabMessage = deps.sendTabMessage;
    this.createTab = deps.createTab;
    this.closeTab = deps.closeTab;
    this.sendNativeMessage = deps.sendNativeMessage;
    this.storage = deps.storage;
    this.alarms = deps.alarms;
    this.reportToController = deps.reportToController || (() => Promise.resolve());
    this._isProcessing = false;
  }

  // 检查是否正在处理
  get isProcessing() {
    return this._isProcessing;
  }

  // ============ 对外 API：批量投递 ============
  async submitBatch(jobs, options = {}) {
    const { mode = 'batch', confirmationSource = 'dashboard' } = options;

    if (!Array.isArray(jobs) || jobs.length === 0) {
      return { success: false, error: 'Empty job list' };
    }

    const { queue, state } = await loadQueue(this.storage);

    // 去重：URL 相同的不再添加
    const existingUrls = new Set(queue.map(j => j.url));
    const newJobs = jobs
      .filter(j => j.url && !existingUrls.has(j.url))
      .map(j => ({
        id: j.id || `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        url: j.url,
        title: j.title || '',
        company: j.company || '',
        platform: j.platform || 'boss',
        status: ChatStatus.PENDING,
        retries: 0,
        createdAt: nowISO(),
        confirmationSource
      }));

    if (newJobs.length === 0) {
      return { success: false, error: 'All jobs already in queue' };
    }

    const combined = [...queue, ...newJobs];
    if (combined.length > BOSS_CHAT.MAX_QUEUE_SIZE) {
      return { success: false, error: `Queue would exceed max size ${BOSS_CHAT.MAX_QUEUE_SIZE}` };
    }

    await saveQueue(this.storage, combined, state);
    await setQueueAlarm(this.alarms, 1000); // 1秒后开始处理

    console.log(`[BossChat] Batch submitted: ${newJobs.length} jobs, queue size: ${combined.length}`);

    return {
      success: true,
      added: newJobs.length,
      queueSize: combined.length,
      jobs: newJobs.map(j => ({ id: j.id, title: j.title, url: j.url }))
    };
  }

  // ============ 对外 API：获取队列状态 ============
  async getQueueStatus() {
    const { queue, state } = await loadQueue(this.storage);
    const pending = queue.filter(j => j.status === ChatStatus.PENDING).length;
    const running = queue.filter(j => j.status === ChatStatus.RUNNING).length;
    const success = queue.filter(j =>
      [ChatStatus.CLICKED, ChatStatus.ALREADY_CHATTED].includes(j.status)
    ).length;
    const failed = queue.filter(j =>
      [ChatStatus.FAILED, ChatStatus.NATIVE_CLICK_FAILED, ChatStatus.UNAVAILABLE,
       ChatStatus.NOT_FOUND, ChatStatus.SECURITY_CHECK, ChatStatus.LOGIN_REQUIRED].includes(j.status)
    ).length;
    const unknown = queue.filter(j => j.status === ChatStatus.CLICKED_UNKNOWN).length;

    return {
      success: true,
      total: queue.length,
      pending,
      running,
      success,
      failed,
      unknown,
      state: {
        totalProcessed: state.totalProcessed || 0,
        totalSuccess: state.totalSuccess || 0,
        lastProcessedAt: state.lastProcessedAt || null
      }
    };
  }

  // ============ 对外 API：清空队列 ============
  async clear() {
    await clearQueue(this.storage);
    await clearQueueAlarm(this.alarms);
    this._isProcessing = false;
    return { success: true };
  }

  // ============ Alarm 触发处理（核心循环） ============
  async onAlarm() {
    if (this._isProcessing) {
      console.log('[BossChat] Already processing, skipping alarm');
      return;
    }

    const { queue, state } = await loadQueue(this.storage);
    const pending = queue.find(j => j.status === ChatStatus.PENDING);

    if (!pending) {
      console.log('[BossChat] Queue empty, clearing alarm');
      await clearQueueAlarm(this.alarms);
      this._isProcessing = false;
      return;
    }

    this._isProcessing = true;

    // MV3 Service Worker 可能在长时间处理中被终止，先设置保险 alarm
    const BACKUP_ALARM = 'boss_chat_backup';
    try {
      await this.alarms.create(BACKUP_ALARM, { delayInMinutes: 0.5 }); // 30秒后保险唤醒
    } catch (e) {
      console.warn('[BossChat] Failed to set backup alarm:', e.message);
    }

    try {
      await this._processJob(pending, queue, state);
    } catch (error) {
      console.error('[BossChat] Process job error:', error);
      pending.status = ChatStatus.FAILED;
      pending.error = error.message;
      pending.processedAt = nowISO();
    } finally {
      this._isProcessing = false;
      await saveQueue(this.storage, queue, state);

      // 清除保险 alarm
      try { await this.alarms.clear(BACKUP_ALARM); } catch (_) {}

      // 设置下一个任务的 alarm
      const nextPending = queue.find(j => j.status === ChatStatus.PENDING);
      if (nextPending) {
        const delay = randomBetween(BOSS_CHAT.MIN_DELAY_MS, BOSS_CHAT.MAX_DELAY_MS);
        await setQueueAlarm(this.alarms, delay);
        console.log(`[BossChat] Next job scheduled in ${delay}ms`);
      }
    }
  }

  // ============ 处理单个岗位 ============
  async _processJob(job, queue, state) {
    job.status = ChatStatus.RUNNING;
    job.startedAt = nowISO();

    console.log(`[BossChat] Processing: ${job.title || job.url}`);

    let tabId = null;

    try {
      // 1. 创建 Tab
      const tab = await this.createTab({ url: job.url, active: true });
      tabId = tab.id;

      // 窗口前置
      if (tab.windowId) {
        await chrome.windows?.update(tab.windowId, { focused: true }).catch(() => null);
      }

      // 2. 等待页面加载
      await this._waitForTabLoad(tabId);
      await this._waitForContentScript(tabId, 8);

      // 3. 阅读延迟（模拟人工浏览）
      const readDelay = randomBetween(BOSS_CHAT.TAB_READ_DELAY_MIN, BOSS_CHAT.TAB_READ_DELAY_MAX);
      console.log(`[BossChat] Reading delay ${readDelay}ms for ${job.title || job.url}`);
      await sleep(readDelay);

      // 4. DOM 点击并验证（直接注入执行，绕过 content script）
      await chrome.tabs.update(tabId, { active: true }).catch(() => null);
      await sleep(500);

      const domResult = await this._injectDomClickAndVerify(tabId);
      console.log('[BossChat] DOM click result:', {
        title: job.title,
        status: domResult?.status,
        success: domResult?.success,
        reason: domResult?.reason
      });

      let result = domResult;

      // 8. 更新状态
      const finalStatus = result?.status || (result?.success ? ChatStatus.CLICKED : ChatStatus.FAILED);
      job.status = finalStatus;
      job.success = Boolean(result?.success);
      job.reason = result?.reason || '';
      job.processedAt = nowISO();

      // 9. 上报到 Controller（可选）
      try {
        await this.reportToController({
          type: 'boss_chat_result',
          jobId: job.id,
          status: finalStatus,
          success: job.success,
          url: job.url,
          title: job.title,
          timestamp: job.processedAt
        });
      } catch (e) {
        console.warn('[BossChat] Report to controller failed:', e.message);
      }

      // 10. 关闭 Tab
      if (this._shouldCloseTab(finalStatus)) {
        await sleep(2000);
        await this.closeTab(tabId);
        tabId = null;
      } else {
        console.warn(`[BossChat] Keeping tab ${tabId} open for status=${finalStatus}`);
      }

      // 更新统计
      state.totalProcessed = (state.totalProcessed || 0) + 1;
      if (job.success) {
        state.totalSuccess = (state.totalSuccess || 0) + 1;
      }
      state.lastProcessedAt = Date.now();

    } catch (error) {
      job.status = ChatStatus.FAILED;
      job.error = error.message;
      job.processedAt = nowISO();
      console.error(`[BossChat] Failed to process ${job.url}:`, error);

      if (tabId) {
        await this.closeTab(tabId).catch(() => null);
        tabId = null;
      }

      throw error;
    }
  }

  // ============ 直接注入 DOM 点击（绕过 content script） ============
  async _injectDomClickAndVerify(tabId) {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const normalizeText = (value) => (value || '').replace(/\s+/g, ' ').trim();

        const isVisibleElement = (element) => {
          if (!element) return false;
          const style = window.getComputedStyle(element);
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };

        const getElementText = (element) => normalizeText(element?.innerText || element?.textContent || '');

        const isSecurityCheckPage = () => {
          const href = window.location.href || '';
          const bodyText = normalizeText(document.body?.innerText || '');
          return href.includes('_security_check') || /环境存在异常|安全验证|请完成验证|验证后继续访问/.test(bodyText);
        };

        const isLoginPage = () => {
          const bodyText = normalizeText(document.body?.innerText || '');
          return /登录|login|扫码登录|账号登录/.test(bodyText) &&
            document.querySelector('input[type="password"], .login-box, .login-form, [class*="login"]');
        };

        const hasAlreadyChattedSignal = () => {
          return Array.from(document.querySelectorAll('a, button, div, span'))
            .some(element => isVisibleElement(element) && getElementText(element) === '继续沟通');
        };

        const hasRateLimitSignal = () => {
          const bodyText = normalizeText(document.body?.innerText || '');
          return /操作过于频繁|请稍后再试|访问太频繁/.test(bodyText);
        };

        const hasChatDialogSignal = () => {
          const dialogSelectors = ['.chat-wrap', '.chat-dialog', '.im-chat-dialog', '.geek-chat-popup'];
          for (const selector of dialogSelectors) {
            const el = document.querySelector(selector);
            if (el && isVisibleElement(el)) return true;
          }
          return false;
        };

        const hasSuccessToastSignal = () => {
          const toastPattern = /沟通申请已发送|已发送沟通|发送成功|投递成功/;
          const allText = normalizeText(document.body?.innerText || '');
          if (toastPattern.test(allText)) return true;
          const toastSelectors = ['.toast-message', '.el-message', '.ant-message', '[class*="toast"]'];
          for (const selector of toastSelectors) {
            const els = Array.from(document.querySelectorAll(selector));
            if (els.some(el => isVisibleElement(el) && /发送|成功|沟通/.test(normalizeText(el.innerText)))) return true;
          }
          return false;
        };

        const findBossChatButton = () => {
          // 优先查找实际的可点击 <a> 标签（Boss直聘按钮结构：div > a.btn-startchat）
          const directA = document.querySelector('a.btn-startchat');
          if (directA && isVisibleElement(directA) && !directA.disabled && getElementText(directA) === '立即沟通') {
            return directA;
          }

          const selectors = [
            '.btn-greet', '.op-btn-chat', '[class*="greet"]', '[class*="chat"]',
            'a[class*="greet"]', 'button[class*="greet"]', 'a[class*="chat"]', 'button[class*="chat"]'
          ];
          for (const selector of selectors) {
            const candidates = Array.from(document.querySelectorAll(selector));
            const match = candidates.find(element =>
              isVisibleElement(element) && !element.disabled && getElementText(element) === '立即沟通'
            );
            if (match) return match;
          }
          return Array.from(document.querySelectorAll('a, button, div, span')).find(element =>
            isVisibleElement(element) && !element.disabled && getElementText(element) === '立即沟通'
          ) || null;
        };

        const getClickableElement = (element) => element.closest?.('a, button, [role="button"]') || element;

        const isVisible = (element) => {
          if (!element?.isConnected) return false;
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
        };

        const isElementUncovered = (element) => {
          const rect = element.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const topElement = document.elementFromPoint(x, y);
          return Boolean(topElement && (topElement === element || element.contains(topElement) || topElement.contains(element)));
        };

        const inspectTopOverlay = () => {
          const overlays = document.querySelectorAll('.dialog-container, .modal, [class*="dialog"], [class*="modal"], [class*="overlay"], [class*="popup"]');
          for (const el of overlays) {
            if (isVisibleElement(el)) {
              const text = normalizeText(el.innerText || '');
              if (/登录|验证|安全|频繁|关闭|下架/.test(text)) return text.slice(0, 100);
            }
          }
          return '';
        };

        const dispatchDomClickSequence = (element) => {
          const rect = element.getBoundingClientRect();
          const clientX = rect.left + rect.width / 2;
          const clientY = rect.top + rect.height / 2;
          const common = { bubbles: true, cancelable: true, composed: true, clientX, clientY, button: 0, buttons: 1, view: window };

          element.dispatchEvent(new PointerEvent('pointerover', { ...common, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
          element.dispatchEvent(new MouseEvent('mouseover', common));
          element.dispatchEvent(new PointerEvent('pointerdown', { ...common, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
          element.dispatchEvent(new MouseEvent('mousedown', common));
          element.dispatchEvent(new PointerEvent('pointerup', { ...common, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 0 }));
          element.dispatchEvent(new MouseEvent('mouseup', { ...common, buttons: 0 }));
          element.dispatchEvent(new MouseEvent('click', { ...common, buttons: 0 }));
        };

        const inspectBossChatState = (context) => {
          if (isSecurityCheckPage()) return { success: false, status: 'security_check', reason: '当前页面是安全验证页' };
          if (isLoginPage()) return { success: false, status: 'login_required', reason: '当前页面需要登录' };
          if (hasRateLimitSignal()) return { success: false, status: 'rate_limited', reason: '操作过于频繁' };
          if (hasAlreadyChattedSignal()) return { success: true, status: 'already_chatted', reason: '检测到该岗位已沟通过' };
          if (hasChatDialogSignal() || hasSuccessToastSignal()) return { success: true, status: 'clicked', reason: '检测到聊天弹窗或成功提示' };
          return { success: false, status: 'verification_pending' };
        };

        const waitForChatResult = (context, timeoutMs = 10000) => {
          return new Promise((resolve) => {
            const startedAt = Date.now();
            const check = () => {
              const result = inspectBossChatState(context);
              if (result.status !== 'verification_pending' || Date.now() - startedAt >= timeoutMs) {
                observer.disconnect();
                resolve(result.status === 'verification_pending' ? { success: false, status: 'clicked_unknown', reason: '点击后未发现明确页面状态变化' } : result);
                return true;
              }
              return false;
            };
            const observer = new MutationObserver(check);
            observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
            if (check()) return;
            const timer = setInterval(() => { if (check()) clearInterval(timer); }, 500);
          });
        };

        const executeDomClickAndVerify = async () => {
          const urlBefore = window.location.href || '';
          const initialState = inspectBossChatState({ urlBefore });
          if (initialState.status !== 'verification_pending') {
            return { ...initialState, urlBefore, urlAfter: urlBefore, method: 'inject' };
          }

          let button = findBossChatButton();
          if (!button) {
            return { success: false, status: 'not_found', reason: '未找到"立即沟通"按钮', urlBefore, urlAfter: window.location.href || '', method: 'inject' };
          }

          button = getClickableElement(button);
          button.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
          await sleep(300 + Math.random() * 200);

          button = findBossChatButton();
          if (!button || !button.isConnected) {
            return { success: false, status: 'not_found', reason: '滚动后按钮节点失效', urlBefore, urlAfter: window.location.href || '', method: 'inject' };
          }

          button = getClickableElement(button);
          if (!isVisible(button)) {
            return { success: false, status: 'not_found', reason: '按钮不可见', urlBefore, urlAfter: window.location.href || '', method: 'inject' };
          }
          if (!isElementUncovered(button)) {
            return { success: false, status: 'not_found', reason: '按钮被遮挡: ' + inspectTopOverlay(), urlBefore, urlAfter: window.location.href || '', method: 'inject' };
          }

          const buttonTextBefore = normalizeText(button.innerText || button.textContent || '');

          // 第一级：原生 DOM click
          HTMLElement.prototype.click.call(button);
          let result = await waitForChatResult({ urlBefore, buttonTextBefore }, 6000);

          // 第二级：完整 DOM 事件序列（fallback）
          if (result.status === 'clicked_unknown' && button.isConnected && isVisible(button)) {
            await sleep(300);
            dispatchDomClickSequence(button);
            result = await waitForChatResult({ urlBefore, buttonTextBefore }, 7000);
          }

          return { ...result, method: 'inject', urlBefore, urlAfter: window.location.href || '', buttonTextBefore };
        };

        return executeDomClickAndVerify();
      }
    });

    return results?.[0]?.result || { success: false, status: 'failed', reason: '注入执行无返回结果', method: 'inject' };
  }

  // ============ Native Host 点击 ============
  async _nativeClick(target) {
    if (!target || !Number.isFinite(Number(target.screenX)) || !Number.isFinite(Number(target.screenY))) {
      return { success: false, error: 'Invalid screen coordinates' };
    }

    // 当前策略：直接传递原始坐标（诊断阶段）
    // 后续根据诊断数据决定是否需要坐标转换
    const x = Math.round(Number(target.screenX));
    const y = Math.round(Number(target.screenY));

    console.log('[BossChat] Native click coordinates:', { x, y, dpr: target.viewport?.devicePixelRatio });

    return this.sendNativeMessage({
      action: 'mouse_click',
      x,
      y
    });
  }

  // ============ 辅助方法 ============
  _shouldCloseTab(status) {
    return ![ChatStatus.SECURITY_CHECK, ChatStatus.LOGIN_REQUIRED].includes(status);
  }

  async _waitForTabLoad(tabId, timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab?.status === 'complete') return;
      await sleep(500);
    }
    throw new Error('Tab load timeout');
  }

  async _waitForContentScript(tabId, timeoutSec = 8) {
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      try {
        const response = await this.sendTabMessage(tabId, { type: 'CHECK_STATUS' });
        if (response?.ready) return;
      } catch (e) {
        // 继续等待
      }
      await sleep(500);
    }
    throw new Error('Content script not ready');
  }
}

// ============ 导出 ============
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { BossChatEngine, ChatStatus, BOSS_CHAT };
}
