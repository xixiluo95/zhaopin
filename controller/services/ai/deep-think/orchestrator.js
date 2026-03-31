/**
 * orchestrator.js - 深度思考核心调度器
 *
 * 控制整个多轮深度思考过程。
 * 流程：初始化 → 循环（Analyst → Critic → 状态更新 → 压缩 → 停止判断）→ Summarizer → 输出
 */

const fs = require('fs');
const path = require('path');
const { createInitialState, createDeepThinkResult } = require('./schemas');
const { resolveDeepThinkMode, mergeDeepThinkConfig } = require('./config');
const {
  mergeAnalystOutput,
  mergeCriticOutput,
  applySummarizerLogic,
  recordRoundSnapshot,
  compressState
} = require('./state-manager');
const { checkStopConditions, calculateRoundMetrics } = require('./stop-conditions');
const { runAnalyst, runCritic } = require('./strategies/single-model');
const { runAnalystWithPrimary, runCriticWithSecondary } = require('./strategies/dual-model');
const { parseSummarizerOutput } = require('./utils/parser');
const { needsCompression, compressStateToContext } = require('./utils/compressor');
const { createDeepThinkLogger } = require('./utils/logger');

const SUMMARIZER_PROMPT = fs.readFileSync(
  path.join(__dirname, 'prompts/summarizer.txt'), 'utf8'
);

/**
 * 运行深度思考引擎
 *
 * @param {Object} params
 * @param {string} params.task - 用户问题/任务
 * @param {string} [params.jobContext] - 岗位上下文
 * @param {string} [params.candidateContext] - 候选人上下文
 * @param {Object} params.primaryModelConfig - 主模型配置
 * @param {Object} [params.secondaryModelConfig] - 第二模型配置（可选）
 * @param {Object} [params.deepThinkConfig] - 深度思考配置
 * @param {Function} params.createChatFn - 创建 chat 函数的工厂 (config) => (messages) => Promise<{content}>
 * @param {Function} [params.onRoundComplete] - 每轮完成回调（用于流式通知前端）
 * @returns {Promise<Object>} 深度思考结果
 */
