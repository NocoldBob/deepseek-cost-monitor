'use strict';

/**
 * 账本层（history-ledger.json）的读写、校验、合并与恢复。
 *
 * 三条核心语义，改代码前必须先读（需求文档 §6.3 / §6.4 / §6.6）：
 * 1. 账本只存 token 与请求数，不存金额。
 * 2. 合并是**逐桶逐字段单调取大（max）**：幂等、只增不减。
 *    日志被删除或截断时，重算值变小会被忽略，已记录的数据不会倒退（FR-02）。
 *    唯一能让数字变小的入口是显式的 rebuildFromDays（FR-16）。
 * 3. 分桶口径变化时（bucketSignature 不同）改为**整日替换**，否则同一条请求
 *    会同时落进高峰桶与低谷桶，总 token 直接翻倍。日志已消失的日期保留原值并标
 *    bucketingStale。
 *
 * 并发：不使用锁文件，靠 tmp + rename 原子替换与后写者胜（§6.6）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { BUCKET_FIELDS, BUCKET_VARIANTS, BUCKET_KINDS, createBucket, createModelEntry } = require('./aggregate');

const SCHEMA_VERSION = 1;
const LEDGER_FILE_NAME = 'history-ledger.json';
const BACKUP_FILE_NAME = 'history-ledger.backup.json';
const LOCK_FILE_NAME = 'history-ledger.lock';
const LOCK_STALE_MS = 15000;
const LOCK_RETRY_DELAYS_MS = [0, 20, 50, 100, 200];
const RENAME_RETRY_DELAYS_MS = [0, 50, 150, 400];
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function toInt(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.floor(number);
}

function isSafeKey(key) {
  return typeof key === 'string' && key.length > 0 && !UNSAFE_KEYS.has(key);
}

function isSafeDayKey(key) {
  if (!isSafeKey(key) || !DAY_KEY_RE.test(key)) return false;
  const [year, month, day] = key.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function nowIso(ms) {
  return new Date(ms).toISOString();
}

function cloneBucket(bucket) {
  const out = createBucket();
  for (const field of BUCKET_FIELDS) out[field] = toInt(bucket && bucket[field]);
  return out;
}

function cloneDay(day) {
  const models = Object.create(null);
  for (const model of Object.keys((day && day.models) || {})) {
    if (!isSafeKey(model)) continue;
    const source = day.models[model] || {};
    const entry = createModelEntry();
    for (const kind of BUCKET_KINDS) {
      for (const variant of BUCKET_VARIANTS) {
        const bucket = source[kind] && source[kind][variant];
        if (bucket) entry[kind][variant] = cloneBucket(bucket);
      }
    }
    models[model] = entry;
  }
  return {
    lastRecomputedAt: Number.isFinite(day && day.lastRecomputedAt) ? day.lastRecomputedAt : null,
    bucketingStale: Boolean(day && day.bucketingStale),
    models
  };
}

/**
 * 分桶口径签名：排序后的节假日表 + 固定时区。
 * 排序保证表项顺序不影响签名；不排序会让“同一张表换个顺序”触发整日替换。
 */
function computeBucketSignature(holidays) {
  let list = [];
  if (holidays instanceof Set) list = Array.from(holidays);
  else if (Array.isArray(holidays)) list = holidays;
  const normalized = [];
  for (const item of list) {
    const value = String(item || '').trim();
    if (DAY_KEY_RE.test(value)) normalized.push(value);
  }
  normalized.sort();
  const unique = Array.from(new Set(normalized));
  return crypto.createHash('sha1').update(['tz=+08:00', ...unique].join('\n')).digest('hex').slice(0, 12);
}

function createLedger(options) {
  const opts = options || {};
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  return {
    schemaVersion: SCHEMA_VERSION,
    installDate: opts.installDate || null,
    firstRecordDate: null,
    lastRecordDate: null,
    updatedAt: nowIso(nowMs),
    lastScanAt: null,
    lastRebuildAt: null,
    bucketSignature: opts.bucketSignature || null,
    days: Object.create(null)
  };
}

