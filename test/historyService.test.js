'use strict';

const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { HistoryService } = require('../src/historyService');
const { buildDayAgg, dayAggToDays } = require('../src/aggregate');
const {
  computeBucketSignature,
  LEDGER_FILE_NAME,
  BACKUP_FILE_NAME,
  ledgerPathFor,
  readLedgerSync
} = require('../src/ledger');

const NOW = Date.parse('2026-11-24T20:00:00+08:00');
const HOLIDAYS = new Set(['2026-10-01', '2026-10-02']);
const SIGNATURE = computeBucketSignature(HOLIDAYS);

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-hs-'));
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

function record(overrides) {
  const base = {
    messageId: 'm1',
    timestampMs: Date.parse('2026-11-24T10:00:00+08:00'),
    model: 'deepseek-flash',
    normalizedModel: 'deepseek-flash',
    inputTokens: 1_000_000,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    isSubagent: false
  };
  const merged = Object.assign({}, base, overrides || {});
  if (!merged.messageId) merged.messageId = 'm-' + Math.random().toString(16).slice(2);
  return merged;
}

function daysOf(records, nowMs) {
  return dayAggToDays(buildDayAgg(records, { holidays: HOLIDAYS, nowMs: nowMs || NOW }));
}

function service(dir, extra) {
  return new HistoryService(Object.assign({ storageDir: dir, installDate: '2026-01-01', bucketSignature: SIGNATURE }, extra || {}));
}

const BASE_QUERY = {
  preset: 'last30',
  nowMs: NOW,
  todayKey: '2026-11-24',
  currency: 'CNY',
  modelPrefixes: ['deepseek'],
  includeSubagents: true
};

test('首次运行：账本缺失不是错误，写入后变成可用', () => {
  const dir = tempDir();
  try {
    const svc = service(dir);
    const loaded = svc.load(NOW);
    assert.strictEqual(loaded.status, 'missing');
    assert.ok(svc.ledger, '缺账本也要有内存结构');
    assert.strictEqual(svc.ledger.installDate, '2026-01-01');

    const result = svc.recordDays(daysOf([record()]), SIGNATURE, NOW);
    assert.strictEqual(result.written, true);
    assert.ok(fs.existsSync(path.join(dir, LEDGER_FILE_NAME)));
    assert.strictEqual(svc.summary().days, 1);
    assert.strictEqual(svc.status, 'ok', '首次写盘后状态不能还是 missing');
  } finally {
    cleanup(dir);
  }
});

test('账本目录不存在时首次运行会自动创建（globalStorage 首次运行）', () => {
  const base = tempDir();
  const dir = path.join(base, 'nested', 'globalStorage');
  try {
    const svc = service(dir);
    const loaded = svc.load(NOW);
    assert.strictEqual(loaded.status, 'missing');
    const result = svc.recordDays(daysOf([record()]), SIGNATURE, NOW);
    assert.strictEqual(result.written, true, result.error || '首次写盘应成功');
    assert.ok(fs.existsSync(ledgerPathFor(dir)), '账本文件应已创建');
  } finally {
    cleanup(base);
  }
});

test('多窗口：后写者重新读取磁盘，不丢另一窗口的日期', () => {
  const dir = tempDir();
  try {
    const a = service(dir);
    a.load(NOW);
    const b = service(dir);
    b.load(NOW); // B 在 A 写盘之前加载，持有空账本

    a.recordDays(daysOf([record({ messageId: 'a', timestampMs: Date.parse('2026-11-20T10:00:00+08:00') })]), SIGNATURE, NOW);
    const bResult = b.recordDays(daysOf([record({ messageId: 'b' })]), SIGNATURE, NOW + 1000);
    assert.strictEqual(bResult.written, true);

    const disk = readLedgerSync(ledgerPathFor(dir)).ledger;
    assert.ok(disk.days['2026-11-20'], 'A 写入的 11-20 不能被 B 的旧内存覆盖');
    assert.ok(disk.days['2026-11-24'], 'B 写入的 11-24 也要保留');
    assert.deepStrictEqual(Object.keys(disk.days).sort(), ['2026-11-20', '2026-11-24']);
  } finally {
    cleanup(dir);
  }
});

