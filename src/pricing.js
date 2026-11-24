'use strict';

const { HOLIDAY_YEARS, HOLIDAY_DAYS } = require('./holidays.data.js');

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 内置法定节假日（2024–2027），由 tools/sync-holidays.mjs 从 holiday-cn 生成。
 * 只含放假日期；调休上班日不参与计价——官方高峰口径是“周一至周五”，
 * 补班周六仍按低谷（需求文档 §4.5）。
 */
const DEFAULT_HOLIDAYS = HOLIDAY_DAYS;

const RATE_CARDS = {
  'deepseek-flash': {
    CNY: { cacheHit: 0.04, cacheMiss: 2.0, output: 8.0 },
    USD: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 }
  },
  'deepseek-v4-pro': {
    CNY: { cacheHit: 0.3, cacheMiss: 9.0, output: 27.0 },
    USD: { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 }
  }
};

const FALLBACK_MODEL = 'deepseek-flash';

function normalizeModel(raw) {
  return String(raw || '').trim().toLowerCase().replace(/\[[^\]]*\]\s*$/, '').trim();
}

function isIncludedModel(model, prefixes) {
  const normalized = normalizeModel(model);
  if (!normalized || normalized === '<synthetic>') return false;
  const list = Array.isArray(prefixes) ? prefixes : [];
  for (const prefix of list) {
    const value = String(prefix || '').trim().toLowerCase();
    if (value && normalized.startsWith(value)) return true;
  }
  return false;
}

function parseTimestamp(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function pad2(value) {
  return value < 10 ? '0' + value : String(value);
}

function shanghaiParts(ms) {
  const date = new Date(ms + SHANGHAI_OFFSET_MS);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    weekday: date.getUTCDay(),
    hours: date.getUTCHours(),
    minutes: date.getUTCMinutes(),
    seconds: date.getUTCSeconds()
  };
}

function dateKeyOf(parts) {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function dateKeyOfMs(ms) {
  const parts = shanghaiParts(ms);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function localDayInfo(nowMs) {
  const parts = shanghaiParts(nowMs);
  const key = dateKeyOf(parts);
  const startMs = Date.parse(`${key}T00:00:00+08:00`);
  const weekdayLabels = ['日', '一', '二', '三', '四', '五', '六'];
  return {
    key,
    startMs,
    endMs: startMs + 24 * 60 * 60 * 1000,
    label: `${parts.year}年${parts.month}月${parts.day}日 周${weekdayLabels[parts.weekday]}`
  };
}

function isPeak(tsMs, holidays) {
  const parts = shanghaiParts(tsMs);
  if (parts.weekday === 0 || parts.weekday === 6) return false;
  if (holidays && typeof holidays.has === 'function' && holidays.has(dateKeyOf(parts))) return false;
  const minutes = parts.hours * 60 + parts.minutes;
  return (minutes >= 540 && minutes < 720) || (minutes >= 840 && minutes < 1080);
}

function currentMarketMode(nowMs, holidays) {
  const parts = shanghaiParts(nowMs);
  const isHoliday = Boolean(holidays && typeof holidays.has === 'function' && holidays.has(dateKeyOf(parts)));
  const peak = isPeak(nowMs, holidays);
  return { mode: peak ? 'peak' : 'offpeak', label: peak ? '高峰' : '低谷', isHoliday };
}

function nextBoundaryMs(nowMs) {
  const day = localDayInfo(nowMs);
  for (const hour of [0, 9, 12, 14, 18]) {
    const boundary = day.startMs + hour * 60 * 60 * 1000;
    if (boundary > nowMs + 1000) return boundary;
  }
  return day.startMs + 24 * 60 * 60 * 1000;
}

function resolveRateInfo(model, settings) {
  const normalized = normalizeModel(model);
  const currency = settings && settings.currency === 'USD' ? 'USD' : 'CNY';
  const overrides = settings && settings.rateOverrides ? settings.rateOverrides : {};
  const override = overrides[normalized];
  if (override && override[currency]) {
    return { normalized, currency, rates: override[currency], estimated: false, custom: true };
  }
  if (RATE_CARDS[normalized] && RATE_CARDS[normalized][currency]) {
    return { normalized, currency, rates: RATE_CARDS[normalized][currency], estimated: false, custom: false };
  }
  for (const known of Object.keys(RATE_CARDS)) {
    if (normalized.startsWith(known)) {
      return { normalized, currency, rates: RATE_CARDS[known][currency], estimated: true, custom: false };
    }
  }
  return { normalized, currency, rates: RATE_CARDS[FALLBACK_MODEL][currency], estimated: true, custom: false };
}

function tokenCost(inputTokens, cacheReadTokens, outputTokens, rates) {
  return (
    inputTokens * rates.cacheMiss +
    cacheReadTokens * rates.cacheHit +
    outputTokens * rates.output
  ) / 1000000;
}

function requestCost(record, rateInfo, holidays) {
  const base = tokenCost(record.inputTokens, record.cacheReadTokens, record.outputTokens, rateInfo.rates);
  return isPeak(record.timestampMs, holidays) ? base : base * 0.5;
}

/**
 * 账本里按“日 × 模型 × 主/子 × 峰谷”存的是 token 桶，不含时间戳，
 * 因此峰谷已经由桶名表达，金额直接按桶名乘折扣，不再重复判断时间。
 */
function bucketCost(bucket, rateInfo, isPeakBucket) {
  if (!bucket || !rateInfo || !rateInfo.rates) return 0;
  const base = tokenCost(
    Number(bucket.cacheMiss) || 0,
    Number(bucket.cacheHit) || 0,
    Number(bucket.output) || 0,
    rateInfo.rates
  );
  return isPeakBucket ? base : base * 0.5;
}

function runPricingAssertions() {
  const holidays = new Set(['2026-10-01']);
  const cases = [
    { name: '工作日10:00高峰', iso: '2026-11-24T10:00:00+08:00', expected: true },
    { name: '工作日12:00低谷', iso: '2026-11-24T12:00:00+08:00', expected: false },
    { name: '工作日14:00高峰', iso: '2026-11-24T14:00:00+08:00', expected: true },
    { name: '工作日18:00低谷', iso: '2026-11-24T18:00:00+08:00', expected: false },
    { name: '周日低谷', iso: '2026-11-22T10:00:00+08:00', expected: false },
    { name: '节假日低谷', iso: '2026-10-01T10:00:00+08:00', expected: false }
  ];
  const results = cases.map(item => {
    const actual = isPeak(Date.parse(item.iso), holidays);
    return { name: item.name, ok: actual === item.expected, expected: item.expected, actual };
  });
  const before = localDayInfo(Date.parse('2026-11-23T15:59:59Z')).key;
  const after = localDayInfo(Date.parse('2026-11-23T16:00:00Z')).key;
  results.push({ name: 'UTC日界前', ok: before === '2026-11-23', expected: '2026-11-23', actual: before });
  results.push({ name: 'UTC日界后', ok: after === '2026-11-24', expected: '2026-11-24', actual: after });
  return results;
}

module.exports = {
  SHANGHAI_OFFSET_MS,
  DEFAULT_HOLIDAYS,
  HOLIDAY_YEARS,
  RATE_CARDS,
  normalizeModel,
  isIncludedModel,
  parseTimestamp,
  dateKeyOfMs,
  localDayInfo,
  isPeak,
  currentMarketMode,
  nextBoundaryMs,
  resolveRateInfo,
  tokenCost,
  requestCost,
  bucketCost,
  runPricingAssertions
};
