'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { DEFAULT_HOLIDAYS, HOLIDAY_YEARS, isPeak, bucketCost, resolveRateInfo, dateKeyOfMs } = require('../src/pricing');

// 0.1.1 的 2026 表原文（33 天）。切换数据源后必须逐条一致，
// 否则已发布的历史金额会凭空变化。
const EXPECTED_2026 = [
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'
];

const HOLIDAYS = new Set(DEFAULT_HOLIDAYS);

test('内置节假日覆盖 2024–2027', () => {
  assert.deepStrictEqual(HOLIDAY_YEARS, [2024, 2025, 2026, 2027]);
  for (const year of HOLIDAY_YEARS) {
    const count = DEFAULT_HOLIDAYS.filter(item => item.startsWith(`${year}-`)).length;
    assert.ok(count > 20, `${year} 年的节假日数量异常：${count}`);
  }
});

test('2026 表与 0.1.1 逐条一致（切换数据源不改历史金额）', () => {
  const actual = DEFAULT_HOLIDAYS.filter(item => item.startsWith('2026-'));
  assert.deepStrictEqual(actual, EXPECTED_2026);
});

test('高峰时段边界左闭右开：09:00 / 12:00 / 14:00 / 18:00', () => {
  const day = '2026-11-24'; // 周二
  const cases = [
    ['08:59', false],
    ['09:00', true],
    ['11:59', true],
    ['12:00', false],
    ['13:59', false],
    ['14:00', true],
    ['17:59', true],
    ['18:00', false]
  ];
  for (const [time, expected] of cases) {
    const ts = Date.parse(`${day}T${time}:00+08:00`);
    assert.strictEqual(isPeak(ts, HOLIDAYS), expected, `${day} ${time}`);
  }
});

test('周末整天低谷，含调休上班的周六（官方口径：Monday through Friday）', () => {
  for (const day of ['2026-02-14', '2026-02-28', '2026-10-10']) {
    const ts = Date.parse(`${day}T10:00:00+08:00`);
    assert.strictEqual(isPeak(ts, HOLIDAYS), false, `${day} 补班周六仍按低谷`);
  }
});

test('落在工作日的法定假日为低谷', () => {
  assert.strictEqual(isPeak(Date.parse('2026-02-16T10:00:00+08:00'), HOLIDAYS), false, '春节假期内的周一');
  assert.strictEqual(isPeak(Date.parse('2025-01-29T10:00:00+08:00'), HOLIDAYS), false, '2025 春节（验证多年度表生效）');
});

test('记账日按北京时间换日', () => {
  assert.strictEqual(dateKeyOfMs(Date.parse('2026-11-23T15:59:59Z')), '2026-11-23');
  assert.strictEqual(dateKeyOfMs(Date.parse('2026-11-23T16:00:00Z')), '2026-11-24');
});

test('bucketCost：高峰全额、低谷半价', () => {
  const rateInfo = resolveRateInfo('deepseek-flash', { currency: 'CNY' });
  const bucket = { requests: 1, cacheMiss: 1_000_000, cacheHit: 1_000_000, cacheCreation: 0, output: 1_000_000 };
  // 2.0 + 0.04 + 8.0
  assert.ok(Math.abs(bucketCost(bucket, rateInfo, true) - 10.04) < 1e-9);
  assert.ok(Math.abs(bucketCost(bucket, rateInfo, false) - 5.02) < 1e-9);
  assert.strictEqual(bucketCost(null, rateInfo, true), 0);
});