/** 深拷贝账本，用于合并磁盘/内存/本轮扫描三份来源。 */
function cloneLedger(ledger) {
  if (!ledger) return null;
  const out = createLedger({
    installDate: ledger.installDate || null,
    bucketSignature: ledger.bucketSignature || null,
    nowMs: Number.isFinite(ledger.lastScanAt) ? ledger.lastScanAt : Date.now()
  });
  out.updatedAt = ledger.updatedAt || out.updatedAt;
  out.lastScanAt = Number.isFinite(ledger.lastScanAt) ? ledger.lastScanAt : null;
  out.lastRebuildAt = ledger.lastRebuildAt || null;
  out.firstRecordDate = ledger.firstRecordDate || null;
  out.lastRecordDate = ledger.lastRecordDate || null;
  for (const dateKey of Object.keys(ledger.days || {})) {
    if (!isSafeDayKey(dateKey)) continue;
    out.days[dateKey] = cloneDay(ledger.days[dateKey]);
  }
  return out;
}

/**
 * 某日是否只剩账本快照（日志已不在本轮扫描中 / 从未复核）。
 * lastRecomputedAt 是“该日最近一次从日志成功重算”的时间；lastScanAt 是
 * “最近一次扫描”的时间。只有两者相等（本轮刚复核）才算可复核。
 */
function isDayFrozen(day, lastScanAt) {
  if (!day) return false;
  if (!Number.isFinite(day.lastRecomputedAt)) return true;
  if (!Number.isFinite(lastScanAt)) return false;
  return day.lastRecomputedAt < lastScanAt;
}

/**
 * 校验并净化从磁盘读到的结构。
 * 返回 { status, ledger, issues }，status ∈ ok | missing | corrupt | tooNew。
 * 任何单点损坏都只丢那一条，不让整个账本失效（FR-12）。
 */
function validateLedger(raw, options) {
  const opts = options || {};
  const issues = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { status: 'corrupt', ledger: null, issues: ['账本根节点不是对象'] };
  }
  const version = Number(raw.schemaVersion);
  if (!Number.isInteger(version) || version < 1) {
    return { status: 'corrupt', ledger: null, issues: ['schemaVersion 非法'] };
  }
  let newerVersion = false;
  if (version > SCHEMA_VERSION) {
    if (!opts.allowNewer) {
      return { status: 'tooNew', ledger: null, issues: [`账本版本 ${version} 高于当前支持的 ${SCHEMA_VERSION}`], newerVersion: true };
    }
    newerVersion = true;
    issues.push(`账本版本 ${version} 高于当前支持的 ${SCHEMA_VERSION}，按只读兼容模式加载`);
  }

  const ledger = createLedger({
    installDate: typeof raw.installDate === 'string' && DAY_KEY_RE.test(raw.installDate) ? raw.installDate : null,
    bucketSignature: typeof raw.bucketSignature === 'string' ? raw.bucketSignature : null,
    nowMs: Date.now()
  });
  ledger.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : ledger.updatedAt;
  ledger.lastScanAt = Number.isFinite(raw.lastScanAt) ? toInt(raw.lastScanAt) : null;
  ledger.lastRebuildAt = typeof raw.lastRebuildAt === 'string' ? raw.lastRebuildAt : null;

  const days = raw.days && typeof raw.days === 'object' && !Array.isArray(raw.days) ? raw.days : null;
  if (!days) issues.push('缺少 days 或类型错误，按空账本处理');

  for (const dateKey of Object.keys(days || {})) {
    if (!isSafeDayKey(dateKey)) {
      issues.push(`忽略非法日期键：${dateKey}`);
      continue;
    }
    const day = cloneDay(days[dateKey]);
    const modelCount = Object.keys(day.models).length;
    if (!modelCount) {
      issues.push(`忽略无模型数据的日期：${dateKey}`);
      continue;
    }
    ledger.days[dateKey] = day;
  }

  recomputeBounds(ledger);
  return { status: 'ok', ledger, issues, newerVersion };
}

function recomputeBounds(ledger) {
  const keys = Object.keys(ledger.days || {}).sort();
  ledger.firstRecordDate = keys.length ? keys[0] : null;
  ledger.lastRecordDate = keys.length ? keys[keys.length - 1] : null;
}

/**
 * 合并 dayAgg（或任意同结构的天数据）。
 *
 * options:
 *   bucketSignature  本轮计算使用的分桶口径签名
 *   nowMs            写入时间
 *   mode             'merge'（默认，max）| 'replace'（FR-16 重建）
 *
 * 返回 stats：{ added, merged, replaced, frozen, changed }
 * changed 用于“无变化不写盘”，不比较字符串。
 */
