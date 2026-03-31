/**
 * schemas.js - 深度思考模块数据结构定义
 *
 * 定义状态对象、配置结构、输入输出格式。
 * 所有结构化状态通过这里的工厂函数创建，确保一致性。
 */

/**
 * 创建初始深度思考状态对象
 *
 * @param {Object} params
 * @param {string} params.task - 用户问题/任务
 * @param {string} [params.jobId] - 岗位 ID
 * @param {string} [params.candidateId] - 候选人 ID
 * @param {string} [params.mode] - 运行模式 (single|dual)
 * @param {number} [params.maxRounds] - 最大轮次
 * @returns {DeepThinkState}
 */
function createInitialState({ task, jobId = '', candidateId = '', mode = 'single', maxRounds = 10 }) {
  return {
    task,
    job_id: jobId,
    candidate_id: candidateId,
    mode,
    current_round: 0,
    max_rounds: maxRounds,
    facts: [],
    hypotheses: [],
    critiques: [],
    verified_conclusions: [],
    open_questions: [],
    tool_results: [],
    short_summary: '',
    status: 'running',
    stop_reason: '',
    final_answer: '',
    logs: [],
    round_history: []
  };
}

/**
 * 创建事实条目
 */
function createFact({ content, sourceType = 'analysis', confidence = 1.0 }) {
  return {
    id: `F${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    content,
    source_type: sourceType,
    confidence,
    round_added: 0
  };
}

/**
 * 创建假设条目
 */
function createHypothesis({ content, confidence = 0.5 }) {
  return {
    id: `H${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    content,
    status: 'candidate',
    confidence,
    round_added: 0
  };
}

/**
 * 创建批评条目
 */
function createCritique({ targetId, issue, severity = 'medium' }) {
  return {
    id: `C${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    target_id: targetId,
    issue,
    severity,
    round_added: 0
  };
}

/**
 * 创建已验证结论
 */
function createVerifiedConclusion({ content, supportIds = [], confidence = 0.8 }) {
  return {
    id: `V${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    content,
    support_ids: supportIds,
    confidence,
    round_added: 0
  };
}

/**
 * 创建开放问题
 */
function createOpenQuestion({ content }) {
  return {
    id: `Q${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    content,
    status: 'open',
    round_added: 0
  };
}

/**
 * Analyst 输出格式定义（用于 prompt 约束）
 */
const ANALYST_OUTPUT_SCHEMA = {
  facts_candidates: [],
  new_hypotheses: [],
  reasoning_summary: '',
  open_questions: [],
  proposed_next_actions: [],
  confidence: 0.5
};

/**
 * Critic 输出格式定义
 */
const CRITIC_OUTPUT_SCHEMA = {
  criticisms: [],
  weak_points: [],
  rejected_items: [],
  should_continue: true,
  suggested_stop_reason: ''
};

/**
 * Summarizer 输出格式定义
 */
const SUMMARIZER_OUTPUT_SCHEMA = {
  short_summary: '',
  surviving_hypotheses: [],
  verified_conclusions: [],
  open_questions: []
};

/**
 * 深度思考最终输出
 */
function createDeepThinkResult(state) {
  return {
    mode_used: state.mode,
    rounds_used: state.current_round,
    stop_reason: state.stop_reason,
    final_answer: state.final_answer,
    state: {
      facts: state.facts,
      hypotheses: state.hypotheses,
      verified_conclusions: state.verified_conclusions,
      open_questions: state.open_questions.filter(q => q.status === 'open'),
      short_summary: state.short_summary
    },
    logs: state.logs
  };
}

module.exports = {
  createInitialState,
  createFact,
  createHypothesis,
  createCritique,
  createVerifiedConclusion,
  createOpenQuestion,
  createDeepThinkResult,
  ANALYST_OUTPUT_SCHEMA,
  CRITIC_OUTPUT_SCHEMA,
  SUMMARIZER_OUTPUT_SCHEMA
};
