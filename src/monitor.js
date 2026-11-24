'use strict';

const fs = require('fs');
const vscode = require('vscode');
const { readSettings } = require('./config');
const { TranscriptScanner } = require('./scanner');
const { UsageStore, buildSnapshot } = require('./usage');
const { localDayInfo, currentMarketMode, nextBoundaryMs, runPricingAssertions } = require('./pricing');

const WATCH_DEBOUNCE_MS = 500;
const WATCH_MAX_DELAY_MS = 2000;

function errorMessage(error) {
  return error && error.message ? error.message : String(error);
}

function emptyTokens() {
  return { cacheMiss: 0, cacheHit: 0, cacheCreation: 0, output: 0, total: 0 };
}

class UsageMonitor {
  constructor(context, output) {
    this.context = context;
    this.output = output;
    this.settings = null;
    this.scanner = new TranscriptScanner();
    this.store = new UsageStore();
    this.snapshot = null;
    this.listeners = new Set();
    this.disposed = false;
    this.initialized = false;
    this.needRebuild = true;
    this.running = false;
    this.pending = false;
    this.currentPromise = null;
    this.watcher = null;
    this.intervalHandle = null;
    this.boundaryHandle = null;
    this.watchTimer = null;
    this.watchFirstAt = 0;
    this.lastLoggedError = null;
  }

  async start() {
    this.settings = readSettings();
    this.createWatcher();
    this.createInterval();
    this.scheduleBoundary();
    await this.refreshNow('startup');
  }

  onDidChange(listener) {
    this.listeners.add(listener);
    return {
      dispose: () => this.listeners.delete(listener)
    };
  }

  refreshNow(reason) {
    if (this.disposed) return Promise.resolve();
    if (this.running) {
      this.pending = true;
      return this.currentPromise;
    }
    this.currentPromise = this.drain(reason || 'manual');
    return this.currentPromise;
  }

  async drain(reason) {
    this.running = true;
    try {
      let currentReason = reason;
      while (!this.disposed) {
        try {
          await this.scanAndPublish(currentReason);
        } catch (error) {
          this.publishError(error, currentReason);
        }
        if (!this.pending || this.disposed) break;
        this.pending = false;
        currentReason = 'merged';
      }
    } finally {
      this.running = false;
      this.pending = false;
      this.currentPromise = null;
    }
  }

  async scanAndPublish(reason) {
    const settings = this.settings;
    let stat = null;
    try {
      stat = fs.statSync(settings.projectsRoot);
    } catch {}
    if (!stat || !stat.isDirectory()) {
      this.initialized = false;
      throw new Error(`未找到会话目录：${settings.projectsRoot}`);
    }

    let scanInfo;
    if (!this.initialized || this.needRebuild) {
      scanInfo = await this.fullScan(settings);
      scanInfo.mode = 'full';
    } else {
      scanInfo = await this.scanner.scanIncremental(settings.projectsRoot, (row, file) => this.store.add(row, file));
      if (scanInfo.needsRebuild) {
        scanInfo = await this.fullScan(settings);
        scanInfo.mode = 'full-rebuild';
      } else {
        scanInfo.mode = 'incremental';
      }
    }

    const snapshot = buildSnapshot(this.store, scanInfo, settings, Date.now());
    snapshot.reason = reason;
    this.publish(snapshot);
  }

  async fullScan(settings) {
    const store = new UsageStore();
    this.scanner.reset();
    const scanInfo = await this.scanner.scanAll(settings.projectsRoot, (row, file) => store.add(row, file));
    this.store = store;
    this.initialized = true;
    this.needRebuild = false;
    return { ...scanInfo };
  }

  publish(snapshot) {
    this.snapshot = snapshot;
    this.lastLoggedError = null;
    for (const listener of this.listeners) {
      try { listener(snapshot); } catch (error) { this.output.appendLine(`回调异常：${errorMessage(error)}`); }
    }
  }

  publishError(error, reason) {
    const message = errorMessage(error);
    if (this.lastLoggedError !== message) {
      this.output.appendLine(`刷新失败（${reason}）：${message}`);
      this.lastLoggedError = message;
    }
    let snapshot;
    if (this.snapshot) {
      snapshot = {
        ...this.snapshot,
        error: message,
        stale: true,
        reason,
        updatedAtMs: Date.now()
      };
    } else {
      const settings = this.settings || {};
      const day = localDayInfo(Date.now());
      snapshot = {
        schemaVersion: 1,
        loading: false,
        error: message,
        stale: true,
        reason,
        dayKey: day.key,
        dayLabel: day.label,
        updatedAtMs: Date.now(),
        updatedLabel: '--:--:--',
        currency: settings.currency === 'USD' ? 'USD' : 'CNY',
        currencySymbol: settings.currency === 'USD' ? '$' : '¥',
        market: currentMarketMode(Date.now(), settings.holidays || new Set()),
        totals: { cost: 0, requests: 0, tokens: emptyTokens() },
        byModel: [],
        bySession: [],
        excluded: { nonDeepseekRequests: 0, nonDeepseekModels: [], nonDeepseekBreakdown: [], syntheticRequests: 0 },
        warnings: [],
        scan: null,
        store: null,
        settings: { projectsRoot: settings.projectsRoot || '', modelPrefixes: [], includeSubagents: true }
      };
    }
    this.publish(snapshot);
  }

