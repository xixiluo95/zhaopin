/**
 * Dashboard API 客户端
 * 封装所有与 Controller 的 fetch 交互
 */

const API_BASE = 'http://127.0.0.1:7893';

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function pingController(timeoutMs = 1200) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}/status`, {
      method: 'GET',
      signal: controller.signal
    });
    clearTimeout(timer);
    return res.ok;
  } catch (_) {
    clearTimeout(timer);
    return false;
  }
}

async function wakeController(reason = 'dashboard_api_request') {
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
    return { success: false, errorType: 'CONTROLLER_UNREACHABLE' };
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'WAKE_UP_CONTROLLER',
      reason
    });
    if (response && response.success) {
      return { success: true, data: response.data };
    }
    return {
      success: false,
      errorType: response?.errorType || 'CONTROLLER_UNREACHABLE',
      error: response?.error || '',
      extensionId: response?.extensionId || null
    };
  } catch (_) {
    return { success: false, errorType: 'CONTROLLER_UNREACHABLE' };
  }
}

async function ensureControllerAvailable(reason = 'dashboard_api_request') {
  if (await pingController()) {
    return { available: true };
  }

  const wakeResult = await wakeController(reason);
  if (!wakeResult.success) {
    return { available: false, errorType: wakeResult.errorType, error: wakeResult.error, extensionId: wakeResult.extensionId };
  }

  // native host 返回成功，轮询确认 HTTP 端口就绪
  // 前 4 次(1秒)视作启动窗口期，返回 STARTING 临时态让 UI 可自动重试
  const SHORT_WINDOW = 4;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    if (await pingController()) {
      return { available: true };
    }
    if (attempt === SHORT_WINDOW - 1) {
      return {
        available: false,
        errorType: 'CONTROLLER_STARTING',
        error: 'Controller is starting up, please wait...'
      };
    }
    await wait(250);
  }

  return { available: false, errorType: 'CONTROLLER_UNREACHABLE', error: 'Controller started but /status still unreachable' };
}

/**
 * 统一 fetch 封装，处理异常兜底
 * @param {string} url 请求路径
 * @param {RequestInit} options fetch 选项
 * @returns {Promise<any>} 解析后的 JSON 响应
 */
async function request(url, options = {}) {
  try {
    const check = await ensureControllerAvailable(`request:${url}`);
    if (!check.available) {
      const err = new Error('后端未启动，请先启动 Controller');
      err.errorType = check.errorType || 'CONTROLLER_UNREACHABLE';
      if (check.extensionId) err.extensionId = check.extensionId;
      throw err;
    }

    const res = await fetch(`${API_BASE}${url}`, {
      ...options,
      headers: {
        ...options.headers,
      },
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(body.error || `服务端错误 (${res.status})`);
    }

    return await res.json();
  } catch (err) {
    if (err instanceof TypeError) {
      const typeErr = new Error('后端未启动，请先启动 Controller');
      typeErr.errorType = err.errorType || 'CONTROLLER_UNREACHABLE';
      if (err.extensionId) typeErr.extensionId = err.extensionId;
      throw typeErr;
    }
    throw err;
  }
}

/**
 * 获取岗位列表（分页 + 多条件过滤）
 * @param {{ platform?: string, keyword?: string, batchId?: string, page?: number, pageSize?: number, selected?: boolean }} params
 */
export async function fetchJobs(params = {}) {
  const query = new URLSearchParams();
  if (params.platform) query.set('platform', params.platform);
  if (params.keyword) query.set('keyword', params.keyword);
  if (params.batchId) query.set('batch_id', params.batchId);
  if (params.page) query.set('page', params.page);
  if (params.pageSize) query.set('pageSize', params.pageSize);
  if (params.selected !== undefined) query.set('selected', params.selected);
  const qs = query.toString();
  return request(`/api/jobs${qs ? '?' + qs : ''}`);
}

/**
 * 获取单条岗位详情
 * @param {number} id 职位 ID
 */
export async function fetchJobDetail(id) {
  const data = await request(`/api/jobs/detail?id=${encodeURIComponent(id)}`);
  return data.job || null;
}

/**
 * 更新选中状态
 * @param {number} id 职位 ID
 * @param {boolean} selected true=选中，false=取消选中
 */
export async function selectJob(id, selected) {
  return request('/api/jobs/select', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, selected }),
  });
}

/**
 * 切换收藏状态
 * @param {number} id 职位 ID
 * @returns {{ success: boolean, id: number, isFavorite: boolean }}
 */
export async function favoriteJob(id) {
  return request(`/api/jobs/${id}/favorite`, {
    method: 'POST',
  });
}

/**
 * 显式设置单个岗位收藏状态（幂等）
 * @param {number} id 职位 ID
 * @param {boolean} isFavorite 是否收藏
 */
export async function setFavoriteJob(id, isFavorite = true) {
  return request('/api/jobs/favorite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, isFavorite }),
  });
}

/**
 * 批量设置岗位收藏状态（幂等）
 * @param {number[]} ids 职位 ID 数组
 * @param {boolean} isFavorite 是否收藏
 */
export async function batchFavoriteJobs(ids, isFavorite = true) {
  return request('/api/jobs/favorite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, isFavorite }),
  });
}

/**
 * 清空全部岗位数据
 */
export async function clearAllJobs() {
  try {
    return await request('/api/jobs/clear', {
      method: 'POST',
    });
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    if (/404|Not found|服务端错误 \(404\)/i.test(message)) {
      const err = new Error('后端未加载清空接口，请重启 Controller');
      err.errorType = error.errorType;
      err.extensionId = error.extensionId;
      throw err;
    }
    throw error;
  }
}

/**
 * 获取已选中的收藏列表
 */
export async function fetchDeliveryList() {
  return request('/api/delivery/selected');
}

/**
 * 上传简历文件
 * @param {File} file 简历文件
 */
export async function uploadResume(file) {
  const formData = new FormData();
  formData.append('file', file);
  return request('/api/resume/upload', {
    method: 'POST',
    body: formData,
  });
}

/**
 * 获取当前（最新上传的）简历信息
 */
export async function fetchResume() {
  return request('/api/resume');
}

/**
 * 更新简历 Markdown 内容（PATCH）
 * @param {string} contentMd 新的 Markdown 内容
 */
export async function updateResumeContent(contentMd) {
  return request('/api/resume', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content_md: contentMd }),
  });
}

/**
 * 获取 AI 配置
 * @returns {Promise<{provider: string, api_key: string, base_url: string, model: string}>}
 */
export async function getAIConfig() {
  return request('/api/ai/config');
}

/**
 * 保存 AI 配置
 * @param {{provider?: string, api_key?: string, base_url?: string, model?: string}} config
 */
export async function saveAIConfig(config) {
  return request('/api/ai/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
}

/**
 * AI 优化简历
 * @param {number} jobId 目标岗位 ID
 * @param {string} instructions 附加优化指令（可选）
 */
export async function optimizeResume(jobId, instructions = '') {
  return request('/api/ai/optimize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_id: jobId, instructions }),
  });
}

/**
 * AI 助手对话
 * @param {number} jobId 目标岗位 ID
 * @param {string} message 用户消息
 * @param {Array<{role: string, text: string}>} conversationHistory 对话历史
 */
export async function chatWithAIAssistant(jobId, message, conversationHistory = []) {
  return request('/api/ai/assistant', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      job_id: jobId,
      message,
      conversation_history: conversationHistory,
    }),
  });
}

/**
 * SSE 流式 AI 助手对话
 * @param {number} jobId 岗位 ID
 * @param {string} message 用户消息
 * @param {Array} conversationHistory 对话历史
 * @param {Function} onEvent SSE 事件回调 ({type, message, ...})
 * @returns {Promise<Object>} 最终结果 (done event data)
 */
export async function chatWithAIAssistantStream(jobId, message, conversationHistory = [], onEvent) {
  const check = await ensureControllerAvailable('request:/api/ai/assistant/stream');
  if (!check.available) {
    const err = new Error('后端未启动，请先启动 Controller');
    err.errorType = check.errorType || 'CONTROLLER_UNREACHABLE';
    if (check.extensionId) err.extensionId = check.extensionId;
    throw err;
  }

  const response = await fetch(`${API_BASE}/api/ai/assistant/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      job_id: jobId,
      message,
      conversation_history: conversationHistory,
    }),
  });

  if (!response.ok) {
    throw new Error(`SSE 请求失败: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResult = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const event = JSON.parse(line.slice(6));
          if (event.type === 'done') {
            finalResult = event;
          } else if (event.type === 'error') {
            throw new Error(event.message || 'AI 处理失败');
          } else if (onEvent) {
            onEvent(event);
          }
        } catch (e) {
          if (e.message && !e.message.includes('JSON')) throw e;
        }
      }
    }
  }

  if (!finalResult) {
    throw new Error('SSE 流结束但未收到完成事件');
  }

  return finalResult;
}

/**
 * AI 智能匹配
 * @param {number[]} jobIds 待匹配的岗位 ID 列表
 */
export async function matchJobs(jobIds) {
  return request('/api/ai/match', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_ids: jobIds }),
  });
}

/**
 * 通过后端 API 导出简历为 PDF
 * 返回 PDF Blob（非 JSON），需直接下载
 * @param {string|{content_md?: string, content_html?: string, template_id?: string}} payloadOrContentMd
 * @returns {Promise<Blob>} PDF 二进制数据
 */
/**
 * 深度思考 API
 * @param {string} task 思考任务描述
 * @param {number} jobId 岗位 ID
 */
export async function deepThink(task, jobId) {
  return request('/api/ai/deep-think', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task, job_id: jobId }),
  });
}

/** 获取 AI 能力状态 */
export async function getAICapabilities() {
  return request('/api/ai/capabilities');
}

/** 获取深度思考配置 */
export async function getDeepThinkConfig() {
  return request('/api/ai/deep-think/config');
}

/**
 * 保存深度思考配置（开关）
 * @param {{ enabled: boolean }} config
 */
export async function saveDeepThinkConfig(config) {
  return request('/api/ai/deep-think/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
}

/**
 * 保存第二模型配置
 * @param {{ provider: string, base_url: string, api_key: string, model_name: string }} config
 */
export async function saveSecondaryModel(config) {
  return request('/api/ai/secondary-model', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
}

export async function exportPDFViaAPI(payloadOrContentMd) {
  const check = await ensureControllerAvailable('export_pdf');
  if (!check.available) {
    const err = new Error('后端未启动，请先启动 Controller');
    err.errorType = check.errorType || 'CONTROLLER_UNREACHABLE';
    if (check.extensionId) err.extensionId = check.extensionId;
    throw err;
  }

  const payload = typeof payloadOrContentMd === 'string'
    ? { content_md: payloadOrContentMd }
    : (payloadOrContentMd || {});

  const res = await fetch(`${API_BASE}/api/resume/export-pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `PDF 生成失败 (${res.status})`);
  }

  return await res.blob();
}
