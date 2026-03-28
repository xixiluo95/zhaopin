/**
 * jobs-db.js - scraped_jobs 表 CRUD 函数
 *
 * 提供 scraped_jobs 表的增删改查操作。
 * 依赖 db.js 中的 getDatabase() 获取数据库实例。
 */

const { getDatabase } = require('./db');

/**
 * 插入单条职位记录，利用 UNIQUE(platform, platformJobId) 自然去重
 *
 * @param {Object} jobData - 职位数据
 * @returns {Object} { id, changes } 或抛出异常
 */
function insertJob(jobData) {
  const db = getDatabase();
  const rawPayload = jobData.rawPayload
    ? (typeof jobData.rawPayload === 'string' ? jobData.rawPayload : JSON.stringify(jobData.rawPayload))
    : null;

  const result = db.prepare(`
    INSERT INTO scraped_jobs (
      platform, platformJobId, title, company, location, url,
      keywords, salary, experience, education,
      match_status, selected, crawl_batch_id, crawl_mode,
      job_alive_status, raw_payload,
      detail_status, detail_error_code
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    jobData.platform,
    jobData.platformJobId,
    jobData.title,
    jobData.company,
    jobData.location || null,
    jobData.url || null,
    jobData.keywords || null,
    jobData.salary || null,
    jobData.experience || null,
    jobData.education || null,
    jobData.matchStatus || 'not_ready',
    jobData.selected !== undefined ? (jobData.selected ? 1 : 0) : 0,
    jobData.crawlBatchId || null,
    jobData.crawlMode || null,
    jobData.jobAliveStatus || 'unknown',
    rawPayload,
    jobData.detailStatus || deriveDefaultDetailStatus(jobData.platform),
    jobData.detailErrorCode || null
  );

  return { id: result.lastInsertRowid, changes: result.changes };
}

/**
 * 插入或更新职位记录（upsert）
 *
 * @param {Object} jobData - 职位数据
 * @returns {Object} { id, changes }
 */
function insertOrUpdateJob(jobData) {
  const db = getDatabase();
  const rawPayload = jobData.rawPayload
    ? (typeof jobData.rawPayload === 'string' ? jobData.rawPayload : JSON.stringify(jobData.rawPayload))
    : null;

  const result = db.prepare(`
    INSERT INTO scraped_jobs (
      platform, platformJobId, title, company, location, url,
      keywords, salary, experience, education,
      match_status, selected, crawl_batch_id, crawl_mode,
      job_alive_status, raw_payload,
      detail_status, detail_error_code
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform, platformJobId) DO UPDATE SET
      title = excluded.title,
      company = excluded.company,
      location = excluded.location,
      url = excluded.url,
      keywords = excluded.keywords,
      salary = excluded.salary,
      experience = excluded.experience,
      education = excluded.education,
      raw_payload = excluded.raw_payload,
      crawled_at = CURRENT_TIMESTAMP
  `).run(
    jobData.platform,
    jobData.platformJobId,
    jobData.title,
    jobData.company,
    jobData.location || null,
    jobData.url || null,
    jobData.keywords || null,
    jobData.salary || null,
    jobData.experience || null,
    jobData.education || null,
    jobData.matchStatus || 'not_ready',
    jobData.selected !== undefined ? (jobData.selected ? 1 : 0) : 0,
    jobData.crawlBatchId || null,
    jobData.crawlMode || null,
    jobData.jobAliveStatus || 'unknown',
    rawPayload,
    jobData.detailStatus || deriveDefaultDetailStatus(jobData.platform),
    jobData.detailErrorCode || null
  );

  return { id: result.lastInsertRowid, changes: result.changes };
}

/**
 * 事务内批量插入职位记录
 *
 * @param {Array<Object>} jobs - 职位数据数组
 * @returns {{ inserted: number, duplicates: number }}
 */
function batchInsertJobs(jobs) {
  const db = getDatabase();
  let inserted = 0;
  let duplicates = 0;

  const insertMany = db.transaction((jobList) => {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO scraped_jobs (
        platform, platformJobId, title, company, location, url,
        keywords, salary, experience, education,
        match_status, selected, crawl_batch_id, crawl_mode,
        job_alive_status, raw_payload,
        detail_status, detail_error_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const job of jobList) {
      const rawPayload = job.rawPayload
        ? (typeof job.rawPayload === 'string' ? job.rawPayload : JSON.stringify(job.rawPayload))
        : null;

      const result = stmt.run(
        job.platform,
        job.platformJobId,
        job.title,
        job.company,
        job.location || null,
        job.url || null,
        job.keywords || null,
        job.salary || null,
        job.experience || null,
        job.education || null,
        job.matchStatus || 'not_ready',
        job.selected !== undefined ? (job.selected ? 1 : 0) : 0,
        job.crawlBatchId || null,
        job.crawlMode || null,
        job.jobAliveStatus || 'unknown',
        rawPayload,
        job.detailStatus || deriveDefaultDetailStatus(job.platform),
        job.detailErrorCode || null
      );

      if (result.changes > 0) {
        inserted++;
      } else {
        duplicates++;
      }
    }
  });

  insertMany(jobs);
  return { inserted, duplicates };
}

/**
 * 分页 + 多条件动态过滤查询
 *
 * @param {Object} filters - 过滤条件
 * @param {string} [filters.platform] - 平台过滤
 * @param {string} [filters.keyword] - 关键词 LIKE 搜索
 * @param {number|boolean} [filters.selected] - 是否选中
 * @param {string} [filters.batchId] - 采集批次 ID 过滤
 * @param {number} [filters.page=1] - 页码（从1开始）
 * @param {number} [filters.pageSize=20] - 每页条数
 * @returns {Object} { total, page, pageSize, records }
 */
function getJobs({ platform, keyword, selected, batchId, page = 1, pageSize = 20 } = {}) {
  const db = getDatabase();
  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.min(100, Math.max(1, Number(pageSize) || 20));
  const offset = (safePage - 1) * safePageSize;

  const conditions = [];
  const params = [];

  if (platform) {
    conditions.push('platform = ?');
    params.push(platform);
  }
  if (keyword) {
    conditions.push('(title LIKE ? OR company LIKE ? OR keywords LIKE ?)');
    const pattern = `%${keyword}%`;
    params.push(pattern, pattern, pattern);
  }
  if (selected !== undefined && selected !== null && selected !== '') {
    conditions.push('selected = ?');
    params.push(selected ? 1 : 0);
  }
  if (batchId) {
    conditions.push('crawl_batch_id = ?');
    params.push(batchId);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const totalRow = db.prepare(`SELECT COUNT(*) AS count FROM scraped_jobs ${whereClause}`).get(...params);
  const total = totalRow?.count || 0;

  const rows = db.prepare(`
    SELECT * FROM scraped_jobs ${whereClause}
    ORDER BY datetime(crawled_at) DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(...params, safePageSize, offset);

  return {
    total,
    page: safePage,
    pageSize: safePageSize,
    records: rows
  };
}

/**
 * 按 id 查询单条职位记录
 *
 * @param {number} id
 * @returns {Object|undefined}
 */
function getJobById(id) {
  const db = getDatabase();
  return db.prepare('SELECT * FROM scraped_jobs WHERE id = ?').get(id);
}

/**
 * 按联合唯一键查询（用于去重检查）
 *
 * @param {string} platform
 * @param {string} platformJobId
 * @returns {Object|undefined}
 */
function getJobByPlatformKey(platform, platformJobId) {
  const db = getDatabase();
  return db.prepare(
    'SELECT * FROM scraped_jobs WHERE platform = ? AND platformJobId = ?'
  ).get(platform, platformJobId);
}

/**
 * 更新单条 selected 字段
 *
 * @param {number} id
 * @param {boolean} selected
 * @returns {boolean} 是否更新成功
 */
function updateSelected(id, selected) {
  const db = getDatabase();
  const result = db.prepare(
    'UPDATE scraped_jobs SET selected = ? WHERE id = ?'
  ).run(selected ? 1 : 0, id);
  return result.changes > 0;
}

/**
 * 批量更新 selected 字段
 *
 * @param {Array<number>} ids
 * @param {boolean} selected
 * @returns {number} 更新条数
 */
function batchSelect(ids, selected) {
  const db = getDatabase();
  let updated = 0;

  const updateMany = db.transaction((idList) => {
    const stmt = db.prepare('UPDATE scraped_jobs SET selected = ? WHERE id = ?');
    for (const id of idList) {
      const result = stmt.run(selected ? 1 : 0, id);
      updated += result.changes;
    }
  });

  updateMany(ids);
  return updated;
}

/**
 * 获取所有已选中的职位（用于待投递列表）
 *
 * @returns {Array<Object>}
 */
function getSelectedJobs() {
  const db = getDatabase();
  return db.prepare('SELECT * FROM scraped_jobs WHERE selected = 1 ORDER BY datetime(crawled_at) DESC, id DESC').all();
}

/**
 * 切换收藏状态
 *
 * @param {number} id
 * @returns {{ isFavorite: boolean }} 切换后的收藏状态
 */
function toggleFavorite(id) {
  const db = getDatabase();
  const job = db.prepare('SELECT is_favorite FROM scraped_jobs WHERE id = ?').get(id);
  if (!job) return null;

  const newValue = job.is_favorite ? 0 : 1;
  db.prepare('UPDATE scraped_jobs SET is_favorite = ? WHERE id = ?').run(newValue, id);
  return { isFavorite: newValue === 1 };
}

/**
 * 获取所有已收藏的职位
 *
 * @returns {Array<Object>}
 */
function getFavoriteJobs() {
  const db = getDatabase();
  return db.prepare('SELECT * FROM scraped_jobs WHERE is_favorite = 1 ORDER BY datetime(crawled_at) DESC, id DESC').all();
}

/**
 * 清除未选中的职位记录（条件清理，不做全表 DELETE）
 *
 * @returns {number} 删除条数
 */
function clearUnselectedJobs() {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM scraped_jobs WHERE selected = 0');
  const info = result.run();
  db.pragma('incremental_vacuum');
  return info.changes;
}

/**
 * 清空全部岗位记录
 *
 * @returns {number} 删除条数
 */
function clearAllJobs() {
  const db = getDatabase();
  const deleteAll = db.transaction(() => {
    const countRow = db.prepare('SELECT COUNT(*) AS count FROM scraped_jobs').get();
    db.prepare('DELETE FROM scraped_jobs').run();
    db.prepare("DELETE FROM sqlite_sequence WHERE name = 'scraped_jobs'").run();
    return countRow?.count || 0;
  });

  const deleted = deleteAll();
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // ignore
  }
  try {
    db.exec('VACUUM');
  } catch {
    // ignore
  }
  return deleted;
}

