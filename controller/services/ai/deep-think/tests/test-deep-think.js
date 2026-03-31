/**
 * test-deep-think.js - 深度思考模块测试
 *
 * 覆盖：config、schemas、state-manager、stop-conditions、parser、orchestrator
 * 运行: node controller/services/ai/deep-think/tests/test-deep-think.js
 */

const assert = require('assert');

// --- Config 测试 ---
const {
  resolveDeepThinkMode,
  mergeDeepThinkConfig,
  isSecondaryModelValid,
  validateDeepThinkConfig
} = require('../config');

function testConfigDefaults() {
  const config = mergeDeepThinkConfig({});
  assert.strictEqual(config.enabled, false);
  assert.strictEqual(config.mode, 'auto');
  assert.strictEqual(config.max_rounds, 10);
  assert.strictEqual(config.compression_enabled, true);
  console.log('  ✅ testConfigDefaults');
}

function testConfigMerge() {
  const config = mergeDeepThinkConfig({ mode: 'dual', max_rounds: 5 });
  assert.strictEqual(config.mode, 'dual');
  assert.strictEqual(config.max_rounds, 5);
  assert.strictEqual(config.compression_enabled, true);
  console.log('  ✅ testConfigMerge');
}

function testSecondaryModelValid() {
  assert.strictEqual(isSecondaryModelValid(null), false);
  assert.strictEqual(isSecondaryModelValid({}), false);
  assert.strictEqual(isSecondaryModelValid({ enabled: false, model: 'gpt-4', api_key: 'sk-xxx' }), false);
  assert.strictEqual(isSecondaryModelValid({ enabled: true, model: '', api_key: 'sk-xxx' }), false);
  assert.strictEqual(isSecondaryModelValid({ enabled: true, model: 'gpt-4', api_key: '' }), false);
  assert.strictEqual(isSecondaryModelValid({ enabled: true, model: 'gpt-4', api_key: 'sk-xxx' }), true);
  console.log('  ✅ testSecondaryModelValid');
}

function testResolveModeAuto() {
  const r1 = resolveDeepThinkMode({ mode: 'auto' }, null);
  assert.strictEqual(r1.mode, 'single');
  assert.strictEqual(r1.fallbackUsed, false);

  const r2 = resolveDeepThinkMode({ mode: 'auto' }, { enabled: true, model: 'gpt-4', api_key: 'sk-xxx' });
  assert.strictEqual(r2.mode, 'dual');
  console.log('  ✅ testResolveModeAuto');
}

function testResolveModeSingle() {
  const r = resolveDeepThinkMode({ mode: 'single' }, { enabled: true, model: 'gpt-4', api_key: 'sk-xxx' });
  assert.strictEqual(r.mode, 'single');
  console.log('  ✅ testResolveModeSingle');
}

function testResolveModeDualWithFallback() {
  const r = resolveDeepThinkMode(
    { mode: 'dual', fallback_to_single_when_secondary_missing: true },
    null
  );
  assert.strictEqual(r.mode, 'single');
  assert.strictEqual(r.fallbackUsed, true);
  console.log('  ✅ testResolveModeDualWithFallback');
}

function testResolveModeDualNoFallback() {
  try {
    resolveDeepThinkMode(
      { mode: 'dual', fallback_to_single_when_secondary_missing: false },
      null
    );
    assert.fail('应抛出错误');
  } catch (err) {
    assert.ok(err.message.includes('第二模型不可用'));
  }
  console.log('  ✅ testResolveModeDualNoFallback');
}

function testValidateConfig() {
  const v1 = validateDeepThinkConfig({ max_rounds: 5, mode: 'auto' });
  assert.strictEqual(v1.valid, true);

  const v2 = validateDeepThinkConfig({ max_rounds: 0 });
  assert.strictEqual(v2.valid, false);

  const v3 = validateDeepThinkConfig({ mode: 'invalid' });
  assert.strictEqual(v3.valid, false);
  console.log('  ✅ testValidateConfig');
}

// --- Schemas 测试 ---
const {
  createInitialState,
  createFact,
  createHypothesis,
  createVerifiedConclusion,
  createDeepThinkResult
} = require('../schemas');

function testCreateInitialState() {
  const state = createInitialState({ task: '测试任务', mode: 'single', maxRounds: 5 });
  assert.strictEqual(state.task, '测试任务');
  assert.strictEqual(state.mode, 'single');
  assert.strictEqual(state.max_rounds, 5);
  assert.strictEqual(state.current_round, 0);
  assert.strictEqual(state.status, 'running');
  assert.deepStrictEqual(state.facts, []);
  console.log('  ✅ testCreateInitialState');
}

