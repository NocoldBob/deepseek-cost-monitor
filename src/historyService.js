'use strict';

/**
 * 历史数据服务：把「账本读写」与「历史查询」封装成不依赖 vscode 的类。
 *
 * 为什么单独一层，而不是直接塞进 monitor.js：
 * 1. 不 require('vscode') 才能用 node:test 直接跑（M1 的测试策略）。
 * 2. 冷启动路径（FR-18）与常规刷新是两条完全不同的时序，混在 monitor 里
 *    很容易写出"启动时必须等全量扫描"的实现。
 *
 * 三条不可违背的规则：
 * 1. 写盘失败绝不能让刷新失败：账本是派生数据，丢了下次扫描还能重建。
 * 2. 账本版本高于当前时进入**只读**模式，绝不覆盖（§6.5）。
 * 3. 今日的实时值只在查询时做逐桶 max，**不写回账本**（§4.9）：
 *    实时值属于"正在发生"，不属于"已从日志复核"。
 */

const fs = require('fs');
const path = require('path');

const aggregate = require('./aggregate');
const ledgerModule = require('./ledger');
const history = require('./history');
const { dateKeyOfMs } = require('./pricing');

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

function cloneDaySafe(day) {
  if (!day) return null;
  return ledgerModule.cloneDay(day);
}

class HistoryService {
  /**
   * options:
   *   storageDir        账本目录（context.globalStorageUri.fsPath），必填
   *   installDate       安装日（YYYY-MM-DD），账本无 installDate 时写入
   *   bucketSignature   当前峰谷分桶口径签名
   *   nowMs             测试注入
   */
  constructor(options) {
    const opts = options || {};
    if (!opts.storageDir) throw new Error('HistoryService 需要 storageDir');
    this.storageDir = opts.storageDir;
    this.ledgerPath = ledgerModule.ledgerPathFor(this.storageDir);
    this.backupPath = ledgerModule.backupPathFor(this.storageDir);
    this.lockPath = ledgerModule.lockPathFor(this.storageDir);
    this.installDate = DAY_KEY_RE.test(String(opts.installDate || '')) ? opts.installDate : null;
    this.bucketSignature = opts.bucketSignature || null;
    this.ledger = null;
    this.status = 'unloaded';
    this.readOnly = false;
    this.suspended = false;
    this.issues = [];
    this.lastMerge = null;
    this.lastWrite = null;
    this.loadedAtMs = null;
    this.consecutiveWriteFailures = 0;
  }

  /** 启动时调用一次。同步、只读磁盘、不做任何扫描。 */
  load(nowMs) {
    const ms = Number.isFinite(nowMs) ? nowMs : Date.now();
    const result = {
      status: 'missing',
      restored: false,
      quarantined: null,
      issues: [],
      removedTempFiles: ledgerModule.cleanupTempFilesSync(this.storageDir)
    };

    // 高版本账本允许按只读兼容模式加载：结构能解析就展示，绝不覆盖。
    const read = ledgerModule.readLedgerSync(this.ledgerPath, { allowNewer: true });

    if (read.status === 'tooNew') {
      // 旧版本不得覆盖新版本账本：进入只读模式，历史页仍可展示（结构兼容时）。
      this.readOnly = true;
      this.ledger = ledgerModule.createLedger({
        installDate: this.installDate,
        bucketSignature: this.bucketSignature,
        nowMs: ms
      });
      this.status = 'too-new';
      this.issues = read.issues || [];
      result.status = 'too-new';
      result.issues = this.issues;
      this.loadedAtMs = ms;
      return result;
    }

    if (read.status === 'corrupt') {
      result.quarantined = this.quarantine();
      this.issues = (read.issues || []).slice();
      const backup = ledgerModule.readLedgerSync(this.backupPath, { allowNewer: true });
      if (backup.ledger) {
        this.ledger = backup.ledger;
        this.readOnly = Boolean(backup.newerVersion);
        this.status = backup.newerVersion ? 'too-new' : 'restored';
        result.status = this.status;
        result.restored = !backup.newerVersion;
        if (!backup.newerVersion) {
          // 立刻把恢复结果写回主文件，避免下次启动又走一遍恢复流程。
          const written = ledgerModule.writeLedgerAtomicSync(this.ledgerPath, this.ledger);
          this.lastWrite = written;
        }
      } else {
        this.ledger = ledgerModule.createLedger({
          installDate: this.installDate,
          bucketSignature: this.bucketSignature,
          nowMs: ms
        });
        this.status = 'rebuilt-empty';
        result.status = 'rebuilt-empty';
        if (backup.issues && backup.issues.length) this.issues = this.issues.concat(backup.issues);
      }
      result.issues = this.issues;
    } else if (read.ledger) {
      this.ledger = read.ledger;
      this.readOnly = Boolean(read.newerVersion);
      this.status = read.newerVersion ? 'too-new' : read.status;
      result.status = this.status;
      this.issues = read.issues || [];
      result.issues = this.issues;
    } else {
      // missing：首次运行，很正常，不是错误。
      this.ledger = ledgerModule.createLedger({
        installDate: this.installDate,
        bucketSignature: this.bucketSignature,
        nowMs: ms
      });
      this.status = 'missing';
      result.status = 'missing';
    }

    if (!this.ledger.installDate) this.ledger.installDate = this.installDate;
    this.installDate = this.ledger.installDate || this.installDate;
    if (!this.ledger.bucketSignature) this.ledger.bucketSignature = this.bucketSignature;
    this.suspended = false;
    this.loadedAtMs = ms;
    return result;
  }

