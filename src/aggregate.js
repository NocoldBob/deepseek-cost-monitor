'use strict';

/**
 * 日聚合层：把去重后的请求记录压成
 *   日 × 模型 × 主请求/子代理 × 高峰/低谷 × {requests, cacheMiss, cacheHit, cacheCreation, output}
 *
 * 三条不可违背的规则（见需求文档 §6.3 / §6.4 / §8.5）：
 * 1. 只存 token 与请求数，**不存金额**：金额永远在查询层按当次价目表算。
 * 2. **不做模型前缀过滤**：账本保存所有模型，改前缀后历史仍可重新过滤（Q4）。
 * 3. **不按 includeSubagents 过滤**：主子代理分桶保存，开关只影响查询（§8.5）。
 *    违反第 2、3 条会让“改设置”变成“丢历史”。
 *
 * 去重由 UsageStore 负责：本模块接收的是已按 message.id 去重的记录集合，
 * 一条 message.id 只应进入聚合一次。
 */

const { isPeak, dateKeyOfMs } = require('./pricing');

/** 账本桶的字段顺序即序列化顺序，改动需同步 §6.3。 */
const BUCKET_FIELDS = ['requests', 'cacheMiss', 'cacheHit', 'cacheCreation', 'output'];
const BUCKET_VARIANTS = ['peak', 'offpeak'];
const BUCKET_KINDS = ['main', 'subagent'];

function createBucket() {
  return { requests: 0, cacheMiss: 0, cacheHit: 0, cacheCreation: 0, output: 0 };
}

function createModelEntry() {
  return {
    main: { peak: createBucket(), offpeak: createBucket() },
    subagent: { peak: createBucket(), offpeak: createBucket() }
  };
}

function createDayEntry() {
  return { lastRecomputedAt: null, models: new Map() };
}

function createDayAgg() {
  return {
    days: new Map(),
    stats: { records: 0, accepted: 0, skipped: 0 }
  };
}

function toInt(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.floor(number);
}

function isSynthetic(record) {
  return record.model === '<synthetic>' || record.normalizedModel === '<synthetic>';
}

function ensureModelEntry(day, model) {
  let entry = day.models.get(model);
  if (!entry) {
    entry = createModelEntry();
    day.models.set(model, entry);
  }
  return entry;
}

function normalizeContext(context) {
  const source = context || {};
  return {
    holidays: source.holidays,
    nowMs: Number.isFinite(source.nowMs) ? source.nowMs : Date.now(),
    dateKeyOf: typeof source.dateKeyOf === 'function' ? source.dateKeyOf : dateKeyOfMs
  };
}

/**
 * 把一条记录累加进 dayAgg。返回是否计入。
 * 时间戳决定归属日与峰谷桶，不按“当前时刻”判断（§4.5）。
 */
function addRecord(agg, record, context) {
  const ctx = normalizeContext(context);
  agg.stats.records += 1;
  if (!record || !record.normalizedModel || !Number.isFinite(record.timestampMs)) {
    agg.stats.skipped += 1;
    return false;
  }
  if (isSynthetic(record)) {
    agg.stats.skipped += 1;
    return false;
  }
  const dateKey = ctx.dateKeyOf(record.timestampMs);
  let day = agg.days.get(dateKey);
  if (!day) {
    day = createDayEntry();
    agg.days.set(dateKey, day);
  }
  const modelEntry = ensureModelEntry(day, record.normalizedModel);
  const kind = record.isSubagent ? 'subagent' : 'main';
  const variant = isPeak(record.timestampMs, ctx.holidays) ? 'peak' : 'offpeak';
  const bucket = modelEntry[kind][variant];

  bucket.requests += 1;
  bucket.cacheMiss += toInt(record.inputTokens);
  bucket.cacheHit += toInt(record.cacheReadTokens);
  bucket.cacheCreation += toInt(record.cacheCreationTokens);
  bucket.output += toInt(record.outputTokens);
  day.lastRecomputedAt = ctx.nowMs;
  agg.stats.accepted += 1;
  return true;
}

/**
 * 从去重后的记录集合全量构建 dayAgg。
 * 采用“全量重算 + 调用方按版本号短路”，而不是在聚合里做增量累加：
 * UsageStore 在流式回复时会把同一 message.id 替换成更大的快照，
 * 增量累加会把这些修正重复计入。全量重算没有这个风险，10 万条量级也在毫秒级。
 */
function buildDayAgg(records, options) {
  const context = normalizeContext(options);
  const agg = createDayAgg();
  for (const record of records) addRecord(agg, record, context);
  return agg;
}

/** 逐字段取大：账本合并的唯一比较方式（§6.4）。 */
function maxBucketInto(target, source) {
  let changed = false;
  for (const field of BUCKET_FIELDS) {
    const next = toInt(source && source[field]);
    if (next > (target[field] || 0)) {
      target[field] = next;
      changed = true;
    }
  }
  return changed;
}

/** 把 dayAgg 的 Map 结构转成可直接 JSON 化的普通对象（供 ledger 写入）。 */
function dayAggToDays(agg) {
  const out = Object.create(null);
  for (const [dateKey, day] of agg.days) {
    const models = Object.create(null);
    for (const [model, entry] of day.models) {
      models[model] = {
        main: { peak: { ...entry.main.peak }, offpeak: { ...entry.main.offpeak } },
        subagent: { peak: { ...entry.subagent.peak }, offpeak: { ...entry.subagent.offpeak } }
      };
    }
    out[dateKey] = { lastRecomputedAt: day.lastRecomputedAt, models };
  }
  return out;
}

/** 反向转换，用于“从账本恢复后再次合并”与测试。 */
function daysToDayAgg(days) {
  const agg = createDayAgg();
  for (const dateKey of Object.keys(days || {})) {
    const raw = days[dateKey];
    if (!raw || typeof raw !== 'object') continue;
    const day = createDayEntry();
    day.lastRecomputedAt = Number.isFinite(raw.lastRecomputedAt) ? raw.lastRecomputedAt : null;
    for (const model of Object.keys(raw.models || {})) {
      const entry = createModelEntry();
      for (const kind of BUCKET_KINDS) {
        for (const variant of BUCKET_VARIANTS) {
          const bucket = raw.models[model] && raw.models[model][kind] && raw.models[model][kind][variant];
          if (!bucket) continue;
          for (const field of BUCKET_FIELDS) entry[kind][variant][field] = toInt(bucket[field]);
        }
      }
      day.models.set(model, entry);
    }
    agg.days.set(dateKey, day);
  }
  return agg;
}

/** 供诊断与测试使用：某个日聚合的合计 token / 请求数。 */
function dayTotals(day) {
  const totals = { requests: 0, cacheMiss: 0, cacheHit: 0, cacheCreation: 0, output: 0 };
  if (!day || !day.models) return totals;
  const entries = day.models instanceof Map ? day.models.values() : Object.values(day.models);
  for (const entry of entries) {
    for (const kind of BUCKET_KINDS) {
      for (const variant of BUCKET_VARIANTS) {
        const bucket = entry[kind] && entry[kind][variant];
        if (!bucket) continue;
        for (const field of BUCKET_FIELDS) totals[field] += toInt(bucket[field]);
      }
    }
  }
  return totals;
}

module.exports = {
  BUCKET_FIELDS,
  BUCKET_VARIANTS,
  BUCKET_KINDS,
  createBucket,
  createModelEntry,
  createDayEntry,
  createDayAgg,
  addRecord,
  buildDayAgg,
  maxBucketInto,
  dayAggToDays,
  daysToDayAgg,
  dayTotals
};
