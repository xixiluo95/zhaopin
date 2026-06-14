/**
 * job-filter-protocol.js - 统一过滤协议
 *
 * 职责：
 * 1. criteria 归一化和递归校验
 * 2. parseExperienceYears 增强版
 * 3. deriveExperienceLabel 映射
 * 4. normalizeExperienceFields 辅助函数
 */

// ============ parseExperienceYears 增强版 ============

/**
 * 解析经验年限文本为结构化数据
 *
 * 覆盖变体：
 * - 经验不限 / 无需经验 / 不限经验 -> { min: 0, max: null }
 * - 应届 / 应届生 / 校招 -> { min: 0, max: 0 }
 * - 实习 / 在校 -> { min: 0, max: 0 }
 * - 1-3年 / 1~3年 / 1 至 3 年 / 1到3年 -> { min: 1, max: 3 }
 * - 3年以上 / 3年及以上 / 3年起 -> { min: 3, max: null }
 * - 3年以下 / 3年以内 / 3年及以下 -> { min: 0, max: 3 }
 * - 3年 -> { min: 3, max: 3 }
 *
 * @param {string} experienceStr - 原始经验文本
 * @returns {{ min: number, max: number|null }|null}
 */
function parseExperienceYears(experienceStr) {
  const text = String(experienceStr || '').trim();
  if (!text) return null;

  // 不限经验类
  if (/经验不限|无需经验|不限经验/.test(text)) return { min: 0, max: null };

  // 应届/校招类
  if (/应届|校招/.test(text)) return { min: 0, max: 0 };

  // 实习/在校类
  if (/实习|在校/.test(text)) return { min: 0, max: 0 };

  // 范围匹配: 1-3年, 1~3年, 1 至 3 年, 1到3年
  const rangeMatch = text.match(/(\d+)\s*[-~至到]\s*(\d+)\s*年/);
  if (rangeMatch) {
    return { min: Number(rangeMatch[1]), max: Number(rangeMatch[2]) };
  }

  // X年以下/以内/及以下
  const belowMatch = text.match(/(\d+)\s*年(?:以下|以内|及以下)/);
  if (belowMatch) {
    return { min: 0, max: Number(belowMatch[1]) };
  }

  // X年以上/及以上/起
  const aboveMatch = text.match(/(\d+)\s*年(?:以上|及以上|起)/);
  if (aboveMatch) {
    return { min: Number(aboveMatch[1]), max: null };
  }

  // 单一数字: X年
  const singleMatch = text.match(/(\d+)\s*年/);
  if (singleMatch) {
    const years = Number(singleMatch[1]);
    return { min: years, max: years };
  }

  return null;
}

/**
 * 从解析结果推导经验等级标签
 *
 * 映射规则：
 * - raw 命中 "实习" 或 "在校": intern
 * - raw 命中 "应届": fresh
 * - parsed 为 null: unknown
 * - parsed.max === 0: fresh
 * - parsed.max <= 2: junior
 * - parsed.min >= 3 且 parsed.max <= 5: mid
 * - parsed.min >= 5 且 parsed.max <= 10: senior
 * - parsed.min >= 10 或 (parsed.max === null 且 parsed.min >= 8): expert
 * - 其他: unknown
 *
 * @param {{ min: number, max: number|null }|null} parsed - 解析结果
 * @param {string} [rawText=''] - 原始文本
 * @returns {string} 经验标签
 */
function deriveExperienceLabel(parsed, rawText) {
  const raw = String(rawText || '').trim();

  if (/实习|在校/.test(raw)) return 'intern';
  if (/应届/.test(raw)) return 'fresh';

  if (!parsed) return 'unknown';

  if (parsed.max === 0) return 'fresh';
  if (parsed.max !== null && parsed.max <= 2) return 'junior';
  if (parsed.min >= 3 && parsed.max !== null && parsed.max <= 5) return 'mid';
  if (parsed.min >= 5 && parsed.max !== null && parsed.max <= 10) return 'senior';
  if (parsed.min >= 10) return 'expert';
  if (parsed.max === null && parsed.min >= 8) return 'expert';

  return 'unknown';
}

/**
 * 从经验文本生成结构化字段
 *
 * @param {string} experience - 原始经验文本
 * @returns {{ experience_raw: string|null, experience_min: number|null, experience_max: number|null, experience_label: string }}
 */
function normalizeExperienceFields(experience) {
  const parsed = parseExperienceYears(experience);
  return {
    experience_raw: experience || null,
    experience_min: parsed ? parsed.min : null,
    experience_max: parsed ? parsed.max : null,
    experience_label: deriveExperienceLabel(parsed, experience),
  };
}

// ============ Criteria 校验 ============