  /** 把损坏的账本文件移走留证，返回新路径或 null。 */
  quarantine() {
    const target = path.join(this.storageDir, `history-ledger.corrupt-${Date.now()}.json`);
    try {
      fs.mkdirSync(this.storageDir, { recursive: true });
      fs.renameSync(this.ledgerPath, target);
      return target;
    } catch {
      return null;
    }
  }

  /**
   * 合并一批日聚合并写盘。
   * 返回 { stats, written, result, error }；**任何失败都不抛异常**。
   *
   * 多窗口安全：写盘前必须拿锁并重新读取磁盘账本，把“磁盘/内存/本轮扫描”
   * 三份来源合并后再写，否则后写者会用旧内存账本覆盖另一个窗口刚写入的日期。
   */
  recordDays(days, signature, nowMs) {
    if (!this.ledger) return { stats: null, written: false, result: null, error: '账本未加载' };
    if (this.readOnly) return { stats: null, written: false, result: null, error: 'read-only' };
    if (this.suspended) return { stats: null, written: false, result: null, error: 'suspended' };
    const ms = Number.isFinite(nowMs) ? nowMs : Date.now();
    if (signature && this.bucketSignature !== signature) this.bucketSignature = signature;

    const lock = ledgerModule.acquireLockSync(this.lockPath);
    if (!lock.ok) {
      this.consecutiveWriteFailures += 1;
      return { stats: null, written: false, result: null, error: `获取账本写锁失败：${lock.error}` };
    }

    let stats = null;
    let result = null;
    try {
      const disk = ledgerModule.readLedgerSync(this.ledgerPath);
      if (disk.status === 'tooNew') {
        this.readOnly = true;
        this.status = 'too-new';
        return { stats: null, written: false, result: null, error: 'read-only' };
      }

      let base;
      let dataChanged = false;
      if (disk.ledger) {
        base = ledgerModule.cloneLedger(disk.ledger);
        if (this.ledger && this.ledger.bucketSignature === this.bucketSignature) {
          if (base.bucketSignature !== this.bucketSignature) {
            // 磁盘可能是另一个窗口用旧口径写的：以当前窗口内存账本为基准，
            // 旧口径日期只在本轮日志已消失时保留并标 stale，避免与当前口径双计。
            const oldBase = base;
            base = ledgerModule.cloneLedger(this.ledger);
            for (const dateKey of Object.keys(oldBase.days || {})) {
              if (days && days[dateKey]) continue;
              if (!base.days[dateKey]) {
                const day = ledgerModule.cloneDay(oldBase.days[dateKey]);
                day.bucketingStale = true;
                base.days[dateKey] = day;
                dataChanged = true;
              }
            }
          } else {
            const merged = ledgerModule.mergeLedgerData(base, this.ledger);
            dataChanged = merged.changed;
          }
        }
        // 内存账本是旧口径时忽略它；mergeDays 会按当前口径整日替换。
      } else {
        if (disk.status === 'corrupt') {
          this.issues = this.issues.concat(disk.issues || []);
          try { this.quarantine(); } catch {}
        }
        base = ledgerModule.cloneLedger(this.ledger);
      }
      if (!base) {
        base = ledgerModule.createLedger({
          installDate: this.installDate,
          bucketSignature: this.bucketSignature,
          nowMs: ms
        });
      }
      if (this.installDate && !base.installDate) base.installDate = this.installDate;

      stats = ledgerModule.mergeDays(base, days, { bucketSignature: this.bucketSignature, nowMs: ms });
      this.lastMerge = stats;
      if (!dataChanged && !stats.changed) {
        this.ledger = base;
        return { stats, written: false, result: null, error: null };
      }

      result = ledgerModule.writeLedgerAtomicSync(this.ledgerPath, base, { backupPath: this.backupPath });
      this.lastWrite = result;
      if (!result.ok) {
        this.consecutiveWriteFailures += 1;
        this.ledger = base;
        return { stats, written: false, result, error: result.error || '写入失败' };
      }

      this.consecutiveWriteFailures = 0;
      this.ledger = base;
      this.status = 'ok';
      this.lastMerge = stats;
      this.installDate = base.installDate || this.installDate;
      return { stats, written: true, result, error: null };
    } catch (error) {
      this.consecutiveWriteFailures += 1;
      return { stats, written: false, result, error: `合并/写入失败：${error.message}` };
    } finally {
      ledgerModule.releaseLockSync(this.lockPath);
    }
  }

