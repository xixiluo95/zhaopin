/**
 * job-filter-executor.js - 统一过滤执行器
 *
 * 职责：
 * 1. preview_job_filter - 只读预览
 * 2. apply_job_filter - 写库执行（带 transaction + snapshot + verifier）
 * 3. undo_last_filter - 5 分钟内撤销
 * 4. 内置 verifier - 强制验证
 *
 * 安全规则：
 * - keep_only 空匹配拒绝
 * - keep_only 低比例保护（< 10%）
 * - force 不进入 tool schema
 * - MVP 仅 scope='favorites'
 */

const { getDatabase } = require('../db');
const { parseExperienceYears, validateFilterRequest } = require('./job-filter-protocol');
const jobsDb = require('../jobs-db');

// ============ Outsourcing 检测 ============

const OUTSOURCING_KEYWORDS = [
  '外包', '派遣', '驻场', '外派', '人力资源', '外协', '劳务',
  '人力外包', '项目外派', '服务外包', '技术外包', '乙方',
  '猎头', '人才服务', '人事代理', '劳务派遣', '人力服务',
  '信息技术服务', '软件外包', '项目外包', '资源外包',
];

function isOutsourcing(job) {
  const targets = [
    job.company || '',
    job.title || '',
  ];
  const combined = targets.join(' ');
  for (const kw of OUTSOURCING_KEYWORDS) {
    if (combined.includes(kw)) return true;
  }
  return false;
}

// ============ 匹配计算 ============

/**
 * 计算岗位是否匹配 criteria
 *
 * @param {Object} job - 岗位记录
 * @param {Object} criteria - 归一化后的 criteria
 * @returns {{ matched: boolean, reason: string }}
 */
function matchJob(job, criteria) {
  // 1. 经验范围 - 排除
  if (criteria.experience && criteria.experience.exclude_ranges) {
    const jobExp = getJobExperience(job);
    for (const rangeStr of criteria.experience.exclude_ranges) {
      const range = parseExperienceYears(rangeStr);
      if (range && jobExp && isExperienceOverlap(jobExp, range)) {
        return { matched: false, reason: `经验在排除范围内 (${rangeStr})` };
      }
    }
  }

  // 2. 经验范围 - 包含（必须至少匹配一个）
  if (criteria.experience && criteria.experience.include_ranges && criteria.experience.include_ranges.length > 0) {
    const jobExp = getJobExperience(job);
    if (!jobExp) {
      // 无法解析时不排除（保守保留）
      return { matched: true, reason: '经验信息无法解析，保守保留' };
    }
    const inAnyRange = criteria.experience.include_ranges.some(rangeStr => {
      const range = parseExperienceYears(rangeStr);
      return range && isExperienceOverlap(jobExp, range);
    });
    if (!inAnyRange) {
      return { matched: false, reason: `经验不在指定范围内 (${criteria.experience.include_ranges.join(', ')})` };
    }
  }

  // 3. 排除关键词
  if (criteria.exclude_keywords && criteria.exclude_keywords.length > 0) {
    const combined = `${job.title || ''} ${job.company || ''} ${job.keywords || ''}`.toLowerCase();
    for (const kw of criteria.exclude_keywords) {
      if (combined.includes(kw.toLowerCase())) {
        return { matched: false, reason: `包含排除关键词: ${kw}` };
      }
    }
  }

  // 4. 包含关键词（OR 逻辑，至少匹配一个）
  if (criteria.include_keywords && criteria.include_keywords.length > 0) {
    const combined = `${job.title || ''} ${job.company || ''} ${job.keywords || ''}`.toLowerCase();
    const matched = criteria.include_keywords.some(kw =>
      combined.includes(kw.toLowerCase())
    );
    if (!matched) {
      return { matched: false, reason: `未包含任何要求关键词: ${criteria.include_keywords.join(', ')}` };
    }
  }

  // 5. 外包排除
  if (criteria.exclude_outsourcing) {
    if (isOutsourcing(job)) {
      return { matched: false, reason: '外包岗位' };
    }
  }

  return { matched: true, reason: '' };
}

/**
 * 获取岗位的经验数据（优先用结构化字段）
 */
function getJobExperience(job) {
  if (job.experience_min !== null && job.experience_min !== undefined) {
    return { min: job.experience_min, max: job.experience_max };
  }
  return parseExperienceYears(job.experience);
}

/**
 * 判断两个经验范围是否有重叠
 */
function isExperienceOverlap(a, b) {
  const aMin = a.min;
  const aMax = a.max !== null ? a.max : Infinity;
  const bMin = b.min;
  const bMax = b.max !== null ? b.max : Infinity;
  return aMin <= bMax && bMin <= aMax;
}

// ============ Preview ============

/**
 * 预览筛选结果（只读）
 */