const VALID_EXPERIENCE_LABELS = ['intern', 'fresh', 'junior', 'mid', 'senior', 'expert', 'unknown'];
const MAX_KEYWORDS_PER_TYPE = 20;
const MAX_KEYWORD_LENGTH = 40;
const MAX_SEMANTIC_INSTRUCTION_LENGTH = 200;

/**
 * 校验并归一化 criteria 对象
 *
 * @param {Object} rawCriteria - 原始 criteria
 * @returns {{ valid: boolean, criteria: Object, errors: string[] }}
 */
function validateCriteria(rawCriteria) {
  const errors = [];
  const criteria = {};

  if (!rawCriteria || typeof rawCriteria !== 'object') {
    return { valid: false, criteria: {}, errors: ['criteria 必须是非空对象'] };
  }

  // experience 校验
  if (rawCriteria.experience) {
    if (typeof rawCriteria.experience !== 'object') {
      errors.push('experience 必须是对象');
    } else {
      criteria.experience = {};
      if (rawCriteria.experience.include_ranges) {
        const result = validateKeywordArray(rawCriteria.experience.include_ranges, 'experience.include_ranges');
        if (result.errors.length > 0) errors.push(...result.errors);
        else criteria.experience.include_ranges = result.values;
      }
      if (rawCriteria.experience.exclude_ranges) {
        const result = validateKeywordArray(rawCriteria.experience.exclude_ranges, 'experience.exclude_ranges');
        if (result.errors.length > 0) errors.push(...result.errors);
        else criteria.experience.exclude_ranges = result.values;
      }
    }
  }

  // include_keywords 校验
  if (rawCriteria.include_keywords) {
    const result = validateKeywordArray(rawCriteria.include_keywords, 'include_keywords');
    if (result.errors.length > 0) errors.push(...result.errors);
    else criteria.include_keywords = result.values;
  }

  // exclude_keywords 校验
  if (rawCriteria.exclude_keywords) {
    const result = validateKeywordArray(rawCriteria.exclude_keywords, 'exclude_keywords');
    if (result.errors.length > 0) errors.push(...result.errors);
    else criteria.exclude_keywords = result.values;
  }

  // exclude_outsourcing 校验
  if (rawCriteria.exclude_outsourcing !== undefined) {
    if (typeof rawCriteria.exclude_outsourcing !== 'boolean') {
      errors.push('exclude_outsourcing 必须是布尔值');
    } else {
      criteria.exclude_outsourcing = rawCriteria.exclude_outsourcing;
    }
  }

  return { valid: errors.length === 0, criteria, errors };
}

/**
 * 校验关键词数组
 */
function validateKeywordArray(arr, fieldName) {
  const errors = [];
  const values = [];

  if (!Array.isArray(arr)) {
    errors.push(`${fieldName} 必须是数组`);
    return { errors, values };
  }
  if (arr.length > MAX_KEYWORDS_PER_TYPE) {
    errors.push(`${fieldName} 最多 ${MAX_KEYWORDS_PER_TYPE} 个`);
    return { errors, values };
  }

  for (const item of arr) {
    const str = String(item || '').trim();
    if (!str) continue;
    if (str.length > MAX_KEYWORD_LENGTH) {
      errors.push(`${fieldName} 单个关键词最长 ${MAX_KEYWORD_LENGTH} 字`);
      return { errors, values };
    }
    values.push(str);
  }

  return { errors, values };
}

/**
 * 校验完整的 filter 请求参数
 *
 * @param {Object} params - { scope, criteria, action?, preview_id?, confirmation_token? }
 * @returns {{ valid: boolean, params: Object, errors: string[] }}
 */
function validateFilterRequest(params) {
  const errors = [];

  // scope 校验
  const scope = String(params?.scope || 'favorites').trim();
  if (scope !== 'favorites') {
    errors.push(`MVP 仅支持 scope='favorites'，不支持 '${scope}'`);
  }

  // criteria 校验
  const { valid: criteriaValid, criteria, errors: criteriaErrors } = validateCriteria(params?.criteria);
  if (!criteriaValid) {
    errors.push(...criteriaErrors);
  }

  // action 校验（apply 时需要）
  let action = null;
  if (params.action) {
    action = String(params.action).trim();
    if (action !== 'keep_only' && action !== 'exclude') {
      errors.push(`action 必须是 'keep_only' 或 'exclude'，不允许 '${action}'`);
    }
  }

  return {
    valid: errors.length === 0,
    params: {
      scope,
      criteria,
      action,
      preview_id: params.preview_id || null,
      confirmation_token: params.confirmation_token || null,
    },
    errors,
  };
}

module.exports = {
  parseExperienceYears,
  deriveExperienceLabel,
  normalizeExperienceFields,
  validateCriteria,
  validateFilterRequest,
  validateKeywordArray,
  VALID_EXPERIENCE_LABELS,
  MAX_KEYWORDS_PER_TYPE,
  MAX_KEYWORD_LENGTH,
};