/**
 * 投递成功后，按 platform + platformJobId 删除已投递记录
 *
 * @param {Array<{platform: string, platformJobId: string}>} keys
 * @returns {number} 删除条数
 */
function clearSelectedAfterDelivery(keys) {
  const db = getDatabase();
  let deleted = 0;

  const deleteMany = db.transaction((keyList) => {
    const stmt = db.prepare(
      'DELETE FROM scraped_jobs WHERE platform = ? AND platformJobId = ?'
    );
    for (const key of keyList) {
      const result = stmt.run(key.platform, key.platformJobId);
      deleted += result.changes;
    }
    db.pragma('incremental_vacuum');
  });

  deleteMany(keys);
  return deleted;
}

/**
 * 统计职位数量
 *
 * @param {Object} [filters] - 过滤条件
 * @param {string} [filters.platform]
 * @param {number|boolean} [filters.selected]
 * @returns {number}
 */
function getJobCount({ platform, selected } = {}) {
  const db = getDatabase();
  const conditions = [];
  const params = [];

  if (platform) {
    conditions.push('platform = ?');
    params.push(platform);
  }
  if (selected !== undefined && selected !== null && selected !== '') {
    conditions.push('selected = ?');
    params.push(selected ? 1 : 0);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const row = db.prepare(`SELECT COUNT(*) AS count FROM scraped_jobs ${whereClause}`).get(...params);
  return row?.count || 0;
}

/**
 * 按 crawl_batch_id 查询（单轮结果查看）
 *
 * @param {string} batchId
 * @returns {Array<Object>}
 */
function getJobsByBatch(batchId) {
  const db = getDatabase();
  return db.prepare(
    'SELECT * FROM scraped_jobs WHERE crawl_batch_id = ? ORDER BY datetime(crawled_at) DESC, id DESC'
  ).all(batchId);
}

// ============ detail_status 状态机 ============

/** 最大重试次数，超过后标记为 skipped */
const DETAIL_MAX_ATTEMPTS = 5;

/** 退避策略：第 N 次失败（0-based）对应的等待分钟数 */
const BACKOFF_MINUTES = [5, 30, 120, 1440]; // 5min, 30min, 2h, 24h

/**
 * 根据平台推导默认的 detail_status 值
 * - 51job 不支持自动详情抓取，默认 skipped
 * - 其他平台（如 zhaopin）默认 pending
 *
 * @param {string} platform - 平台标识
 * @returns {string} detail_status 值
 */
function deriveDefaultDetailStatus(platform) {
  if (platform === '51job') {
    return 'skipped';
  }
  return 'pending';
}

/**
 * 计算下一次重试时间（退避策略）
 *
 * 退避梯度：5min → 30min → 2h → 24h（循环）
 *
 * @param {number} attemptCount - 当前已尝试次数（0-based，即本次失败前已失败几次）
 * @returns {string} SQLite datetime 表达式计算出的下次重试时间
 */
function computeNextRetryAt(attemptCount) {
  const idx = Math.min(attemptCount, BACKOFF_MINUTES.length - 1);
  const minutes = BACKOFF_MINUTES[idx];
  // 返回 SQLite 可直接使用的 datetime 表达式
  const db = getDatabase();
  const row = db.prepare(`SELECT datetime('now', '+${minutes} minutes') AS next_retry`).get();
  return row.next_retry;
}

/**
 * 标记详情抓取成功
 * 更新 detail_status = 'success'，清空错误码
 *
 * @param {number} id - scraped_jobs 记录 ID
 * @param {string} description - 抓取到的职位描述正文
 * @returns {boolean} 是否更新成功
 */
function markDetailSuccess(id, description) {
  const db = getDatabase();

  // 更新 raw_payload 中的 description
  const job = db.prepare('SELECT raw_payload FROM scraped_jobs WHERE id = ?').get(id);
  if (job?.raw_payload) {
    try {
      const payload = JSON.parse(job.raw_payload);
      payload.description = description || '';
      db.prepare(`
        UPDATE scraped_jobs
        SET raw_payload = ?,
            detail_status = 'success',
            detail_error_code = NULL
        WHERE id = ?
      `).run(JSON.stringify(payload), id);
      return true;
    } catch {
      // JSON 解析失败，仍更新状态
    }
  }

  db.prepare(`
    UPDATE scraped_jobs
    SET detail_status = 'success',
        detail_error_code = NULL
    WHERE id = ?
  `).run(id);
  return true;
}

/**
 * 标记详情抓取失败，更新退避策略
 *
 * @param {number} id - scraped_jobs 记录 ID
 * @param {'anti_bot'|'empty'|'error'} errorCode - 错误类型
 * @param {string} [errorMessage] - 可选的错误详情
 * @returns {boolean} 是否更新成功
 */
function markDetailFailed(id, errorCode, errorMessage) {
  const db = getDatabase();

  const job = db.prepare(
    'SELECT detail_attempt_count FROM scraped_jobs WHERE id = ?'
  ).get(id);

  if (!job) return false;

  const newAttemptCount = (job.detail_attempt_count || 0) + 1;

  if (newAttemptCount >= DETAIL_MAX_ATTEMPTS) {
    // 达到最大重试次数，标记为 skipped
    db.prepare(`
      UPDATE scraped_jobs
      SET detail_status = 'skipped',
          detail_attempt_count = ?,
          last_detail_attempt_at = datetime('now'),
          next_detail_retry_at = NULL,
          detail_error_code = ?
      WHERE id = ?
    `).run(newAttemptCount, errorCode, id);
  } else {
    // 退避重试
    const nextRetryAt = computeNextRetryAt(newAttemptCount - 1);
    db.prepare(`
      UPDATE scraped_jobs
      SET detail_status = ?,
          detail_attempt_count = ?,
          last_detail_attempt_at = datetime('now'),
          next_detail_retry_at = ?,
          detail_error_code = ?
      WHERE id = ?
    `).run(errorCode, newAttemptCount, nextRetryAt, errorCode, id);
  }

  return true;
}

/**
 * 查询待抓取详情的职位列表
 * 条件：detail_status = 'pending' 或到了重试时间
 *
 * @param {number} [limit=10] - 返回条数上限
 * @returns {Array<Object>} 待处理的职位记录
 */
function getPendingDetailJobs(limit = 10) {
  const db = getDatabase();
  return db.prepare(`
    SELECT *
    FROM scraped_jobs
    WHERE (detail_status = 'pending'
           OR (detail_status IN ('anti_bot', 'empty', 'error')
               AND next_detail_retry_at <= datetime('now')))
    ORDER BY crawled_at ASC, id ASC
    LIMIT ?
  `).all(limit);
}

/**
 * 查询智联详情 backlog 队列
 * pending 优先于 anti_bot，按 crawled_at 排序
 * 仅返回未达 max_attempts 且到重试时间的记录
 *
 * @param {number} [limit=3] - 返回条数上限（对应 DETAIL_BUDGET_PER_RUN）
 * @returns {Array<Object>} 待补详情的职位记录
 */
function getZhaopinDetailBacklog(limit = 3) {
  const db = getDatabase();
  return db.prepare(`
    SELECT *
    FROM scraped_jobs
    WHERE platform = 'zhaopin'
      AND detail_status IN ('pending', 'anti_bot')
      AND detail_attempt_count < ?
      AND (next_detail_retry_at IS NULL OR next_detail_retry_at <= datetime('now', 'localtime'))
    ORDER BY
      CASE detail_status WHEN 'pending' THEN 0 WHEN 'anti_bot' THEN 1 ELSE 2 END,
      crawled_at ASC
    LIMIT ?
  `).all(DETAIL_MAX_ATTEMPTS, limit);
}

/**
 * 按 platform + platformJobId 更新 detail_status
 * 用于详情抓取完成后直接按业务键更新
 *
 * @param {string} platform - 平台
 * @param {string} platformJobId - 平台职位 ID
 * @param {'success'|'anti_bot'|'empty'|'error'|'skipped'} detailStatus - 目标状态
 * @param {string} [description] - 成功时的职位描述
 * @param {string} [errorCode] - 失败时的错误码
 * @returns {boolean} 是否更新成功
 */
function updateDetailStatusByKey(platform, platformJobId, detailStatus, description, errorCode) {
  const db = getDatabase();

  if (detailStatus === 'success') {
    // 成功：更新 raw_payload 中的 description
    const job = db.prepare(
      'SELECT id, raw_payload FROM scraped_jobs WHERE platform = ? AND platformJobId = ?'
    ).get(platform, platformJobId);

    if (!job) return false;

    if (job.raw_payload && description) {
      try {
        const payload = JSON.parse(job.raw_payload);
        payload.description = description;
        db.prepare(`
          UPDATE scraped_jobs
          SET raw_payload = ?,
              detail_status = 'success',
              detail_error_code = NULL
          WHERE id = ?
        `).run(JSON.stringify(payload), job.id);
        return true;
      } catch {
        // JSON 解析失败，仍更新状态
      }
    }

    db.prepare(`
      UPDATE scraped_jobs
      SET detail_status = 'success',
          detail_error_code = NULL
      WHERE platform = ? AND platformJobId = ?
    `).run(platform, platformJobId);
    return true;
  }

  // 失败状态：走退避策略
  const job = db.prepare(
    'SELECT id, detail_attempt_count FROM scraped_jobs WHERE platform = ? AND platformJobId = ?'
  ).get(platform, platformJobId);

  if (!job) return false;

  return markDetailFailed(job.id, errorCode || detailStatus);
}

module.exports = {
  insertJob,
  insertOrUpdateJob,
  batchInsertJobs,
  getJobs,
  getJobById,
  getJobByPlatformKey,
  updateSelected,
  batchSelect,
  getSelectedJobs,
  toggleFavorite,
  getFavoriteJobs,
  clearUnselectedJobs,
  clearAllJobs,
  clearSelectedAfterDelivery,
  getJobCount,
  getJobsByBatch,
  // detail_status 状态机
  markDetailSuccess,
  markDetailFailed,
  getPendingDetailJobs,
  getZhaopinDetailBacklog,
  updateDetailStatusByKey,
  computeNextRetryAt,
  deriveDefaultDetailStatus,
  DETAIL_MAX_ATTEMPTS
};