function testCreateFactAndHypothesis() {
  const fact = createFact({ content: '候选人有 5 年经验', sourceType: 'resume', confidence: 0.9 });
  assert.ok(fact.id.startsWith('F'));
  assert.strictEqual(fact.content, '候选人有 5 年经验');
  assert.strictEqual(fact.confidence, 0.9);

  const hyp = createHypothesis({ content: '候选人适合该岗位', confidence: 0.6 });
  assert.ok(hyp.id.startsWith('H'));
  assert.strictEqual(hyp.status, 'candidate');
  console.log('  ✅ testCreateFactAndHypothesis');
}

function testDeepThinkResult() {
  const state = createInitialState({ task: '测试' });
  state.mode = 'single';
  state.current_round = 3;
  state.stop_reason = 'no_new_info';
  state.final_answer = '分析完成';

  const result = createDeepThinkResult(state);
  assert.strictEqual(result.mode_used, 'single');
  assert.strictEqual(result.rounds_used, 3);
  assert.strictEqual(result.stop_reason, 'no_new_info');
  assert.strictEqual(result.final_answer, '分析完成');
  console.log('  ✅ testDeepThinkResult');
}

// --- State Manager 测试 ---
const {
  mergeAnalystOutput,
  mergeCriticOutput,
  compressState
} = require('../state-manager');

function testMergeAnalystOutput() {
  const state = createInitialState({ task: '测试' });
  state.current_round = 1;

  const analystOutput = {
    facts_candidates: [{ content: '事实1', confidence: 0.8 }, '事实2'],
    new_hypotheses: [{ content: '假设1', confidence: 0.6 }],
    reasoning_summary: '本轮分析摘要',
    open_questions: ['问题1']
  };

  const updated = mergeAnalystOutput(state, analystOutput);
  assert.strictEqual(updated.facts.length, 2);
  assert.strictEqual(updated.hypotheses.length, 1);
  assert.strictEqual(updated.open_questions.length, 1);
  assert.strictEqual(updated.short_summary, '本轮分析摘要');
  console.log('  ✅ testMergeAnalystOutput');
}

function testMergeCriticOutput() {
  const state = createInitialState({ task: '测试' });
  state.current_round = 1;

  const fact = createFact({ content: '事实1' });
  fact.status = 'candidate';
  fact.round_added = 1;
  state.facts = [fact];

  const criticOutput = {
    criticisms: [{ issue: '证据不足', severity: 'medium' }],
    rejected_items: [],
    should_continue: true
  };

  const updated = mergeCriticOutput(state, criticOutput);
  assert.strictEqual(updated.critiques.length, 1);
  assert.strictEqual(updated.facts[0].status, 'accepted');
  console.log('  ✅ testMergeCriticOutput');
}

function testCompressState() {
  const state = createInitialState({ task: '测试' });
  state.current_round = 5;

  const acceptedFact = createFact({ content: 'accepted' });
  acceptedFact.status = 'accepted';
  const rejectedFact = createFact({ content: 'rejected' });
  rejectedFact.status = 'rejected';
  state.facts = [acceptedFact, rejectedFact];

  const activHyp = createHypothesis({ content: 'active' });
  activHyp.status = 'candidate';
  const promotedHyp = createHypothesis({ content: 'promoted' });
  promotedHyp.status = 'promoted';
  state.hypotheses = [activHyp, promotedHyp];

  const compressed = compressState(state);
  assert.strictEqual(compressed.facts.length, 1);
  assert.strictEqual(compressed.hypotheses.length, 1);
  console.log('  ✅ testCompressState');
}

// --- Stop Conditions 测试 ---
const { checkStopConditions } = require('../stop-conditions');

function testStopMaxRounds() {
  const state = createInitialState({ task: '测试', maxRounds: 3 });
  state.current_round = 3;
  state.round_history = [];

  const config = mergeDeepThinkConfig({ max_rounds: 3 });
  const result = checkStopConditions(state, config);
  assert.strictEqual(result.shouldStop, true);
  assert.strictEqual(result.reason, 'max_rounds_reached');
  console.log('  ✅ testStopMaxRounds');
}

function testStopStableConclusions() {
  const state = createInitialState({ task: '测试' });
  state.current_round = 2;
  state.round_history = [{ round: 1, verified_count: 2, facts_count: 3, open_questions_count: 0 }];
  state.verified_conclusions = [
    createVerifiedConclusion({ content: '1' }),
    createVerifiedConclusion({ content: '2' }),
    createVerifiedConclusion({ content: '3' })
  ];
  state.open_questions = [];

  const config = mergeDeepThinkConfig({});
  const result = checkStopConditions(state, config);
  assert.strictEqual(result.shouldStop, true);
  assert.strictEqual(result.reason, 'stable_conclusions');
  console.log('  ✅ testStopStableConclusions');
}

