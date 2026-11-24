'use strict';

const fs = require('fs');
const vscode = require('vscode');
const { readSettings } = require('./config');
const { TranscriptScanner } = require('./scanner');
const { UsageStore, buildSnapshot } = require('./usage');
const { localDayInfo, currentMarketMode, nextBoundaryMs, runPricingAssertions, dateKeyOfMs, HOLIDAY_YEARS } = require('./pricing');
const { buildDayAgg, dayAggToDays } = require('./aggregate');
const { computeBucketSignature } = require('./ledger');
const { summarizeDay } = require('./history');
const { HistoryService } = require('./historyService');
const { readCleanupPeriodDays } = require('./retention');

const WATCH_DEBOUNCE_MS = 500;
const WATCH_MAX_DELAY_MS = 2000;
const INSTALL_DATE_KEY = 'deepseekCostMonitor.installDate';
const RETENTION_NOTICE_KEY = 'deepseekCostMonitor.retentionNoticeDismissed';
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

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
    // 历史账本（0.2.0 M2）：启动时同步加载，之后随扫描增量合并。
    this.history = null;
    this.historyLoad = null;
    this.daysCache = null;
    this.daysKey = null;
    this.storeSeq = 0;
    this.lastLedgerError = null;
    this.lastLedgerWriteAt = 0;
    this.retention = null;
    this.retentionNoticeDismissed = false;
  }

  async start() {
    this.settings = readSettings();
    this.retention = readCleanupPeriodDays();
    this.retentionNoticeDismissed = this.readGlobalFlag(RETENTION_NOTICE_KEY);
    this.initHistory();
    this.publishTodayPrefill();
    this.createWatcher();
    this.createInterval();
    this.scheduleBoundary();
    await this.refreshNow('startup');
  }

  readGlobalFlag(key) {
    try {
      return Boolean(this.context && this.context.globalState && this.context.globalState.get(key));
    } catch {
      return false;
    }
  }

  writeGlobalFlag(key, value) {
    try {
      if (!this.context || !this.context.globalState) return;
      const pending = this.context.globalState.update(key, value);
      if (pending && typeof pending.then === 'function') pending.then(undefined, () => {});
    } catch {}
  }

  /**
   * 冷启动快速路径（FR-18）：只读账本、不做扫描，让历史页立刻有数。
   * 账本读不出来也不能影响今日页，所以整体包一层 try。
   */
  initHistory() {
    const uri = this.context && this.context.globalStorageUri;
    const storageDir = uri && uri.fsPath ? uri.fsPath : null;
    if (!storageDir) {
      this.output.appendLine('未取得 globalStorageUri，历史账本功能不可用。');
      return;
    }
    const todayKey = dateKeyOfMs(Date.now());
    try {
      const installDate = this.resolveInstallDate(todayKey);
      this.history = new HistoryService({
        storageDir,
        installDate,
        bucketSignature: computeBucketSignature(this.settings.holidays)
      });
      const loaded = this.history.load();
      this.historyLoad = loaded;
      this.describeLedgerLoad(loaded);
      if (loaded.removedTempFiles && loaded.removedTempFiles.length) {
        this.output.appendLine(`已清理 ${loaded.removedTempFiles.length} 个异常退出遗留的临时账本文件。`);
      }
    } catch (error) {
      this.history = null;
      this.output.appendLine(`账本初始化失败（历史页不可用，今日页不受影响）：${errorMessage(error)}`);
    }
  }

  /** 安装日优先用 globalState 里已记录的值：账本被误删后仍能保留原安装日。 */
  resolveInstallDate(todayKey) {
    try {
      const stored = this.context.globalState.get(INSTALL_DATE_KEY);
      if (typeof stored === 'string' && DAY_KEY_RE.test(stored)) return stored;
      const pending = this.context.globalState.update(INSTALL_DATE_KEY, todayKey);
      if (pending && typeof pending.then === 'function') pending.then(undefined, () => {});
    } catch (error) {
      this.output.appendLine(`安装日读写失败：${errorMessage(error)}`);
    }
    return todayKey;
  }

  describeLedgerLoad(loaded) {
    const summary = this.history ? this.history.summary() : null;
    switch (loaded.status) {
      case 'missing':
        this.output.appendLine('账本：首次运行，将从日志生成历史。');
        break;
      case 'ok':
        this.output.appendLine(
          `账本：已加载 ${summary.days} 天（${summary.firstRecordDate || '—'} → ${summary.lastRecordDate || '—'}）。`
        );
        break;
      case 'restored':
        this.output.appendLine(
          `账本损坏，已从备份恢复（${summary.days} 天）${loaded.quarantined ? '，损坏文件保留为 ' + loaded.quarantined : ''}。`
        );
        break;
      case 'rebuilt-empty':
        this.output.appendLine('账本损坏且备份不可用，将从日志重建。');
        break;
      case 'too-new':
        this.output.appendLine('账本版本高于当前扩展支持版本，历史数据进入只读模式（不会覆盖）。');
        break;
      default:
        this.output.appendLine(`账本状态：${loaded.status}`);
    }
    for (const issue of (loaded.issues || []).slice(0, 5)) this.output.appendLine(`  账本提示：${issue}`);
  }

  /**
   * FR-18 冷启动预填：已有账本时先用“账本里的今天”渲染今日页，
   * 不等全量扫描。按会话/项目明细无法从账本恢复，扫描完成后补齐。
   */
  publishTodayPrefill() {
    if (!this.history || !this.history.ledger || !this.settings) return;
    const nowMs = Date.now();
    const day = localDayInfo(nowMs);
    const ledgerDay = this.history.ledger.days[day.key];
    if (!ledgerDay) return;
    const settings = this.settings;
    let summary;
    try {
      summary = summarizeDay(ledgerDay, {
        currency: settings.currency,
        rateOverrides: settings.rateOverrides,
        includeSubagents: settings.includeSubagents,
        modelPrefixes: settings.modelPrefixes
      });
    } catch (error) {
      this.output.appendLine(`冷启动预填失败：${errorMessage(error)}`);
      return;
    }
    const snapshot = {
      schemaVersion: 1,
      loading: true,
      prefill: true,
      error: null,
      stale: false,
      reason: 'prefill',
      dayKey: day.key,
      dayLabel: day.label,
      updatedAtMs: nowMs,
      updatedLabel: '',
      currency: settings.currency === 'USD' ? 'USD' : 'CNY',
      currencySymbol: settings.currency === 'USD' ? '$' : '¥',
      market: currentMarketMode(nowMs, settings.holidays),
      totals: { cost: summary.cost, requests: summary.requests, tokens: summary.tokens },
      byModel: summary.byModel,
      bySession: [],
      excluded: { nonDeepseekRequests: 0, nonDeepseekModels: [], nonDeepseekBreakdown: [], syntheticRequests: 0 },
      warnings: [{
        code: 'ledger-prefill',
        message: '正在扫描本地会话记录，当前显示账本中今日的数据；按会话明细会在扫描完成后补齐。'
      }],
      scan: null,
      store: null,
      settings: {
        projectsRoot: settings.projectsRoot,
        modelPrefixes: settings.modelPrefixes,
        includeSubagents: settings.includeSubagents
      },
      ledgerReady: true,
      ledgerStatus: this.history.status
    };
    this.publish(snapshot);
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

    const nowMs = Date.now();
    const snapshot = buildSnapshot(this.store, scanInfo, settings, nowMs);
    snapshot.reason = reason;
    // 顺序不能反：先把实时结果并入账本，再用账本兜底今日，
    // 否则本次刷新中"日志里还在、账本里还没有"的记录会被兜底逻辑忽略。
    this.syncLedger(settings, nowMs);
    this.applyTodayFloor(snapshot, settings, nowMs);
    snapshot.ledgerReady = Boolean(this.history && this.history.ledger);
    snapshot.ledgerStatus = this.history ? this.history.status : 'unavailable';
    this.publish(snapshot);
  }

  async fullScan(settings) {
    const store = new UsageStore();
    this.scanner.reset();
    const scanInfo = await this.scanner.scanAll(settings.projectsRoot, (row, file) => store.add(row, file));
    this.store = store;
    this.storeSeq += 1;
    this.initialized = true;
    this.needRebuild = false;
    return { ...scanInfo };
  }

  /**
   * 从去重记录构建日聚合，重复调用时按“记录集合未变”短路。
   *
   * 短路键里带 storeSeq：全量重建后 stats 会归零，只比数字可能恰好相等，
   * 那会导致账本沿用一份来自**旧记录集合**的聚合，属于静默错误。
   */
  buildDays(settings, nowMs) {
    const signature = computeBucketSignature(settings.holidays);
    const stats = this.store.stats || {};
    const key = `${this.storeSeq}|${stats.accepted || 0}|${stats.duplicates || 0}|${signature}`;
    if (this.daysKey === key && this.daysCache) return { days: this.daysCache, signature };
    const agg = buildDayAgg(this.store.records.values(), { holidays: settings.holidays, nowMs });
    this.daysCache = dayAggToDays(agg);
    this.daysKey = key;
    return { days: this.daysCache, signature };
  }

  /** 合并进账本并原子写盘。任何失败都只记日志，不抛异常、不影响今日页。 */
  syncLedger(settings, nowMs) {
    if (!this.history) return;
    let built;
    try {
      built = this.buildDays(settings, nowMs);
    } catch (error) {
      this.reportLedgerError(`日聚合失败：${errorMessage(error)}`);
      return;
    }
    let result;
    try {
      result = this.history.recordDays(built.days, built.signature, nowMs);
    } catch (error) {
      this.reportLedgerError(`账本写入异常：${errorMessage(error)}`);
      return;
    }
    if (result.written) {
      this.lastLedgerWriteAt = nowMs;
      if (this.lastLedgerError) {
        this.lastLedgerError = null;
        this.output.appendLine('账本写入已恢复。');
      }
    } else if (result.error && result.error !== 'read-only' && result.error !== 'suspended') {
      this.reportLedgerError(result.error);
    }
  }

  reportLedgerError(message) {
    if (this.lastLedgerError === message) return;
    this.lastLedgerError = message;
    this.output.appendLine(`账本写入失败：${message}（历史数据会在下次刷新时重新生成）`);
  }

  /**
   * 今日页的账本兜底（§4.10 情况 C）。
   *
   * 今日合计与“按模型”改为以 max(实时, 账本今日) 为数据源，否则日志一被清理
   * 今日金额就立刻下降，而历史页的今天不会降，直接违反 FR-04 的一致性验收。
   * “按会话/按项目”无法兜底：账本按隐私要求不存 sessionId / cwd，界面需说明。
   */
  applyTodayFloor(snapshot, settings, nowMs) {
    if (!this.history || !this.history.ledger || !snapshot) return;
    const dayKey = snapshot.dayKey;
    if (!DAY_KEY_RE.test(String(dayKey || ''))) return;
    const liveDay = this.daysCache ? this.daysCache[dayKey] : null;
    const merged = this.history.mergedToday(dayKey, liveDay);
    if (!merged) return;

    const dayOptions = {
      currency: settings.currency === 'USD' ? 'USD' : 'CNY',
      rateOverrides: settings.rateOverrides,
      includeSubagents: settings.includeSubagents,
      modelPrefixes: settings.modelPrefixes
    };
    let summary;
    try {
      summary = summarizeDay(merged, dayOptions);
    } catch (error) {
      this.output.appendLine(`今日兜底计算失败：${errorMessage(error)}`);
      return;
    }
    const liveSummary = liveDay ? summarizeDay(liveDay, dayOptions) : null;

    // 用整数 token 判定是否真的发生了兜底：金额是浮点，不适合做等值比较。
    const floorActive = liveSummary
      ? summary.tokens.total > liveSummary.tokens.total || summary.requests > liveSummary.requests
      : summary.tokens.total > 0 || summary.requests > 0;

    snapshot.totals = { cost: summary.cost, requests: summary.requests, tokens: summary.tokens };
    snapshot.byModel = summary.byModel;
    snapshot.floorActive = floorActive;
    snapshot.liveOnly = !liveSummary;

    if (floorActive) {
      snapshot.warnings = (snapshot.warnings || []).concat([
        {
          code: 'today-floor',
          message: liveSummary
            ? '今日合计含账本中已不在本地日志里的记录（日志被清理或目录已更换）；下方"按会话/按项目"来自实时日志，明细合计可能小于总计。'
            : '尚未完成扫描，今日数字来自账本快照。'
        }
      ]);
    }
  }

  /** 历史查询：纯计算，不写盘、不改账本。 */
  queryHistory(request) {
    const settings = this.settings;
    if (!this.history) {
      return { empty: true, reason: 'unavailable', message: '历史账本不可用。', ledger: null };
    }
    const nowMs = Date.now();
    const todayKey = dateKeyOfMs(nowMs);
    const liveDay = this.daysCache ? this.daysCache[todayKey] : null;
    let result;
    try {
      result = this.history.query({
        preset: request && request.preset,
        granularity: request && request.granularity,
        fromKey: request && request.fromKey,
        toKey: request && request.toKey,
        todayKey,
        nowMs,
        liveDay,
        currency: settings.currency,
        rateOverrides: settings.rateOverrides,
        includeSubagents: settings.includeSubagents,
        modelPrefixes: settings.modelPrefixes
      });
    } catch (error) {
      this.output.appendLine(`历史查询失败：${errorMessage(error)}`);
      return { empty: true, reason: 'error', message: `历史查询失败：${errorMessage(error)}`, ledger: null };
    }
    result.empty = result.summary.daysWithData === 0;
    result.scanning = !this.initialized;
    result.installDate = this.history.installDate;
    const retentionDays = this.retention && Number.isFinite(this.retention.days) ? this.retention.days : null;
    result.retentionDays = retentionDays;
    result.retentionNotice = Boolean(retentionDays && !this.retentionNoticeDismissed);
    result.suspended = Boolean(this.history.suspended);
    return result;
  }

  dismissRetentionNotice() {
    this.retentionNoticeDismissed = true;
    this.writeGlobalFlag(RETENTION_NOTICE_KEY, true);
  }

  /**
   * FR-16 从日志重建账本。先做一次全量扫描，确保重建依据的是当前日志。
   * 重建是 replace 语义，金额可能变小；失败时账本保持原样。
   */
  async rebuildLedger() {
    if (!this.history) {
      vscode.window.showErrorMessage('历史账本不可用，无法重建。');
      return false;
    }
    const choice = await vscode.window.showWarningMessage(
      '从日志重建账本会按当前日志全量重算，历史金额可能变小；已删除日志对应的数据将无法恢复。',
      { modal: true },
      '重建'
    );
    if (choice !== '重建') return false;

    this.needRebuild = true;
    this.initialized = false;
    await this.refreshNow('rebuild-scan');
    if (!this.initialized) {
      vscode.window.showErrorMessage('重建失败：当前日志目录不可用，账本未改动。');
      return false;
    }
    const nowMs = Date.now();
    const built = this.buildDays(this.settings, nowMs);
    const result = this.history.rebuildFromDays(built.days, built.signature, nowMs);
    if (!result.written) {
      vscode.window.showErrorMessage(`重建失败：${result.error || '账本写入失败'}`);
      return false;
    }
    await this.refreshNow('rebuild-publish');
    vscode.window.showInformationMessage(`已从日志重建账本：${Object.keys(built.days).length} 天。`);
    return true;
  }

  /**
   * FR-16 清除历史账本。只删除扩展账本，不修改 Claude Code 日志。
   * 本次会话暂停自动写回；重新加载 VS Code 后会从日志重新生成历史。
   */
  async clearLedger() {
    if (!this.history) {
      vscode.window.showErrorMessage('历史账本不可用，无法清除。');
      return false;
    }
    const choice = await vscode.window.showWarningMessage(
      '清除历史账本只删除扩展本地账本，不修改 Claude Code 日志。清除后本次会话不再自动写入；重新加载 VS Code 后会从日志重新生成历史。',
      { modal: true },
      '清除'
    );
    if (choice !== '清除') return false;
    const result = this.history.clear(Date.now());
    if (result.error) {
      vscode.window.showErrorMessage(`清除失败：${result.error}`);
      return false;
    }
    await this.refreshNow('clear');
    vscode.window.showInformationMessage('历史账本已清除。本次会话不再自动写入，重新加载 VS Code 后会从日志重建。');
    return true;
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
    // 出错时也用账本保住今日合计：日志目录被删/不可读时，
    // 0.1.1 会直接显示 0；这里有账本就不该让用户以为今天没花钱。
    if (this.settings) {
      try {
        this.applyTodayFloor(snapshot, this.settings, Date.now());
      } catch (error) {
        this.output.appendLine(`错误态兜底失败：${errorMessage(error)}`);
      }
    }
    snapshot.ledgerReady = Boolean(this.history && this.history.ledger);
    snapshot.ledgerStatus = this.history ? this.history.status : 'unavailable';
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
      target.appendLine(`今日兜底：${snapshot.floorActive ? '是（合计含账本中已不在日志里的记录）' : '否'}`);
    }
    target.appendLine('--- 历史账本 ---');
    let ledgerSummary = null;
    if (this.history) {
      ledgerSummary = this.history.summary();
      target.appendLine(`路径：${ledgerSummary.path}`);
      target.appendLine(
        `状态：${ledgerSummary.status}${ledgerSummary.readOnly ? '（只读，不覆盖）' : ''} · 天数 ${ledgerSummary.days} · 模型 ${ledgerSummary.models}`
      );
      target.appendLine(
        `区间：${ledgerSummary.firstRecordDate || '—'} → ${ledgerSummary.lastRecordDate || '—'} · 安装日 ${ledgerSummary.installDate || '—'}`
      );
      target.appendLine(
        `口径签名：${ledgerSummary.bucketSignature || '—'} · 仅账本记录 ${ledgerSummary.frozenDays} 天 · 峰谷口径过期 ${ledgerSummary.bucketingStaleDays} 天`
      );
      target.appendLine(
        `最近扫描：${ledgerSummary.lastScanAt ? new Date(ledgerSummary.lastScanAt).toISOString() : '—'} · 最近重建：${ledgerSummary.lastRebuildAt || '—'}`
      );
      target.appendLine(
        `大小：${ledgerSummary.bytes === null ? '—' : ledgerSummary.bytes + ' B'} · 连续写入失败 ${ledgerSummary.consecutiveWriteFailures} 次 · 最近合并 ${JSON.stringify(ledgerSummary.lastMerge)}`
      );
      for (const issue of ledgerSummary.issues) target.appendLine(`  账本提示：${issue}`);
    } else {
      target.appendLine('不可用（未取得 globalStorageUri 或初始化失败），今日页不受影响。');
    }
    const retentionText = this.retention && this.retention.found
      ? `${this.retention.days} 天（只读探测 ${this.retention.path}）`
      : `未检出${this.retention && this.retention.error ? '：' + this.retention.error : ''}`;
    target.appendLine(`日志保留期（cleanupPeriodDays）：${retentionText}`);
    target.appendLine(`内置节假日覆盖：${HOLIDAY_YEARS[0]}–${HOLIDAY_YEARS[HOLIDAY_YEARS.length - 1]}`);
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
      retention: this.retention,
      holidayYears: HOLIDAY_YEARS,
      snapshot,
      ledger: ledgerSummary,
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
