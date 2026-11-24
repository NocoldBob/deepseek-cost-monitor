'use strict';

const os = require('os');
const path = require('path');
const vscode = require('vscode');
const { DEFAULT_HOLIDAYS, normalizeModel } = require('./pricing');

const SECTION = 'deepseekCostMonitor';

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function normalizePrefixes(raw) {
  if (!Array.isArray(raw)) return ['deepseek'];
  const seen = new Set();
  for (const item of raw) {
    const value = String(item || '').trim().toLowerCase();
    if (value) seen.add(value);
  }
  return Array.from(seen);
}

/**
 * 节假日是**整体替换**语义：用户设置非空数组时完全替代内置表；
 * 空数组或未设置表示“使用内置表”（2024–2027）。
 * 这条必须与 package.json 的默认值 [] 保持一致，否则内置的多年度表会被
 * 一个只含 2026 的默认值覆盖掉，回溯 2024/2025 时金额系统性偏高。
 */
function normalizeHolidays(raw) {
  const source = Array.isArray(raw) && raw.length ? raw : DEFAULT_HOLIDAYS;
  const out = [];
  for (const item of source) {
    const value = String(item || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) out.push(value);
  }
  return out;
}

function isFiniteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function sanitizeRateOverrides(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [model, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== 'object') continue;
    const normalized = normalizeModel(model);
    if (!normalized) continue;
    const currencies = {};
    for (const currency of ['CNY', 'USD']) {
      const rates = entry[currency];
      if (!rates || typeof rates !== 'object') continue;
      if (!isFiniteNonNegative(rates.cacheHit) || !isFiniteNonNegative(rates.cacheMiss) || !isFiniteNonNegative(rates.output)) continue;
      currencies[currency] = { cacheHit: rates.cacheHit, cacheMiss: rates.cacheMiss, output: rates.output };
    }
    if (Object.keys(currencies).length) out[normalized] = currencies;
  }
  return out;
}

function resolveProjectsRoot(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return path.join(os.homedir(), '.claude', 'projects');
  let resolved = value;
  if (resolved === '~') resolved = os.homedir();
  else if (resolved.startsWith('~/') || resolved.startsWith('~\\')) resolved = path.join(os.homedir(), resolved.slice(2));
  return path.resolve(resolved);
}

function readSettings() {
  const config = vscode.workspace.getConfiguration(SECTION);
  const holidays = normalizeHolidays(config.get('holidays', DEFAULT_HOLIDAYS));
  return {
    projectsRoot: resolveProjectsRoot(config.get('projectsPath', '')),
    modelPrefixes: normalizePrefixes(config.get('modelPrefixes', ['deepseek'])),
    currency: config.get('currency', 'CNY') === 'USD' ? 'USD' : 'CNY',
    rateOverrides: sanitizeRateOverrides(config.get('rateOverrides', {})),
    holidayList: holidays,
    holidays: new Set(holidays),
    refreshIntervalMs: Math.round(clamp(config.get('refreshIntervalSeconds', 30), 10, 3600)) * 1000,
    includeSubagents: config.get('includeSubagents', true) !== false,
    showStatusBar: config.get('showStatusBar', true) !== false
  };
}

module.exports = {
  readSettings,
  resolveProjectsRoot,
  sanitizeRateOverrides,
  normalizeHolidays,
  normalizePrefixes
};
