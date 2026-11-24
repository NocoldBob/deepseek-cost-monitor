'use strict';

const Module = require('module');
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
  const context = {
    subscriptions: [],
    extensionUri: { fsPath: 'D:\\vscode-ext\\deepseek-cost-monitor', scheme: 'file', path: 'D:\\vscode-ext\\deepseek-cost-monitor' }
  };
  extension.activate(context);

  await waitFor(() => statusItems.length === 1 && /¥|DeepSeek --/.test(statusItems[0].text) && !/计算中/.test(statusItems[0].text), 20000, '初始扫描完成');
  const statusItem = statusItems[0];
  check('状态栏已创建', statusItems.length === 1, statusItems.length);
  check('状态栏金额已显示', statusItem.visible && /¥\d/.test(statusItem.text), statusItem.text);
  check('状态栏 tooltip', Boolean(statusItem.tooltip && String(statusItem.tooltip.value).includes('非官方账单')), statusItem.tooltip ? statusItem.tooltip.value.slice(0, 80) : null);
  check('状态栏点击命令', statusItem.command === 'deepseekCostMonitor.focus', statusItem.command);
  check('文件监听已建立', watchedPatterns.length === 1 && watchedPatterns[0].pattern === '**/*.jsonl', watchedPatterns.map(item => item.pattern));
  check('命令已注册', commands.has('deepseekCostMonitor.refresh') && commands.has('deepseekCostMonitor.focus') && commands.has('deepseekCostMonitor.showDiagnostics'), Array.from(commands.keys()));
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
  }

  for (const item of context.subscriptions.slice().reverse()) {
    try { if (item && typeof item.dispose === 'function') item.dispose(); } catch {}
  }
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
