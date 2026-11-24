'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { buildDayAgg, dayAggToDays } = require('../src/aggregate');
const { createLedger, mergeDays, computeBucketSignature } = require('../src/ledger');
const history = require('../src/history');
const {
  periodKeyOf,
  periodRange,
  previousPeriodKey,
  resolveRange,
  defaultGranularity,
  aggregateHistory,
  isoWeekInfo,
  addDays,
  dayDiff
} = history;

const NO_HOLIDAY = new Set();
const NOW = Date.parse('2026-11-24T20:00:00+08:00');

function at(iso) {
  return Date.parse(iso);
}

let seq = 0;
function record(overrides) {
  seq += 1;
  return {
    messageId: `m${seq}`,
    timestampMs: at('2026-11-24T10:00:00+08:00'),
    model: 'deepseek-flash',
    normalizedModel: 'deepseek-flash',
    isSubagent: false,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    ...overrides
  };
}

function ledgerFrom(records, options) {
  const opts = options || {};
  const holidays = opts.holidays || NO_HOLIDAY;
  const ledger = createLedger({ installDate: '2026-01-01', bucketSignature: computeBucketSignature(holidays), nowMs: NOW });
  const days = dayAggToDays(buildDayAgg(records, { holidays, nowMs: NOW }));
  mergeDays(ledger, days, { bucketSignature: ledger.bucketSignature, nowMs: NOW });
  return ledger;
}

const DEFAULT_QUERY = {
  currency: 'CNY',
  modelPrefixes: ['deepseek'],
  includeSubagents: true,
  todayKey: '2026-11-24'
};

function query(ledger, overrides) {
  return aggregateHistory(ledger, { ...DEFAULT_QUERY, ...overrides });
}

test('ISO 周跨年：2026-12-31 与 2027-01-01 同属 2026-W53', () => {
  assert.deepStrictEqual(isoWeekInfo('2026-12-31'), { isoYear: 2026, week: 53 });
  assert.strictEqual(periodKeyOf('2027-01-01', 'week'), '2026-W53');
  assert.deepStrictEqual(periodRange('2026-W53', 'week'), { fromKey: '2026-12-28', toKey: '2027-01-03' });
  assert.strictEqual(periodKeyOf('2026-11-24', 'week'), '2026-W48');
});

test('月/季/年键与自然边界（含闰年 2 月）', () => {
  assert.strictEqual(periodKeyOf('2026-11-24', 'month'), '2026-11');
  assert.deepStrictEqual(periodRange('2026-11', 'month'), { fromKey: '2026-11-01', toKey: '2026-11-30' });
  assert.strictEqual(periodKeyOf('2026-11-24', 'quarter'), '2026-Q4');
  assert.deepStrictEqual(periodRange('2026-Q4', 'quarter'), { fromKey: '2026-10-01', toKey: '2026-12-31' });
  assert.deepStrictEqual(periodRange('2028-02', 'month'), { fromKey: '2028-02-01', toKey: '2028-02-29' });
  assert.deepStrictEqual(periodRange('2026', 'year'), { fromKey: '2026-01-01', toKey: '2026-12-31' });
});

test('上一周期：日/周/月/季/年', () => {
  assert.strictEqual(previousPeriodKey('2026-11-24', 'day'), '2026-11-23');
  assert.strictEqual(previousPeriodKey('2026-W48', 'week'), '2026-W47');
  assert.strictEqual(previousPeriodKey('2026-11', 'month'), '2026-10');
  assert.strictEqual(previousPeriodKey('2026-Q1', 'quarter'), '2025-Q4');
  assert.strictEqual(previousPeriodKey('2026', 'year'), '2025');
});

test('范围预置与默认粒度', () => {
  const last30 = resolveRange('last30', { nowMs: NOW });
  assert.strictEqual(last30.toKey, '2026-11-24');
  assert.strictEqual(last30.fromKey, '2026-10-26');
  assert.strictEqual(last30.dayCount, 30);

  const last7 = resolveRange('last7', { nowMs: NOW });
  assert.strictEqual(last7.dayCount, 7);

  const week = resolveRange('thisWeek', { nowMs: NOW });
  assert.deepStrictEqual({ fromKey: week.fromKey, toKey: week.toKey }, { fromKey: '2026-11-23', toKey: '2026-11-29' });

  const year = resolveRange('thisYear', { nowMs: NOW });
  assert.deepStrictEqual({ fromKey: year.fromKey, toKey: year.toKey }, { fromKey: '2026-01-01', toKey: '2026-12-31' });

  assert.strictEqual(defaultGranularity(30), 'day');
  assert.strictEqual(defaultGranularity(90), 'day');
  assert.strictEqual(defaultGranularity(91), 'week');
  assert.strictEqual(defaultGranularity(730), 'week');
  assert.strictEqual(defaultGranularity(731), 'month');
});

