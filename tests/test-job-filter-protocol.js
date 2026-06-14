/**
 * test-job-filter.js - 统一过滤协议单元测试
 *
 * 覆盖范围：
 * 1. parseExperienceYears 增强版
 * 2. deriveExperienceLabel 映射
 * 3. normalizeExperienceFields
 * 4. criteria 校验
 * 5. preview/apply/undo 基本流程
 * 6. verifier
 */

const assert = require('assert');
const path = require('path');

// 设置测试数据库路径
process.env.ZHAOPIN_DB_PATH = path.join(__dirname, '_test_filter.db');

const protocol = require('../controller/services/job-filter-protocol');
const executor = require('../controller/services/job-filter-executor');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

console.log('\n=== parseExperienceYears 测试 ===');

test('经验不限 -> { min: 0, max: null }', () => {
  const r = protocol.parseExperienceYears('经验不限');
  assert.deepStrictEqual(r, { min: 0, max: null });
});

test('无需经验 -> { min: 0, max: null }', () => {
  const r = protocol.parseExperienceYears('无需经验');
  assert.deepStrictEqual(r, { min: 0, max: null });
});

test('不限经验 -> { min: 0, max: null }', () => {
  const r = protocol.parseExperienceYears('不限经验');
  assert.deepStrictEqual(r, { min: 0, max: null });
});

test('应届 -> { min: 0, max: 0 }', () => {
  const r = protocol.parseExperienceYears('应届');
  assert.deepStrictEqual(r, { min: 0, max: 0 });
});

test('应届生 -> { min: 0, max: 0 }', () => {
  const r = protocol.parseExperienceYears('应届生');
  assert.deepStrictEqual(r, { min: 0, max: 0 });
});

test('校招 -> { min: 0, max: 0 }', () => {
  const r = protocol.parseExperienceYears('校招');
  assert.deepStrictEqual(r, { min: 0, max: 0 });
});

test('实习 -> { min: 0, max: 0 }', () => {
  const r = protocol.parseExperienceYears('实习');
  assert.deepStrictEqual(r, { min: 0, max: 0 });
});

test('在校 -> { min: 0, max: 0 }', () => {
  const r = protocol.parseExperienceYears('在校');
  assert.deepStrictEqual(r, { min: 0, max: 0 });
});

test('1-3年 -> { min: 1, max: 3 }', () => {
  const r = protocol.parseExperienceYears('1-3年');
  assert.deepStrictEqual(r, { min: 1, max: 3 });
});

test('1~3年 -> { min: 1, max: 3 }', () => {
  const r = protocol.parseExperienceYears('1~3年');
  assert.deepStrictEqual(r, { min: 1, max: 3 });
});

test('1 至 3 年 -> { min: 1, max: 3 }', () => {
  const r = protocol.parseExperienceYears('1 至 3 年');
  assert.deepStrictEqual(r, { min: 1, max: 3 });
});

test('1到3年 -> { min: 1, max: 3 }', () => {
  const r = protocol.parseExperienceYears('1到3年');
  assert.deepStrictEqual(r, { min: 1, max: 3 });
});

test('3年以上 -> { min: 3, max: null }', () => {
  const r = protocol.parseExperienceYears('3年以上');
  assert.deepStrictEqual(r, { min: 3, max: null });
});

test('3年及以上 -> { min: 3, max: null }', () => {
  const r = protocol.parseExperienceYears('3年及以上');
  assert.deepStrictEqual(r, { min: 3, max: null });
});

test('3年起 -> { min: 3, max: null }', () => {
  const r = protocol.parseExperienceYears('3年起');
  assert.deepStrictEqual(r, { min: 3, max: null });
});

test('3年以下 -> { min: 0, max: 3 }', () => {
  const r = protocol.parseExperienceYears('3年以下');
  assert.deepStrictEqual(r, { min: 0, max: 3 });
});

test('3年以内 -> { min: 0, max: 3 }', () => {
  const r = protocol.parseExperienceYears('3年以内');
  assert.deepStrictEqual(r, { min: 0, max: 3 });
});

test('3年及以下 -> { min: 0, max: 3 }', () => {
  const r = protocol.parseExperienceYears('3年及以下');
  assert.deepStrictEqual(r, { min: 0, max: 3 });
});

test('3年 -> { min: 3, max: 3 }', () => {
  const r = protocol.parseExperienceYears('3年');
  assert.deepStrictEqual(r, { min: 3, max: 3 });
});

test('空字符串 -> null', () => {
  assert.strictEqual(protocol.parseExperienceYears(''), null);
});

test('null -> null', () => {
  assert.strictEqual(protocol.parseExperienceYears(null), null);
});

console.log('\n=== deriveExperienceLabel 测试 ===');

test('实习 -> intern', () => {
  assert.strictEqual(protocol.deriveExperienceLabel({ min: 0, max: 0 }, '实习'), 'intern');
});

