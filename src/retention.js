'use strict';

/**
 * 只读探测 Claude Code 的 cleanupPeriodDays（FR-19）。
 *
 * 严禁写入、创建或修改 settings.json；读不到/解析失败/权限不足均静默返回。
 * 检出值只用于提示和诊断，不参与任何金额、分桶或账本计算。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function configDirFromEnv(env) {
  const source = env || process.env;
  const raw = source && typeof source.CLAUDE_CONFIG_DIR === 'string' ? source.CLAUDE_CONFIG_DIR.trim() : '';
  if (raw) return path.resolve(raw);
  return path.join(os.homedir(), '.claude');
}

function readCleanupPeriodDays(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const configDir = opts.configDir ? path.resolve(opts.configDir) : configDirFromEnv(env);
  const settingsPath = path.join(configDir, 'settings.json');
  const result = {
    found: false,
    days: null,
    path: settingsPath,
    error: null
  };
  let text;
  try {
    text = fs.readFileSync(settingsPath, 'utf8');
  } catch (error) {
    if (error && error.code !== 'ENOENT') result.error = error.message;
    return result;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    result.error = 'JSON 解析失败';
    return result;
  }
  const raw = data && data.cleanupPeriodDays;
  const days = Number(raw);
  if (!Number.isFinite(days) || days <= 0) return result;
  result.found = true;
  result.days = Math.floor(days);
  return result;
}

module.exports = { readCleanupPeriodDays, configDirFromEnv };
