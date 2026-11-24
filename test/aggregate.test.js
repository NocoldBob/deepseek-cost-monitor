'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  createDayAgg,
  addRecord,
  buildDayAgg,
  dayAggToDays,
  daysToDayAgg,
  dayTotals
} = require('../src/aggregate');
const { dateKeyOfMs } = require('../src/pricing');

const HOLIDAYS = new Set(['2026-10-01']);
// 2026-11-24 是周二；10:00 高峰、12:30 低谷、2026-11-22 周日。
const AT = {
  tuePeak: Date.parse('2026-11-24T10:00:00+08:00'),
  tueLunch: Date.parse('2026-11-24T12:30:00+08:00'),
  sunday: Date.parse('2026-11-22T10:00:00+08:00'),
  holiday: Date.parse('2026-10-01T10:00:00+08:00')
};
const NOW = Date.parse('2026-11-24T20:00:00+08:00');

function record(overrides) {
  return {
    messageId: 'm1',
    timestampMs: AT.tuePeak,
    model: 'deepseek-flash',
    normalizedModel: 'deepseek-flash',
    isSubagent: false,
    inputTokens: 1200,
    cacheReadTokens: 3400,
    cacheCreationTokens: 100,
    outputTokens: 800,
    ...overrides
  };
}

function view(agg, dateKey, model, kind, variant) {
  const day = agg.days.get(dateKey);
  return day.models.get(model)[kind][variant];
}

test('按时间戳分峰谷桶：高峰 / 午间 / 周日 / 节假日', () => {
  const agg = createDayAgg();
  const ctx = { holidays: HOLIDAYS, nowMs: NOW, dateKeyOf: dateKeyOfMs };
  addRecord(agg, record({ messageId: 'a', timestampMs: AT.tuePeak }), ctx);
  addRecord(agg, record({ messageId: 'b', timestampMs: AT.tueLunch }), ctx);
  addRecord(agg, record({ messageId: 'c', timestampMs: AT.sunday }), ctx);
  addRecord(agg, record({ messageId: 'd', timestampMs: AT.holiday }), ctx);

  assert.strictEqual(view(agg, '2026-11-24', 'deepseek-flash', 'main', 'peak').requests, 1);
  assert.strictEqual(view(agg, '2026-11-24', 'deepseek-flash', 'main', 'offpeak').requests, 1);
  assert.strictEqual(view(agg, '2026-11-22', 'deepseek-flash', 'main', 'offpeak').requests, 1);
  assert.strictEqual(view(agg, '2026-10-01', 'deepseek-flash', 'main', 'peak').requests, 0);
  assert.strictEqual(view(agg, '2026-10-01', 'deepseek-flash', 'main', 'offpeak').requests, 1);
});

test('token 按桶累加，字段映射正确', () => {
  const agg = createDayAgg();
  const ctx = { holidays: HOLIDAYS, nowMs: NOW };
  addRecord(agg, record({ messageId: 'a' }), ctx);
  addRecord(agg, record({ messageId: 'b' }), ctx);
  const bucket = view(agg, '2026-11-24', 'deepseek-flash', 'main', 'peak');
  assert.strictEqual(bucket.requests, 2);
  assert.strictEqual(bucket.cacheMiss, 2400);
  assert.strictEqual(bucket.cacheHit, 6800);
  assert.strictEqual(bucket.cacheCreation, 200);
  assert.strictEqual(bucket.output, 1600);
});

test('主请求与子代理各自分桶', () => {
  const agg = createDayAgg();
  const ctx = { holidays: HOLIDAYS, nowMs: NOW };
  addRecord(agg, record({ messageId: 'a' }), ctx);
  addRecord(agg, record({ messageId: 'b', isSubagent: true, outputTokens: 50 }), ctx);
  assert.strictEqual(view(agg, '2026-11-24', 'deepseek-flash', 'main', 'peak').output, 800);
  assert.strictEqual(view(agg, '2026-11-24', 'deepseek-flash', 'subagent', 'peak').output, 50);
});

test('<synthetic> 与残缺记录被跳过', () => {
  const agg = createDayAgg();
  const ctx = { holidays: HOLIDAYS, nowMs: NOW };
  assert.strictEqual(addRecord(agg, record({ model: '<synthetic>', normalizedModel: '<synthetic>' }), ctx), false);
  assert.strictEqual(addRecord(agg, record({ normalizedModel: '' }), ctx), false);
  assert.strictEqual(addRecord(agg, record({ timestampMs: NaN }), ctx), false);
  assert.strictEqual(agg.stats.skipped, 3);
  assert.strictEqual(agg.days.size, 0);
});

test('记账日按北京时间：UTC 16:00 换日', () => {
  const agg = createDayAgg();
  const ctx = { holidays: HOLIDAYS, nowMs: NOW };
  addRecord(agg, record({ messageId: 'a', timestampMs: Date.parse('2026-11-23T15:59:59Z') }), ctx);
  addRecord(agg, record({ messageId: 'b', timestampMs: Date.parse('2026-11-23T16:00:00Z') }), ctx);
  assert.ok(agg.days.has('2026-11-23'));
  assert.ok(agg.days.has('2026-11-24'));
});

test('不做模型前缀过滤：账本保存所有模型（Q4）', () => {
  const agg = buildDayAgg(
    [
      record({ messageId: 'a' }),
      record({ messageId: 'b', model: 'gpt-5', normalizedModel: 'gpt-5' })
    ],
    { holidays: HOLIDAYS, nowMs: NOW }
  );
  const models = Array.from(agg.days.get('2026-11-24').models.keys()).sort();
  assert.deepStrictEqual(models, ['deepseek-flash', 'gpt-5']);
});

test('lastRecomputedAt 记录本轮聚合时间', () => {
  const agg = buildDayAgg([record({})], { holidays: HOLIDAYS, nowMs: NOW });
  assert.strictEqual(agg.days.get('2026-11-24').lastRecomputedAt, NOW);
});

test('dayAggToDays / daysToDayAgg 往返一致', () => {
  const agg = buildDayAgg([record({}), record({ messageId: 'b', isSubagent: true })], {
    holidays: HOLIDAYS,
    nowMs: NOW
  });
  const days = dayAggToDays(agg);
  assert.deepStrictEqual(Object.keys(days), ['2026-11-24']);
  assert.strictEqual(days['2026-11-24'].models['deepseek-flash'].main.peak.output, 800);

  const roundTrip = daysToDayAgg(days);
  assert.deepStrictEqual(dayTotals(roundTrip.days.get('2026-11-24')), dayTotals(agg.days.get('2026-11-24')));
});

test('dayTotals 覆盖全部桶', () => {
  const agg = buildDayAgg(
    [
      record({ messageId: 'a' }),
      record({ messageId: 'b', isSubagent: true, timestampMs: AT.tueLunch })
    ],
    { holidays: HOLIDAYS, nowMs: NOW }
  );
  const totals = dayTotals(agg.days.get('2026-11-24'));
  assert.strictEqual(totals.requests, 2);
  assert.strictEqual(totals.output, 1600);
});