function mergeDays(ledger, incomingDays, options) {
  const opts = options || {};
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const incoming = incomingDays || {};
  const stats = { added: 0, merged: 0, replaced: 0, frozen: 0, changed: false };
  const previousLastScanAt = Number.isFinite(ledger.lastScanAt) ? ledger.lastScanAt : null;
  // opts 没有签名时不做“口径变化”判断；有签名而账本没有（旧账本）时，
  // 视为口径变化并整日替换，避免把旧桶与新桶 max 成双计。
  const signatureChanged = Boolean(opts.bucketSignature) && ledger.bucketSignature !== opts.bucketSignature;
  const forceReplace = opts.mode === 'replace';

  for (const dateKey of Object.keys(incoming)) {
    if (!isSafeDayKey(dateKey)) continue;
    const source = incoming[dateKey];
    if (!source || typeof source !== 'object') continue;
    const day = cloneDay({ ...source, lastRecomputedAt: source.lastRecomputedAt === undefined ? nowMs : source.lastRecomputedAt });
    if (!Object.keys(day.models).length) continue;

    const existing = ledger.days[dateKey];
    if (!existing) {
      day.lastRecomputedAt = nowMs;
      ledger.days[dateKey] = day;
      stats.added += 1;
      stats.changed = true;
      continue;
    }

    const wasFrozen = isDayFrozen(existing, previousLastScanAt);

    if (forceReplace) {
      day.lastRecomputedAt = nowMs;
      ledger.days[dateKey] = day;
      stats.replaced += 1;
      stats.changed = true;
      continue;
    }

    if (signatureChanged) {
      day.lastRecomputedAt = nowMs;
      ledger.days[dateKey] = day;
      stats.replaced += 1;
      stats.changed = true;
      continue;
    }

    // 同一口径：逐桶逐字段取大。日志被删后重算值变小，这里会原样保留旧值。
    let dayChanged = false;
    if (existing.bucketingStale) {
      existing.bucketingStale = false;
      dayChanged = true;
    }
    for (const model of Object.keys(day.models)) {
      if (!isSafeKey(model)) continue;
      if (!existing.models[model]) {
        existing.models[model] = day.models[model];
        dayChanged = true;
        continue;
      }
      for (const kind of BUCKET_KINDS) {
        for (const variant of BUCKET_VARIANTS) {
          const target = existing.models[model][kind][variant];
          const sourceBucket = day.models[model][kind][variant];
          for (const field of BUCKET_FIELDS) {
            const next = toInt(sourceBucket[field]);
            if (next > toInt(target[field])) {
              target[field] = next;
              dayChanged = true;
            }
          }
        }
      }
    }
    // 出现在本轮 incoming 中 = 本轮确实扫描到了这一天；用扫描时间而非
    // 缓存里的旧构建时间，否则复用 daysCache 时会把已看到的日期误判为仅账本。
    existing.lastRecomputedAt = nowMs;
    if (wasFrozen) dayChanged = true;
    if (dayChanged) stats.changed = true;
    stats.merged += 1;
  }

  if (forceReplace) {
    // 重建：账本里“本轮没有日志”的日期必须删掉，否则重建永远清不干净。
    for (const dateKey of Object.keys(ledger.days)) {
      if (incoming[dateKey]) continue;
      delete ledger.days[dateKey];
      stats.changed = true;
    }
  } else if (signatureChanged) {
    for (const dateKey of Object.keys(ledger.days)) {
      if (incoming[dateKey]) continue;
      if (!ledger.days[dateKey].bucketingStale) {
        ledger.days[dateKey].bucketingStale = true;
        stats.frozen += 1;
        stats.changed = true;
      }
    }
  } else {
    // 本轮扫描没有看到的日期：之前还能复核的，现在变成“仅账本”，必须落盘。
    for (const dateKey of Object.keys(ledger.days)) {
      if (incoming[dateKey]) continue;
      if (!isDayFrozen(ledger.days[dateKey], previousLastScanAt)) {
        stats.changed = true;
      }
    }
  }

  if (opts.bucketSignature && ledger.bucketSignature !== opts.bucketSignature) {
    ledger.bucketSignature = opts.bucketSignature;
    stats.changed = true;
  }

  ledger.lastScanAt = nowMs;
  if (stats.changed) {
    ledger.updatedAt = nowIso(nowMs);
    recomputeBounds(ledger);
  }
  return stats;
}

/**
 * 用今天的实时快照兜底账本里的今天（§4.9 / §4.10 情况 C）。
 * 只做 max，不写入历史、不修改 lastRecomputedAt：
 * 实时值属于“正在发生”，不属于“已从日志复核”。
 */