function previewJobFilter(params) {
  const validation = validateFilterRequest(params);
  if (!validation.valid) {
    return { success: false, error: 'INVALID_CRITERIA', message: validation.errors.join('; ') };
  }

  const { scope, criteria } = validation.params;
  const db = getDatabase();

  // 获取 scope 对应的岗位集合
  const jobs = scope === 'favorites'
    ? jobsDb.getFavoriteJobs()
    : [];

  if (jobs.length === 0) {
    const previewId = generatePreviewId();
    return {
      success: true,
      preview_id: previewId,
      expires_at: computeExpiry(),
      scope,
      total: 0,
      matched_count: 0,
      excluded_count: 0,
      matched_ids: [],
      excluded: [],
      criteria,
      requires_confirmation: false,
    };
  }

  const matched = [];
  const excluded = [];

  for (const job of jobs) {
    const result = matchJob(job, criteria);
    if (result.matched) {
      matched.push(job);
    } else {
      excluded.push({
        id: job.id,
        title: job.title,
        company: job.company,
        reason: result.reason,
      });
    }
  }

  const matchedIds = matched.map(j => j.id);
  const requiresConfirmation = matchedIds.length > 0 && matchedIds.length / jobs.length < 0.1;

  const previewId = generatePreviewId();

  // 存储预览到内存缓存（不写库）
  previewCache.set(previewId, {
    preview_id: previewId,
    scope,
    criteria,
    matched_ids: matchedIds,
    total: jobs.length,
    created_at: Date.now(),
    expires_at: Date.now() + 5 * 60 * 1000,
  });

  return {
    success: true,
    preview_id: previewId,
    expires_at: computeExpiry(),
    scope,
    total: jobs.length,
    matched_count: matchedIds.length,
    excluded_count: excluded.length,
    matched_ids: matchedIds,
    excluded: excluded.slice(0, 50),
    criteria,
    requires_confirmation: requiresConfirmation,
  };
}

// ============ Apply ============

/**
 * 执行筛选操作（写库）
 */
function applyJobFilter(params) {
  const validation = validateFilterRequest(params);
  if (!validation.valid) {
    return { success: false, error: 'INVALID_CRITERIA', message: validation.errors.join('; ') };
  }

  const { scope, criteria, action, preview_id, confirmation_token } = validation.params;

  if (!action) {
    return { success: false, error: 'MISSING_ACTION', message: 'apply 操作必须指定 action' };
  }

  const db = getDatabase();

  // 重新读取当前 scope（不复用 preview 的旧数据）
  const jobs = scope === 'favorites'
    ? jobsDb.getFavoriteJobs()
    : [];

  const beforeIds = jobs.map(j => j.id);

  if (beforeIds.length === 0) {
    return { success: false, error: 'EMPTY_SCOPE', message: '收藏列表为空，无需操作' };
  }

  // 重新计算匹配
  const matchedIds = [];
  const excludedInfo = [];
  for (const job of jobs) {
    const result = matchJob(job, criteria);
    if (result.matched) {
      matchedIds.push(job.id);
    } else {
      excludedInfo.push({ id: job.id, reason: result.reason });
    }
  }

  // 安全检查
  if (action === 'keep_only') {
    if (matchedIds.length === 0) {
      return { success: false, error: 'EMPTY_KEEP_ONLY', message: '匹配结果为空，拒绝执行 keep_only（会删除所有收藏）' };
    }
    if (matchedIds.length / beforeIds.length < 0.1) {
      if (!verifyConfirmationToken(confirmation_token)) {
        return {
          success: false,
          error: 'LOW_RATIO_PROTECTION',
          message: `keep_only 仅保留 ${matchedIds.length}/${beforeIds.length} (${(matchedIds.length / beforeIds.length * 100).toFixed(1)}%)，低于 10% 保护阈值。需要用户确认。`,
          requires_confirmation: true,
        };
      }
    }
  }

  // 确定受影响的 ID
  let affectedIds;
  if (action === 'keep_only') {
    affectedIds = beforeIds.filter(id => !matchedIds.includes(id));
  } else {
    // exclude
    affectedIds = matchedIds;
  }

  if (affectedIds.length === 0) {
    return {
      success: true,
      action,
      affected_count: 0,
      before_count: beforeIds.length,
      after_count: beforeIds.length,
      message: '没有需要操作的岗位',
    };
  }

  // 生成操作 ID
  const operationId = generateOperationId();

  // 执行写库（在 transaction 中）
  const applyTransaction = db.transaction(() => {
    // 写入操作快照
    db.prepare(`
      INSERT INTO job_filter_operations (operation_id, action, scope, criteria_json, before_ids_json, affected_ids_json, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+5 minutes'))
    `).run(
      operationId,
      action,
      scope,
      JSON.stringify(criteria),
      JSON.stringify(beforeIds),
      JSON.stringify(affectedIds)
    );

    // 执行收藏状态更新
    const stmt = db.prepare('UPDATE scraped_jobs SET is_favorite = 0, selected = 0 WHERE id = ?');
    for (const id of affectedIds) {
      stmt.run(id);
    }

    // 读取 afterIds
    const afterRows = db.prepare('SELECT id FROM scraped_jobs WHERE is_favorite = 1').all();
    const afterIds = afterRows.map(r => r.id);

    // 更新 after_ids_json
    db.prepare('UPDATE job_filter_operations SET after_ids_json = ? WHERE operation_id = ?').run(
      JSON.stringify(afterIds), operationId
    );

    return afterIds;
  });

  const afterIds = applyTransaction();

  // Verifier
  const verifyResult = verifyAfterApply(action, beforeIds, matchedIds, affectedIds, afterIds);
  if (!verifyResult.ok) {
    const error = new Error(verifyResult.message || '过滤结果验证失败');
    error.code = 'VERIFY_FAILED';
    error.details = verifyResult.details || {};
    throw error;
  }

  return {
    success: true,
    operation_id: operationId,
    action,
    affected_count: affectedIds.length,
    before_count: beforeIds.length,
    after_count: afterIds.length,
    undo_available: true,
    undo_expires_in_seconds: 300,
  };
}

