'use strict';

const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const results = [];
const outputLines = [];
const statusItems = [];
const watchedPatterns = [];
const webviewProviders = new Map();
const commands = new Map();
const configHandlers = new Set();

function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition), detail: detail === undefined ? null : detail });
}

function disposable(onDispose) {
  return { dispose: onDispose || function () {} };
}

const configValues = {
  projectsPath: '',
  modelPrefixes: ['deepseek'],
  currency: 'CNY',
  rateOverrides: {},
  holidays: [],
  refreshIntervalSeconds: 30,
  includeSubagents: true,
  showStatusBar: true
};

class RelativePattern {
  constructor(base, pattern) {
    this.base = base;
    this.pattern = pattern;
  }
}

class MarkdownString {
  constructor(value) {
    this.value = value;
  }
}

const vscodeStub = {
  Uri: {
    file: value => ({ fsPath: value, scheme: 'file', path: value }),
    joinPath: (base, ...segments) => ({
      fsPath: path.join(base.fsPath, ...segments),
      scheme: 'file',
      path: path.join(base.fsPath, ...segments)
    })
  },
  RelativePattern,
  MarkdownString,
  StatusBarAlignment: { Left: 1, Right: 2 },
  workspace: {
    getConfiguration: () => ({
      get: (key, fallback) => (Object.prototype.hasOwnProperty.call(configValues, key) ? configValues[key] : fallback)
    }),
    createFileSystemWatcher: pattern => {
      watchedPatterns.push(pattern);
      const handlers = { change: [], create: [], delete: [] };
      return {
        onDidChange: handler => { handlers.change.push(handler); return disposable(); },
        onDidCreate: handler => { handlers.create.push(handler); return disposable(); },
        onDidDelete: handler => { handlers.delete.push(handler); return disposable(); },
        dispose: () => {}
      };
    },
    onDidChangeConfiguration: handler => {
      configHandlers.add(handler);
      return disposable(() => configHandlers.delete(handler));
    }
  },
  window: {
    createOutputChannel: () => {
      const channel = {
        appendLine: line => outputLines.push(line),
        show: () => {},
        dispose: () => {}
      };
      return channel;
    },
    createStatusBarItem: () => {
      const item = {
        text: '',
        tooltip: null,
        command: null,
        name: '',
        visible: false,
        show() { this.visible = true; },
        hide() { this.visible = false; },
        dispose() {}
      };
      statusItems.push(item);
      return item;
    },
    registerWebviewViewProvider: (id, provider) => {
      webviewProviders.set(id, provider);
      return disposable();
    }
  },
  commands: {
    registerCommand: (id, handler) => {
      commands.set(id, handler);
      return disposable(() => commands.delete(id));
    },
    executeCommand: async () => undefined
  }
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return originalLoad.call(this, request, parent, isMain);
};

const extension = require('../extension.js');

function waitFor(predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    function tick() {
      let value = false;
      try { value = predicate(); } catch {}
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) return reject(new Error(`等待超时：${label}`));
      setTimeout(tick, 100);
    }
    tick();
  });
}

function fakeWebviewView() {
  const posted = [];
  const messageHandlers = [];
  const disposeHandlers = [];
  const webview = {
    options: null,
    html: '',
    cspSource: 'vscode-resource:',
    asWebviewUri: uri => 'vscode-webview://stub/' + encodeURI(uri.fsPath.replace(/\\/g, '/')),
    onDidReceiveMessage: handler => {
      messageHandlers.push(handler);
      return disposable();
    },
    postMessage: message => {
      posted.push(message);
      return Promise.resolve(true);
    }
  };
  return {
    webview,
    posted,
    messageHandlers,
    onDidDispose: handler => { disposeHandlers.push(handler); return disposable(); },
    onDidChangeVisibility: () => disposable(),
    show: () => {},
    dispose: () => { for (const handler of disposeHandlers) handler(); }
  };
}