function testStopErrorThreshold() {
  const state = createInitialState({ task: '测试' });
  state.current_round = 1;
  state.round_history = [];

  const config = mergeDeepThinkConfig({});
  const result = checkStopConditions(state, config, { parseErrors: 3 });
  assert.strictEqual(result.shouldStop, true);
  assert.strictEqual(result.reason, 'error_threshold');
  console.log('  ✅ testStopErrorThreshold');
}

function testContinue() {
  const state = createInitialState({ task: '测试', maxRounds: 10 });
  state.current_round = 1;
  state.round_history = [];

  const config = mergeDeepThinkConfig({});
  const result = checkStopConditions(state, config);
  assert.strictEqual(result.shouldStop, false);
  console.log('  ✅ testContinue');
}

// --- Parser 测试 ---
const { extractJSON, parseAnalystOutput, parseCriticOutput } = require('../utils/parser');

function testExtractJSONDirect() {
  const r = extractJSON('{"key": "value"}');
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.data.key, 'value');
  console.log('  ✅ testExtractJSONDirect');
}

function testExtractJSONCodeBlock() {
  const r = extractJSON('一些文本\n```json\n{"key": "value"}\n```\n更多文本');
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.data.key, 'value');
  console.log('  ✅ testExtractJSONCodeBlock');
}

function testExtractJSONWithTrailingComma() {
  const r = extractJSON('{"items": [1, 2, 3,], "key": "value",}');
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.data.key, 'value');
  console.log('  ✅ testExtractJSONWithTrailingComma');
}

function testExtractJSONEmpty() {
  const r = extractJSON('');
  assert.strictEqual(r.success, false);
  console.log('  ✅ testExtractJSONEmpty');
}

function testParseAnalystFallback() {
  const result = parseAnalystOutput('这不是 JSON，只是普通文本');
  assert.strictEqual(result.reasoning_summary, '这不是 JSON，只是普通文本');
  assert.deepStrictEqual(result.facts_candidates, []);
  console.log('  ✅ testParseAnalystFallback');
}

function testParseCriticValid() {
  const input = JSON.stringify({
    criticisms: [{ issue: '证据不足', severity: 'high' }],
    weak_points: ['分析不够深入'],
    rejected_items: [],
    should_continue: false,
    suggested_stop_reason: '分析已充分'
  });
  const result = parseCriticOutput(input);
  assert.strictEqual(result.criticisms.length, 1);
  assert.strictEqual(result.should_continue, false);
  console.log('  ✅ testParseCriticValid');
}

// --- Compressor 测试 ---
const { compressStateToContext, needsCompression } = require('../utils/compressor');

function testCompressStateToContext() {
  const state = createInitialState({ task: '测试' });
  state.verified_conclusions = [createVerifiedConclusion({ content: '结论1', confidence: 0.9 })];
  const fact = createFact({ content: '事实1' });
  fact.status = 'accepted';
  state.facts = [fact];
  state.short_summary = '测试摘要';

  const context = compressStateToContext(state);
  assert.ok(context.includes('已验证结论'));
  assert.ok(context.includes('结论1'));
  assert.ok(context.includes('事实1'));
  assert.ok(context.includes('测试摘要'));
  console.log('  ✅ testCompressStateToContext');
}

function testNeedsCompression() {
  const small = createInitialState({ task: '小任务' });
  assert.strictEqual(needsCompression(small), false);
  console.log('  ✅ testNeedsCompression');
}

// --- Logger 测试 ---
const { createDeepThinkLogger, sanitizeLogData } = require('../utils/logger');

function testLoggerSanitize() {
  const sanitized = sanitizeLogData({ api_key: 'sk-secret', name: '测试' });
  assert.strictEqual(sanitized.api_key, '***REDACTED***');
  assert.strictEqual(sanitized.name, '测试');
  console.log('  ✅ testLoggerSanitize');
}

function testLoggerBasic() {
  const logger = createDeepThinkLogger({ debug: false, traceId: 'test-001' });
  logger.info('test', '测试信息');
  logger.warn('test', '测试警告');
  logger.error('test', '测试错误');
  logger.roundStart(1, 'single');
  logger.roundEnd(1, { newFacts: 2 });
  logger.fallback('dual', 'single', '测试回退');
  logger.stop('max_rounds_reached', 5);

  const logs = logger.getLogs();
  assert.ok(logs.length >= 6);
  assert.strictEqual(logger.traceId, 'test-001');
  console.log('  ✅ testLoggerBasic');
}

// --- Orchestrator 集成测试（Mock LLM）---
const { runDeepThink } = require('../orchestrator');