test('写锁被占用时跳过写盘，旧账本保持可读', () => {
  const dir = tempDir();
  try {
    const svc = service(dir);
    svc.load(NOW);
    svc.recordDays(daysOf([record({ messageId: 'a' })]), SIGNATURE, NOW);
    const file = path.join(dir, LEDGER_FILE_NAME);
    const before = fs.readFileSync(file, 'utf8');
    const lockPath = path.join(dir, 'history-ledger.lock');
    fs.writeFileSync(lockPath, 'other-window', 'utf8');
    try {
      const result = svc.recordDays(daysOf([record({ messageId: 'b' })]), SIGNATURE, NOW + 1000);
      assert.strictEqual(result.written, false);
      assert.match(result.error, /写锁/);
      assert.strictEqual(fs.readFileSync(file, 'utf8'), before, '拿不到锁不能改动账本');
    } finally {
      fs.unlinkSync(lockPath);
    }
  } finally {
    cleanup(dir);
  }
});

test('清除账本：删除文件并暂停本次会话写入', () => {
  const dir = tempDir();
  try {
    const svc = service(dir);
    svc.load(NOW);
    svc.recordDays(daysOf([record()]), SIGNATURE, NOW);
    const cleared = svc.clear(NOW + 1000);
    assert.strictEqual(cleared.error, null);
    assert.ok(!fs.existsSync(ledgerPathFor(dir)));
    assert.strictEqual(svc.status, 'cleared');
    assert.strictEqual(svc.suspended, true);

    const next = svc.recordDays(daysOf([record({ messageId: 'm2' })]), SIGNATURE, NOW + 2000);
    assert.strictEqual(next.error, 'suspended');
    assert.ok(!fs.existsSync(ledgerPathFor(dir)), '暂停期间不能把日志重新写回');
  } finally {
    cleanup(dir);
  }
});

test('重建账本：replace 语义删除无日志日期并恢复写入', () => {
  const dir = tempDir();
  try {
    const svc = service(dir);
    svc.load(NOW);
    svc.recordDays(daysOf([
      record({ messageId: 'a', timestampMs: Date.parse('2026-11-20T10:00:00+08:00') }),
      record({ messageId: 'b' })
    ]), SIGNATURE, NOW);
    const rebuild = svc.rebuildFromDays(daysOf([record({ messageId: 'b' })]), SIGNATURE, NOW + 1000);
    assert.strictEqual(rebuild.written, true);
    assert.strictEqual(svc.status, 'ok');
    assert.strictEqual(svc.suspended, false);
    const disk = readLedgerSync(ledgerPathFor(dir)).ledger;
    assert.deepStrictEqual(Object.keys(disk.days), ['2026-11-24']);
  } finally {
    cleanup(dir);
  }
});

test('重复合并不写盘（幂等）', () => {
  const dir = tempDir();
  try {
    const svc = service(dir);
    svc.load(NOW);
    const days = daysOf([record({ inputTokens: 500_000 })]);
    assert.strictEqual(svc.recordDays(days, SIGNATURE, NOW).written, true);

    const before = fs.statSync(path.join(dir, LEDGER_FILE_NAME)).mtimeMs;
    const second = svc.recordDays(days, SIGNATURE, NOW + 60_000);
    assert.strictEqual(second.written, false);
    assert.strictEqual(second.stats.changed, false);
    assert.strictEqual(second.error, null);
    assert.strictEqual(fs.statSync(path.join(dir, LEDGER_FILE_NAME)).mtimeMs, before, '内容没变不该重写文件');
  } finally {
    cleanup(dir);
  }
});

test('日志被删除后账本不倒退（FR-02）', () => {
  const dir = tempDir();
  try {
    const svc = service(dir);
    svc.load(NOW);
    svc.recordDays(daysOf([record({ inputTokens: 1_000_000 }), record({ messageId: 'm2', inputTokens: 1_000_000 })]), SIGNATURE, NOW);

    const full = svc.query(BASE_QUERY);
    assert.ok(Math.abs(full.summary.totalCost - 4.0) < 1e-9, '两条 1M 未命中 = 2 + 2');

    // 用户清理了日志：重算后只剩一条，账本必须保留原值。
    const shrunk = svc.recordDays(daysOf([record({ inputTokens: 1_000_000 })]), SIGNATURE, NOW + 1000);
    assert.strictEqual(shrunk.stats.changed, false, '变小不该被写进账本');

    const after = svc.query(BASE_QUERY);
    assert.ok(Math.abs(after.summary.totalCost - 4.0) < 1e-9, '删日志后金额不变');
  } finally {
    cleanup(dir);
  }
});

