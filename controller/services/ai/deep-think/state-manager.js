/**
 * state-manager.js - 深度思考状态管理器
 *
 * 负责状态初始化、更新、压缩维护。
 * 每轮结束后合并 Analyst/Critic 输出到全局状态。
 */

const {
  createFact,
  createHypothesis,
  createCritique,
  createVerifiedConclusion,
  createOpenQuestion
} = require('./schemas');

/**
 * 将 Analyst 输出合并到全局状态
 *
 * @param {Object} state - 当前状态
 * @param {Object} analystOutput - Analyst 结构化输出
 * @returns {Object} 更新后的状态（浅拷贝）
 */
function mergeAnalystOutput(state, analystOutput) {
  const updated = { ...state };
  const round = state.current_round;

  // 合并事实候选（暂标记为 candidate，等 Critic 审查）
  if (Array.isArray(analystOutput.facts_candidates)) {
    for (const fc of analystOutput.facts_candidates) {
      const fact = createFact({
        content: typeof fc === 'string' ? fc : fc.content || JSON.stringify(fc),
        sourceType: 'analyst',
        confidence: fc.confidence || 0.7
      });
      fact.round_added = round;
      fact.status = 'candidate';
      updated.facts = [...updated.facts, fact];
    }
  }

  // 合并新假设
  if (Array.isArray(analystOutput.new_hypotheses)) {
    for (const h of analystOutput.new_hypotheses) {
      const hyp = createHypothesis({
        content: typeof h === 'string' ? h : h.content || JSON.stringify(h),
        confidence: h.confidence || 0.5
      });
      hyp.round_added = round;
      updated.hypotheses = [...updated.hypotheses, hyp];
    }
  }

  // 合并开放问题
  if (Array.isArray(analystOutput.open_questions)) {
    for (const q of analystOutput.open_questions) {
      const question = createOpenQuestion({
        content: typeof q === 'string' ? q : q.content || JSON.stringify(q)
      });
      question.round_added = round;
      updated.open_questions = [...updated.open_questions, question];
    }
  }

  // 更新摘要
  if (analystOutput.reasoning_summary) {
    updated.short_summary = analystOutput.reasoning_summary;
  }

  return updated;
}

/**
 * 将 Critic 输出合并到全局状态
 *
 * @param {Object} state - 当前状态
 * @param {Object} criticOutput - Critic 结构化输出
 * @returns {Object} 更新后的状态
 */
function mergeCriticOutput(state, criticOutput) {
  const updated = { ...state };
  const round = state.current_round;

  // 处理批评意见
  if (Array.isArray(criticOutput.criticisms)) {
    for (const c of criticOutput.criticisms) {
      const critique = createCritique({
        targetId: c.target_id || '',
        issue: typeof c === 'string' ? c : c.issue || JSON.stringify(c),
        severity: c.severity || 'medium'
      });
      critique.round_added = round;
      updated.critiques = [...updated.critiques, critique];
    }
  }

  // 处理被拒绝的条目（将对应 fact 标记为 rejected）
  if (Array.isArray(criticOutput.rejected_items)) {
    updated.facts = updated.facts.map(f => {
      if (criticOutput.rejected_items.includes(f.id)) {
        return { ...f, status: 'rejected' };
      }
      return f;
    });

    updated.hypotheses = updated.hypotheses.map(h => {
      if (criticOutput.rejected_items.includes(h.id)) {
        return { ...h, status: 'rejected' };
      }
      return h;
    });
  }

  // 将未被拒绝的 candidate facts 提升为 accepted
  updated.facts = updated.facts.map(f => {
    if (f.status === 'candidate' && f.round_added === round) {
      return { ...f, status: 'accepted' };
    }
    return f;
  });

  return updated;
}

/**
 * 执行 Summarizer 逻辑：提升高置信假设为结论
 *
 * @param {Object} state - 当前状态
 * @param {Object} [summarizerOutput] - 可选的 Summarizer LLM 输出
 * @returns {Object} 更新后的状态
 */
function applySummarizerLogic(state, summarizerOutput) {
  const updated = { ...state };
  const round = state.current_round;

  if (summarizerOutput) {
    // 使用 LLM Summarizer 输出
    if (Array.isArray(summarizerOutput.verified_conclusions)) {
      for (const vc of summarizerOutput.verified_conclusions) {
        const conclusion = createVerifiedConclusion({
          content: typeof vc === 'string' ? vc : vc.content || JSON.stringify(vc),
          supportIds: vc.support_ids || [],
          confidence: vc.confidence || 0.8
        });
        conclusion.round_added = round;
        updated.verified_conclusions = [...updated.verified_conclusions, conclusion];
      }
    }

    if (summarizerOutput.short_summary) {
      updated.short_summary = summarizerOutput.short_summary;
    }

    // 关闭已回答的开放问题
    if (Array.isArray(summarizerOutput.closed_questions)) {
      updated.open_questions = updated.open_questions.map(q => {
        if (summarizerOutput.closed_questions.includes(q.id)) {
          return { ...q, status: 'resolved' };
        }
        return q;
      });
    }
  } else {
    // 规则引擎：将高置信假设提升为结论
    const highConfidenceHypotheses = updated.hypotheses.filter(
      h => h.status === 'candidate' && h.confidence >= 0.8
    );

    for (const h of highConfidenceHypotheses) {
      // 检查是否被批评
      const hasCritique = updated.critiques.some(c => c.target_id === h.id);
      if (!hasCritique) {
        const conclusion = createVerifiedConclusion({
          content: h.content,
          supportIds: [h.id],
          confidence: h.confidence
        });
        conclusion.round_added = round;
        updated.verified_conclusions = [...updated.verified_conclusions, conclusion];
        h.status = 'promoted';
      }
    }
  }

  return updated;
}

/**
 * 记录当前轮次状态快照
 *
 * @param {Object} state - 当前状态
 * @returns {Object} 带 round_history 的更新状态
 */
function recordRoundSnapshot(state) {
  const snapshot = {
    round: state.current_round,
    facts_count: state.facts.filter(f => f.status === 'accepted').length,
    hypotheses_count: state.hypotheses.filter(h => h.status === 'candidate').length,
    critiques_count: state.critiques.length,
    verified_count: state.verified_conclusions.length,
    open_questions_count: state.open_questions.filter(q => q.status === 'open').length,
    summary: state.short_summary
  };

  return {
    ...state,
    round_history: [...state.round_history, snapshot]
  };
}

/**
 * 压缩状态：移除冗余数据，保留关键信息
 *
 * @param {Object} state - 当前状态
 * @param {Object} options - 压缩选项
 * @returns {Object} 压缩后的状态
 */
function compressState(state, options = {}) {
  const { keepLastNRounds = 3 } = options;
  const currentRound = state.current_round;
  const cutoffRound = Math.max(0, currentRound - keepLastNRounds);

  return {
    ...state,
    // 只保留 accepted 的事实
    facts: state.facts.filter(f => f.status === 'accepted'),
    // 只保留活跃假设
    hypotheses: state.hypotheses.filter(h => h.status === 'candidate'),
    // 只保留最近 N 轮的批评
    critiques: state.critiques.filter(c => c.round_added >= cutoffRound),
    // 结论全部保留
    verified_conclusions: state.verified_conclusions,
    // 只保留未解决的问题
    open_questions: state.open_questions.filter(q => q.status === 'open')
  };
}

module.exports = {
  mergeAnalystOutput,
  mergeCriticOutput,
  applySummarizerLogic,
  recordRoundSnapshot,
  compressState
};