// ============ Undo ============

/**
 * 撤销最近一次 apply 操作
 */
function undoLastFilter() {
  const db = getDatabase();

  // 查找最近一条未过期、未撤销的操作
  const op = db.prepare(`
    SELECT * FROM job_filter_operations
    WHERE undone_at IS NULL AND expires_at > datetime('now')
    ORDER BY created_at DESC LIMIT 1
  `).get();

  if (!op) {
    return { success: false, error: 'NO_UNDOABLE_OPERATION', message: '没有可撤销的操作（可能已过期或已撤销）' };
  }

  const beforeIds = JSON.parse(op.before_ids_json || '[]');
  const affectedIds = JSON.parse(op.affected_ids_json || '[]');

  if (beforeIds.length === 0) {
    return { success: false, error: 'EMPTY_BEFORE', message: '操作记录中无 before_ids' };
  }

  // 恢复 before_ids 中的岗位
  const restoreTransaction = db.transaction(() => {
    const stmt = db.prepare('UPDATE scraped_jobs SET is_favorite = 1, selected = 1 WHERE id = ?');
    for (const id of beforeIds) {
      stmt.run(id);
    }
    // 标记已撤销
    db.prepare('UPDATE job_filter_operations SET undone_at = datetime(\'now\') WHERE operation_id = ?').run(op.operation_id);
  });

  restoreTransaction();

  return {
    success: true,
    operation_id: op.operation_id,
    restored_count: beforeIds.length,
    message: `已撤销操作 ${op.operation_id}，恢复了 ${beforeIds.length} 个收藏`,
  };
}

// ============ Verifier ============

function verifyAfterApply(action, beforeIds, matchedIds, affectedIds, afterIds) {
  if (action === 'keep_only') {
    // afterIds 应该是 matchedIds 的子集
    for (const id of afterIds) {
      if (!matchedIds.includes(id)) {
        return {
          ok: false,
          message: `keep_only 验证失败: ID ${id} 在 afterIds 中但不在 matchedIds 中`,
          details: { unexpected_id: id },
        };
      }
    }
    // affectedIds 不应在 afterIds 中
    for (const id of affectedIds) {
      if (afterIds.includes(id)) {
        return {
          ok: false,
          message: `keep_only 验证失败: 已移除的 ID ${id} 仍在 afterIds 中`,
          details: { leaked_id: id },
        };
      }
    }
  } else {
    // exclude: affectedIds 不应在 afterIds 中
    for (const id of affectedIds) {
      if (afterIds.includes(id)) {
        return {
          ok: false,
          message: `exclude 验证失败: 已排除的 ID ${id} 仍在 afterIds 中`,
          details: { leaked_id: id },
        };
      }
    }
    // 未命中的 beforeIds 应保留
    const unaffected = beforeIds.filter(id => !affectedIds.includes(id));
    for (const id of unaffected) {
      if (!afterIds.includes(id)) {
        return {
          ok: false,
          message: `exclude 验证失败: 未排除的 ID ${id} 不在 afterIds 中`,
          details: { missing_id: id },
        };
      }
    }
  }

  return { ok: true };
}

function assertVerified(result) {
  if (!result.ok) {
    const error = new Error(result.message || 'filter verification failed');
    error.code = 'VERIFY_FAILED';
    error.details = result.details || {};
    throw error;
  }
}

// ============ 辅助 ============

const previewCache = new Map();

function generatePreviewId() {
  return `fp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateOperationId() {
  return `fo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function computeExpiry() {
  return new Date(Date.now() + 5 * 60 * 1000).toISOString();
}

/**
 * 验证确认 token（MVP 简化实现）
 * 生产环境应使用加密签名 token
 */
function verifyConfirmationToken(token) {
  if (!token || typeof token !== 'string') return false;
  // MVP: 简单校验 token 格式
  return token.startsWith('confirm_') && token.length > 20;
}

/**
 * 生成确认 token
 */
function generateConfirmationToken(previewId) {
  return `confirm_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 获取预览缓存
 */
function getPreviewFromCache(previewId) {
  const cached = previewCache.get(previewId);
  if (!cached) return null;
  if (Date.now() > cached.expires_at) {
    previewCache.delete(previewId);
    return null;
  }
  return cached;
}

module.exports = {
  previewJobFilter,
  applyJobFilter,
  undoLastFilter,
  matchJob,
  getJobExperience,
  isExperienceOverlap,
  verifyAfterApply,
  assertVerified,
  generateConfirmationToken,
  getPreviewFromCache,
};