async function runDeepThink({
  task,
  jobContext = '',
  candidateContext = '',
  primaryModelConfig,
  secondaryModelConfig,
  deepThinkConfig = {},
  createChatFn,
  onRoundComplete
}) {
  const config = mergeDeepThinkConfig(deepThinkConfig);
  const logger = createDeepThinkLogger({
    debug: config.debug,
    traceId: `dt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  });

  // 1. 解析运行模式
  let modeResult;
  try {
    modeResult = resolveDeepThinkMode(config, secondaryModelConfig);
  } catch (err) {
    logger.error('init', `模式解析失败: ${err.message}`);
    return {
      mode_used: 'error',
      rounds_used: 0,
      stop_reason: 'config_error',
      final_answer: `深度思考配置错误: ${err.message}`,
      state: {},
      logs: logger.getLogs()
    };
  }

  const { mode, fallbackUsed, reason } = modeResult;
  logger.info('init', `运行模式: ${mode}`, { fallbackUsed, reason });

  if (fallbackUsed) {
    logger.fallback('dual', 'single', reason);
  }

  // 2. 创建 LLM 客户端
  const primaryChatFn = createChatFn(primaryModelConfig);
  let secondaryChatFn = null;

  if (mode === 'dual' && secondaryModelConfig) {
    try {
      secondaryChatFn = createChatFn(secondaryModelConfig);
      logger.info('init', '第二模型客户端创建成功');
    } catch (err) {
      logger.warn('init', `第二模型客户端创建失败，回退到 single: ${err.message}`);
      modeResult.mode = 'single';
    }
  }

  // 3. 初始化状态
  const state = createInitialState({
    task,
    mode: modeResult.mode,
    maxRounds: config.max_rounds
  });

  let currentState = state;
  const roundMetrics = { parseErrors: 0, apiErrors: 0 };

  logger.info('init', `深度思考开始`, {
    task: task.slice(0, 100),
    mode: modeResult.mode,
    maxRounds: config.max_rounds
  });

  // 4. 多轮循环
  while (currentState.status === 'running') {
    currentState.current_round += 1;
    logger.roundStart(currentState.current_round, modeResult.mode);

    const prevState = { ...currentState };
    let analystOutput, criticOutput;

    // Step 1-2: Analyst 执行
    try {
      if (modeResult.mode === 'dual' && secondaryChatFn) {
        analystOutput = await runAnalystWithPrimary({
          primaryChatFn,
          state: currentState,
          jobContext,
          candidateContext,
          logger
        });
      } else {
        analystOutput = await runAnalyst({
          chatFn: primaryChatFn,
          state: currentState,
          jobContext,
          candidateContext,
          logger
        });
      }
    } catch (err) {
      roundMetrics.apiErrors += 1;
      logger.error('analyst', `Analyst 执行失败: ${err.message}`, { error: err.message });

      // 检查是否达到错误阈值
      const stopCheck = checkStopConditions(currentState, config, roundMetrics);
      if (stopCheck.shouldStop) {
        currentState.status = 'stopped';
        currentState.stop_reason = stopCheck.reason;
        logger.stop(stopCheck.reason, currentState.current_round);
        break;
      }
      continue;
    }

    // Step 3: 合并 Analyst 输出到状态
    currentState = mergeAnalystOutput(currentState, analystOutput);

    // Step 4: Critic 执行
    try {
      if (modeResult.mode === 'dual' && secondaryChatFn) {
        criticOutput = await runCriticWithSecondary({
          secondaryChatFn,
          state: currentState,
          analystOutput,
          jobContext,
          candidateContext,
          logger
        });
      } else {
        criticOutput = await runCritic({
          chatFn: primaryChatFn,
          state: currentState,
          analystOutput,
          jobContext,
          candidateContext,
          logger
        });
      }
    } catch (err) {
      roundMetrics.apiErrors += 1;
      logger.error('critic', `Critic 执行失败: ${err.message}`, { error: err.message });

      const stopCheck = checkStopConditions(currentState, config, roundMetrics);
      if (stopCheck.shouldStop) {
        currentState.status = 'stopped';
        currentState.stop_reason = stopCheck.reason;
        logger.stop(stopCheck.reason, currentState.current_round);
        break;
      }
      continue;
    }

    // Step 5: 合并 Critic 输出到状态
    currentState = mergeCriticOutput(currentState, criticOutput);

    // Step 6: Summarizer 逻辑（规则引擎）
    currentState = applySummarizerLogic(currentState);

    // Step 7: 记录轮次快照
    currentState = recordRoundSnapshot(currentState);

    // Step 8: 压缩（如需要）
    if (config.compression_enabled && needsCompression(currentState)) {
      currentState = compressState(currentState);
      logger.debug('compress', '状态压缩完成');
    }

    // 计算轮次指标
    const metrics = calculateRoundMetrics(prevState, currentState, criticOutput);
    metrics.parseErrors = roundMetrics.parseErrors;
    metrics.apiErrors = roundMetrics.apiErrors;

    logger.roundEnd(currentState.current_round, {
      newFacts: metrics.newFactsCount,
      newConclusions: metrics.newConclusionsCount,
      criticSuggestsStop: metrics.criticSuggestsStop
    });

    // 回调通知（流式前端更新）
    if (onRoundComplete) {
      try {
        await onRoundComplete({
          round: currentState.current_round,
          mode: modeResult.mode,
          state: {
            facts_count: currentState.facts.length,
            hypotheses_count: currentState.hypotheses.length,
            conclusions_count: currentState.verified_conclusions.length,
            open_questions_count: currentState.open_questions.filter(q => q.status === 'open').length,
            summary: currentState.short_summary
          },
          analystOutput,
          criticOutput
        });
      } catch (_) { /* 回调失败不影响主流程 */ }
    }

    // Step 9: 停止判断
    const stopCheck = checkStopConditions(currentState, config, metrics);
    if (stopCheck.shouldStop) {
      currentState.status = 'stopped';
      currentState.stop_reason = stopCheck.reason;
      logger.stop(stopCheck.reason, currentState.current_round);
      break;
    }
  }

  // 5. 最终 Summarizer
  try {
    const finalAnswer = await runFinalSummarizer({
      chatFn: primaryChatFn,
      state: currentState,
      logger
    });
    currentState.final_answer = finalAnswer;
  } catch (err) {
    logger.error('summarizer', `最终总结失败: ${err.message}`);
    currentState.final_answer = generateFallbackAnswer(currentState);
  }

  // 6. 保存 trace
  logger.saveTrace(currentState);

  // 7. 返回结果
  return createDeepThinkResult(currentState);
}

/**
 * 运行最终 Summarizer
 */
async function runFinalSummarizer({ chatFn, state, logger }) {
  const stateContext = compressStateToContext(state, { maxLength: 4000 });

  const messages = [
    { role: 'system', content: SUMMARIZER_PROMPT },
    {
      role: 'user',
      content: [
        `## 用户任务\n${state.task}`,
        `\n## 分析状态\n${stateContext}`,
        `\n## 已完成轮次: ${state.current_round}`,
        `\n## 停止原因: ${state.stop_reason}`,
        '\n请生成最终报告。'
      ].join('\n')
    }
  ];

  logger.debug('summarizer', '最终 Summarizer 输入构建完成');

  const response = await chatFn(messages);
  const content = response.content || response.choices?.[0]?.message?.content || '';

  const parsed = parseSummarizerOutput(content);

  // 如果有 final_report 字段，优先使用
  if (parsed.final_report) {
    return parsed.final_report;
  }

  // 否则用 short_summary + verified_conclusions 组合
  const parts = [];
  if (parsed.short_summary) {
    parts.push(parsed.short_summary);
  }
  if (parsed.verified_conclusions?.length) {
    parts.push('\n### 关键结论');
    for (const vc of parsed.verified_conclusions) {
      const text = typeof vc === 'string' ? vc : vc.content;
      parts.push(`- ${text}`);
    }
  }
  if (parsed.open_questions?.length) {
    parts.push('\n### 待进一步探讨');
    for (const q of parsed.open_questions) {
      const text = typeof q === 'string' ? q : q.content;
      parts.push(`- ${text}`);
    }
  }

  return parts.join('\n') || content;
}

/**
 * 降级回答：当 Summarizer 失败时使用
 */
function generateFallbackAnswer(state) {
  const parts = ['## 深度思考分析结果\n'];

  if (state.verified_conclusions.length > 0) {
    parts.push('### 已验证结论');
    for (const vc of state.verified_conclusions) {
      parts.push(`- ${vc.content}`);
    }
  }

  if (state.short_summary) {
    parts.push(`\n### 分析摘要\n${state.short_summary}`);
  }

  const openQuestions = state.open_questions.filter(q => q.status === 'open');
  if (openQuestions.length > 0) {
    parts.push('\n### 待验证问题');
    for (const q of openQuestions) {
      parts.push(`- ${q.content}`);
    }
  }

  parts.push(`\n---\n*共 ${state.current_round} 轮分析，停止原因: ${state.stop_reason}*`);

  return parts.join('\n');
}

module.exports = {
  runDeepThink
};
