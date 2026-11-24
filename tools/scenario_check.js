'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { TranscriptScanner } = require('../src/scanner');
const { UsageStore, buildSnapshot } = require('../src/usage');
const { DEFAULT_HOLIDAYS } = require('../src/pricing');

const results = [];

function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition), detail: detail === undefined ? null : detail });
}

function close(name, actual, expected, tolerance) {
  const ok = Math.abs(actual - expected) <= tolerance;
  check(name, ok, { actual, expected });
}

function snapshotOf(store, scanInfo, settings, nowMs) {
  return buildSnapshot(store, scanInfo, settings, nowMs);
}

function assistantLine(options) {
  const row = {
    type: 'assistant',
    message: {
      id: options.id,
      model: options.model,
      usage: {
        input_tokens: options.input || 0,
        output_tokens: options.output || 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: options.cacheRead || 0
      }
    },
    timestamp: options.timestamp,
    sessionId: options.sessionId,
    cwd: options.cwd,
    isSidechain: Boolean(options.isSidechain)
  };
  let text = JSON.stringify(row);
  if (options.spaced) text = text.replace('"type":"assistant"', '"type": "assistant"');
  return text;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dscm-fixture-'));
const alphaDir = path.join(root, 'proj-alpha');
const subagentDir = path.join(alphaDir, 'sessA', 'subagents');
const betaDir = path.join(root, 'proj-beta');
const lateDir = path.join(root, 'proj-late', 'nested');
fs.mkdirSync(subagentDir, { recursive: true });
fs.mkdirSync(betaDir, { recursive: true });

const fileA = path.join(alphaDir, 'sessionA.jsonl');
const fileSub = path.join(subagentDir, 'agent-1.jsonl');
const fileB = path.join(betaDir, 'sessionB.jsonl');

const settings = {
  projectsRoot: root,
  modelPrefixes: ['deepseek'],
  currency: 'CNY',
  rateOverrides: {},
  holidayList: DEFAULT_HOLIDAYS,
  holidays: new Set(DEFAULT_HOLIDAYS),
  includeSubagents: true
};
const nowMs = Date.parse('2026-11-24T23:00:00+08:00');

const m1a = assistantLine({
  id: 'msg_m1', model: 'deepseek-flash', timestamp: '2026-11-24T10:00:00.000+08:00',
  sessionId: 'sessA', cwd: 'D:\\work\\alpha', input: 1000000, cacheRead: 1000000, output: 500000
});
const m1b = assistantLine({
  id: 'msg_m1', model: 'deepseek-flash[1m]', timestamp: '2026-11-24T10:00:00.000+08:00',
  sessionId: 'sessA', cwd: 'D:\\work\\alpha', input: 1000000, cacheRead: 1000000, output: 1000000,
  spaced: true
});
const userLine = JSON.stringify({
  type: 'user', message: { role: 'user', content: 'hello' },
  timestamp: '2026-11-24T09:59:00.000+08:00', sessionId: 'sessA', cwd: 'D:\\work\\alpha'
});
const m2 = assistantLine({
  id: 'msg_m2', model: 'deepseek-flash', timestamp: '2026-11-24T12:30:00.000+08:00',
  sessionId: 'sessA', cwd: 'D:\\work\\alpha', input: 500000, output: 100000
});
fs.writeFileSync(fileA, '\ufeff' + m1a + '\r\n' + m1b + '\n' + userLine + '\n' + m2 + '\n');

const m3 = assistantLine({
  id: 'msg_m3', model: 'deepseek-flash', timestamp: '2026-11-24T15:00:00.000+08:00',
  sessionId: 'sessA', cwd: 'D:\\work\\alpha', cacheRead: 2000000, isSidechain: true
});
fs.writeFileSync(fileSub, m3 + '\n');

const m4 = assistantLine({
  id: 'msg_m4', model: 'k3-256k', timestamp: '2026-11-24T11:00:00.000+08:00',
  sessionId: 'sessB', cwd: 'D:\\work\\beta', input: 1000, output: 1000
});
const synth = assistantLine({
  id: 'msg_synth', model: '<synthetic>', timestamp: '2026-11-24T11:01:00.000+08:00',
  sessionId: 'sessB', cwd: 'D:\\work\\beta', input: 10, output: 10
});
const m6 = assistantLine({
  id: 'msg_m6', model: 'deepseek-v5-experimental', timestamp: '2026-11-24T09:30:00.000+08:00',
  sessionId: 'sessB', cwd: 'D:\\work\\beta', input: 1000, output: 100
});
fs.writeFileSync(fileB, m4 + '\n' + synth + '\n' + m6 + '\n');

(async () => {
const scanner = new TranscriptScanner();
const store = new UsageStore();
const scanAllInfo = await scanner.scanAll(root, (row, file) => store.add(row, file));
let snapshot = snapshotOf(store, { ...scanAllInfo, mode: 'full' }, settings, nowMs);

check('初始文件数', scanAllInfo.files === 3, scanAllInfo.files);
check('初始请求数', snapshot.totals.requests === 4, snapshot.totals.requests);
close('初始金额', snapshot.totals.cost, 11.0228, 1e-9);
check('初始未命中输入', snapshot.totals.tokens.cacheMiss === 1501000, snapshot.totals.tokens.cacheMiss);
check('初始命中缓存', snapshot.totals.tokens.cacheHit === 3000000, snapshot.totals.tokens.cacheHit);
check('初始输出', snapshot.totals.tokens.output === 1100100, snapshot.totals.tokens.output);
check('初始排除非 DeepSeek', snapshot.excluded.nonDeepseekRequests === 1, snapshot.excluded);
check('初始忽略系统消息', snapshot.excluded.syntheticRequests === 1, snapshot.excluded);
check('初始未知模型警告', snapshot.warnings.length === 1 && snapshot.warnings[0].code === 'unknown-model', snapshot.warnings);
const estimatedEntry = snapshot.byModel.find(item => item.model === 'deepseek-v5-experimental');
check('未知模型标记估算', Boolean(estimatedEntry && estimatedEntry.estimated), estimatedEntry);

const m5 = assistantLine({
  id: 'msg_m5', model: 'deepseek-flash', timestamp: '2026-11-24T20:00:00.000+08:00',
  sessionId: 'sessB', cwd: 'D:\\work\\beta', input: 100, output: 50
});
const splitAt = Math.floor(m5.length / 2);
fs.appendFileSync(fileB, m5.slice(0, splitAt));
let incremental = await scanner.scanIncremental(root, (row, file) => store.add(row, file));
check('增量扫描未重建', incremental.needsRebuild === false, incremental);
const stateB = scanner.files.get(fileB);
check('半行已缓冲', Boolean(stateB && stateB.pending.length > 0), stateB ? stateB.pending.length : null);
snapshot = snapshotOf(store, { ...incremental, mode: 'incremental' }, settings, nowMs);
check('半行未计入请求', snapshot.totals.requests === 4, snapshot.totals.requests);

fs.appendFileSync(fileB, m5.slice(splitAt) + '\n');
incremental = await scanner.scanIncremental(root, (row, file) => store.add(row, file));
snapshot = snapshotOf(store, { ...incremental, mode: 'incremental' }, settings, nowMs);
check('半行补齐后计入', snapshot.totals.requests === 5, snapshot.totals.requests);
close('半行补齐后金额', snapshot.totals.cost, 11.0231, 1e-9);

const m1c = assistantLine({
  id: 'msg_m1', model: 'deepseek-flash', timestamp: '2026-11-24T10:00:00.000+08:00',
  sessionId: 'sessA', cwd: 'D:\\work\\alpha', input: 1000000, cacheRead: 1000000, output: 2000000
});
fs.appendFileSync(fileA, m1c + '\n');
incremental = await scanner.scanIncremental(root, (row, file) => store.add(row, file));
snapshot = snapshotOf(store, { ...incremental, mode: 'incremental' }, settings, nowMs);
check('重复 message.id 不增请求', snapshot.totals.requests === 5, snapshot.totals.requests);
close('重复快照取最大输出', snapshot.totals.cost, 19.0231, 1e-9);

fs.mkdirSync(lateDir, { recursive: true });
const fileC = path.join(lateDir, 'sessionC.jsonl');
const m7 = assistantLine({
  id: 'msg_m7', model: 'deepseek-flash', timestamp: '2026-11-24T19:00:00.000+08:00',
  sessionId: 'sessC', cwd: 'D:\\work\\gamma', output: 1000
});
fs.writeFileSync(fileC, m7 + '\n');
incremental = await scanner.scanIncremental(root, (row, file) => store.add(row, file));
snapshot = snapshotOf(store, { ...incremental, mode: 'incremental' }, settings, nowMs);

check('新增文件自动纳入', incremental.files === 4, incremental.files);
check('最终请求数', snapshot.totals.requests === 6, snapshot.totals.requests);
close('最终金额', snapshot.totals.cost, 19.0271, 1e-9);
check('最终未命中输入', snapshot.totals.tokens.cacheMiss === 1501100, snapshot.totals.tokens.cacheMiss);
check('最终命中缓存', snapshot.totals.tokens.cacheHit === 3000000, snapshot.totals.tokens.cacheHit);
check('最终输出', snapshot.totals.tokens.output === 2101150, snapshot.totals.tokens.output);
check('最终合计', snapshot.totals.tokens.total === 6602250, snapshot.totals.tokens.total);
check('扫描行数', store.stats.assistantRows === 10, store.stats.assistantRows);
check('去重统计', store.stats.accepted === 8 && store.stats.duplicates === 2 && store.stats.skipped === 0, store.stats);

const sessionA = snapshot.bySession.find(item => item.sessionId === 'sessA');
const sessionB = snapshot.bySession.find(item => item.sessionId === 'sessB');
const sessionC = snapshot.bySession.find(item => item.sessionId === 'sessC');
check('会话A归组', Boolean(sessionA && sessionA.requests === 3 && sessionA.includesSubagents), sessionA);
check('会话B归组', Boolean(sessionB && sessionB.requests === 2), sessionB);
check('会话C归组', Boolean(sessionC && sessionC.requests === 1 && sessionC.cwdLabel === 'gamma'), sessionC);
close('会话A金额', sessionA ? sessionA.cost : -1, 19.02, 1e-9);
close('会话B金额', sessionB ? sessionB.cost : -1, 0.0031, 1e-9);
close('会话C金额', sessionC ? sessionC.cost : -1, 0.004, 1e-9);

const flashEntry = snapshot.byModel.find(item => item.model === 'deepseek-flash');
check('Flash模型请求数', Boolean(flashEntry && flashEntry.requests === 5), flashEntry);
close('Flash模型金额', flashEntry ? flashEntry.cost : -1, 19.0243, 1e-9);

const noSubSettings = { ...settings, includeSubagents: false };
const noSubSnapshot = snapshotOf(store, { ...incremental, mode: 'incremental' }, noSubSettings, nowMs);
check('排除子代理请求数', noSubSnapshot.totals.requests === 5, noSubSnapshot.totals.requests);
close('排除子代理金额', noSubSnapshot.totals.cost, 18.9471, 1e-9);
check('排除子代理后会话A', noSubSnapshot.bySession.find(item => item.sessionId === 'sessA').requests === 2);

const nextDay = snapshotOf(store, { ...incremental, mode: 'incremental' }, settings, Date.parse('2026-11-25T12:00:00+08:00'));
check('本地日窗口过滤', nextDay.totals.requests === 0 && nextDay.totals.cost === 0, nextDay.totals);

const freshScanner = new TranscriptScanner();
const freshStore = new UsageStore();
const freshScan = await freshScanner.scanAll(root, (row, file) => freshStore.add(row, file));
const freshSnapshot = snapshotOf(freshStore, { ...freshScan, mode: 'full' }, settings, nowMs);
const compareKeys = ['totals', 'byModel', 'bySession', 'excluded', 'warnings'];
const incrementalComparable = JSON.stringify(Object.fromEntries(compareKeys.map(key => [key, snapshot[key]])));
const freshComparable = JSON.stringify(Object.fromEntries(compareKeys.map(key => [key, freshSnapshot[key]])));
check('增量与全量结果一致', incrementalComparable === freshComparable, null);

const truncRoot = root + '-trunc';
fs.cpSync(root, truncRoot, { recursive: true });
const truncScanner = new TranscriptScanner();
const truncStore = new UsageStore();
await truncScanner.scanAll(truncRoot, (row, file) => truncStore.add(row, file));
const truncFile = path.join(truncRoot, 'proj-alpha', 'sessionA.jsonl');
const truncSize = fs.statSync(truncFile).size;
fs.truncateSync(truncFile, truncSize - 10);
const truncResult = await truncScanner.scanIncremental(truncRoot, (row, file) => truncStore.add(row, file));
check('文件截断触发重建', truncResult.needsRebuild === true, truncResult);

for (const item of results) {
  console.log(`${item.ok ? '[PASS]' : '[FAIL]'} ${item.name}${item.detail === null ? '' : ' ' + JSON.stringify(item.detail)}`);
}
const failed = results.filter(item => !item.ok).length;
console.log(`SUMMARY pass=${results.length - failed} fail=${failed}`);
console.log('SELFTEST_JSON ' + JSON.stringify({
  generatedAt: new Date().toISOString(),
  fixtureRoot: root,
  truncRoot,
  settings: {
    projectsRoot: root,
    modelPrefixes: settings.modelPrefixes,
    currency: settings.currency,
    includeSubagents: true,
    holidays: DEFAULT_HOLIDAYS,
    rateOverrides: {}
  },
  snapshot,
  files: scanner.getFileStats()
}));
if (failed) process.exitCode = 1;
})().catch(error => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
