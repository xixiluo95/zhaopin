/**
 * jobs-handler.js - scraped_jobs API Handler
 *
 * 提供 4 个 API 端点处理函数。
 * 依赖 jobs-db.js 的 CRUD 函数。
 */

const jobsDb = require('./jobs-db');

/**
 * GET /api/jobs - 分页 + 多条件过滤查询
 */
function handleGetJobs(req, res) {
  const url = new URL(req.url, `http://localhost:${req.socket.localPort}`);
  const platform = url.searchParams.get('platform') || undefined;
  const keyword = url.searchParams.get('keyword') || undefined;
  const batchId = url.searchParams.get('batch_id') || undefined;
  const page = Number(url.searchParams.get('page')) || 1;
  const pageSize = Number(url.searchParams.get('pageSize')) || 20;
  const selectedParam = url.searchParams.get('selected');

  const selected = selectedParam !== null && selectedParam !== undefined && selectedParam !== ''
    ? selectedParam === 'true' || selectedParam === '1'
    : undefined;

  const result = jobsDb.getJobs({ platform, keyword, page, pageSize, selected, batchId });
  res.end(JSON.stringify({ jobs: result.records, total: result.total }));
}

/**
 * GET /api/jobs/detail?id=N - 获取单条职位详情
 */
function handleGetJobDetail(req, res) {
  const url = new URL(req.url, `http://localhost:${req.socket.localPort}`);
  const id = Number(url.searchParams.get('id'));

  if (!id) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: 'Missing or invalid id parameter' }));
    return;
  }

  const job = jobsDb.getJobById(id);
  if (!job) {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Job not found' }));
    return;
  }

  let mergedJob = { ...job };
  try {
    const payload = typeof job.raw_payload === 'string'
      ? JSON.parse(job.raw_payload)
      : (job.raw_payload || {});

    mergedJob = {
      ...mergedJob,
      description: payload.description || payload.jobDesc || payload['岗位描述'] || '',
      url: payload.url || (payload.encryptJobId ? `https://www.zhipin.com/job_detail/${payload.encryptJobId}.html` : '') || mergedJob.url || '',
      location: payload.location || payload.locationName || mergedJob.location || '',
      keywords: payload.keywords || (Array.isArray(payload.skills) ? payload.skills.join(', ') : '') || mergedJob.keywords || '',
      salary: payload.salary || payload.salaryDesc || mergedJob.salary || '',
      experience: payload.experience || payload.jobExperience || mergedJob.experience || '',
      education: payload.education || payload.jobDegree || mergedJob.education || '',
      company: payload.company || payload.brandName || mergedJob.company || '',
      title: payload.title || payload.jobName || mergedJob.title || ''
    };
  } catch {
    mergedJob.description = mergedJob.description || '';
  }

  res.end(JSON.stringify({ job: mergedJob }));
}

/**
 * POST /api/jobs/select - 更新选中状态
 * body: { id: number, selected: boolean }
 */
function handleSelectJob(req, res) {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    try {
      const payload = JSON.parse(body);
      const id = Number(payload.id);
      const selected = Boolean(payload.selected);

      if (!id) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing or invalid id' }));
        return;
      }

      const updated = jobsDb.updateSelected(id, selected);
      if (!updated) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Job not found' }));
        return;
      }

      res.end(JSON.stringify({ success: true, id }));
    } catch (e) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
  });
}

/**
 * GET /api/delivery/selected - 获取收藏列表
 * 读取 is_favorite = 1 的记录，与 UI "收藏列表" 语义对齐
 */
function handleGetDeliveryList(req, res) {
  const jobs = jobsDb.getFavoriteJobs();
  res.end(JSON.stringify({ jobs }));
}

/**
 * POST /api/jobs/:id/favorite - 切换收藏状态
 */
function handleToggleFavorite(req, res) {
  const url = new URL(req.url, `http://localhost:${req.socket.localPort}`);
  const parts = url.pathname.split('/').filter(Boolean);
  const id = Number(parts[parts.length - 2]);

  if (!Number.isInteger(id) || id <= 0) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: 'Missing or invalid id' }));
    return;
  }

  const result = jobsDb.toggleFavorite(id);
  if (!result) {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Job not found' }));
    return;
  }

  res.end(JSON.stringify({ success: true, id, isFavorite: result.isFavorite }));
}

/**
 * POST /api/jobs/clear - 清空全部岗位
 */
function handleClearAllJobs(req, res) {
  try {
    const deleted = jobsDb.clearAllJobs();
    res.end(JSON.stringify({ success: true, deleted }));
  } catch (error) {
    console.error('[JobsAPI] clear-all error:', error);
    res.writeHead(500);
    res.end(JSON.stringify({ success: false, error: error.message }));
  }
}

