'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildDayAgg, dayAggToDays, dayTotals } = require('../src/aggregate');
const ledgerModule = require('../src/ledger');
const {
  SCHEMA_VERSION,
  computeBucketSignature,
  createLedger,
  validateLedger,
  mergeDays,
  mergeLiveDay,
  serializeLedger,
  hashText,
  readLedgerSync,
  writeLedgerAtomicSync,
  cleanupTempFilesSync,
  clearLedgerSync,
  ledgerSummary,
  ledgerPathFor
} = ledgerModule;

const NOW = Date.parse('2026-11-24T20:00:00+08:00');
const LATER = Date.parse('2026-11-24T21:00:00+08:00');
const NO_HOLIDAY = new Set();
const PEAK_TS = Date.parse('2026-11-24T10:00:00+08:00');

function record(overrides) {
  return {
    messageId: 'm1',
    timestampMs: PEAK_TS,
    model: 'deepseek-flash',
    normalizedModel: 'deepseek-flash',
    isSubagent: false,
    inputTokens: 1000,
    cacheReadTokens: 2000,
    cacheCreationTokens: 0,
    outputTokens: 800,
    ...overrides
  };
}

function daysFor(records, options) {
  const opts = options || {};
  return dayAggToDays(buildDayAgg(records, { holidays: opts.holidays || NO_HOLIDAY, nowMs: opts.nowMs || NOW }));
}

function newLedger(holidays) {
  return createLedger({ installDate: '2026-11-01', bucketSignature: computeBucketSignature(holidays || NO_HOLIDAY), nowMs: NOW });
}

function totalsOf(ledger, dateKey) {
  return dayTotals(ledger.days[dateKey]);
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dscm-ledger-'));
}

test('bucketSignature 对表项顺序不敏感、对内容敏感', () => {
  const a = computeBucketSignature(['2026-10-01', '2026-01-01']);
  const b = computeBucketSignature(['2026-01-01', '2026-10-01', '2026-01-01']);
  const c = computeBucketSignature(['2026-01-01']);
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c);
  assert.strictEqual(a.length, 12);
});

test('首次合并写入新日期', () => {
  const ledger = newLedger();
  const stats = mergeDays(ledger, daysFor([record({})]), { bucketSignature: ledger.bucketSignature, nowMs: NOW });
  assert.strictEqual(stats.added, 1);
  assert.strictEqual(stats.changed, true);
  assert.strictEqual(ledger.firstRecordDate, '2026-11-24');
  assert.strictEqual(totalsOf(ledger, '2026-11-24').output, 800);
});

test('合并幂等：连写 20 次结果完全不变', () => {
  const ledger = newLedger();
  const days = daysFor([record({}), record({ messageId: 'm2', outputTokens: 200 })]);
  mergeDays(ledger, days, { bucketSignature: ledger.bucketSignature, nowMs: NOW });
  const first = serializeLedger(ledger);
  for (let index = 0; index < 20; index += 1) {
    const stats = mergeDays(ledger, days, { bucketSignature: ledger.bucketSignature, nowMs: NOW });
    assert.strictEqual(stats.changed, false, `第 ${index + 1} 次不应有变化`);
  }
  assert.strictEqual(serializeLedger(ledger), first);
});

test('合并单调：日志被删后重算值变小，旧值保留（FR-02）', () => {
  const ledger = newLedger();
  mergeDays(ledger, daysFor([record({}), record({ messageId: 'm2', outputTokens: 200 })]), {
    bucketSignature: ledger.bucketSignature,
    nowMs: NOW
  });
  // 模拟删掉一条日志：重算只剩一条，值更小
  const stats = mergeDays(ledger, daysFor([record({})]), { bucketSignature: ledger.bucketSignature, nowMs: LATER });
  assert.strictEqual(stats.changed, false);
  assert.strictEqual(totalsOf(ledger, '2026-11-24').output, 1000);
  assert.strictEqual(totalsOf(ledger, '2026-11-24').requests, 2);
});

