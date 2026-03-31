/**
 * parser.js - LLM 输出解析器
 *
 * 负责从 LLM 文本输出中提取结构化 JSON。
 * 支持轻微修复（尾部逗号、缺失括号），失败时提供降级输出。
 */

/**
 * 平衡括号匹配提取 JSON 对象
 * 避免贪婪正则在嵌套 JSON 中截断错误
 */
function extractBalancedBraces(text, start) {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

/**
 * 从 LLM 文本中提取 JSON 对象
 *
 * @param {string} text - LLM 原始输出
 * @returns {{ success: boolean, data: Object|null, raw: string, error: string }}
 */
function extractJSON(text) {
  if (!text || typeof text !== 'string') {
    return { success: false, data: null, raw: '', error: '输入为空' };
  }

  const raw = text.trim();

  // 1. 尝试直接解析
  try {
    const parsed = JSON.parse(raw);
    return { success: true, data: parsed, raw, error: '' };
  } catch (_) { /* 继续尝试 */ }

  // 2. 尝试提取 ```json ... ``` 代码块
  const codeBlockMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1].trim());
      return { success: true, data: parsed, raw: codeBlockMatch[1].trim(), error: '' };
    } catch (_) { /* 继续尝试 */ }
  }

  // 3. 尝试提取 { ... } 最外层 JSON（使用平衡括号匹配）
  const jsonStart = raw.indexOf('{');
  if (jsonStart !== -1) {
    let candidate = extractBalancedBraces(raw, jsonStart);
    if (!candidate) {
      candidate = raw.match(/\{[\s\S]*\}/)?.[0];
    }
    if (candidate) {
      // 轻微修复：移除尾部逗号、修复单引号
      candidate = candidate.replace(/,\s*([}\]])/g, '$1');
      candidate = candidate.replace(/'/g, '"');
      // 移除注释行
      candidate = candidate.replace(/\/\/[^\n]*/g, '');

      try {
        const parsed = JSON.parse(candidate);
        return { success: true, data: parsed, raw: candidate, error: '' };
      } catch (e) {
        return { success: false, data: null, raw: candidate, error: `JSON 解析失败: ${e.message}` };
      }
    }
  }

  // 4. 尝试提取 [ ... ] JSON 数组
  const arrayMatch = raw.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    let candidate = arrayMatch[0].replace(/,\s*([}\]])/g, '$1');
    try {
      const parsed = JSON.parse(candidate);
      return { success: true, data: parsed, raw: candidate, error: '' };
    } catch (_) { /* 降级 */ }
  }

  return { success: false, data: null, raw, error: '未找到有效 JSON' };
}

/**
 * 解析 Analyst 输出，确保包含所有必要字段
 *
 * @param {string} text - LLM 原始输出
 * @returns {Object} 标准化的 Analyst 输出
 */
function parseAnalystOutput(text) {
  const { success, data } = extractJSON(text);

  const defaults = {
    facts_candidates: [],
    new_hypotheses: [],
    reasoning_summary: '',
    open_questions: [],
    proposed_next_actions: [],
    confidence: 0.5
  };

  if (!success || !data) {
    // 降级：将原始文本作为 reasoning_summary
    return { ...defaults, reasoning_summary: text?.slice(0, 2000) || '' };
  }

  return {
    facts_candidates: Array.isArray(data.facts_candidates) ? data.facts_candidates : defaults.facts_candidates,
    new_hypotheses: Array.isArray(data.new_hypotheses) ? data.new_hypotheses : defaults.new_hypotheses,
    reasoning_summary: data.reasoning_summary || defaults.reasoning_summary,
    open_questions: Array.isArray(data.open_questions) ? data.open_questions : defaults.open_questions,
    proposed_next_actions: Array.isArray(data.proposed_next_actions) ? data.proposed_next_actions : defaults.proposed_next_actions,
    confidence: typeof data.confidence === 'number' ? data.confidence : defaults.confidence
  };
}

/**
 * 解析 Critic 输出
 *
 * @param {string} text - LLM 原始输出
 * @returns {Object} 标准化的 Critic 输出
 */
function parseCriticOutput(text) {
  const { success, data } = extractJSON(text);

  const defaults = {
    criticisms: [],
    weak_points: [],
    rejected_items: [],
    should_continue: true,
    suggested_stop_reason: ''
  };

  if (!success || !data) {
    return defaults;
  }

  return {
    criticisms: Array.isArray(data.criticisms) ? data.criticisms : defaults.criticisms,
    weak_points: Array.isArray(data.weak_points) ? data.weak_points : defaults.weak_points,
    rejected_items: Array.isArray(data.rejected_items) ? data.rejected_items : defaults.rejected_items,
    should_continue: typeof data.should_continue === 'boolean' ? data.should_continue : defaults.should_continue,
    suggested_stop_reason: data.suggested_stop_reason || defaults.suggested_stop_reason
  };
}

/**
 * 解析 Summarizer 输出
 *
 * @param {string} text - LLM 原始输出
 * @returns {Object} 标准化的 Summarizer 输出
 */
function parseSummarizerOutput(text) {
  const { success, data } = extractJSON(text);

  const defaults = {
    short_summary: '',
    surviving_hypotheses: [],
    verified_conclusions: [],
    open_questions: [],
    closed_questions: []
  };

  if (!success || !data) {
    return { ...defaults, short_summary: text?.slice(0, 1000) || '' };
  }

  return {
    short_summary: data.short_summary || defaults.short_summary,
    surviving_hypotheses: Array.isArray(data.surviving_hypotheses) ? data.surviving_hypotheses : defaults.surviving_hypotheses,
    verified_conclusions: Array.isArray(data.verified_conclusions) ? data.verified_conclusions : defaults.verified_conclusions,
    open_questions: Array.isArray(data.open_questions) ? data.open_questions : defaults.open_questions,
    closed_questions: Array.isArray(data.closed_questions) ? data.closed_questions : defaults.closed_questions
  };
}

module.exports = {
  extractJSON,
  parseAnalystOutput,
  parseCriticOutput,
  parseSummarizerOutput
};