  /**
   * 今日记账本与实时值的逐桶 max（不写回账本）。
   * 账本今日不存在时直接用实时值；两者都没有时返回 null。
   */
  mergedToday(dateKey, liveDay) {
    if (!DAY_KEY_RE.test(String(dateKey || ''))) return liveDay ? cloneDaySafe(liveDay) : null;
    const existing = this.ledger && this.ledger.days ? this.ledger.days[dateKey] : null;
    if (!existing) return liveDay ? cloneDaySafe(liveDay) : null;
    const merged = cloneDaySafe(existing);
    if (liveDay) {
      try {
        ledgerModule.mergeLiveDay({ days: { [dateKey]: merged } }, liveDay, dateKey);
      } catch {
        // 实时值结构异常时退回账本值，绝不因为兜底失败而中断刷新。
      }
    }
    return merged;
  }

  /**
   * 历史查询。返回 aggregateHistory 的结果，额外附带账本摘要与"今天是否已用实时值"。
   *
   * params:
   *   preset / granularity / fromKey / toKey / todayKey / nowMs / liveDay
   *   currency / rateOverrides / includeSubagents / modelPrefixes
   */
  query(params) {
    const opts = params || {};
    const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
    const todayKey = DAY_KEY_RE.test(String(opts.todayKey || '')) ? opts.todayKey : dateKeyOfMs(nowMs);
    const range = history.resolveRange(opts.preset || 'last30', {
      todayKey,
      fromKey: opts.fromKey,
      toKey: opts.toKey,
      nowMs
    });
    const requested = String(opts.granularity || 'auto');
    const granularity = history.GRANULARITIES.includes(requested)
      ? requested
      : history.defaultGranularity(range.dayCount);

    const viewDays = Object.assign(Object.create(null), (this.ledger && this.ledger.days) || {});
    let liveApplied = false;
    if (opts.liveDay && range.days.includes(todayKey)) {
      const merged = this.mergedToday(todayKey, opts.liveDay);
      if (merged) {
        viewDays[todayKey] = merged;
        liveApplied = true;
      }
    }
    const viewLedger = Object.assign({}, this.ledger || {}, { days: viewDays });
    if (liveApplied) ledgerModule.recomputeBounds(viewLedger);

    const result = history.aggregateHistory(viewLedger, {
      fromKey: range.fromKey,
      toKey: range.toKey,
      todayKey,
      granularity,
      currency: opts.currency,
      rateOverrides: opts.rateOverrides,
      includeSubagents: opts.includeSubagents,
      modelPrefixes: opts.modelPrefixes
    });

    result.preset = range.preset;
    result.requestedGranularity = requested;
    result.liveTodayApplied = liveApplied;
    result.ledger = this.summary();
    return result;
  }