async function testOrchestratorSingleMode() {
  let callCount = 0;

  function createMockChatFn() {
    return async (messages) => {
      callCount++;
      const systemContent = messages[0]?.content || '';

      if (systemContent.includes('分析师') || systemContent.includes('Analyst')) {
        return {
          content: JSON.stringify({
            facts_candidates: [{ content: `事实-${callCount}`, confidence: 0.8 }],
            new_hypotheses: [{ content: `假设-${callCount}`, confidence: 0.7 }],
            reasoning_summary: `第 ${callCount} 轮分析完成`,
            open_questions: [],
            proposed_next_actions: [],
            confidence: 0.75
          })
        };
      }

      if (systemContent.includes('审查') || systemContent.includes('Critic')) {
        return {
          content: JSON.stringify({
            criticisms: [],
            weak_points: [],
            rejected_items: [],
            should_continue: callCount < 6,
            suggested_stop_reason: callCount >= 6 ? '分析已充分' : ''
          })
        };
      }

      if (systemContent.includes('总结') || systemContent.includes('Summarizer')) {
        return {
          content: JSON.stringify({
            short_summary: '测试摘要',
            verified_conclusions: [{ content: '测试结论', confidence: 0.9 }],
            open_questions: [],
            final_report: '## 测试报告\n分析完成。'
          })
        };
      }

      return { content: '默认响应' };
    };
  }

  const result = await runDeepThink({
    task: '分析候选人与岗位匹配度',
    jobContext: '高级产品经理，要求 5 年经验',
    candidateContext: '张三，产品经理，6 年经验',
    primaryModelConfig: { provider: 'mock', apiKey: 'test', baseURL: '', model: 'mock' },
    deepThinkConfig: { mode: 'single', max_rounds: 5, debug: false },
    createChatFn: () => createMockChatFn()
  });

  assert.strictEqual(result.mode_used, 'single');
  assert.ok(result.rounds_used > 0);
  assert.ok(result.rounds_used <= 5);
  assert.ok(result.stop_reason);
  assert.ok(result.final_answer);
  console.log(`  ✅ testOrchestratorSingleMode (${result.rounds_used} 轮, 停止: ${result.stop_reason})`);
}

async function testOrchestratorAutoFallback() {
  function createMockChatFn() {
    return async () => ({
      content: JSON.stringify({
        facts_candidates: [{ content: '事实', confidence: 0.9 }],
        new_hypotheses: [],
        reasoning_summary: '分析',
        open_questions: [],
        criticisms: [],
        weak_points: [],
        rejected_items: [],
        should_continue: false,
        suggested_stop_reason: '已完成',
        short_summary: '摘要',
        verified_conclusions: [{ content: '结论', confidence: 0.9 }],
        final_report: '报告'
      })
    });
  }

  const result = await runDeepThink({
    task: '测试 auto fallback',
    primaryModelConfig: { provider: 'mock', apiKey: 'test', baseURL: '', model: 'mock' },
    secondaryModelConfig: null,
    deepThinkConfig: { mode: 'auto', max_rounds: 3, debug: false },
    createChatFn: () => createMockChatFn()
  });

  assert.strictEqual(result.mode_used, 'single');
  console.log('  ✅ testOrchestratorAutoFallback');
}

// --- 运行所有测试 ---
async function runAllTests() {
  console.log('\n🧪 深度思考模块测试\n');

  console.log('📋 Config 测试:');
  testConfigDefaults();
  testConfigMerge();
  testSecondaryModelValid();
  testResolveModeAuto();
  testResolveModeSingle();
  testResolveModeDualWithFallback();
  testResolveModeDualNoFallback();
  testValidateConfig();

  console.log('\n📋 Schemas 测试:');
  testCreateInitialState();
  testCreateFactAndHypothesis();
  testDeepThinkResult();

  console.log('\n📋 State Manager 测试:');
  testMergeAnalystOutput();
  testMergeCriticOutput();
  testCompressState();

  console.log('\n📋 Stop Conditions 测试:');
  testStopMaxRounds();
  testStopStableConclusions();
  testStopErrorThreshold();
  testContinue();

  console.log('\n📋 Parser 测试:');
  testExtractJSONDirect();
  testExtractJSONCodeBlock();
  testExtractJSONWithTrailingComma();
  testExtractJSONEmpty();
  testParseAnalystFallback();
  testParseCriticValid();

  console.log('\n📋 Compressor 测试:');
  testCompressStateToContext();
  testNeedsCompression();

  console.log('\n📋 Logger 测试:');
  testLoggerSanitize();
  testLoggerBasic();

  console.log('\n📋 Orchestrator 集成测试:');
  await testOrchestratorSingleMode();
  await testOrchestratorAutoFallback();

  console.log('\n✅ 全部测试通过!\n');
}

runAllTests().catch(err => {
  console.error('\n❌ 测试失败:', err);
  process.exit(1);
});
