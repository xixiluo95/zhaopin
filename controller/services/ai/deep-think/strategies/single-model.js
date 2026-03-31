/**
 * single-model.js - 单模型深度思考策略
 *
 * 使用同一个模型通过角色分工（Analyst → Critic → Summarizer）完成多轮分析。
 * 每轮只传递结构化状态和摘要，不回喂全文思考。
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
 * 执行单轮 Analyst 分析
 *
 * @param {Object} params
 * @param {Function} params.chatFn - LLM 调用函数 (messages) => Promise<{content}>
 * @param {Object} params.state - 当前状态
 * @param {string} params.jobContext - 岗位上下文
 * @param {string} params.candidateContext - 候选人上下文
 * @param {Object} params.logger - 日志实例
 * @returns {Promise<Object>} Analyst 结构化输出
 */
async function runAnalyst({ chatFn, state, jobContext, candidateContext, logger }) {
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

  logger.debug('analyst', `第 ${state.current_round} 轮 Analyst 输入构建完成`);

  const response = await chatFn(messages);
  const content = response.content || response.choices?.[0]?.message?.content || '';

  logger.debug('analyst', `Analyst 原始输出长度: ${content.length}`);

  return parseAnalystOutput(content);
}

/**
 * 执行单轮 Critic 审查
 *
 * @param {Object} params
 * @param {Function} params.chatFn - LLM 调用函数
 * @param {Object} params.state - 当前状态
 * @param {Object} params.analystOutput - 本轮 Analyst 输出
 * @param {string} params.jobContext - 岗位上下文
 * @param {string} params.candidateContext - 候选人上下文
 * @param {Object} params.logger - 日志实例
 * @returns {Promise<Object>} Critic 结构化输出
 */
async function runCritic({ chatFn, state, analystOutput, jobContext, candidateContext, logger }) {
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

  logger.debug('critic', `第 ${state.current_round} 轮 Critic 输入构建完成`);

  const response = await chatFn(messages);
  const content = response.content || response.choices?.[0]?.message?.content || '';

  logger.debug('critic', `Critic 原始输出长度: ${content.length}`);

  return parseCriticOutput(content);
}

/**
 * 构建 Analyst 输入文本
 */
function buildAnalystInput({ task, jobContext, candidateContext, stateContext, round }) {
  const parts = [
    `## 用户任务\n${task}`,
    `\n## 当前轮次\n第 ${round} 轮`
  ];

  if (jobContext) {
    parts.push(`\n## 岗位上下文\n${jobContext}`);
  }

  if (candidateContext) {
    parts.push(`\n## 候选人上下文\n${candidateContext}`);
  }

  if (stateContext) {
    parts.push(`\n## 当前分析状态\n${stateContext}`);
  }

  return parts.join('\n');
}

/**
 * 构建 Critic 输入文本
 */
function buildCriticInput({ task, jobContext, candidateContext, stateContext, analystOutput, round }) {
  const parts = [
    `## 用户任务\n${task}`,
    `\n## 当前轮次\n第 ${round} 轮`,
    `\n## 本轮 Analyst 输出\n${JSON.stringify(analystOutput, null, 2)}`
  ];

  if (jobContext) {
    parts.push(`\n## 岗位上下文\n${jobContext}`);
  }

  if (candidateContext) {
    parts.push(`\n## 候选人上下文\n${candidateContext}`);
  }

  if (stateContext) {
    parts.push(`\n## 当前分析状态\n${stateContext}`);
  }

  return parts.join('\n');
}

module.exports = {
  runAnalyst,
  runCritic
};
