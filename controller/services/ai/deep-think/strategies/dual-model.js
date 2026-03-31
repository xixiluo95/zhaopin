/**
 * dual-model.js - 双模型深度思考策略
 *
 * 主模型担任 Analyst，第二模型担任 Critic。
 * Summarizer 由主模型承担。
 *
 * 当第二模型不可用时不会在此文件处理回退逻辑——
 * 回退在 orchestrator 中通过 config.resolveDeepThinkMode() 完成。
 */

const fs = require('fs');
const path = require('path');
const { parseAnalystOutput, parseCriticOutput } = require('../utils/parser');
const { compressStateToContext } = require('../utils/compressor');

const ANALYST_PROMPT = fs.readFileSync(
  path.join(__dirname, '../prompts/analyst.txt'), 'utf8'
);
const CRITIC_PROMPT = fs.readFileSync(
  path.join(__dirname, '../prompts/critic.txt'), 'utf8'
);

/**
 * 使用主模型执行 Analyst 分析
 *
 * @param {Object} params
 * @param {Function} params.primaryChatFn - 主模型调用函数
 * @param {Object} params.state - 当前状态
 * @param {string} params.jobContext - 岗位上下文
 * @param {string} params.candidateContext - 候选人上下文
 * @param {Object} params.logger - 日志实例
 * @returns {Promise<Object>} Analyst 结构化输出
 */
async function runAnalystWithPrimary({ primaryChatFn, state, jobContext, candidateContext, logger }) {
  const stateContext = compressStateToContext(state);

  const messages = [
    { role: 'system', content: ANALYST_PROMPT },
    {
      role: 'user',
      content: buildAnalystInput({
        task: state.task,
        jobContext,
        candidateContext,
        stateContext,
        round: state.current_round
      })
    }
  ];

  logger.debug('analyst-primary', `第 ${state.current_round} 轮 Analyst（主模型）输入构建完成`);

  const response = await primaryChatFn(messages);
  const content = response.content || response.choices?.[0]?.message?.content || '';

  logger.debug('analyst-primary', `Analyst 原始输出长度: ${content.length}`);

  return parseAnalystOutput(content);
}

/**
 * 使用第二模型执行 Critic 审查
 *
 * @param {Object} params
 * @param {Function} params.secondaryChatFn - 第二模型调用函数
 * @param {Object} params.state - 当前状态
 * @param {Object} params.analystOutput - 本轮 Analyst 输出
 * @param {string} params.jobContext - 岗位上下文
 * @param {string} params.candidateContext - 候选人上下文
 * @param {Object} params.logger - 日志实例
 * @returns {Promise<Object>} Critic 结构化输出
 */
async function runCriticWithSecondary({ secondaryChatFn, state, analystOutput, jobContext, candidateContext, logger }) {
  const stateContext = compressStateToContext(state);

  const messages = [
    { role: 'system', content: CRITIC_PROMPT },
    {
      role: 'user',
      content: buildCriticInput({
        task: state.task,
        jobContext,
        candidateContext,
        stateContext,
        analystOutput,
        round: state.current_round
      })
    }
  ];

  logger.debug('critic-secondary', `第 ${state.current_round} 轮 Critic（第二模型）输入构建完成`);

  const response = await secondaryChatFn(messages);
  const content = response.content || response.choices?.[0]?.message?.content || '';

  logger.debug('critic-secondary', `Critic 原始输出长度: ${content.length}`);

  return parseCriticOutput(content);
}

/**
 * 构建 Analyst 输入
 */
function buildAnalystInput({ task, jobContext, candidateContext, stateContext, round }) {
  const parts = [
    `## 用户任务\n${task}`,
    `\n## 当前轮次\n第 ${round} 轮`
  ];
  if (jobContext) parts.push(`\n## 岗位上下文\n${jobContext}`);
  if (candidateContext) parts.push(`\n## 候选人上下文\n${candidateContext}`);
  if (stateContext) parts.push(`\n## 当前分析状态\n${stateContext}`);
  return parts.join('\n');
}

/**
 * 构建 Critic 输入
 */
function buildCriticInput({ task, jobContext, candidateContext, stateContext, analystOutput, round }) {
  const parts = [
    `## 用户任务\n${task}`,
    `\n## 当前轮次\n第 ${round} 轮`,
    `\n## 本轮 Analyst 输出\n${JSON.stringify(analystOutput, null, 2)}`
  ];
  if (jobContext) parts.push(`\n## 岗位上下文\n${jobContext}`);
  if (candidateContext) parts.push(`\n## 候选人上下文\n${candidateContext}`);
  if (stateContext) parts.push(`\n## 当前分析状态\n${stateContext}`);
  return parts.join('\n');
}

module.exports = {
  runAnalystWithPrimary,
  runCriticWithSecondary
};
