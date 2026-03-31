/**
 * deep-think/index.js - 深度思考模块入口
 *
 * 导出模块公共 API。
 */

const { runDeepThink } = require('./orchestrator');
const {
  resolveDeepThinkMode,
  mergeDeepThinkConfig,
  mergeSecondaryModelConfig,
  isSecondaryModelValid,
  validateDeepThinkConfig,
  DEFAULT_DEEP_THINK_CONFIG,
  DEFAULT_SECONDARY_MODEL
} = require('./config');
const { createDeepThinkResult, createInitialState } = require('./schemas');

module.exports = {
  runDeepThink,
  resolveDeepThinkMode,
  mergeDeepThinkConfig,
  mergeSecondaryModelConfig,
  isSecondaryModelValid,
  validateDeepThinkConfig,
  createDeepThinkResult,
  createInitialState,
  DEFAULT_DEEP_THINK_CONFIG,
  DEFAULT_SECONDARY_MODEL
};