function mergeLiveDay(ledger, liveDay, dateKey) {
  if (!ledger || !liveDay || !isSafeDayKey(dateKey)) return { changed: false, hasLedgerValue: false };
  const existing = ledger.days[dateKey];
  const incoming = cloneDay(liveDay);
  if (!existing) return { changed: false, hasLedgerValue: false };
  let changed = false;
  for (const model of Object.keys(incoming.models)) {
    if (!isSafeKey(model)) continue;
    if (!existing.models[model]) {
      existing.models[model] = incoming.models[model];
      changed = true;
      continue;
    }
    for (const kind of BUCKET_KINDS) {
      for (const variant of BUCKET_VARIANTS) {
        const target = existing.models[model][kind][variant];
        const sourceBucket = incoming.models[model][kind][variant];
        for (const field of BUCKET_FIELDS) {
          const next = toInt(sourceBucket[field]);
          if (next > toInt(target[field])) {
            target[field] = next;
            changed = true;
          }
        }
      }
    }
  }
  return { changed, hasLedgerValue: true };
}

/**
 * 数据合并（不推进 lastScanAt、不改变“本轮是否看到”的语义）。
 * 用于把内存账本并入磁盘账本：只取桶的最大值并保留复核时间，
 * 不把内存里的旧日期误标成“本轮刚复核”。
 *
 * 口径不同不能做 max，否则同一条请求会同时落在高峰/低谷桶；此时只补
 * target 缺失的日期并标记 bucketingStale，具体由调用方决定以谁为基准。
 */
function mergeLedgerData(target, source) {
  const stats = { changed: false, added: 0, merged: 0 };
  if (!target || !source) return stats;
  const differentSignature = Boolean(target.bucketSignature && source.bucketSignature && target.bucketSignature !== source.bucketSignature);
  for (const dateKey of Object.keys(source.days || {})) {
    if (!isSafeDayKey(dateKey)) continue;
    const src = source.days[dateKey];
    if (!src) continue;
    const dst = target.days[dateKey];
    if (!dst) {
      const day = cloneDay(src);
      if (differentSignature) day.bucketingStale = true;
      target.days[dateKey] = day;
      stats.added += 1;
      stats.changed = true;
      continue;
    }
    if (differentSignature) continue;
    let dayChanged = false;
    for (const model of Object.keys(src.models || {})) {
      if (!isSafeKey(model)) continue;
      if (!dst.models[model]) {
        dst.models[model] = cloneDay({ models: { [model]: src.models[model] } }).models[model];
        dayChanged = true;
        continue;
      }
      for (const kind of BUCKET_KINDS) {
        for (const variant of BUCKET_VARIANTS) {
          const sourceBucket = src.models[model][kind] && src.models[model][kind][variant];
          if (!sourceBucket) continue;
          const targetBucket = dst.models[model][kind][variant];
          for (const field of BUCKET_FIELDS) {
            const next = toInt(sourceBucket[field]);
            if (next > toInt(targetBucket[field])) {
              targetBucket[field] = next;
              dayChanged = true;
            }
          }
        }
      }
    }
    if (Number.isFinite(src.lastRecomputedAt) && (!Number.isFinite(dst.lastRecomputedAt) || src.lastRecomputedAt > dst.lastRecomputedAt)) {
      dst.lastRecomputedAt = src.lastRecomputedAt;
      dayChanged = true;
    }
    if (src.bucketingStale && !dst.bucketingStale) {
      dst.bucketingStale = true;
      dayChanged = true;
    }
    if (dayChanged) {
      stats.merged += 1;
      stats.changed = true;
    }
  }
  if (Number.isFinite(source.lastScanAt) && (!Number.isFinite(target.lastScanAt) || source.lastScanAt > target.lastScanAt)) {
    target.lastScanAt = source.lastScanAt;
    stats.changed = true;
  }
  return stats;
}