  /** 诊断用的账本摘要，附带加载状态与写盘健康度。 */
  summary() {
    const base = ledgerModule.ledgerSummary(this.ledger, this.ledgerPath);
    return Object.assign(base, {
      status: this.status,
      readOnly: this.readOnly,
      suspended: this.suspended,
      issues: this.issues.slice(0, 10),
      issueCount: this.issues.length,
      loadedAtMs: this.loadedAtMs,
      consecutiveWriteFailures: this.consecutiveWriteFailures,
      lastMerge: this.lastMerge,
      lastWrite: this.lastWrite
        ? { ok: this.lastWrite.ok, bytes: this.lastWrite.bytes, retries: this.lastWrite.retries, error: this.lastWrite.error }
        : null,
      storageDir: this.storageDir
    });
  }

  /**
   * FR-16 重建：按当前日志的完整结果替换账本，可以让数字变小。
   * 失败时不改动当前内存账本，保证“重建过程中扫描/写入失败，账本保持原样”。
   */
  rebuildFromDays(days, signature, nowMs) {
    if (!this.ledger) return { stats: null, written: false, result: null, error: '账本未加载' };
    if (this.readOnly) return { stats: null, written: false, result: null, error: 'read-only' };
    const lock = ledgerModule.acquireLockSync(this.lockPath);
    if (!lock.ok) return { stats: null, written: false, result: null, error: `获取账本写锁失败：${lock.error}` };
    try {
      const ms = Number.isFinite(nowMs) ? nowMs : Date.now();
      this.bucketSignature = signature || this.bucketSignature;
      const base = ledgerModule.cloneLedger(this.ledger);
      base.lastRebuildAt = new Date(ms).toISOString();
      const stats = ledgerModule.mergeDays(base, days, {
        bucketSignature: this.bucketSignature,
        nowMs: ms,
        mode: 'replace'
      });
      const result = ledgerModule.writeLedgerAtomicSync(this.ledgerPath, base, { backupPath: this.backupPath });
      this.lastWrite = result;
      if (!result.ok) {
        this.consecutiveWriteFailures += 1;
        return { stats, written: false, result, error: result.error || '写入失败' };
      }
      this.consecutiveWriteFailures = 0;
      this.ledger = base;
      this.status = 'ok';
      this.suspended = false;
      this.lastMerge = stats;
      this.installDate = base.installDate || this.installDate;
      return { stats, written: true, result, error: null };
    } catch (error) {
      this.consecutiveWriteFailures += 1;
      return { stats: null, written: false, result: null, error: `重建失败：${error.message}` };
    } finally {
      ledgerModule.releaseLockSync(this.lockPath);
    }
  }

  /**
   * FR-16 清除：删除账本与备份。本次会话暂停自动写回，
   * 否则下一个 30 秒刷新就会把日志重新扫回账本，清除失去意义。
   * 重新加载 VS Code 后账本缺失，会从日志重建。
   */
  clear(nowMs) {
    if (!this.ledger) return { removed: [], error: '账本未加载' };
    if (this.readOnly) return { removed: [], error: 'read-only' };
    const lock = ledgerModule.acquireLockSync(this.lockPath);
    if (!lock.ok) return { removed: [], error: `获取账本写锁失败：${lock.error}` };
    try {
      const ms = Number.isFinite(nowMs) ? nowMs : Date.now();
      const removed = ledgerModule.clearLedgerSync(this.storageDir);
      this.ledger = ledgerModule.createLedger({
        installDate: this.installDate,
        bucketSignature: this.bucketSignature,
        nowMs: ms
      });
      this.status = 'cleared';
      this.suspended = true;
      this.lastMerge = null;
      this.lastWrite = null;
      this.issues = [];
      return { removed, error: null };
    } catch (error) {
      return { removed: [], error: `清除失败：${error.message}` };
    } finally {
      ledgerModule.releaseLockSync(this.lockPath);
    }
  }
}

module.exports = { HistoryService };
