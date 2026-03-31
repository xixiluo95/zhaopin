/**
 * logger.js - 深度思考日志工具
 *
 * 负责 debug log、fallback log、异常日志。
 * 日志中禁止出现 API Key 明文或敏感字段。
 */

const fs = require('fs');
const path = require('path');

const TRACES_DIR = path.join(__dirname, '../../../data/ai_traces');

/**
 * 创建深度思考日志实例
 *
 * @param {Object} options
 * @param {boolean} [options.debug] - 是否启用调试日志
 * @param {string} [options.traceId] - 追踪 ID
 * @returns {Object} 日志实例
 */
function createDeepThinkLogger(options = {}) {
  const { debug = false, traceId = `dt-${Date.now()}` } = options;
  const logs = [];
  const startTime = Date.now();

  function log(level, category, message, data = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      elapsed_ms: Date.now() - startTime,
      level,
      category,
      message,
      data: sanitizeLogData(data)
    };

    logs.push(entry);

    if (debug || level === 'error' || level === 'warn') {
      const prefix = `[DeepThink:${traceId}]`;
      const msg = `${prefix} [${level.toUpperCase()}] [${category}] ${message}`;
      if (level === 'error') {
        console.error(msg, data.error || '');
      } else if (level === 'warn') {
        console.warn(msg);
      } else {
        console.log(msg);
      }
    }
  }

  return {
    traceId,

    info(category, message, data) {
      log('info', category, message, data);
    },

    warn(category, message, data) {
      log('warn', category, message, data);
    },

    error(category, message, data) {
      log('error', category, message, data);
    },

    debug(category, message, data) {
      if (debug) {
        log('debug', category, message, data);
      }
    },

    /**
     * 记录轮次开始
     */
    roundStart(round, mode) {
      log('info', 'round', `第 ${round} 轮开始`, { round, mode });
    },

    /**
     * 记录轮次结束
     */
    roundEnd(round, metrics) {
      log('info', 'round', `第 ${round} 轮结束`, { round, ...metrics });
    },

    /**
     * 记录 fallback 事件
     */
    fallback(from, to, reason) {
      log('warn', 'fallback', `模式回退: ${from} → ${to}`, { from, to, reason });
    },

    /**
     * 记录停止事件
     */
    stop(reason, round) {
      log('info', 'stop', `深度思考停止: ${reason}`, { reason, round });
    },

    /**
     * 获取所有日志
     */
    getLogs() {
      return [...logs];
    },

    /**
     * 将 trace 保存到文件
     */
    saveTrace(state) {
      try {
        if (!fs.existsSync(TRACES_DIR)) {
          fs.mkdirSync(TRACES_DIR, { recursive: true });
        }

        const traceData = {
          trace_id: traceId,
          created_at: new Date().toISOString(),
          duration_ms: Date.now() - startTime,
          mode: state.mode,
          rounds: state.current_round,
          stop_reason: state.stop_reason,
          conclusions_count: state.verified_conclusions.length,
          logs
        };

        const filePath = path.join(TRACES_DIR, `${traceId}.json`);
        fs.writeFileSync(filePath, JSON.stringify(traceData, null, 2));
        return filePath;
      } catch (err) {
        console.error(`[DeepThink] trace 保存失败:`, err.message);
        return null;
      }
    }
  };
}

/**
 * 清理日志数据，脱敏敏感字段
 *
 * @param {Object} data - 原始数据
 * @returns {Object} 脱敏后的数据
 */
function sanitizeLogData(data) {
  if (!data || typeof data !== 'object') return data;

  const sensitiveKeys = ['api_key', 'apiKey', 'api_key_encrypted', 'password', 'secret', 'token', 'authorization', 'bearer', 'credential'];
  const sanitized = {};

  for (const [key, value] of Object.entries(data)) {
    if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk.toLowerCase()))) {
      sanitized[key] = '***REDACTED***';
    } else if (Array.isArray(value)) {
      sanitized[key] = value.map(item =>
        typeof item === 'object' && item !== null ? sanitizeLogData(item) : item
      );
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeLogData(value);
    } else if (typeof value === 'string' && value.length > 30 && /^[A-Za-z0-9+/=._-]{30,}$/.test(value)) {
      // 可能是 token/key，脱敏处理
      sanitized[key] = value.slice(0, 6) + '***REDACTED***';
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

module.exports = {
  createDeepThinkLogger,
  sanitizeLogData
};
