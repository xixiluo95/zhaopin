/**
 * compressor.js - 状态压缩器
 *
 * 负责压缩深度思考的历史状态，防止上下文膨胀。
 * 核心原则：只保留关键状态与摘要，删除冗余 reasoning。
 */

/**
 * 压缩状态摘要，用于构建下一轮上下文
 *
 * @param {Object} state - 当前深度思考状态
 * @param {Object} options - 压缩选项
 * @returns {string} 压缩后的上下文摘要文本
 */
function compressStateToContext(state, options = {}) {
  const { maxLength = 3000 } = options;
  const parts = [];

  // 1. 已验证结论（最重要）
  if (state.verified_conclusions.length > 0) {
    parts.push('## 已验证结论');
    for (const vc of state.verified_conclusions) {
      parts.push(`- [${vc.id}] (置信度 ${vc.confidence}): ${vc.content}`);
    }
  }

  // 2. 已接受的事实
  const acceptedFacts = state.facts.filter(f => f.status === 'accepted');
  if (acceptedFacts.length > 0) {
    parts.push('\n## 已确认事实');
    for (const f of acceptedFacts.slice(-10)) {
      parts.push(`- [${f.id}]: ${f.content}`);
    }
  }

  // 3. 活跃假设
  const activeHypotheses = state.hypotheses.filter(h => h.status === 'candidate');
  if (activeHypotheses.length > 0) {
    parts.push('\n## 待验证假设');
    for (const h of activeHypotheses.slice(-5)) {
      parts.push(`- [${h.id}] (置信度 ${h.confidence}): ${h.content}`);
    }
  }

  // 4. 开放问题
  const openQuestions = state.open_questions.filter(q => q.status === 'open');
  if (openQuestions.length > 0) {
    parts.push('\n## 待回答问题');
    for (const q of openQuestions.slice(-5)) {
      parts.push(`- [${q.id}]: ${q.content}`);
    }
  }

  // 5. 最近批评（只保留最新的）
  if (state.critiques.length > 0) {
    const recentCritiques = state.critiques.slice(-3);
    parts.push('\n## 最近批评');
    for (const c of recentCritiques) {
      parts.push(`- [${c.id}] 针对 ${c.target_id}: ${c.issue} (严重性: ${c.severity})`);
    }
  }

  // 6. 摘要
  if (state.short_summary) {
    parts.push(`\n## 当前摘要\n${state.short_summary}`);
  }

  let result = parts.join('\n');

  // 截断保护
  if (result.length > maxLength) {
    result = result.slice(0, maxLength) + '\n\n[状态摘要已截断]';
  }

  return result;
}

/**
 * 估算状态的 token 数（粗略）
 *
 * @param {Object} state - 状态对象
 * @returns {number} 预估 token 数
 */
function estimateStateTokens(state) {
  const json = JSON.stringify(state);
  // 粗略估算：中文约 1.5 token/字符，英文约 0.25 token/word
  return Math.ceil(json.length * 0.5);
}

/**
 * 判断是否需要压缩
 *
 * @param {Object} state - 当前状态
 * @param {number} [threshold] - token 阈值
 * @returns {boolean}
 */
function needsCompression(state, threshold = 8000) {
  return estimateStateTokens(state) > threshold;
}

module.exports = {
  compressStateToContext,
  estimateStateTokens,
  needsCompression
};