  createWatcher() {
    if (this.watcher) {
      this.watcher.dispose();
      this.watcher = null;
    }
    const pattern = new vscode.RelativePattern(this.settings.projectsRoot, '**/*.jsonl');
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const onChange = () => this.scheduleWatchRefresh();
    this.watcher.onDidChange(onChange);
    this.watcher.onDidCreate(onChange);
    this.watcher.onDidDelete(() => {
      this.needRebuild = true;
      this.scheduleWatchRefresh();
    });
  }

  scheduleWatchRefresh() {
    if (this.disposed) return;
    const now = Date.now();
    if (!this.watchFirstAt) this.watchFirstAt = now;
    if (this.watchTimer) clearTimeout(this.watchTimer);
    const delay = Math.max(0, Math.min(WATCH_DEBOUNCE_MS, WATCH_MAX_DELAY_MS - (now - this.watchFirstAt)));
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      this.watchFirstAt = 0;
      this.refreshNow('watch');
    }, delay);
  }

  createInterval() {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.intervalHandle = setInterval(() => this.refreshNow('interval'), this.settings.refreshIntervalMs);
  }

  scheduleBoundary() {
    if (this.boundaryHandle) {
      clearTimeout(this.boundaryHandle);
      this.boundaryHandle = null;
    }
    if (this.disposed) return;
    const now = Date.now();
    const delay = Math.max(1000, nextBoundaryMs(now) - now + 100);
    this.boundaryHandle = setTimeout(() => {
      this.boundaryHandle = null;
      this.refreshNow('boundary');
      this.scheduleBoundary();
    }, delay);
  }

  reconfigure() {
    if (this.disposed) return;
    const previous = this.settings;
    const next = readSettings();
    this.settings = next;
    if (!previous) return;
    if (previous.projectsRoot !== next.projectsRoot) {
      this.needRebuild = true;
      this.initialized = false;
      this.createWatcher();
    }
    if (previous.refreshIntervalMs !== next.refreshIntervalMs) this.createInterval();
    this.refreshNow('reconfigure');
  }

  printDiagnostics(channel) {
    const target = channel || this.output;
    target.show(true);
    target.appendLine('=== DeepSeek Cost Monitor 诊断 ===');
    const snapshot = this.snapshot;
    if (!snapshot) {
      target.appendLine('尚无快照，请稍候或执行刷新。');
    } else {
      target.appendLine(`日期：${snapshot.dayLabel}（${snapshot.dayKey}）`);
      target.appendLine(`金额：${snapshot.currencySymbol}${Number(snapshot.totals.cost || 0).toFixed(6)} · 请求 ${snapshot.totals.requests}`);
      target.appendLine(`目录：${this.settings ? this.settings.projectsRoot : '(未初始化)'}`);
      target.appendLine(`模式：${snapshot.market ? snapshot.market.label : '未知'} · 更新 ${snapshot.updatedLabel}`);
      if (snapshot.error) target.appendLine(`错误：${snapshot.error}`);
      target.appendLine(`扫描：${JSON.stringify(snapshot.scan)}`);
      target.appendLine(`去重：${JSON.stringify(snapshot.store)}`);
    }
    const files = this.scanner.getFileStats();
    target.appendLine(`已跟踪文件：${files.length} 个`);
    for (const file of files) {
      target.appendLine(`  ${file.path} | offset=${file.offset} pending=${file.pendingBytes} errors=${file.errors}`);
    }
    const assertions = runPricingAssertions();
    for (const item of assertions) {
      target.appendLine(`${item.ok ? '[PASS]' : '[FAIL]'} ${item.name} expected=${item.expected} actual=${item.actual}`);
    }
    const settings = this.settings || {};
    const payload = {
      generatedAt: new Date().toISOString(),
      settings: {
        projectsRoot: settings.projectsRoot || '',
        modelPrefixes: settings.modelPrefixes || [],
        currency: settings.currency || 'CNY',
        includeSubagents: settings.includeSubagents !== false,
        holidays: settings.holidayList || [],
        rateOverrides: settings.rateOverrides || {}
      },
      pricingAssertions: assertions,
      snapshot,
      files
    };
    target.appendLine('SELFTEST_JSON ' + JSON.stringify(payload));
  }

  dispose() {
    this.disposed = true;
    this.listeners.clear();
    if (this.watcher) {
      this.watcher.dispose();
      this.watcher = null;
    }
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    if (this.boundaryHandle) clearTimeout(this.boundaryHandle);
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.intervalHandle = null;
    this.boundaryHandle = null;
    this.watchTimer = null;
  }
}

module.exports = { UsageMonitor };