test('金额：高峰全额、低谷半价、缓存价不同', () => {
  const ledger = ledgerFrom([
    record({ timestampMs: at('2026-11-24T10:00:00+08:00'), inputTokens: 1_000_000 }),
    record({ timestampMs: at('2026-11-24T12:30:00+08:00'), inputTokens: 1_000_000 }),
    record({ timestampMs: at('2026-11-24T10:30:00+08:00'), cacheReadTokens: 1_000_000 })
  ]);
  const result = query(ledger, { fromKey: '2026-11-24', toKey: '2026-11-24' });
  // 2.0 + 1.0 + 0.04
  assert.ok(Math.abs(result.summary.totalCost - 3.04) < 1e-9, `实际 ${result.summary.totalCost}`);
});

test('币种切换只改展示，不影响账本', () => {
  const ledger = ledgerFrom([record({ inputTokens: 1_000_000 })]);
  const cny = query(ledger, { fromKey: '2026-11-24', toKey: '2026-11-24' });
  const usd = query(ledger, { fromKey: '2026-11-24', toKey: '2026-11-24', currency: 'USD' });
  assert.ok(Math.abs(cny.summary.totalCost - 2.0) < 1e-9);
  assert.ok(Math.abs(usd.summary.totalCost - 0.3) < 1e-9);
  assert.strictEqual(cny.days[0].tokens.cacheMiss, 1_000_000, '账本 token 不随币种变化');
});

test('子代理开关与模型前缀都是查询期过滤', () => {
  const ledger = ledgerFrom([
    record({ inputTokens: 1_000_000 }),
    record({ isSubagent: true, inputTokens: 1_000_000 }),
    record({ model: 'gpt-5', normalizedModel: 'gpt-5', inputTokens: 1_000_000 })
  ]);
  const all = query(ledger, { fromKey: '2026-11-24', toKey: '2026-11-24' });
  assert.ok(Math.abs(all.summary.totalCost - 4.0) < 1e-9, `默认前缀只计 deepseek 的两条，实际 ${all.summary.totalCost}`);
  assert.strictEqual(all.summary.requests, 2);

  const noSub = query(ledger, { fromKey: '2026-11-24', toKey: '2026-11-24', includeSubagents: false });
  assert.strictEqual(noSub.summary.requests, 1);
  assert.ok(Math.abs(noSub.summary.totalCost - 2.0) < 1e-9);

  const withGpt = query(ledger, { fromKey: '2026-11-24', toKey: '2026-11-24', modelPrefixes: ['deepseek', 'gpt'] });
  assert.strictEqual(withGpt.summary.requests, 3);
  assert.ok(withGpt.summary.totalCost > all.summary.totalCost);
});

test('周期明细之和等于汇总', () => {
  const ledger = ledgerFrom([
    record({ timestampMs: at('2026-10-05T10:00:00+08:00'), inputTokens: 500_000 }),
    record({ timestampMs: at('2026-11-03T10:00:00+08:00'), inputTokens: 700_000 }),
    record({ timestampMs: at('2026-11-24T12:00:00+08:00'), inputTokens: 300_000 })
  ]);
  const result = query(ledger, { fromKey: '2026-10-01', toKey: '2026-11-30', granularity: 'month' });
  const sum = result.periods.reduce((acc, item) => acc + item.cost, 0);
  assert.ok(Math.abs(sum - result.summary.totalCost) < 1e-9);
  assert.strictEqual(result.periods.length, 2);
  assert.deepStrictEqual(result.periods.map(item => item.key), ['2026-10', '2026-11']);
});

test('环比按完整自然周期计算，不受所选范围影响', () => {
  const ledger = ledgerFrom([
    record({ timestampMs: at('2026-10-01T10:00:00+08:00'), inputTokens: 0 }), // 让 10 月从 10-01 开始可复核
    record({ timestampMs: at('2026-10-05T10:00:00+08:00'), inputTokens: 1_000_000 }), // 10 月：2.0
    record({ timestampMs: at('2026-11-03T10:00:00+08:00'), inputTokens: 3_000_000 }) // 11 月：6.0
  ]);
  const result = query(ledger, { fromKey: '2026-11-01', toKey: '2026-11-30', granularity: 'month' });
  const nov = result.periods[0];
  assert.ok(Math.abs(nov.cost - 6.0) < 1e-9);
  assert.ok(Math.abs(nov.previousCost - 2.0) < 1e-9, '上一周期在范围之外也要能取到基线');
  assert.ok(Math.abs(nov.changePct - 2.0) < 1e-9);
  assert.strictEqual(nov.previousIncomplete, false);
});