/** 稳定序列化：键排序固定，避免“内容相同但键序不同”导致无谓写盘。 */
function serializeLedger(ledger, options) {
  const opts = options || {};
  const days = Object.create(null);
  for (const dateKey of Object.keys(ledger.days || {}).sort()) {
    const day = ledger.days[dateKey];
    const models = Object.create(null);
    for (const model of Object.keys(day.models || {}).sort()) {
      const entry = day.models[model];
      models[model] = {
        main: { peak: cloneBucket(entry.main.peak), offpeak: cloneBucket(entry.main.offpeak) },
        subagent: { peak: cloneBucket(entry.subagent.peak), offpeak: cloneBucket(entry.subagent.offpeak) }
      };
    }
    days[dateKey] = {
      lastRecomputedAt: day.lastRecomputedAt === null || day.lastRecomputedAt === undefined ? null : toInt(day.lastRecomputedAt),
      bucketingStale: Boolean(day.bucketingStale),
      models
    };
  }
  const ordered = {
    schemaVersion: ledger.schemaVersion || SCHEMA_VERSION,
    installDate: ledger.installDate || null,
    firstRecordDate: ledger.firstRecordDate || null,
    lastRecordDate: ledger.lastRecordDate || null,
    updatedAt: ledger.updatedAt || null,
    lastScanAt: Number.isFinite(ledger.lastScanAt) ? toInt(ledger.lastScanAt) : null,
    lastRebuildAt: ledger.lastRebuildAt || null,
    bucketSignature: ledger.bucketSignature || null,
    days
  };
  return JSON.stringify(ordered, null, opts.pretty ? 2 : 0);
}

function hashText(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

function ledgerPathFor(storageDir) {
  return path.join(storageDir, LEDGER_FILE_NAME);
}

function backupPathFor(storageDir) {
  return path.join(storageDir, BACKUP_FILE_NAME);
}

function lockPathFor(storageDir) {
  return path.join(storageDir, LOCK_FILE_NAME);
}

/**
 * 跨窗口写锁。多窗口同时写账本时，单靠“原子替换 + 后写者胜”会丢数据：
 * 后写者若在加载后没有重新读取，就会用旧账本覆盖前面窗口刚写入的日期。
 * 因此写盘前必须拿锁并重新读取磁盘账本，再做合并。
 *
 * 锁失败不阻塞刷新：返回 ok:false，调用方跳过本次写盘，下次刷新重试。
 */
function acquireLockSync(lockPath, options) {
  const opts = options || {};
  const staleMs = Number.isFinite(opts.staleMs) ? opts.staleMs : LOCK_STALE_MS;
  const delays = Array.isArray(opts.delays) ? opts.delays : LOCK_RETRY_DELAYS_MS;
  let staleRemoved = false;
  try {
    // 首次运行时 globalStorage 扩展目录可能还不存在；锁文件在写盘前创建，
    // 必须先保证父目录存在，否则 open('wx') 会以 ENOENT 失败，历史账本写不进去。
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch (error) {
    return { ok: false, staleRemoved, error: `无法创建账本目录：${error.message}` };
  }
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    const delay = Number(delays[attempt]) || 0;
    if (delay) sleepSync(delay);
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeSync(fd, String(process.pid));
      } finally {
        fs.closeSync(fd);
      }
      return { ok: true, staleRemoved };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        return { ok: false, staleRemoved, error: error ? error.message : '未知错误' };
      }
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          fs.unlinkSync(lockPath);
          staleRemoved = true;
          continue;
        }
      } catch {
        // 锁文件刚好被释放或无法 stat：进入下一轮重试。
      }
    }
  }
  return { ok: false, staleRemoved, error: '等待账本写锁超时' };
}

function releaseLockSync(lockPath) {
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch (error) {
    return !error || error.code === 'ENOENT';
  }
}

/**
 * 读取账本。missing 不是错误（首次运行）；corrupt 时优先尝试备份。
 */
function readLedgerSync(filePath, options) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { status: 'missing', ledger: null, issues: [] };
    return { status: 'corrupt', ledger: null, issues: [`读取失败：${error.message}`] };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { status: 'corrupt', ledger: null, issues: [`JSON 解析失败：${error.message}`], hash: null };
  }
  const validated = validateLedger(raw, options);
  return { ...validated, hash: hashText(text), bytes: Buffer.byteLength(text, 'utf8') };
}