test('今日兜底：账本值大于实时值时取账本', () => {
  const dir = tempDir();
  try {
    const svc = service(dir);
    svc.load(NOW);
    svc.recordDays(daysOf([record({ inputTokens: 1_000_000 })]), SIGNATURE, NOW);

    const live = daysOf([record({ inputTokens: 400_000 })])['2026-11-24'];
    const merged = svc.mergedToday('2026-11-24', live);
    const mergedTokens = merged.models['deepseek-flash'].main.peak.cacheMiss;
    assert.strictEqual(mergedTokens, 1_000_000, '逐桶取大，账本值更大');

    // 实时值更大时反过来取实时值。
    const bigger = daysOf([record({ inputTokens: 3_000_000 })])['2026-11-24'];
    const merged2 = svc.mergedToday('2026-11-24', bigger);
    assert.strictEqual(merged2.models['deepseek-flash'].main.peak.cacheMiss, 3_000_000);
  } finally {
    cleanup(dir);
  }
});

test('今日兜底不写回账本', () => {
  const dir = tempDir();
  try {
    const svc = service(dir);
    svc.load(NOW);
    svc.recordDays(daysOf([record({ inputTokens: 1_000_000 })]), SIGNATURE, NOW);
    const before = svc.summary().lastMerge;

    const bigger = daysOf([record({ inputTokens: 9_000_000 })])['2026-11-24'];
    svc.query(Object.assign({}, BASE_QUERY, { liveDay: bigger }));

    assert.strictEqual(svc.ledger.days['2026-11-24'].models['deepseek-flash'].main.peak.cacheMiss, 1_000_000, '查询不得改动账本');
    assert.strictEqual(svc.summary().lastMerge, before);
  } finally {
    cleanup(dir);
  }
});

test('查询：liveTodayApplied 反映今日是否并入实时值', () => {
  const dir = tempDir();
  try {
    const svc = service(dir);
    svc.load(NOW);
    svc.recordDays(daysOf([record({ inputTokens: 1_000_000 })]), SIGNATURE, NOW);

    const without = svc.query(Object.assign({}, BASE_QUERY, { liveDay: null }));
    assert.strictEqual(without.liveTodayApplied, false);

    const live = daysOf([record({ inputTokens: 4_000_000 })])['2026-11-24'];
    const withLive = svc.query(Object.assign({}, BASE_QUERY, { liveDay: live }));
    assert.strictEqual(withLive.liveTodayApplied, true);
    assert.ok(Math.abs(withLive.summary.totalCost - 8.0) < 1e-9, '实时值 4M = 8.0 覆盖账本 2.0');
  } finally {
    cleanup(dir);
  }
});

test('账本损坏：隔离坏文件并从备份恢复', () => {
  const dir = tempDir();
  try {
    const svc = service(dir);
    svc.load(NOW);
    svc.recordDays(daysOf([record({ messageId: 'a', inputTokens: 1_000_000 })]), SIGNATURE, NOW);
    // 第二次写盘会把上一版复制成 backup
    svc.recordDays(
      daysOf([record({ messageId: 'a', inputTokens: 1_000_000 }), record({ messageId: 'b', inputTokens: 1_000_000 })]),
      SIGNATURE,
      NOW + 1000
    );
    assert.ok(fs.existsSync(path.join(dir, BACKUP_FILE_NAME)), '应有备份');

    fs.writeFileSync(path.join(dir, LEDGER_FILE_NAME), '{ broken json', 'utf8');

    const recovered = service(dir);
    const loaded = recovered.load(NOW + 2000);
    assert.strictEqual(loaded.status, 'restored');
    assert.ok(loaded.quarantined, '坏文件应被移走留证');
    assert.ok(fs.existsSync(loaded.quarantined));
    assert.ok(recovered.summary().days >= 1, '恢复后仍有数据');
    assert.ok(fs.existsSync(path.join(dir, LEDGER_FILE_NAME)), '恢复结果应写回主文件');
  } finally {
    cleanup(dir);
  }
});

test('账本版本更高：进入只读，绝不覆盖', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, LEDGER_FILE_NAME);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 99, days: {} }), 'utf8');
    const before = fs.readFileSync(file, 'utf8');

    const svc = service(dir);
    const loaded = svc.load(NOW);
    assert.strictEqual(loaded.status, 'too-new');
    assert.strictEqual(svc.readOnly, true);

    const result = svc.recordDays(daysOf([record()]), SIGNATURE, NOW);
    assert.strictEqual(result.written, false);
    assert.strictEqual(result.error, 'read-only');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before, '高版本文件必须原样保留');
  } finally {
    cleanup(dir);
  }
});