test('上一周期早于账本可复核范围时，不显示环比', () => {
  const ledger = ledgerFrom([
    record({ timestampMs: at('2026-10-05T10:00:00+08:00'), inputTokens: 1_000_000 }),
    record({ timestampMs: at('2026-11-03T10:00:00+08:00'), inputTokens: 3_000_000 })
  ]);
  // 账本最早 10-05，10 月并不是完整可复核月份，不能作为 11 月基线。
  const result = query(ledger, { fromKey: '2026-11-01', toKey: '2026-11-30', granularity: 'month' });
  const nov = result.periods[0];
  assert.strictEqual(nov.previousCost, null);
  assert.strictEqual(nov.changePct, null);
  assert.strictEqual(nov.previousIncomplete, true);
  assert.strictEqual(nov.previousReason, 'before-ledger');
});

test('被范围截断的上一周期不作为下一周期基线', () => {
  const ledger = ledgerFrom([
    record({ timestampMs: at('2026-11-02T10:00:00+08:00'), inputTokens: 1_000_000 }),
    record({ timestampMs: at('2026-11-10T10:00:00+08:00'), inputTokens: 1_000_000 }),
    record({ timestampMs: at('2026-11-17T10:00:00+08:00'), inputTokens: 1_000_000 }),
    record({ timestampMs: at('2026-11-24T10:00:00+08:00'), inputTokens: 1_000_000 })
  ]);
  // 11-11 在 W46 中间：W46 被范围截断，W47 的“上一周期”不完整。
  const result = query(ledger, { fromKey: '2026-11-11', toKey: '2026-11-24', granularity: 'week' });
  const w47 = result.periods.find(period => period.key === '2026-W47');
  const w46 = result.periods.find(period => period.key === '2026-W46');
  assert.strictEqual(w46.partial, true);
  assert.strictEqual(w47.previousIncomplete, true);
  assert.strictEqual(w47.previousReason, 'partial-range');
  assert.strictEqual(w47.previousCost, null);
  assert.strictEqual(w47.changePct, null);
});

test('日志消失的日期在后续扫描中标记为仅账本', () => {
  const ledger = ledgerFrom([
    record({ messageId: 'keep', timestampMs: at('2026-11-24T10:00:00+08:00'), inputTokens: 1_000_000 }),
    record({ messageId: 'gone', timestampMs: at('2026-11-20T10:00:00+08:00'), inputTokens: 1_000_000 })
  ]);
  // 第二轮只扫描到 11-24：11-20 的日志已删除。
  const next = dayAggToDays(buildDayAgg([
    record({ messageId: 'keep', timestampMs: at('2026-11-24T10:00:00+08:00'), inputTokens: 1_000_000 })
  ], { holidays: NO_HOLIDAY, nowMs: NOW + 1000 }));
  mergeDays(ledger, next, { bucketSignature: ledger.bucketSignature, nowMs: NOW + 1000 });
  const result = query(ledger, { fromKey: '2026-11-19', toKey: '2026-11-24', granularity: 'day' });
  const day20 = result.days.find(day => day.dateKey === '2026-11-20');
  const day24 = result.days.find(day => day.dateKey === '2026-11-24');
  assert.strictEqual(day20.frozen, true);
  assert.strictEqual(day24.frozen, false);
  assert.strictEqual(result.summary.frozenDays, 1);
  assert.ok(result.warnings.some(item => item.code === 'ledger-only'));
});

test('没有基线时 changePct 为 null，不虚构环比', () => {
  const ledger = ledgerFrom([record({ inputTokens: 1_000_000 })]);
  const result = query(ledger, { fromKey: '2026-11-01', toKey: '2026-11-30', granularity: 'month' });
  assert.strictEqual(result.periods[0].previousCost, null);
  assert.strictEqual(result.periods[0].changePct, null);
});

test('端点落在周期中间时标记 partial，未结束的周期标记 inProgress', () => {
  const ledger = ledgerFrom([record({ inputTokens: 1_000_000 })]);
  const result = query(ledger, { fromKey: '2026-11-10', toKey: '2026-11-24', granularity: 'month' });
  const nov = result.periods[0];
  assert.strictEqual(nov.partial, true);
  assert.strictEqual(nov.inProgress, true);
  assert.strictEqual(nov.fromKey, '2026-11-01');
  assert.strictEqual(nov.toKey, '2026-11-30');
});

test('日均分母用“范围 ∩ 可覆盖区间”，范围早于账本时不被拉低', () => {
  const ledger = ledgerFrom([
    record({ timestampMs: at('2026-11-20T10:00:00+08:00'), inputTokens: 1_000_000 }), // 2.0
    record({ timestampMs: at('2026-11-24T10:00:00+08:00'), inputTokens: 1_000_000 }) // 2.0
  ]);
  // 账本最早 11-20，最晚 11-24；今天 11-24
  const result = query(ledger, { fromKey: '2026-01-01', toKey: '2026-12-31', granularity: 'month' });
  assert.strictEqual(result.summary.rangeDays, 328, '范围截到今天（01-01 → 11-24），不生成未来日期');
  assert.strictEqual(result.summary.coveredDays, 5, '11-20 至 11-24 共 5 天');
  assert.ok(Math.abs(result.summary.avgPerDay - 0.8) < 1e-9, '4.0 / 5 天');
  assert.ok(result.warnings.some(item => item.code === 'range-before-ledger'));
});