function sleepSync(ms) {
  if (!(ms > 0)) return;
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

/**
 * 原子写入：tmp → fsync → rename（Windows 上 EPERM/EBUSY 重试）。
 * 写前把旧账本转存为 backup，写入失败不改动正式文件。
 */
function writeLedgerAtomicSync(filePath, ledger, options) {
  const opts = options || {};
  const dir = path.dirname(filePath);
  const text = opts.text || serializeLedger(ledger, { pretty: opts.pretty });
  const bytes = Buffer.byteLength(text, 'utf8');
  const result = { ok: false, bytes, retries: 0, error: null, backupError: null, hash: hashText(text) };

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    result.error = error.message;
    return result;
  }

  // 备份失败不影响主写入：旧账本还在磁盘上，rename 是原子的。
  const backupPath = opts.backupPath || path.join(dir, BACKUP_FILE_NAME);
  try {
    if (fs.existsSync(filePath)) fs.copyFileSync(filePath, backupPath);
  } catch (error) {
    result.backupError = error.message;
  }

  const tempPath = `${filePath}.tmp.${process.pid}`;
  let handle = null;
  try {
    handle = fs.openSync(tempPath, 'w');
    fs.writeFileSync(handle, text);
    try { fs.fsyncSync(handle); } catch {}
  } catch (error) {
    result.error = `写入临时文件失败：${error.message}`;
    try { if (handle !== null) fs.closeSync(handle); } catch {}
    handle = null;
    try { fs.unlinkSync(tempPath); } catch {}
    return result;
  } finally {
    try { if (handle !== null) fs.closeSync(handle); } catch {}
  }

  for (let attempt = 0; attempt < RENAME_RETRY_DELAYS_MS.length; attempt += 1) {
    const delay = RENAME_RETRY_DELAYS_MS[attempt];
    if (delay) sleepSync(delay);
    try {
      fs.renameSync(tempPath, filePath);
      result.ok = true;
      result.retries = attempt;
      result.error = null;
      return result;
    } catch (error) {
      result.error = error.message;
      result.retries = attempt + 1;
      result.code = error.code || null;
    }
  }

  try { fs.unlinkSync(tempPath); } catch {}
  return result;
}

/** 清理进程异常退出遗留的临时文件，启动时调用。 */
function cleanupTempFilesSync(dir, fileName) {
  const base = fileName || LEDGER_FILE_NAME;
  const removed = [];
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return removed;
  }
  const prefix = `${base}.tmp.`;
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    try {
      fs.unlinkSync(path.join(dir, entry));
      removed.push(entry);
    } catch {}
  }
  return removed;
}

function clearLedgerSync(storageDir) {
  const removed = [];
  for (const filePath of [ledgerPathFor(storageDir), backupPathFor(storageDir)]) {
    try {
      fs.unlinkSync(filePath);
      removed.push(path.basename(filePath));
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }
  return removed;
}

/** 诊断信息：账本规模、可信度分布（§FR-15）。 */
function ledgerSummary(ledger, filePath) {
  const summary = {
    path: filePath || null,
    schemaVersion: ledger ? ledger.schemaVersion : null,
    days: 0,
    firstRecordDate: ledger ? ledger.firstRecordDate : null,
    lastRecordDate: ledger ? ledger.lastRecordDate : null,
    installDate: ledger ? ledger.installDate : null,
    updatedAt: ledger ? ledger.updatedAt : null,
    lastScanAt: ledger && Number.isFinite(ledger.lastScanAt) ? ledger.lastScanAt : null,
    lastRebuildAt: ledger ? ledger.lastRebuildAt : null,
    bucketSignature: ledger ? ledger.bucketSignature : null,
    bucketingStaleDays: 0,
    frozenDays: 0,
    models: 0,
    bytes: null
  };
  if (!ledger) return summary;
  const modelSet = new Set();
  const keys = Object.keys(ledger.days || {});
  summary.days = keys.length;
  for (const dateKey of keys) {
    const day = ledger.days[dateKey];
    if (day.bucketingStale) summary.bucketingStaleDays += 1;
    if (isDayFrozen(day, ledger.lastScanAt)) summary.frozenDays += 1;
    for (const model of Object.keys(day.models || {})) modelSet.add(model);
  }
  summary.models = modelSet.size;
  if (filePath) {
    try {
      summary.bytes = fs.statSync(filePath).size;
    } catch {}
  }
  return summary;
}

module.exports = {
  SCHEMA_VERSION,
  LEDGER_FILE_NAME,
  BACKUP_FILE_NAME,
  LOCK_FILE_NAME,
  computeBucketSignature,
  createLedger,
  cloneLedger,
  cloneDay,
  isDayFrozen,
  validateLedger,
  mergeDays,
  mergeLiveDay,
  mergeLedgerData,
  serializeLedger,
  hashText,
  ledgerPathFor,
  backupPathFor,
  lockPathFor,
  acquireLockSync,
  releaseLockSync,
  readLedgerSync,
  writeLedgerAtomicSync,
  cleanupTempFilesSync,
  clearLedgerSync,
  ledgerSummary,
  recomputeBounds
};