(async () => {
  // 账本写在临时目录里，不污染真实扩展存储，也不要在自检里碰用户数据。
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-check-'));
  const globalStateMap = new Map();
  const context = {
    subscriptions: [],
    extensionUri: { fsPath: 'D:\\vscode-ext\\deepseek-cost-monitor', scheme: 'file', path: 'D:\\vscode-ext\\deepseek-cost-monitor' },
    globalStorageUri: { fsPath: storageDir, scheme: 'file', path: storageDir },
    globalState: {
      get: key => globalStateMap.get(key),
      update: (key, value) => {
        globalStateMap.set(key, value);
        return Promise.resolve();
      },
      keys: () => Array.from(globalStateMap.keys())
    }
  };
  extension.activate(context);

  await waitFor(() => statusItems.length === 1 && /¥|DeepSeek --/.test(statusItems[0].text) && !/计算中/.test(statusItems[0].text), 20000, '初始扫描完成');
  const statusItem = statusItems[0];
  check('状态栏已创建', statusItems.length === 1, statusItems.length);
  check('状态栏金额已显示', statusItem.visible && /¥\d/.test(statusItem.text), statusItem.text);
  check('状态栏 tooltip', Boolean(statusItem.tooltip && String(statusItem.tooltip.value).includes('非官方账单')), statusItem.tooltip ? statusItem.tooltip.value.slice(0, 80) : null);
  check('状态栏点击命令', statusItem.command === 'deepseekCostMonitor.focus', statusItem.command);
  check('文件监听已建立', watchedPatterns.length === 1 && watchedPatterns[0].pattern === '**/*.jsonl', watchedPatterns.map(item => item.pattern));
  check(
    '命令已注册',
    ['refresh', 'focus', 'showDiagnostics', 'rebuildLedger', 'clearLedger']
      .every(name => commands.has('deepseekCostMonitor.' + name)),
    Array.from(commands.keys())
  );
  check('激活无启动错误', !outputLines.some(line => line.includes('启动失败') || line.includes('回调异常')), outputLines);

  const provider = webviewProviders.get('deepseekCostMonitor.today');
  check('Webview 提供者已注册', Boolean(provider), Boolean(provider));
  const view = fakeWebviewView();
  provider.resolveWebviewView(view);

  check('Webview 启用脚本', Boolean(view.webview.options && view.webview.options.enableScripts), view.webview.options);
  const html = view.webview.html;
  check('Webview 含 CSP nonce', /script-src 'nonce-[0-9a-f]+'/.test(html), null);
  check('Webview 无远程资源', !/https?:\/\//.test(html), null);
  check('Webview 引入本地样式与脚本', html.includes('vscode-webview://stub/') && html.includes('media/main.js') && html.includes('media/style.css'), null);
  check('Webview 初始占位', html.includes('正在计算'), null);
  check('Webview 含今日/历史标签', html.includes('id="tabToday"') && html.includes('id="tabHistory"') && html.includes('id="historyPane"'), null);
  check('Webview 含自定义范围与季/年粒度', html.includes('id="customFrom"') && html.includes('data-granularity="quarter"') && html.includes('data-granularity="year"'), null);
  check('Webview 含波动图与热力图容器', html.includes('id="trendChart"') && html.includes('id="heatmap"') && html.includes('id="heatYear"'), null);
  check('Webview 含保留期提示条', html.includes('id="retentionBanner"'), null);

  for (const handler of view.messageHandlers) handler({ type: 'ready' });
  await waitFor(() => view.posted.some(message => message.type === 'snapshot'), 5000, '快照推送');
  const firstSnapshot = view.posted.filter(message => message.type === 'snapshot').pop().snapshot;
  check('快照请求数大于零', firstSnapshot.totals.requests > 0, firstSnapshot.totals.requests);
  check('快照币种默认 CNY', firstSnapshot.currency === 'CNY' && firstSnapshot.currencySymbol === '¥', firstSnapshot.currency);
  const todayKey = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
  check('快照日期为北京时间今日', firstSnapshot.dayKey === todayKey, { snapshot: firstSnapshot.dayKey, todayKey });
  check('快照含模型与会话', firstSnapshot.byModel.length > 0 && firstSnapshot.bySession.length > 0, {
    models: firstSnapshot.byModel.length,
    sessions: firstSnapshot.bySession.length
  });

  const postedBefore = view.posted.length;
  for (const handler of view.messageHandlers) handler({ type: 'refresh' });
  await waitFor(() => view.posted.length > postedBefore && view.posted[view.posted.length - 1].type === 'snapshot', 15000, '手动刷新快照');
  check('手动刷新产生新快照', view.posted[view.posted.length - 1].type === 'snapshot', view.posted[view.posted.length - 1].type);

  configValues.currency = 'USD';
  for (const handler of configHandlers) handler({ affectsConfiguration: section => section.startsWith('deepseekCostMonitor') });
  await waitFor(() => {
    const last = view.posted[view.posted.length - 1];
    return last && last.type === 'snapshot' && last.snapshot.currency === 'USD';
  }, 15000, '配置变更重算');
  const usdSnapshot = view.posted[view.posted.length - 1].snapshot;
  check('币种切换生效', usdSnapshot.currency === 'USD' && usdSnapshot.currencySymbol === '$', usdSnapshot.currency);
  check('USD 金额有效', usdSnapshot.totals.cost > 0, usdSnapshot.totals.cost);
  await waitFor(() => statusItem.text.includes('$'), 5000, '状态栏币种更新');
  check('状态栏跟随币种', statusItem.text.includes('$'), statusItem.text);

  configValues.showStatusBar = false;
  for (const handler of configHandlers) handler({ affectsConfiguration: section => section === 'deepseekCostMonitor.showStatusBar' });
  check('状态栏可隐藏', statusItem.visible === false, statusItem.visible);
  configValues.showStatusBar = true;
  for (const handler of configHandlers) handler({ affectsConfiguration: section => section === 'deepseekCostMonitor.showStatusBar' });
  check('状态栏可恢复', statusItem.visible === true, statusItem.visible);

  const diagnostics = [];
  const originalAppend = outputLines.push.bind(outputLines);
  outputLines.push = function (line) {
    diagnostics.push(line);
    return originalAppend(line);
  };
  await commands.get('deepseekCostMonitor.showDiagnostics')();
  outputLines.push = originalAppend;
  const selftestLine = diagnostics.find(line => line.startsWith('SELFTEST_JSON '));
  check('诊断输出 SELFTEST_JSON', Boolean(selftestLine), null);
  if (selftestLine) {
    const payload = JSON.parse(selftestLine.slice('SELFTEST_JSON '.length));
    check('诊断含计价断言', Array.isArray(payload.pricingAssertions) && payload.pricingAssertions.every(item => item.ok), payload.pricingAssertions);
    check('诊断含快照', Boolean(payload.snapshot && payload.snapshot.totals.requests > 0), payload.snapshot ? payload.snapshot.totals.requests : null);
    check('诊断含账本摘要', Boolean(payload.ledger && payload.ledger.days >= 1), payload.ledger);
  }

  // ---- 历史账本（M2 接线） ----
  const ledgerFile = path.join(storageDir, 'history-ledger.json');
  check('账本文件已写入', fs.existsSync(ledgerFile), ledgerFile);
  let ledgerRaw = null;
  try {
    ledgerRaw = fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile, 'utf8')) : null;
  } catch {}
  check('账本含日聚合', Boolean(ledgerRaw && Object.keys(ledgerRaw.days || {}).length > 0), ledgerRaw ? Object.keys(ledgerRaw.days).length : null);
  // 账本只存 token：桶字段里出现金额字段就说明设计被破坏了（§6.3）。
  const sampleDay = ledgerRaw ? Object.values(ledgerRaw.days || {})[0] : null;
  const sampleModel = sampleDay ? Object.keys(sampleDay.models || {})[0] : null;
  const sampleBucket = sampleModel ? sampleDay.models[sampleModel].main.peak : null;
  check(
    '账本桶仅有 token 字段',
    Boolean(sampleBucket) && Object.keys(sampleBucket).sort().join(',') === 'cacheCreation,cacheHit,cacheMiss,output,requests',
    sampleBucket ? Object.keys(sampleBucket).sort().join(',') : null
  );
  check(
    '账本不含会话与路径（隐私白名单）',
    Boolean(ledgerRaw) && JSON.stringify(ledgerRaw).indexOf('sessionId') === -1 && JSON.stringify(ledgerRaw).indexOf('cwd') === -1,
    null
  );
  check(
    '安装日已写入 globalState',
    typeof globalStateMap.get('deepseekCostMonitor.installDate') === 'string',
    globalStateMap.get('deepseekCostMonitor.installDate')
  );

  const historyBefore = view.posted.length;
  for (const handler of view.messageHandlers) handler({ type: 'history', request: { preset: 'last30', granularity: 'auto' } });
  await waitFor(() => view.posted.slice(historyBefore).some(message => message.type === 'history'), 10000, '历史查询');
  const historyData = view.posted.filter(message => message.type === 'history').pop().data;
  check('历史查询返回数据', Boolean(historyData && !historyData.empty), historyData ? { days: historyData.summary.daysWithData, total: historyData.summary.totalCost } : null);
  check('历史粒度按范围自动选择', Boolean(historyData) && historyData.granularity === 'day', historyData ? historyData.granularity : null);
  check('历史周期之和等于汇总', (() => {
    if (!historyData) return false;
    const sum = historyData.periods.reduce((acc, period) => acc + period.cost, 0);
    return Math.abs(sum - historyData.summary.totalCost) < 1e-9;
  })(), historyData ? { periods: historyData.periods.length } : null);

  // FR-04 的硬验收：今日页 = 历史页的今天 = 状态栏，三者必须同口径。
  const todayInHistory = historyData && historyData.days ? historyData.days.find(day => day.dateKey === todayKey) : null;
  check(
    '今日页与历史页今天金额一致',
    Boolean(todayInHistory) && Math.abs(todayInHistory.cost - usdSnapshot.totals.cost) < 1e-9,
    { todayPage: usdSnapshot.totals.cost, historyToday: todayInHistory ? todayInHistory.cost : null }
  );

  // 切到「今年」应回到周粒度，且不应出现未来周期。
  const yearBefore = view.posted.length;
  for (const handler of view.messageHandlers) handler({ type: 'history', request: { preset: 'thisYear', granularity: 'auto' } });
  await waitFor(() => view.posted.slice(yearBefore).some(message => message.type === 'history'), 10000, '今年历史查询');
  const yearData = view.posted.filter(message => message.type === 'history').pop().data;
  check('今年按周聚合', Boolean(yearData) && yearData.granularity === 'week', yearData ? yearData.granularity : null);
  check(
    '未来周期不出现在明细里',
    Boolean(yearData) && yearData.periods.every(period => period.fromKey <= todayKey),
    yearData ? yearData.periods.slice(-3).map(period => period.key) : null
  );

  for (const item of context.subscriptions.slice().reverse()) {
    try { if (item && typeof item.dispose === 'function') item.dispose(); } catch {}
  }
  try { fs.rmSync(storageDir, { recursive: true, force: true }); } catch {}
  check('配置监听已清理', configHandlers.size === 0, configHandlers.size);
  check('无运行时错误输出', !outputLines.some(line => line.includes('刷新失败') || line.includes('回调异常')), outputLines);

  for (const item of results) {
    console.log(`${item.ok ? '[PASS]' : '[FAIL]'} ${item.name}${item.detail === null ? '' : ' ' + JSON.stringify(item.detail)}`);
  }
  const failed = results.filter(item => !item.ok).length;
  console.log(`SUMMARY pass=${results.length - failed} fail=${failed}`);
  if (failed) process.exitCode = 1;
})().catch(error => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