test('日志消失的日期永不删除', () => {
  const ledger = newLedger();
  mergeDays(ledger, daysFor([record({})]), { bucketSignature: ledger.bucketSignature, nowMs: NOW });
  const nextDay = daysFor([record({ messageId: 'm9', timestampMs: Date.parse('2026-11-25T10:00:00+08:00') })]);
  mergeDays(ledger, nextDay, { bucketSignature: ledger.bucketSignature, nowMs: LATER });
  assert.ok(ledger.days['2026-11-24'], '前一天的日志虽已不在本轮扫描中，但账本必须保留');
  assert.strictEqual(ledger.firstRecordDate, '2026-11-24');
  assert.strictEqual(ledger.lastRecordDate, '2026-11-25');
});

test('口径变化时整日替换，防止同一条请求双计', () => {
  const holidaysA = new Set();
  const holidaysB = new Set(['2026-11-24']);
  const ledger = newLedger(holidaysA);
  mergeDays(ledger, daysFor([record({})], { holidays: holidaysA }), {
    bucketSignature: computeBucketSignature(holidaysA),
    nowMs: NOW
  });
  assert.strictEqual(totalsOf(ledger, '2026-11-24').output, 800, '口径 A：落在高峰桶');

  const stats = mergeDays(ledger, daysFor([record({})], { holidays: holidaysB }), {
    bucketSignature: computeBucketSignature(holidaysB),
    nowMs: LATER
  });
  assert.strictEqual(stats.replaced, 1);
  const totals = totalsOf(ledger, '2026-11-24');
  assert.strictEqual(totals.output, 800, '换口径是替换而非叠加，总 token 不能翻倍');
  assert.strictEqual(ledger.days['2026-11-24'].bucketingStale, false);
  assert.strictEqual(ledger.bucketSignature, computeBucketSignature(holidaysB));
});

test('口径变化时，日志已消失的日期保留原值并标 bucketingStale', () => {
  const holidaysA = new Set();
  const holidaysB = new Set(['2026-10-01']);
  const ledger = newLedger(holidaysA);
  mergeDays(ledger, daysFor([record({})], { holidays: holidaysA }), {
    bucketSignature: computeBucketSignature(holidaysA),
    nowMs: NOW
  });
  // 本轮只扫描到 11-25，11-24 的日志被视为已消失
  const nextDays = daysFor([record({ messageId: 'm9', timestampMs: Date.parse('2026-11-25T10:00:00+08:00') })], {
    holidays: holidaysB
  });
  const stats = mergeDays(ledger, nextDays, { bucketSignature: computeBucketSignature(holidaysB), nowMs: LATER });
  assert.strictEqual(stats.frozen, 1);
  assert.strictEqual(ledger.days['2026-11-24'].bucketingStale, true);
  assert.strictEqual(totalsOf(ledger, '2026-11-24').output, 800, '冻结的日期数值不变');
});

test('replace 模式（FR-16 重建）清掉无日志的日期', () => {
  const ledger = newLedger();
  mergeDays(ledger, daysFor([record({})]), { bucketSignature: ledger.bucketSignature, nowMs: NOW });
  mergeDays(ledger, daysFor([record({ messageId: 'm9', timestampMs: Date.parse('2026-11-25T10:00:00+08:00') })]), {
    bucketSignature: ledger.bucketSignature,
    nowMs: LATER
  });
  assert.strictEqual(Object.keys(ledger.days).length, 2);

  const stats = mergeDays(ledger, daysFor([record({})]), {
    bucketSignature: ledger.bucketSignature,
    nowMs: LATER,
    mode: 'replace'
  });
  assert.strictEqual(stats.replaced, 1);
  assert.deepStrictEqual(Object.keys(ledger.days), ['2026-11-24'], '重建是 replace 语义，无日志的日期被清除');
});

