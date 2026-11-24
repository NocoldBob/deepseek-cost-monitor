'use strict';

/**
 * 历史查询层：范围解析 → 周期分桶 → 按当前价目表算钱。
 *
 * 这一层是“钱的唯一来源”：账本只存 token，任何金额都在这里用**当次**价目表
 * 与币种即时计算（§8.1）。因此改价、改币种、改前缀、关子代理都只需重新查询，
 * 不需要动账本。
 *
 * 周期口径（§4.7）：
 * - 记账日 = 北京时间自然日；
 * - 周 = 周一起始的 ISO 周，键带 ISO 周年份，避免跨年周归属歧义（2026-W53）；
 * - 季 = 自然季度；年 = 自然年。
 */

const { dateKeyOfMs, resolveRateInfo, isIncludedModel, bucketCost } = require('./pricing');
const { isDayFrozen } = require('./ledger');

const DAY_MS = 24 * 60 * 60 * 1000;
const GRANULARITIES = ['day', 'week', 'month', 'quarter', 'year'];

function pad2(value) {
  return value < 10 ? '0' + value : String(value);
}

function formatDayKey(year, month, day) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function parseDayKey(dayKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || ''));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day, utcMs: Date.UTC(year, month - 1, day) };
}

function dayKeyFromUtcMs(utcMs) {
  const date = new Date(utcMs);
  return formatDayKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function addDays(dayKey, delta) {
  const parsed = parseDayKey(dayKey);
  if (!parsed) return null;
  return dayKeyFromUtcMs(parsed.utcMs + delta * DAY_MS);
}

function dayDiff(fromKey, toKey) {
  const a = parseDayKey(fromKey);
  const b = parseDayKey(toKey);
  if (!a || !b) return 0;
  return Math.round((b.utcMs - a.utcMs) / DAY_MS);
}

function eachDay(fromKey, toKey) {
  const total = dayDiff(fromKey, toKey);
  if (total < 0) return [];
  const out = [];
  for (let index = 0; index <= total; index += 1) out.push(addDays(fromKey, index));
  return out;
}

/** ISO 8601 周：返回 ISO 周年份与周序号（1–53）。 */
function isoWeekInfo(dayKey) {
  const parsed = parseDayKey(dayKey);
  if (!parsed) return null;
  const date = new Date(parsed.utcMs);
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const isoYear = date.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / DAY_MS + 1) / 7);
  return { isoYear, week };
}

/** ISO 周的周一（以日历日期计算，不涉及时区）。 */
function isoWeekStartKey(isoYear, week) {
  const jan4 = Date.UTC(isoYear, 0, 4);
  const jan4Weekday = new Date(jan4).getUTCDay() || 7;
  const mondayMs = jan4 - (jan4Weekday - 1) * DAY_MS + (week - 1) * 7 * DAY_MS;
  return dayKeyFromUtcMs(mondayMs);
}

function periodKeyOf(dayKey, granularity) {
  const parsed = parseDayKey(dayKey);
  if (!parsed) return null;
  switch (granularity) {
    case 'week': {
      const info = isoWeekInfo(dayKey);
      return `${info.isoYear}-W${pad2(info.week)}`;
    }
    case 'month':
      return `${parsed.year}-${pad2(parsed.month)}`;
    case 'quarter':
      return `${parsed.year}-Q${Math.floor((parsed.month - 1) / 3) + 1}`;
    case 'year':
      return String(parsed.year);
    case 'day':
    default:
      return dayKey;
  }
}

function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 周期键 → 该周期的自然起止日（含）。 */
function periodRange(periodKey, granularity) {
  const key = String(periodKey || '');
  if (granularity === 'day') {
    const parsed = parseDayKey(key);
    return parsed ? { fromKey: key, toKey: key } : null;
  }
  if (granularity === 'week') {
    const match = /^(\d{4})-W(\d{2})$/.exec(key);
    if (!match) return null;
    const fromKey = isoWeekStartKey(Number(match[1]), Number(match[2]));
    return { fromKey, toKey: addDays(fromKey, 6) };
  }
  if (granularity === 'month') {
    const match = /^(\d{4})-(\d{2})$/.exec(key);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    return { fromKey: formatDayKey(year, month, 1), toKey: formatDayKey(year, month, lastDayOfMonth(year, month)) };
  }
  if (granularity === 'quarter') {
    const match = /^(\d{4})-Q([1-4])$/.exec(key);
    if (!match) return null;
    const year = Number(match[1]);
    const quarter = Number(match[2]);
    const startMonth = (quarter - 1) * 3 + 1;
    const endMonth = quarter * 3;
    return {
      fromKey: formatDayKey(year, startMonth, 1),
      toKey: formatDayKey(year, endMonth, lastDayOfMonth(year, endMonth))
    };
  }
  if (granularity === 'year') {
    const match = /^(\d{4})$/.exec(key);
    if (!match) return null;
    const year = Number(match[1]);
    return { fromKey: formatDayKey(year, 1, 1), toKey: formatDayKey(year, 12, 31) };
  }
  return null;
}

