'use strict';

const os = require('os');
const path = require('path');
const { TranscriptScanner } = require('../src/scanner');
const { UsageStore, buildSnapshot } = require('../src/usage');
const { DEFAULT_HOLIDAYS, runPricingAssertions } = require('../src/pricing');

const args = process.argv.slice(2);

function argValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

const projectsRoot = path.resolve(argValue('--projects') || path.join(os.homedir(), '.claude', 'projects'));
const currency = (argValue('--currency') || 'CNY') === 'USD' ? 'USD' : 'CNY';
const dateArg = argValue('--date');
const nowMs = dateArg ? Date.parse(dateArg + 'T12:00:00+08:00') : Date.now();
const includeSubagents = !args.includes('--exclude-subagents');
const prefixesArg = argValue('--prefixes');
const modelPrefixes = prefixesArg
  ? prefixesArg.split(',').map(item => item.trim().toLowerCase()).filter(Boolean)
  : ['deepseek'];
const holidays = new Set(DEFAULT_HOLIDAYS);

const settings = {
  projectsRoot,
  modelPrefixes,
  currency,
  rateOverrides: {},
  holidayList: DEFAULT_HOLIDAYS,
  holidays,
  includeSubagents
};

(async () => {
  const scanner = new TranscriptScanner();
  const store = new UsageStore();
  const scanInfo = await scanner.scanAll(projectsRoot, (row, file) => store.add(row, file));
  scanInfo.mode = 'full';
  const snapshot = buildSnapshot(store, scanInfo, settings, nowMs);
  const pricingAssertions = runPricingAssertions();
  const payload = {
    generatedAt: new Date().toISOString(),
    settings: {
      projectsRoot,
      modelPrefixes,
      currency,
      includeSubagents,
      holidays: DEFAULT_HOLIDAYS,
      rateOverrides: {}
    },
    pricingAssertions,
    snapshot,
    files: scanner.getFileStats()
  };
  console.log(`日期：${snapshot.dayLabel}（${snapshot.dayKey}）`);
  console.log(`金额：${snapshot.currencySymbol}${snapshot.totals.cost.toFixed(6)} · 请求 ${snapshot.totals.requests}`);
  console.log(`扫描：${scanInfo.files} 个文件，${scanInfo.bytesRead} 字节，assistant 行 ${scanInfo.assistantRows}，坏行 ${scanInfo.malformedLines}`);
  for (const model of snapshot.byModel) {
    console.log(`模型 ${model.model}：${model.requests} 次 · ${snapshot.currencySymbol}${model.cost.toFixed(6)}`);
  }
  for (const session of snapshot.bySession) {
    console.log(`会话 #${session.shortId} ${session.cwdLabel}：${session.requests} 次 · ${snapshot.currencySymbol}${session.cost.toFixed(6)}`);
  }
  for (const item of pricingAssertions) {
    console.log(`${item.ok ? '[PASS]' : '[FAIL]'} ${item.name} expected=${item.expected} actual=${item.actual}`);
  }
  console.log('SELFTEST_JSON ' + JSON.stringify(payload));
  if (!pricingAssertions.every(item => item.ok)) process.exitCode = 1;
})().catch(error => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