test('实时快照兜底今天：只取大、不改 lastRecomputedAt', () => {
  const ledger = newLedger();
  mergeDays(ledger, daysFor([record({})]), { bucketSignature: ledger.bucketSignature, nowMs: NOW });
  const recomputedAt = ledger.days['2026-11-24'].lastRecomputedAt;

  const live = { models: { 'deepseek-flash': { main: { peak: { requests: 2, cacheMiss: 1000, cacheHit: 2000, cacheCreation: 0, output: 1600 }, offpeak: null }, subagent: null } } };
  const result = mergeLiveDay(ledger, live, '2026-11-24');
  assert.strictEqual(result.changed, true);
  assert.strictEqual(totalsOf(ledger, '2026-11-24').output, 1600);
  assert.strictEqual(ledger.days['2026-11-24'].lastRecomputedAt, recomputedAt, '实时值不代表“已从日志复核”');

  const unchanged = mergeLiveDay(ledger, live, '2026-11-24');
  assert.strictEqual(unchanged.changed, false);
});

test('实时快照小于账本时不下降（日志被删场景）', () => {
  const ledger = newLedger();
  mergeDays(ledger, daysFor([record({}), record({ messageId: 'm2', outputTokens: 200 })]), {
    bucketSignature: ledger.bucketSignature,
    nowMs: NOW
  });
  const live = { models: { 'deepseek-flash': { main: { peak: { requests: 1, cacheMiss: 1000, cacheHit: 2000, cacheCreation: 0, output: 800 }, offpeak: null }, subagent: null } } };
  mergeLiveDay(ledger, live, '2026-11-24');
  assert.strictEqual(totalsOf(ledger, '2026-11-24').output, 1000);
});

test('validateLedger 拒绝非法结构、忽略不安全键', () => {
  assert.strictEqual(validateLedger(null).status, 'corrupt');
  assert.strictEqual(validateLedger({}).status, 'corrupt');
  assert.strictEqual(validateLedger({ schemaVersion: SCHEMA_VERSION + 1, days: {} }).status, 'tooNew');

  const raw = {
    schemaVersion: SCHEMA_VERSION,
    installDate: '2026-11-01',
    bucketSignature: 'abc',
    days: {
      '2026-11-24': { lastRecomputedAt: NOW, models: { 'deepseek-flash': { main: { peak: { requests: 1, output: 10 } } } } },
      '2026-13-99': { models: {} },
      'bad-key': { models: {} },
      '2026-11-25': { models: {} }
    }
  };
  const result = validateLedger(raw);
  assert.strictEqual(result.status, 'ok');
  assert.deepStrictEqual(Object.keys(result.ledger.days), ['2026-11-24']);
  assert.ok(result.issues.length >= 1);
});

test('__proto__ 之类的模型名不会污染原型', () => {
  const raw = {
    schemaVersion: SCHEMA_VERSION,
    days: {
      '2026-11-24': {
        lastRecomputedAt: NOW,
        models: JSON.parse(
          '{"__proto__":{"main":{"peak":{"output":999}}},"deepseek-flash":{"main":{"peak":{"output":10}}}}'
        )
      }
    }
  };
  const result = validateLedger(raw);
  const models = result.ledger.days['2026-11-24'].models;
  assert.deepStrictEqual(Object.keys(models), ['deepseek-flash'], '不安全的键必须被丢弃');
  assert.strictEqual(Object.getPrototypeOf(models), null);
  assert.strictEqual({}.output, undefined, '原型未被污染');
});

test('序列化稳定：键序不同但内容相同则哈希一致', () => {
  const a = newLedger();
  const b = newLedger();
  const daysA = daysFor([record({}), record({ messageId: 'm2', timestampMs: Date.parse('2026-11-22T10:00:00+08:00') })]);
  const daysB = {};
  for (const key of Object.keys(daysA).sort().reverse()) daysB[key] = daysA[key];
  mergeDays(a, daysA, { bucketSignature: a.bucketSignature, nowMs: NOW });
  mergeDays(b, daysB, { bucketSignature: b.bucketSignature, nowMs: NOW });
  assert.strictEqual(hashText(serializeLedger(a)), hashText(serializeLedger(b)));
});