test('应届 -> fresh', () => {
  assert.strictEqual(protocol.deriveExperienceLabel({ min: 0, max: 0 }, '应届'), 'fresh');
});

test('parsed=null -> unknown', () => {
  assert.strictEqual(protocol.deriveExperienceLabel(null, '某些文本'), 'unknown');
});

test('max=0 -> fresh', () => {
  assert.strictEqual(protocol.deriveExperienceLabel({ min: 0, max: 0 }, '0年'), 'fresh');
});

test('max=2 -> junior', () => {
  assert.strictEqual(protocol.deriveExperienceLabel({ min: 1, max: 2 }, '1-2年'), 'junior');
});

test('min=3,max=5 -> mid', () => {
  assert.strictEqual(protocol.deriveExperienceLabel({ min: 3, max: 5 }, '3-5年'), 'mid');
});

test('min=5,max=10 -> senior', () => {
  assert.strictEqual(protocol.deriveExperienceLabel({ min: 5, max: 10 }, '5-10年'), 'senior');
});

test('min=10,max=15 -> expert', () => {
  assert.strictEqual(protocol.deriveExperienceLabel({ min: 10, max: 15 }, '10-15年'), 'expert');
});

test('min=8,max=null -> expert', () => {
  assert.strictEqual(protocol.deriveExperienceLabel({ min: 8, max: null }, '8年以上'), 'expert');
});

test('min=3,max=null -> unknown', () => {
  assert.strictEqual(protocol.deriveExperienceLabel({ min: 3, max: null }, '3年以上'), 'unknown');
});

console.log('\n=== normalizeExperienceFields 测试 ===');

test('3-5年 -> { raw, min:3, max:5, label:mid }', () => {
  const r = protocol.normalizeExperienceFields('3-5年');
  assert.strictEqual(r.experience_raw, '3-5年');
  assert.strictEqual(r.experience_min, 3);
  assert.strictEqual(r.experience_max, 5);
  assert.strictEqual(r.experience_label, 'mid');
});

test('null -> { raw:null, min:null, max:null, label:unknown }', () => {
  const r = protocol.normalizeExperienceFields(null);
  assert.strictEqual(r.experience_raw, null);
  assert.strictEqual(r.experience_min, null);
  assert.strictEqual(r.experience_max, null);
  assert.strictEqual(r.experience_label, 'unknown');
});

console.log('\n=== validateCriteria 测试 ===');

test('有效 criteria 通过校验', () => {
  const r = protocol.validateCriteria({
    experience: { include_ranges: ['1-3年'] },
    include_keywords: ['产品经理'],
    exclude_keywords: ['外包'],
    exclude_outsourcing: true,
  });
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.criteria.include_keywords.length, 1);
});

test('空 criteria 通过校验', () => {
  const r = protocol.validateCriteria({});
  assert.strictEqual(r.valid, true);
});

test('关键词超过 20 个拒绝', () => {
  const keywords = Array(21).fill('测试');
  const r = protocol.validateCriteria({ include_keywords: keywords });
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors[0].includes('最多 20'));
});

test('单个关键词超过 40 字拒绝', () => {
  const longKeyword = '测试'.repeat(30);
  const r = protocol.validateCriteria({ include_keywords: [longKeyword] });
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors[0].includes('最长 40'));
});

console.log('\n=== validateFilterRequest 测试 ===');

test('scope=all 被 MVP 拒绝', () => {
  const r = protocol.validateFilterRequest({ scope: 'all', criteria: {} });
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors[0].includes("scope='favorites'"));
});

test('scope=favorites 通过', () => {
  const r = protocol.validateFilterRequest({ scope: 'favorites', criteria: {} });
  assert.strictEqual(r.valid, true);
});

test('非法 action 被拒绝', () => {
  const r = protocol.validateFilterRequest({ scope: 'favorites', criteria: {}, action: 'delete_all' });
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors[0].includes("keep_only"));
});

console.log('\n=== executor matchJob 测试 ===');

test('排除外包', () => {
  const r = executor.matchJob(
    { title: 'Java开发', company: '某某外包公司', keywords: '' },
    { exclude_outsourcing: true }
  );
  assert.strictEqual(r.matched, false);
  assert.ok(r.reason.includes('外包'));
});

test('包含关键词匹配', () => {
  const r = executor.matchJob(
    { title: '产品经理', company: '某公司', keywords: '' },
    { include_keywords: ['产品经理', 'AI'] }
  );
  assert.strictEqual(r.matched, true);
});

test('包含关键词不匹配', () => {
  const r = executor.matchJob(
    { title: 'Java开发', company: '某公司', keywords: '' },
    { include_keywords: ['产品经理', 'AI'] }
  );
  assert.strictEqual(r.matched, false);
});

test('排除关键词匹配', () => {
  const r = executor.matchJob(
    { title: 'Java开发', company: '某公司', keywords: '外包' },
    { exclude_keywords: ['外包'] }
  );
  assert.strictEqual(r.matched, false);
});

