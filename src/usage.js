'use strict';

const {
  normalizeModel,
  isIncludedModel,
  localDayInfo,
  currentMarketMode,
  resolveRateInfo,
  requestCost
} = require('./pricing');

function emptyTokens() {
  return { cacheMiss: 0, cacheHit: 0, cacheCreation: 0, output: 0, total: 0 };
}

function toTokenCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.floor(number);
}

function addTokens(target, record) {
  target.cacheMiss += record.inputTokens;
  target.cacheHit += record.cacheReadTokens;
  target.cacheCreation += record.cacheCreationTokens;
  target.output += record.outputTokens;
  target.total = target.cacheMiss + target.cacheHit + target.output;
}

function deriveSessionId(filePath) {
  const parts = String(filePath || '').split(/[\\/]/).filter(Boolean);
  for (let index = parts.length - 1; index >= 0; index--) {
    if (parts[index].toLowerCase() === 'subagents' && index > 0) return parts[index - 1];
  }
  const base = parts[parts.length - 1] || 'unknown';
  return base.replace(/\.jsonl$/i, '') || 'unknown';
}

function baseName(value) {
  const parts = String(value || '').replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || '未知项目';
}

function isBetterSnapshot(next, previous) {
  if (next.outputTokens !== previous.outputTokens) return next.outputTokens > previous.outputTokens;
  if (next.timestampMs !== previous.timestampMs) return next.timestampMs > previous.timestampMs;
  return (next.inputTokens + next.cacheReadTokens) > (previous.inputTokens + previous.cacheReadTokens);
}

function pad2(value) {
  return value < 10 ? '0' + value : String(value);
}

function formatTime(ms) {
  const date = new Date(ms + 8 * 60 * 60 * 1000);
  return `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`;
}

class UsageStore {
  constructor() {
    this.records = new Map();
    this.stats = { assistantRows: 0, accepted: 0, skipped: 0, duplicates: 0 };
  }

  clear() {
    this.records.clear();
    this.stats = { assistantRows: 0, accepted: 0, skipped: 0, duplicates: 0 };
  }

  add(row, sourceFile) {
    this.stats.assistantRows += 1;
    const message = row && row.message;
    if (!message || typeof message !== 'object' || !message.usage || typeof message.usage !== 'object') {
      this.stats.skipped += 1;
      return;
    }
    const messageId = typeof message.id === 'string' ? message.id : '';
    const timestampMs = Date.parse(row.timestamp);
    const model = typeof message.model === 'string' ? message.model : '';
    if (!messageId || !Number.isFinite(timestampMs) || !model) {
      this.stats.skipped += 1;
      return;
    }
    const usage = message.usage;
    const record = {
      messageId,
      timestampMs,
      model,
      normalizedModel: normalizeModel(model),
      sessionId: typeof row.sessionId === 'string' && row.sessionId ? row.sessionId : deriveSessionId(sourceFile),
      cwd: typeof row.cwd === 'string' ? row.cwd : null,
      isSubagent: Boolean(row.isSidechain) || /[\\/]subagents[\\/]/i.test(String(sourceFile)),
      inputTokens: toTokenCount(usage.input_tokens),
      cacheReadTokens: toTokenCount(usage.cache_read_input_tokens),
      cacheCreationTokens: toTokenCount(usage.cache_creation_input_tokens),
      outputTokens: toTokenCount(usage.output_tokens),
      sourceFile
    };
    const previous = this.records.get(messageId);
    if (!previous) {
      this.records.set(messageId, record);
      this.stats.accepted += 1;
      return;
    }
    this.stats.duplicates += 1;
    if (isBetterSnapshot(record, previous)) this.records.set(messageId, record);
  }
}

