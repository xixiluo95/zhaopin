/**
 * Dashboard API 客户端
 * 封装所有与 Controller 的 fetch 交互
 */

const API_BASE = 'http://127.0.0.1:7893';

/**
 * 统一 fetch 封装，处理异常兜底
 * @param {string} url 请求路径
 * @param {RequestInit} options fetch 选项
 * @returns {Promise<any>} 解析后的 JSON 响应
 */
async function request(url, options = {}) {
  try {
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
      throw new Error('后端未启动，请先启动 Controller');
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
      throw new Error('后端未加载清空接口，请重启 Controller');
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
 * @param {string} contentMd 简历 Markdown 内容
 * @returns {Promise<Blob>} PDF 二进制数据
 */
export async function exportPDFViaAPI(contentMd) {
  const res = await fetch(`${API_BASE}/api/resume/export-pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content_md: contentMd }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `PDF 生成失败 (${res.status})`);
  }

  return await res.blob();
}
