/**
 * stop-conditions.js - 深度思考停止条件判断
 *
 * 至少支持四种停止规则：
 * 1. 达到轮次上限
 * 2. 连续 N 轮无新增有效信息
 * 3. 已形成稳定结论
 * 4. 异常保护退出
 */

/**
 * 停止条件检查器
 *
 * @param {Object} state - 当前深度思考状态
 * @param {Object} config - 深度思考配置
 * @param {Object} roundMetrics - 当前轮次指标
 * @returns {{ shouldStop: boolean, reason: string }}
 */
function checkStopConditions(state, config, roundMetrics = {}) {
  // 1. 轮次上限
  if (state.current_round >= config.max_rounds) {
    return { shouldStop: true, reason: 'max_rounds_reached' };
  }

  // 2. 连续无新增有效信息
  const noNewInfoRounds = config.stop_if_no_new_info_rounds || 2;
  if (state.round_history.length >= noNewInfoRounds) {
    const recentRounds = state.round_history.slice(-noNewInfoRounds);
    const noProgress = recentRounds.every((snap, i) => {
      if (i === 0) return true;
      const prev = recentRounds[i - 1];
      return (
        snap.verified_count === prev.verified_count &&
        snap.facts_count === prev.facts_count &&
        snap.open_questions_count >= prev.open_questions_count
      );
    });

    if (noProgress && state.round_history.length > 1) {
      return { shouldStop: true, reason: 'no_new_info' };
    }
  }

  // 3. 已形成稳定结论
  if (state.verified_conclusions.length >= 3) {
    const activeQuestions = state.open_questions.filter(q => q.status === 'open');
    if (activeQuestions.length === 0) {
      return { shouldStop: true, reason: 'stable_conclusions' };
    }
  }

  // 4. 异常保护退出
  const errorCount = roundMetrics.parseErrors || 0;
  const apiErrors = roundMetrics.apiErrors || 0;
  if (errorCount >= 3 || apiErrors >= 2) {
    return { shouldStop: true, reason: 'error_threshold' };
  }

  // 5. Critic 建议停止
  if (roundMetrics.criticSuggestsStop) {
    return { shouldStop: true, reason: 'critic_suggests_stop' };
  }

  return { shouldStop: false, reason: '' };
}

/**
 * 计算当前轮次的指标（用于停止条件判断）
 *
 * @param {Object} prevState - 上一轮状态
 * @param {Object} currentState - 当前状态
 * @param {Object} criticOutput - 当前轮 Critic 输出
 * @returns {Object} 轮次指标
 */
function calculateRoundMetrics(prevState, currentState, criticOutput = {}) {
  return {
    newFactsCount: currentState.facts.length - prevState.facts.length,
    newHypothesesCount: currentState.hypotheses.length - prevState.hypotheses.length,
    newConclusionsCount: currentState.verified_conclusions.length - prevState.verified_conclusions.length,
    closedQuestionsCount: prevState.open_questions.filter(q => q.status === 'open').length -
                          currentState.open_questions.filter(q => q.status === 'open').length,
    criticSuggestsStop: criticOutput.should_continue === false,
    parseErrors: 0,
    apiErrors: 0
  };
}

module.exports = {
  checkStopConditions,
  calculateRoundMetrics
};