function buildSnapshot(store, scanInfo, settings, nowMs) {
  const day = localDayInfo(nowMs);
  const currency = settings.currency === 'USD' ? 'USD' : 'CNY';
  const totals = { cost: 0, requests: 0, tokens: emptyTokens() };
  const byModel = new Map();
  const bySession = new Map();
  const excludedModels = new Map();
  const unknownModels = new Set();
  let syntheticCount = 0;
  let excludedRequests = 0;

  for (const record of store.records.values()) {
    if (record.timestampMs < day.startMs || record.timestampMs >= day.endMs) continue;
    if (!settings.includeSubagents && record.isSubagent) continue;
    if (record.model === '<synthetic>' || record.normalizedModel === '<synthetic>') {
      syntheticCount += 1;
      continue;
    }
    if (!isIncludedModel(record.normalizedModel, settings.modelPrefixes)) {
      excludedRequests += 1;
      const key = record.model || '(未知)';
      excludedModels.set(key, (excludedModels.get(key) || 0) + 1);
      continue;
    }

    const rateInfo = resolveRateInfo(record.normalizedModel, settings);
    if (rateInfo.estimated) unknownModels.add(record.normalizedModel);
    const cost = requestCost(record, rateInfo, settings.holidays);

    totals.cost += cost;
    totals.requests += 1;
    addTokens(totals.tokens, record);

    let modelEntry = byModel.get(record.normalizedModel);
    if (!modelEntry) {
      modelEntry = {
        model: record.normalizedModel,
        requests: 0,
        cost: 0,
        tokens: emptyTokens(),
        estimated: false,
        custom: false
      };
      byModel.set(record.normalizedModel, modelEntry);
    }
    modelEntry.requests += 1;
    modelEntry.cost += cost;
    addTokens(modelEntry.tokens, record);
    if (rateInfo.estimated) modelEntry.estimated = true;
    if (rateInfo.custom) modelEntry.custom = true;

    const sessionKey = record.sessionId || 'unknown';
    let sessionEntry = bySession.get(sessionKey);
    if (!sessionEntry) {
      sessionEntry = {
        sessionId: sessionKey,
        shortId: sessionKey.slice(0, 8),
        cwdLabel: '',
        requests: 0,
        cost: 0,
        tokens: emptyTokens(),
        includesSubagents: false,
        _lastTs: 0
      };
      bySession.set(sessionKey, sessionEntry);
    }
    sessionEntry.requests += 1;
    sessionEntry.cost += cost;
    addTokens(sessionEntry.tokens, record);
    if (record.isSubagent) sessionEntry.includesSubagents = true;
    if (record.cwd && (!sessionEntry.cwdLabel || record.timestampMs >= sessionEntry._lastTs)) {
      sessionEntry.cwdLabel = baseName(record.cwd);
    }
    if (record.timestampMs >= sessionEntry._lastTs) sessionEntry._lastTs = record.timestampMs;
  }

  const models = Array.from(byModel.values())
    .sort((a, b) => b.cost - a.cost || a.model.localeCompare(b.model));
  const sessions = Array.from(bySession.values())
    .map(entry => ({
      sessionId: entry.sessionId,
      shortId: entry.shortId,
      cwdLabel: entry.cwdLabel || '未知项目',
      requests: entry.requests,
      cost: entry.cost,
      tokens: entry.tokens,
      includesSubagents: entry.includesSubagents
    }))
    .sort((a, b) => b.cost - a.cost || a.sessionId.localeCompare(b.sessionId));

  const warnings = [];
  if (unknownModels.size) {
    warnings.push({
      code: 'unknown-model',
      message: `模型 ${Array.from(unknownModels).join('、')} 未在价目表中，已按 Flash 价估算。`
    });
  }

  return {
    schemaVersion: 1,
    loading: false,
    error: null,
    dayKey: day.key,
    dayLabel: day.label,
    updatedAtMs: nowMs,
    updatedLabel: formatTime(nowMs),
    currency,
    currencySymbol: currency === 'USD' ? '$' : '¥',
    market: currentMarketMode(nowMs, settings.holidays),
    totals: { cost: totals.cost, requests: totals.requests, tokens: totals.tokens },
    byModel: models,
    bySession: sessions,
    excluded: {
      nonDeepseekRequests: excludedRequests,
      nonDeepseekModels: Array.from(excludedModels.keys()),
      nonDeepseekBreakdown: Array.from(excludedModels.entries()).map(([model, requests]) => ({ model, requests })),
      syntheticRequests: syntheticCount
    },
    warnings,
    scan: scanInfo || null,
    store: { ...store.stats },
    settings: {
      projectsRoot: settings.projectsRoot,
      modelPrefixes: settings.modelPrefixes,
      includeSubagents: settings.includeSubagents
    }
  };
}

module.exports = { UsageStore, buildSnapshot, emptyTokens };