function previousPeriodKey(periodKey, granularity) {
  const range = periodRange(periodKey, granularity);
  if (!range) return null;
  if (granularity === 'day') return addDays(range.fromKey, -1);
  return periodKeyOf(addDays(range.fromKey, -1), granularity);
}

/** 预置范围。默认“最近 30 天”，与 FR-05 一致。 */
function resolveRange(preset, options) {
  const opts = options || {};
  const todayKey = opts.todayKey || dateKeyOfMs(Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now());
  const name = String(preset || 'last30');
  let fromKey;
  let toKey = todayKey;

  switch (name) {
    case 'last7':
      fromKey = addDays(todayKey, -6);
      break;
    case 'last90':
      fromKey = addDays(todayKey, -89);
      break;
    case 'thisWeek': {
      const range = periodRange(periodKeyOf(todayKey, 'week'), 'week');
      fromKey = range.fromKey;
      toKey = range.toKey;
      break;
    }
    case 'thisMonth': {
      const range = periodRange(periodKeyOf(todayKey, 'month'), 'month');
      fromKey = range.fromKey;
      toKey = range.toKey;
      break;
    }
    case 'thisQuarter': {
      const range = periodRange(periodKeyOf(todayKey, 'quarter'), 'quarter');
      fromKey = range.fromKey;
      toKey = range.toKey;
      break;
    }
    case 'thisYear': {
      const range = periodRange(periodKeyOf(todayKey, 'year'), 'year');
      fromKey = range.fromKey;
      toKey = range.toKey;
      break;
    }
    case 'custom':
      fromKey = opts.fromKey || todayKey;
      toKey = opts.toKey || todayKey;
      break;
    case 'last30':
    default:
      fromKey = addDays(todayKey, -29);
      break;
  }

  if (dayDiff(fromKey, toKey) < 0) {
    const swap = fromKey;
    fromKey = toKey;
    toKey = swap;
  }
  const days = eachDay(fromKey, toKey);
  return { preset: name, fromKey, toKey, todayKey, dayCount: days.length, days };
}

/** 默认粒度随范围变化：≤90 天按日、≤2 年按周、更长按月（Q7）。 */
function defaultGranularity(dayCount) {
  const count = Number(dayCount) || 0;
  if (count <= 90) return 'day';
  if (count <= 730) return 'week';
  return 'month';
}

function emptyTokens() {
  return { cacheMiss: 0, cacheHit: 0, cacheCreation: 0, output: 0, total: 0 };
}

function addTokens(target, bucket) {
  target.cacheMiss += bucket.cacheMiss;
  target.cacheHit += bucket.cacheHit;
  target.cacheCreation += bucket.cacheCreation;
  target.output += bucket.output;
  target.total = target.cacheMiss + target.cacheHit + target.output;
}

/**
 * 单日查询：把一天的 token 桶换算成金额与按模型明细。
 * includeSubagents / modelPrefixes 都是**查询期过滤**，不改账本。
 */
