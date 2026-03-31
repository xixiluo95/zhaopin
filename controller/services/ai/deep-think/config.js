/**
 * config.js - 深度思考配置管理
 *
 * 定义深度思考配置结构、默认值、验证与模式决策逻辑。
 */

const DEFAULT_DEEP_THINK_CONFIG = {
  enabled: false,
  mode: 'auto',         // auto | single | dual
  max_rounds: 10,
  compression_enabled: true,
  fallback_to_single_when_secondary_missing: true,
  stop_if_no_new_info_rounds: 2,
  debug: false
};

const DEFAULT_SECONDARY_MODEL = {
  enabled: false,
  provider: '',
  model: '',
  api_key: '',
  base_url: '',
  temperature: 0.2,
  max_tokens: 4000,
  timeout: 60,
  role_preference: 'critic'
};

/**
 * 合并用户配置与默认值
 *
 * @param {Object} userConfig - 用户提供的深度思考配置
 * @returns {Object} 完整配置
 */
function mergeDeepThinkConfig(userConfig = {}) {
  return {
    ...DEFAULT_DEEP_THINK_CONFIG,
    ...userConfig
  };
}

/**
 * 合并第二模型配置与默认值
 *
 * @param {Object} userConfig - 用户提供的第二模型配置
 * @returns {Object} 完整配置
 */
function mergeSecondaryModelConfig(userConfig = {}) {
  return {
    ...DEFAULT_SECONDARY_MODEL,
    ...userConfig
  };
}

/**
 * 检测第二模型是否有效
 *
 * @param {Object} secondaryModel - 第二模型配置
 * @returns {boolean}
 */
function isSecondaryModelValid(secondaryModel) {
  if (!secondaryModel) return false;
  if (!secondaryModel.enabled) return false;
  if (!secondaryModel.model || !secondaryModel.model.trim()) return false;
  if (!secondaryModel.api_key || !secondaryModel.api_key.trim()) return false;
  return true;
}

/**
 * 解析深度思考运行模式
 *
 * 规则：
 * - single → 强制单模型
 * - dual → 优先双模型；若第二模型无效则根据 fallback 配置决定
 * - auto → 第二模型有效用 dual，否则用 single
 *
 * @param {Object} deepThinkConfig - 深度思考配置
 * @param {Object} secondaryModel - 第二模型配置
 * @returns {{ mode: string, fallbackUsed: boolean, reason: string }}
 */
function resolveDeepThinkMode(deepThinkConfig, secondaryModel) {
  const config = mergeDeepThinkConfig(deepThinkConfig);
  const secondary = mergeSecondaryModelConfig(secondaryModel);
  const secondaryValid = isSecondaryModelValid(secondary);

  if (config.mode === 'single') {
    return { mode: 'single', fallbackUsed: false, reason: '显式配置为 single 模式' };
  }

  if (config.mode === 'dual') {
    if (secondaryValid) {
      return { mode: 'dual', fallbackUsed: false, reason: '双模型配置有效' };
    }
    if (config.fallback_to_single_when_secondary_missing) {
      return { mode: 'single', fallbackUsed: true, reason: '第二模型不可用，自动回退到 single' };
    }
    throw new Error('dual 模式要求第二模型配置，但第二模型不可用且未允许回退');
  }

  if (config.mode === 'auto') {
    if (secondaryValid) {
      return { mode: 'dual', fallbackUsed: false, reason: 'auto 模式检测到有效第二模型，使用 dual' };
    }
    return { mode: 'single', fallbackUsed: false, reason: 'auto 模式未检测到第二模型，使用 single' };
  }

  // 未知模式，默认 single
  return { mode: 'single', fallbackUsed: false, reason: `未知模式 "${config.mode}"，默认 single` };
}

/**
 * 验证深度思考配置
 *
 * @param {Object} config - 待验证配置
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateDeepThinkConfig(config) {
  const errors = [];

  if (config.max_rounds !== undefined) {
    if (typeof config.max_rounds !== 'number' || config.max_rounds < 1 || config.max_rounds > 20) {
      errors.push('max_rounds 必须为 1-20 的整数');
    }
  }

  if (config.mode !== undefined) {
    if (!['auto', 'single', 'dual'].includes(config.mode)) {
      errors.push('mode 必须为 auto、single 或 dual');
    }
  }

  if (config.stop_if_no_new_info_rounds !== undefined) {
    if (typeof config.stop_if_no_new_info_rounds !== 'number' || config.stop_if_no_new_info_rounds < 1) {
      errors.push('stop_if_no_new_info_rounds 必须为正整数');
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  DEFAULT_DEEP_THINK_CONFIG,
  DEFAULT_SECONDARY_MODEL,
  mergeDeepThinkConfig,
  mergeSecondaryModelConfig,
  isSecondaryModelValid,
  resolveDeepThinkMode,
  validateDeepThinkConfig
};
