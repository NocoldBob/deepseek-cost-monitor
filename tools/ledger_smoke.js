'use strict';

/**
 * M1 冒烟验证：用本机真实 Claude Code 日志跑通
 *   扫描 → 去重 → 日聚合 → 账本合并 → 原子写入 → 读回 → 历史查询
 * 不触碰扩展的存储目录，全部在系统临时目录里进行；不改动任何日志。
 *
 * 用法：node tools/ledger_smoke.js [日志目录]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { TranscriptScanner } = require('../src/scanner');
const { UsageStore } = require('../src/usage');
const { DEFAULT_HOLIDAYS, dateKeyOfMs } = require('../src/pricing');
const { buildDayAgg, dayAggToDays } = require('../src/aggregate');
const ledgerModule = require('../src/ledger');
const { resolveRange, defaultGranularity, aggregateHistory } = require('../src/history');

const SETTINGS = {
  projectsRoot: process.argv[2] || path.join(os.homedir(), '.claude', 'projects'),
  modelPrefixes: ['deepseek'],
  currency: 'CNY',
  includeSubagents: true
};

function ms(start) {
  return Date.now() - start;
}

async function main() {
  const root = SETTINGS.projectsRoot;
  if (!fs.existsSync(root)) {
    console.error(`日志目录不存在：${root}`);
    process.exitCode = 1;
    return;
  }

  console.log('=== M1 数据层冒烟 ===');
  console.log(`日志目录：${root}`);

  let start = Date.now();
  const scanner = new TranscriptScanner();
  const store = new UsageStore();
  const scanInfo = await scanner.scanAll(root, (row, file) => store.add(row, file));
  console.log(`扫描完成：${scanInfo.files} 个文件，${store.records.size} 条去重记录，耗时 ${ms(start)} ms`);

  start = Date.now();
  const holidays = new Set(DEFAULT_HOLIDAYS);
  const nowMs = Date.now();
  const agg = buildDayAgg(store.records.values(), { holidays, nowMs });
  const days = dayAggToDays(agg);
  const dayKeys = Object.keys(days).sort();
  console.log(`日聚合完成：${dayKeys.length} 天（${dayKeys[0]} → ${dayKeys[dayKeys.length - 1]}），耗时 ${ms(start)} ms`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dscm-smoke-'));
  const filePath = ledgerModule.ledgerPathFor(dir);
  const signature = ledgerModule.computeBucketSignature(holidays);
  const ledger = ledgerModule.createLedger({ installDate: dateKeyOfMs(nowMs), bucketSignature: signature, nowMs });

  start = Date.now();
  const first = ledgerModule.mergeDays(ledger, days, { bucketSignature: signature, nowMs });
  console.log(`首次合并：新增 ${first.added} 天，changed=${first.changed}，耗时 ${ms(start)} ms`);

  start = Date.now();
  const second = ledgerModule.mergeDays(ledger, days, { bucketSignature: signature, nowMs });
  console.log(`重复合并：changed=${second.changed}（应为 false），耗时 ${ms(start)} ms`);

  const write = ledgerModule.writeLedgerAtomicSync(filePath, ledger);
  console.log(`写盘：ok=${write.ok} bytes=${write.bytes} retries=${write.retries} 备份错误=${write.backupError || '无'}`);

  const readBack = ledgerModule.readLedgerSync(filePath);
  console.log(`读回：status=${readBack.status} issues=${readBack.issues.length}`);
  const summary = ledgerModule.ledgerSummary(readBack.ledger, filePath);
  console.log(
    `账本：${summary.days} 天 / ${summary.models} 个模型 / ${summary.bytes} bytes / 仅账本 ${summary.frozenDays} 天 / 口径过期 ${summary.bucketingStaleDays} 天`
  );

  const models = new Set();
  for (const key of Object.keys(ledger.days)) {
    for (const model of Object.keys(ledger.days[key].models)) models.add(model);
  }
  console.log(`账本内模型：${Array.from(models).join('、')}`);

  // 历史查询：最近 30 天 + 今年以来
  for (const preset of ['last30', 'thisYear']) {
    const range = resolveRange(preset, { nowMs });
    const granularity = defaultGranularity(range.dayCount);
    start = Date.now();
    const result = aggregateHistory(readBack.ledger, {
      fromKey: range.fromKey,
      toKey: range.toKey,
      granularity,
      currency: SETTINGS.currency,
      modelPrefixes: SETTINGS.modelPrefixes,
      includeSubagents: SETTINGS.includeSubagents,
      todayKey: dateKeyOfMs(nowMs)
    });
    console.log('');
    console.log(`--- ${preset}（${range.fromKey} → ${range.toKey}，${granularity}，${ms(start)} ms）---`);
    console.log(
      `合计 ¥${result.summary.totalCost.toFixed(4)} · 请求 ${result.summary.requests} · 日均 ¥${result.summary.avgPerDay.toFixed(4)} · 覆盖 ${result.summary.coveredDays}/${result.summary.rangeDays} 天`
    );
    console.log(`无记录 ${result.summary.noRecordDays} 天 · 仅账本 ${result.summary.frozenDays} 天 · 周期数 ${result.periods.length}`);
    const head = result.periods.slice(-5);
    for (const row of head) {
      const change = row.changePct === null ? '—' : `${(row.changePct * 100).toFixed(1)}%`;
      console.log(
        `  ${row.key}${row.partial ? '*' : ''} ¥${row.cost.toFixed(4)} 请求 ${row.requests} 环比 ${change}${row.inProgress ? ' (进行中)' : ''}`
      );
    }
    if (result.warnings.length) {
      for (const warning of result.warnings) console.log(`  [警告] ${warning.code}: ${warning.message}`);
    }
  }

  // 一致性校验：周期之和 == 汇总
  const range = resolveRange('last30', { nowMs });
  const check = aggregateHistory(readBack.ledger, {
    fromKey: range.fromKey,
    toKey: range.toKey,
    granularity: 'day',
    currency: SETTINGS.currency,
    modelPrefixes: SETTINGS.modelPrefixes,
    includeSubagents: SETTINGS.includeSubagents,
    todayKey: dateKeyOfMs(nowMs)
  });
  const periodSum = check.periods.reduce((acc, item) => acc + item.cost, 0);
  const ok = Math.abs(periodSum - check.summary.totalCost) < 1e-9;
  console.log('');
  console.log(`${ok ? '[PASS]' : '[FAIL]'} 周期之和 == 汇总（${periodSum.toFixed(6)} vs ${check.summary.totalCost.toFixed(6)}）`);

  fs.rmSync(dir, { recursive: true, force: true });
}

main().catch(error => {
  console.error(`冒烟失败：${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
});