function summarizeDay(day, options) {
  const result = {
    cost: 0,
    requests: 0,
    tokens: emptyTokens(),
    byModel: [],
    estimated: false
  };
  if (!day || !day.models) return result;
  const includeSubagents = options.includeSubagents !== false;
  const prefixes = options.modelPrefixes;
  const pricingSettings = { currency: options.currency, rateOverrides: options.rateOverrides };
  const byModel = new Map();

  for (const model of Object.keys(day.models)) {
    if (!isIncludedModel(model, prefixes)) continue;
    const rateInfo = resolveRateInfo(model, pricingSettings);
    let modelCost = 0;
    let modelRequests = 0;
    const modelTokens = emptyTokens();

    for (const kind of ['main', 'subagent']) {
      if (kind === 'subagent' && !includeSubagents) continue;
      const entry = day.models[model][kind];
      if (!entry) continue;
      for (const variant of ['peak', 'offpeak']) {
        const bucket = entry[variant];
        if (!bucket) continue;
        const requests = Number(bucket.requests) || 0;
        if (!requests && !bucket.cacheMiss && !bucket.cacheHit && !bucket.output) continue;
        modelCost += bucketCost(bucket, rateInfo, variant === 'peak');
        modelRequests += requests;
        addTokens(modelTokens, {
          cacheMiss: Number(bucket.cacheMiss) || 0,
          cacheHit: Number(bucket.cacheHit) || 0,
          cacheCreation: Number(bucket.cacheCreation) || 0,
          output: Number(bucket.output) || 0
        });
      }
    }

    if (!modelRequests && !modelTokens.total) continue;
    result.cost += modelCost;
    result.requests += modelRequests;
    addTokens(result.tokens, modelTokens);
    if (rateInfo.estimated) result.estimated = true;
    byModel.set(model, {
      model,
      cost: modelCost,
      requests: modelRequests,
      tokens: modelTokens,
      estimated: Boolean(rateInfo.estimated),
      custom: Boolean(rateInfo.custom)
    });
  }

  result.byModel = Array.from(byModel.values()).sort((a, b) => b.cost - a.cost || a.model.localeCompare(b.model));
  return result;
}

/** 上一周期是否完整落在账本可复核区间内（最早记录日 ≤ 周期起点）。 */
function isPeriodCompleteInLedger(ledger, periodKey, granularity) {
  const range = periodRange(periodKey, granularity);
  if (!range) return false;
  const first = ledger && ledger.firstRecordDate;
  if (!first) return false;
  return dayDiff(first, range.fromKey) >= 0;
}

/** 周期是否被所选范围截断（用于 FR-10：不完整周期不得作为下一周期的基线）。 */
function isPeriodPartialInRange(periodKey, granularity, fromKey, toKey) {
  const range = periodRange(periodKey, granularity);
  if (!range) return true;
  return dayDiff(range.fromKey, fromKey) > 0 || dayDiff(range.toKey, toKey) < 0;
}

function periodLabel(periodKey, granularity) {
  switch (granularity) {
    case 'week': {
      const match = /^(\d{4})-W(\d{2})$/.exec(periodKey);
      return match ? `${match[1]} 第${Number(match[2])}周` : periodKey;
    }
    case 'month': {
      const match = /^(\d{4})-(\d{2})$/.exec(periodKey);
      return match ? `${match[1]}年${Number(match[2])}月` : periodKey;
    }
    case 'quarter': {
      const match = /^(\d{4})-Q([1-4])$/.exec(periodKey);
      return match ? `${match[1]}年 Q${match[2]}` : periodKey;
    }
    case 'year':
      return periodKey;
    case 'day':
    default:
      return periodKey;
  }
}

/**
 * 主查询：范围 → 日明细 + 周期明细 + 汇总。
 *
 * options:
 *   fromKey / toKey     统计范围（含）
 *   granularity         day|week|month|quarter|year
 *   currency            CNY|USD
 *   rateOverrides       {模型:{CNY:{...}}}
 *   includeSubagents    是否计入子代理（查询期过滤）
 *   modelPrefixes       计入统计的模型前缀
 *   todayKey            北京时间“今天”，用于 inProgress 判定与可覆盖区间
 */