test('原子写入：写后可读回，且生成备份', () => {
  const dir = tmpDir();
  const filePath = ledgerPathFor(dir);
  const ledger = newLedger();
  mergeDays(ledger, daysFor([record({})]), { bucketSignature: ledger.bucketSignature, nowMs: NOW });

  const first = writeLedgerAtomicSync(filePath, ledger);
  assert.strictEqual(first.ok, true, first.error);
  assert.ok(fs.existsSync(filePath));
  assert.strictEqual(readLedgerSync(filePath).status, 'ok');

  mergeDays(ledger, daysFor([record({ messageId: 'm2', timestampMs: Date.parse('2026-11-25T10:00:00+08:00') })]), {
    bucketSignature: ledger.bucketSignature,
    nowMs: LATER
  });
  const second = writeLedgerAtomicSync(filePath, ledger);
  assert.strictEqual(second.ok, true);
  assert.ok(fs.existsSync(path.join(dir, 'history-ledger.backup.json')), '写前应转存备份');
  assert.strictEqual(fs.readdirSync(dir).filter(name => name.includes('.tmp.')).length, 0, '不应残留临时文件');
});

test('损坏的账本被识别，且备份仍可读', () => {
  const dir = tmpDir();
  const filePath = ledgerPathFor(dir);
  const ledger = newLedger();
  mergeDays(ledger, daysFor([record({})]), { bucketSignature: ledger.bucketSignature, nowMs: NOW });
  writeLedgerAtomicSync(filePath, ledger);
  writeLedgerAtomicSync(filePath, ledger);

  fs.writeFileSync(filePath, '{ this is not json', 'utf8');
  const broken = readLedgerSync(filePath);
  assert.strictEqual(broken.status, 'corrupt');
  assert.ok(broken.issues[0].includes('JSON'));

  const backup = readLedgerSync(path.join(dir, 'history-ledger.backup.json'));
  assert.strictEqual(backup.status, 'ok');
});

test('缺失账本返回 missing 而不是报错', () => {
  const dir = tmpDir();
  assert.strictEqual(readLedgerSync(path.join(dir, 'nope.json')).status, 'missing');
});

test('清理遗留临时文件，不动正式文件', () => {
  const dir = tmpDir();
  const filePath = ledgerPathFor(dir);
  const ledger = newLedger();
  writeLedgerAtomicSync(filePath, ledger);
  fs.writeFileSync(`${filePath}.tmp.999`, 'junk', 'utf8');
  const removed = cleanupTempFilesSync(dir);
  assert.deepStrictEqual(removed, ['history-ledger.json.tmp.999']);
  assert.ok(fs.existsSync(filePath));
});

test('清除账本同时删除备份', () => {
  const dir = tmpDir();
  const filePath = ledgerPathFor(dir);
  const ledger = newLedger();
  writeLedgerAtomicSync(filePath, ledger);
  writeLedgerAtomicSync(filePath, ledger);
  const removed = clearLedgerSync(dir);
  assert.deepStrictEqual(removed.sort(), ['history-ledger.backup.json', 'history-ledger.json']);
  assert.strictEqual(readLedgerSync(filePath).status, 'missing');
});

test('ledgerSummary 统计天数、模型与仅账本天数', () => {
  const ledger = newLedger();
  mergeDays(ledger, daysFor([record({})]), { bucketSignature: ledger.bucketSignature, nowMs: NOW });
  const summary = ledgerSummary(ledger, null);
  assert.strictEqual(summary.days, 1);
  assert.strictEqual(summary.models, 1);
  assert.strictEqual(summary.frozenDays, 0);
  assert.strictEqual(summary.firstRecordDate, '2026-11-24');
});