/**
 * POST /api/jobs/batch-insert - 批量写入 scraped_jobs 表
 *
 * body: {
 *   platform: string,
 *   jobs: Array<{
 *     platformJobId, title, company, location, url,
 *     keywords, salary, experience, education,
 *     rawPayload?, crawlBatchId?, crawlMode?
 *   }>
 * }
 *
 * 响应: { success, inserted, duplicates, errors }
 */
function handleBatchInsert(req, res) {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    try {
      const payload = JSON.parse(body);
      const platform = payload.platform || 'unknown';
      const rawJobs = Array.isArray(payload.jobs) ? payload.jobs : [];

      if (rawJobs.length === 0) {
        res.end(JSON.stringify({
          success: true,
          inserted: 0,
          duplicates: 0,
          errors: []
        }));
        return;
      }

      // 生成采集批次ID（如果调用方未提供）
      const batchId = payload.crawlBatchId || (
        new Date().toISOString().slice(0, 16).replace(/[-T:]/g, '') +
        '-' + Math.random().toString(36).slice(2, 6)
      );

      // 映射到 scraped_jobs 表字段
      const mapped = rawJobs.map(raw => ({
        platform: raw.platform || platform,
        platformJobId: String(raw.platformJobId || ''),
        title: raw.title || '',
        company: raw.company || '',
        location: raw.location || null,
        url: raw.url || null,
        keywords: raw.keywords || null,
        salary: raw.salary || null,
        experience: raw.experience || null,
        education: raw.education || null,
        crawlBatchId: raw.crawlBatchId || batchId,
        crawlMode: raw.crawlMode || null,
        rawPayload: raw.raw_payload || raw.rawPayload || raw,
        detailStatus: raw.detailStatus || null,
        detailErrorCode: raw.detailErrorCode || null
      }));

      // 过滤掉必填字段缺失的记录
      const valid = mapped.filter(j => j.title && j.company);
      const skipped = mapped.length - valid.length;

      const result = jobsDb.batchInsertJobs(valid);

      console.log(
        `[JobsAPI] batch-insert: platform=${platform}, ` +
        `total=${rawJobs.length}, valid=${valid.length}, skipped=${skipped}, ` +
        `inserted=${result.inserted}, duplicates=${result.duplicates}`
      );

      res.end(JSON.stringify({
        success: true,
        inserted: result.inserted,
        duplicates: result.duplicates,
        skipped,
        errors: []
      }));

    } catch (e) {
      console.error('[JobsAPI] batch-insert error:', e);
      res.writeHead(400);
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
  });
}

/**
 * GET /api/jobs/detail-backlog?platform=zhaopin&limit=N
 * 获取待补详情的 backlog 队列
 */
function handleGetDetailBacklog(req, res) {
  const url = new URL(req.url, `http://localhost:${req.socket.localPort}`);
  const platform = url.searchParams.get('platform') || 'zhaopin';
  const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit')) || 3));

  if (platform !== 'zhaopin') {
    res.end(JSON.stringify({ success: true, jobs: [], total: 0 }));
    return;
  }

  const jobs = jobsDb.getZhaopinDetailBacklog(limit);
  res.end(JSON.stringify({ success: true, jobs, total: jobs.length }));
}

/**
 * POST /api/jobs/detail-status-update
 * 按 platform + platformJobId 更新 detail_status
 *
 * body: {
 *   platform: string,
 *   platformJobId: string,
 *   detailStatus: 'success' | 'anti_bot' | 'empty' | 'error' | 'skipped',
 *   description?: string,   // 成功时的正文
 *   errorCode?: string      // 失败时的错误码
 * }
 */
function handleDetailStatusUpdate(req, res) {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    try {
      const payload = JSON.parse(body);
      const { platform, platformJobId, detailStatus, description, errorCode } = payload;

      if (!platform || !platformJobId || !detailStatus) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Missing required fields: platform, platformJobId, detailStatus' }));
        return;
      }

      const validStatuses = ['success', 'anti_bot', 'empty', 'error', 'skipped'];
      if (!validStatuses.includes(detailStatus)) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: `Invalid detailStatus: ${detailStatus}` }));
        return;
      }

      const updated = jobsDb.updateDetailStatusByKey(platform, platformJobId, detailStatus, description, errorCode);
      if (!updated) {
        res.writeHead(404);
        res.end(JSON.stringify({ success: false, error: 'Job not found' }));
        return;
      }

      res.end(JSON.stringify({ success: true, platform, platformJobId, detailStatus }));
    } catch (e) {
      res.writeHead(400);
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
  });
}

module.exports = {
  handleGetJobs,
  handleGetJobDetail,
  handleSelectJob,
  handleGetDeliveryList,
  handleToggleFavorite,
  handleClearAllJobs,
  handleBatchInsert,
  handleGetDetailBacklog,
  handleDetailStatusUpdate
};