function aggregateHistory(ledger, options) {
  const opts = options || {};
  const granularity = GRANULARITIES.includes(opts.granularity) ? opts.granularity : 'day';
  const todayKey = opts.todayKey || dateKeyOfMs(Date.now());
  const fromKey = opts.fromKey;
  const toKey = opts.toKey;
  // 未来日期不产生数据行：范围可以选到年底，但聚合只到今天。
  // 否则“今年”会多出一堆 ¥0.00 的未来周/月，且被误标为“进行中”。
  const lastKey = dayDiff(todayKey, toKey) > 0 ? todayKey : toKey;
  const days = eachDay(fromKey, lastKey);
  const dayOptions = {
    currency: opts.currency === 'USD' ? 'USD' : 'CNY',
    rateOverrides: opts.rateOverrides,
    includeSubagents: opts.includeSubagents,
    modelPrefixes: opts.modelPrefixes
  };
  const warnings = [];
  const ledgerDays = (ledger && ledger.days) || {};

  const daily = [];
  const periodMap = new Map();
  const summary = {
    totalCost: 0,
    requests: 0,
    tokens: emptyTokens(),
    rangeDays: days.length,
    coveredDays: 0,
    daysWithData: 0,
    noRecordDays: 0,
    frozenDays: 0,
    staleDays: 0,
    avgPerDay: 0,
    estimated: false,
    lastScanAt: ledger && Number.isFinite(ledger.lastScanAt) ? ledger.lastScanAt : null,
    byModel: []
  };
  const summaryByModel = new Map();
  let estimatedSeen = false;

  for (const dateKey of days) {
    const day = ledgerDays[dateKey];
    const dayResult = summarizeDay(day, dayOptions);
    const entry = {
      dateKey,
      cost: dayResult.cost,
      requests: dayResult.requests,
      tokens: dayResult.tokens,
      byModel: dayResult.byModel,
      hasRecord: Boolean(day),
      frozen: Boolean(day) && isDayFrozen(day, ledger && ledger.lastScanAt),
      stale: Boolean(day && day.bucketingStale),
      estimated: dayResult.estimated
    };
    daily.push(entry);

    summary.totalCost += entry.cost;
    summary.requests += entry.requests;
    addTokens(summary.tokens, entry.tokens);
    if (entry.hasRecord) {
      summary.daysWithData += 1;
      if (entry.frozen) summary.frozenDays += 1;
    } else {
      summary.noRecordDays += 1;
    }
    if (entry.stale) summary.staleDays += 1;
    if (entry.estimated) estimatedSeen = true;
    for (const modelEntry of entry.byModel) {
      const acc = summaryByModel.get(modelEntry.model) || {
        model: modelEntry.model,
        cost: 0,
        requests: 0,
        tokens: emptyTokens(),
        estimated: modelEntry.estimated,
        custom: modelEntry.custom
      };
      acc.cost += modelEntry.cost;
      acc.requests += modelEntry.requests;
      addTokens(acc.tokens, modelEntry.tokens);
      acc.estimated = acc.estimated || modelEntry.estimated;
      acc.custom = acc.custom || modelEntry.custom;
      summaryByModel.set(modelEntry.model, acc);
    }

    const key = periodKeyOf(dateKey, granularity);
    let bucket = periodMap.get(key);
    if (!bucket) {
      const range = periodRange(key, granularity) || { fromKey: dateKey, toKey: dateKey };
      bucket = {
        key,
        label: periodLabel(key, granularity),
        fromKey: range.fromKey,
        toKey: range.toKey,
        cost: 0,
        requests: 0,
        tokens: emptyTokens(),
        daysWithData: 0,
        noRecordDays: 0,
        frozenDays: 0,
        staleDays: 0,
        estimated: false,
        byModel: new Map()
      };
      periodMap.set(key, bucket);
    }
    bucket.cost += entry.cost;
    bucket.requests += entry.requests;
    addTokens(bucket.tokens, entry.tokens);
    if (entry.hasRecord) {
      bucket.daysWithData += 1;
      if (entry.frozen) bucket.frozenDays += 1;
    } else {
      bucket.noRecordDays += 1;
    }
    if (entry.stale) bucket.staleDays += 1;
    if (entry.estimated) bucket.estimated = true;
    for (const modelEntry of entry.byModel) {
      const acc = bucket.byModel.get(modelEntry.model) || {
        model: modelEntry.model,
        cost: 0,
        requests: 0,
        tokens: emptyTokens(),
        estimated: modelEntry.estimated,
        custom: modelEntry.custom
      };
      acc.cost += modelEntry.cost;
      acc.requests += modelEntry.requests;
      addTokens(acc.tokens, modelEntry.tokens);
      acc.estimated = acc.estimated || modelEntry.estimated;
      acc.custom = acc.custom || modelEntry.custom;
      bucket.byModel.set(modelEntry.model, acc);
    }
  }

  // 可覆盖区间：范围为“今年”但实际只有 30 天数据时，日均不能按 365 天算。
  const firstCoverable = ledger && ledger.firstRecordDate ? ledger.firstRecordDate : null;
  const lastCoverable = ledger && ledger.lastRecordDate
    ? (dayDiff(ledger.lastRecordDate, todayKey) > 0 ? ledger.lastRecordDate : todayKey)
    : todayKey;
  const coveredFrom = firstCoverable && dayDiff(fromKey, firstCoverable) > 0 ? firstCoverable : fromKey;
  const coveredTo = dayDiff(lastCoverable, toKey) > 0 ? lastCoverable : toKey;
  summary.coveredDays = Math.max(0, dayDiff(coveredFrom, coveredTo) + 1);
  if (dayDiff(fromKey, toKey) >= 0 && summary.coveredDays > summary.rangeDays) summary.coveredDays = summary.rangeDays;
  summary.avgPerDay = summary.coveredDays > 0 ? summary.totalCost / summary.coveredDays : 0;
  summary.byModel = Array.from(summaryByModel.values()).sort((a, b) => b.cost - a.cost || a.model.localeCompare(b.model));
  summary.estimated = estimatedSeen;

  const periodBuckets = Array.from(periodMap.values())
    .sort((a, b) => (a.fromKey < b.fromKey ? -1 : a.fromKey > b.fromKey ? 1 : 0));
  const partialKeys = new Set(
    periodBuckets
      .filter(bucket => isPeriodPartialInRange(bucket.key, granularity, fromKey, toKey))
      .map(bucket => bucket.key)
  );
  const periods = periodBuckets.map(bucket => {
    const partial = partialKeys.has(bucket.key);
    const inProgress = dayDiff(todayKey, bucket.toKey) > 0;
    const previousKey = previousPeriodKey(bucket.key, granularity);
    let previousCost = null;
    let previousIncomplete = false;
    let previousReason = null;
    if (previousKey) {
      if (partialKeys.has(previousKey)) {
        previousIncomplete = true;
        previousReason = 'partial-range';
      } else if (!isPeriodCompleteInLedger(ledger, previousKey, granularity)) {
        previousIncomplete = true;
        previousReason = 'before-ledger';
      } else {
        previousCost = costOfPeriod(ledger, previousKey, granularity, dayOptions);
        if (previousCost === null) previousReason = 'no-data';
      }
    }
    const changePct = previousCost !== null && previousCost > 0 ? (bucket.cost - previousCost) / previousCost : null;
    return {
      key: bucket.key,
      label: bucket.label,
      fromKey: bucket.fromKey,
      toKey: bucket.toKey,
      cost: bucket.cost,
      requests: bucket.requests,
      tokens: bucket.tokens,
      partial,
      inProgress,
      daysWithData: bucket.daysWithData,
      noRecordDays: bucket.noRecordDays,
      frozenDays: bucket.frozenDays,
      staleDays: bucket.staleDays,
      estimated: bucket.estimated,
      byModel: Array.from(bucket.byModel.values()).sort((a, b) => b.cost - a.cost || a.model.localeCompare(b.model)),
      previousCost,
      previousIncomplete,
      previousReason,
      changePct
    };
  });

  if (firstCoverable && dayDiff(fromKey, firstCoverable) > 0) {
    warnings.push({
      code: 'range-before-ledger',
      message: `所选范围早于可回溯的最早日期 ${firstCoverable}，更早的部分没有数据（不是消费为 0）。`
    });
  }
  if (summary.staleDays) {
    warnings.push({
      code: 'bucketing-stale',
      message: `${summary.staleDays} 天的峰谷口径已过期（日志缺失无法重算），金额仍按原分桶计算。`
    });
  }
  if (summary.frozenDays) {
    warnings.push({
      code: 'ledger-only',
      message: `${summary.frozenDays} 天仅有账本快照（本地日志已不在），无法复核。`
    });
  }
  if (estimatedSeen) {
    warnings.push({
      code: 'estimated-model',
      message: '存在未在价目表中的模型，相关金额按 Flash 价估算。'
    });
  }

  return {
    fromKey,
    toKey,
    todayKey,
    granularity,
    currency: dayOptions.currency,
    currencySymbol: dayOptions.currency === 'USD' ? '$' : '¥',
    days: daily,
    periods,
    summary,
    warnings
  };
}

/** 指定周期的完整金额（环比基线用；不受所选范围限制）。 */
function costOfPeriod(ledger, periodKey, granularity, dayOptions) {
  const range = periodRange(periodKey, granularity);
  if (!range) return null;
  const ledgerDays = (ledger && ledger.days) || {};
  let cost = 0;
  let any = false;
  for (const dateKey of eachDay(range.fromKey, range.toKey)) {
    const day = ledgerDays[dateKey];
    if (!day) continue;
    any = true;
    cost += summarizeDay(day, dayOptions).cost;
  }
  return any ? cost : null;
}

module.exports = {
  DAY_MS,
  GRANULARITIES,
  parseDayKey,
  addDays,
  dayDiff,
  eachDay,
  isoWeekInfo,
  isoWeekStartKey,
  periodKeyOf,
  periodRange,
  periodLabel,
  previousPeriodKey,
  resolveRange,
  defaultGranularity,
  summarizeDay,
  aggregateHistory,
  costOfPeriod
};