test('无记录日与仅账本日分别计数', () => {
  const ledger = ledgerFrom([record({ timestampMs: at('2026-11-20T10:00:00+08:00'), inputTokens: 1_000_000 })]);
  // 手工把某天标为“仅账本记录”
  delete ledger.days['2026-11-20'].lastRecomputedAt;
  ledger.days['2026-11-21'] = ledger.days['2026-11-20'];
  delete ledger.days['2026-11-20'];

  const result = query(ledger, { fromKey: '2026-11-19', toKey: '2026-11-24' });
  assert.strictEqual(result.summary.noRecordDays, 5, '11-19/20/22/23/24 无记录');
  assert.strictEqual(result.summary.frozenDays, 1, '11-21 只剩账本快照');
  const frozenDay = result.days.find(item => item.dateKey === '2026-11-21');
  assert.strictEqual(frozenDay.frozen, true);
  assert.strictEqual(frozenDay.hasRecord, true);
  assert.ok(result.warnings.some(item => item.code === 'ledger-only'));
});

test('未知模型按 Flash 估算并给出告警', () => {
  const ledger = ledgerFrom([record({ model: 'deepseek-future', normalizedModel: 'deepseek-future', inputTokens: 1_000_000 })]);
  const result = query(ledger, { fromKey: '2026-11-24', toKey: '2026-11-24' });
  assert.ok(Math.abs(result.summary.totalCost - 2.0) < 1e-9);
  assert.strictEqual(result.summary.estimated, true);
  assert.ok(result.warnings.some(item => item.code === 'estimated-model'));
});

test('峰谷口径过期时给出告警', () => {
  const ledger = ledgerFrom([record({ inputTokens: 1_000_000 })]);
  ledger.days['2026-11-24'].bucketingStale = true;
  const result = query(ledger, { fromKey: '2026-11-24', toKey: '2026-11-24' });
  assert.strictEqual(result.summary.staleDays, 1);
  assert.ok(result.warnings.some(item => item.code === 'bucketing-stale'));
});

test('空账本不崩，返回空结构', () => {
  const result = query(createLedger({ installDate: '2026-11-01', nowMs: NOW }), {
    fromKey: '2026-11-01',
    toKey: '2026-11-24',
    granularity: 'day'
  });
  assert.strictEqual(result.summary.totalCost, 0);
  assert.strictEqual(result.summary.noRecordDays, 24);
  assert.strictEqual(result.periods.length, 24);
});

test('跨月/跨年范围按周聚合不丢日', () => {
  const ledger = ledgerFrom([
    record({ timestampMs: at('2026-12-28T10:00:00+08:00'), inputTokens: 1_000_000 }),
    record({ timestampMs: at('2027-01-02T10:00:00+08:00'), inputTokens: 1_000_000 })
  ]);
  const result = query(ledger, {
    fromKey: '2026-12-28',
    toKey: '2027-01-03',
    granularity: 'week',
    todayKey: '2027-01-03'
  });
  assert.strictEqual(result.periods.length, 1);
  assert.strictEqual(result.periods[0].key, '2026-W53');
  assert.ok(Math.abs(result.periods[0].cost - 3.0) < 1e-9, '同一 ISO 周跨年后仍合并且不重复（12-28 周一高峰 2.0 + 01-02 周六低谷 1.0）');
});

test('未来日期不生成数据行，当前周期标 inProgress', () => {
  const ledger = ledgerFrom([record({ inputTokens: 1_000_000 })]);
  const result = query(ledger, { fromKey: '2026-01-01', toKey: '2026-12-31', granularity: 'month' });
  const keys = result.periods.map(item => item.key);
  assert.strictEqual(keys[keys.length - 1], '2026-11', '12 月还没到，不能生成 0 值行');
  assert.ok(!keys.includes('2026-12'));
  const nov = result.periods[result.periods.length - 1];
  assert.strictEqual(nov.inProgress, true);
  assert.strictEqual(nov.partial, false, '整月都在范围内，不算被范围截断');
});

test('addDays / dayDiff 边界', () => {
  assert.strictEqual(addDays('2026-11-30', 1), '2026-12-01');
  assert.strictEqual(addDays('2026-01-01', -1), '2025-12-31');
  assert.strictEqual(dayDiff('2026-01-01', '2026-12-31'), 364);
  assert.strictEqual(addDays('2028-02-28', 1), '2028-02-29');
});