test('高版本账本结构兼容时只读展示，不显示空历史', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, LEDGER_FILE_NAME);
    fs.mkdirSync(dir, { recursive: true });
    const bucket = { requests: 1, cacheMiss: 1_000_000, cacheHit: 0, cacheCreation: 0, output: 0 };
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: 99,
      installDate: '2026-01-01',
      lastScanAt: NOW,
      days: {
        '2026-11-24': {
          lastRecomputedAt: NOW,
          bucketingStale: false,
          models: {
            'deepseek-flash': {
              main: { peak: bucket, offpeak: { requests: 0, cacheMiss: 0, cacheHit: 0, cacheCreation: 0, output: 0 } },
              subagent: { peak: { requests: 0, cacheMiss: 0, cacheHit: 0, cacheCreation: 0, output: 0 }, offpeak: { requests: 0, cacheMiss: 0, cacheHit: 0, cacheCreation: 0, output: 0 } }
            }
          }
        }
      }
    }), 'utf8');

    const svc = service(dir);
    const loaded = svc.load(NOW);
    assert.strictEqual(loaded.status, 'too-new');
    assert.strictEqual(svc.readOnly, true);
    assert.strictEqual(svc.summary().days, 1, '兼容结构应能展示');
    const result = svc.query(BASE_QUERY);
    assert.ok(result.summary.totalCost > 0, '只读高版本账本也能查询');
  } finally {
    cleanup(dir);
  }
});

test('隐私：账本不保存 sessionId / cwd', () => {
  const dir = tempDir();
  try {
    const svc = service(dir);
    svc.load(NOW);
    svc.recordDays(
      daysOf([record({ sessionId: 'secret-session-id', cwd: 'C:\\Users\\someone\\secret-project' })]),
      SIGNATURE,
      NOW
    );
    const text = fs.readFileSync(path.join(dir, LEDGER_FILE_NAME), 'utf8');
    assert.ok(!text.includes('secret-session-id'));
    assert.ok(!text.includes('secret-project'));
    assert.ok(!text.includes('cost'), '账本不存金额');
  } finally {
    cleanup(dir);
  }
});

test('分桶口径变化：整日替换而非 max，总 token 不翻倍', () => {
  const dir = tempDir();
  try {
    const svc = service(dir);
    svc.load(NOW);
    // 第一条 2026-10-01 是节假日（低谷），10-02 也是。
    const days = daysOf([
      record({ messageId: 'h1', timestampMs: Date.parse('2026-10-01T10:00:00+08:00'), inputTokens: 1_000_000 })
    ]);
    svc.recordDays(days, SIGNATURE, NOW);

    const beforeQuery = svc.query(Object.assign({}, BASE_QUERY, {
      preset: 'custom',
      fromKey: '2026-10-01',
      toKey: '2026-10-01'
    }));
    assert.ok(Math.abs(beforeQuery.summary.totalCost - 1.0) < 1e-9, '节假日 1M 低谷 = 1.0');

    // 换一张不含该日的节假日表：口径签名变化，该日应整日替换成高峰价。
    const newHolidays = new Set();
    const newSignature = computeBucketSignature(newHolidays);
    const newDays = dayAggToDays(
      buildDayAgg(
        [record({ messageId: 'h1', timestampMs: Date.parse('2026-10-01T10:00:00+08:00'), inputTokens: 1_000_000 })],
        { holidays: newHolidays, nowMs: NOW + 1000 }
      )
    );
    const merged = svc.recordDays(newDays, newSignature, NOW + 1000);
    assert.strictEqual(merged.stats.replaced, 1, '口径变化走整日替换');

    const afterQuery = svc.query(Object.assign({}, BASE_QUERY, {
      preset: 'custom',
      fromKey: '2026-10-01',
      toKey: '2026-10-01'
    }));
    assert.ok(Math.abs(afterQuery.summary.totalCost - 2.0) < 1e-9, '变成高峰 2.0');
    assert.ok(
      Math.abs(afterQuery.summary.tokens.cacheMiss - 1_000_000) < 1e-6,
      'token 不能因为同时落两桶而翻倍'
    );
  } finally {
    cleanup(dir);
  }
});

test('口径变化时日志已消失的日期标记 bucketingStale', () => {
  const dir = tempDir();
  try {
    const svc = service(dir);
    svc.load(NOW);
    svc.recordDays(
      daysOf([record({ messageId: 'old', timestampMs: Date.parse('2026-11-20T10:00:00+08:00'), inputTokens: 1_000_000 })]),
      SIGNATURE,
      NOW
    );
    svc.recordDays(daysOf([record()]), computeBucketSignature(new Set()), NOW + 1000);
    assert.strictEqual(svc.ledger.days['2026-11-20'].bucketingStale, true);
    const query = svc.query(BASE_QUERY);
    assert.ok(query.warnings.some(item => item.code === 'bucketing-stale'));
  } finally {
    cleanup(dir);
  }
});

test('storageDir 缺失时构造直接失败（让上层降级而不是静默写错位置）', () => {
  assert.throws(() => new HistoryService({}), /storageDir/);
});