test('经验范围排除', () => {
  const r = executor.matchJob(
    { title: '高级开发', company: '某公司', keywords: '', experience: '5-10年', experience_min: 5, experience_max: 10 },
    { experience: { exclude_ranges: ['5-10年'] } }
  );
  assert.strictEqual(r.matched, false);
});

test('经验范围包含', () => {
  const r = executor.matchJob(
    { title: '中级开发', company: '某公司', keywords: '', experience: '3-5年', experience_min: 3, experience_max: 5 },
    { experience: { include_ranges: ['1-3年', '3-5年'] } }
  );
  assert.strictEqual(r.matched, true);
});

test('经验范围不包含', () => {
  const r = executor.matchJob(
    { title: '高级开发', company: '某公司', keywords: '', experience: '5-10年', experience_min: 5, experience_max: 10 },
    { experience: { include_ranges: ['1-3年'] } }
  );
  assert.strictEqual(r.matched, false);
});

console.log('\n=== isExperienceOverlap 测试 ===');

test('[1,3] 和 [2,5] 有重叠', () => {
  assert.strictEqual(executor.isExperienceOverlap({ min: 1, max: 3 }, { min: 2, max: 5 }), true);
});

test('[1,3] 和 [4,6] 无重叠', () => {
  assert.strictEqual(executor.isExperienceOverlap({ min: 1, max: 3 }, { min: 4, max: 6 }), false);
});

test('[5,null] 和 [3,5] 有重叠', () => {
  assert.strictEqual(executor.isExperienceOverlap({ min: 5, max: null }, { min: 3, max: 5 }), true);
});

test('[0,null] 和 [1,3] 有重叠', () => {
  assert.strictEqual(executor.isExperienceOverlap({ min: 0, max: null }, { min: 1, max: 3 }), true);
});

console.log('\n=== verifier 测试 ===');

test('keep_only 验证通过', () => {
  const r = executor.verifyAfterApply('keep_only', [1, 2, 3], [1, 2], [3], [1, 2]);
  assert.strictEqual(r.ok, true);
});

test('keep_only 验证失败 - 意外 ID', () => {
  const r = executor.verifyAfterApply('keep_only', [1, 2, 3], [1, 2], [3], [1, 2, 4]);
  assert.strictEqual(r.ok, false);
});

test('keep_only 验证失败 - 泄漏 ID', () => {
  const r = executor.verifyAfterApply('keep_only', [1, 2, 3], [1, 2], [3], [1, 2, 3]);
  assert.strictEqual(r.ok, false);
});

test('exclude 验证通过', () => {
  const r = executor.verifyAfterApply('exclude', [1, 2, 3], [1], [1], [2, 3]);
  assert.strictEqual(r.ok, true);
});

test('exclude 验证失败 - 泄漏 ID', () => {
  const r = executor.verifyAfterApply('exclude', [1, 2, 3], [1], [1], [1, 2, 3]);
  assert.strictEqual(r.ok, false);
});

console.log('\n=== assertVerified 测试 ===');

test('assertVerified 成功时不抛异常', () => {
  executor.assertVerified({ ok: true });
});

test('assertVerified 失败时抛 VERIFY_FAILED', () => {
  assert.throws(() => {
    executor.assertVerified({ ok: false, message: 'test fail' });
  }, { code: 'VERIFY_FAILED' });
});

console.log('\n=== preview 功能测试 ===');

test('preview 正常返回结构', () => {
  const r = executor.previewJobFilter({
    scope: 'favorites',
    criteria: { exclude_outsourcing: true },
  });
  assert.strictEqual(r.success, true);
  assert.ok(typeof r.total === 'number');
  assert.ok(r.preview_id);
  assert.ok(r.expires_at);
  assert.ok(Array.isArray(r.matched_ids));
  assert.ok(Array.isArray(r.excluded));
});

test('preview 无效 criteria 失败', () => {
  const r = executor.previewJobFilter({
    scope: 'all',
    criteria: {},
  });
  assert.strictEqual(r.success, false);
});

console.log('\n=== confirmationToken 测试 ===');

test('有效 token 格式通过', () => {
  const token = executor.generateConfirmationToken('fp_test');
  assert.ok(token.startsWith('confirm_'));
  assert.ok(token.length > 20);
});

console.log(`\n========================================`);
console.log(`测试结果: ${passed} 通过, ${failed} 失败`);
console.log(`========================================\n`);

// 清理测试数据库
const fs = require('fs');
try {
  if (fs.existsSync(process.env.ZHAOPIN_DB_PATH)) {
    fs.unlinkSync(process.env.ZHAOPIN_DB_PATH);
  }
  const walPath = process.env.ZHAOPIN_DB_PATH + '-wal';
  if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
  const shmPath = process.env.ZHAOPIN_DB_PATH + '-shm';
  if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
} catch {}

process.exit(failed > 0 ? 1 : 0);
