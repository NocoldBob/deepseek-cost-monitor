'use strict';

const crypto = require('crypto');
const vscode = require('vscode');

class MonitorPanelProvider {
  constructor(extensionUri, monitor) {
    this.extensionUri = extensionUri;
    this.monitor = monitor;
    this.view = null;
    this.listener = monitor.onDidChange(snapshot => this.postSnapshot(snapshot));
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(message => {
      if (!message || typeof message.type !== 'string') return;
      if (message.type === 'ready') {
        const snapshot = this.monitor.snapshot;
        if (snapshot) this.postSnapshot(snapshot);
        else this.post({ type: 'loading' });
      } else if (message.type === 'refresh') {
        this.monitor.refreshNow('webview');
      }
    });
    webviewView.onDidDispose(() => {
      this.view = null;
    });
  }

  post(message) {
    if (!this.view) return;
    this.view.webview.postMessage(message).then(undefined, () => {});
  }

  postSnapshot(snapshot) {
    this.post({ type: 'snapshot', snapshot });
  }

  getNonce() {
    return crypto.randomBytes(16).toString('hex');
  }

  getHtml(webview) {
    const nonce = this.getNonce();
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'style.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'main.js'));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      "base-uri 'none'",
      "form-action 'none'",
      "img-src 'none'"
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${styleUri}">
<title>今日消费</title>
</head>
<body>
<div id="app">
  <header class="topbar">
    <div class="date" id="dayLabel">今日消费</div>
    <div class="top-actions">
      <span id="marketBadge" class="badge hidden">--</span>
      <button id="refreshBtn" type="button" class="icon-btn" title="刷新">↻</button>
    </div>
  </header>

  <div id="banner" class="banner hidden"></div>

  <section class="hero">
    <div class="amount"><span id="amountValue">—</span></div>
    <div class="subline">
      <span id="requestsText">正在计算…</span>
      <span id="updatedText"></span>
    </div>
  </section>

  <section class="tokens" id="tokenGrid">
    <div class="token-cell">
      <div class="token-label">未命中输入</div>
      <div class="token-value" id="tokenMiss">—</div>
    </div>
    <div class="token-cell">
      <div class="token-label">命中缓存</div>
      <div class="token-value" id="tokenHit">—</div>
    </div>
    <div class="token-cell">
      <div class="token-label">输出</div>
      <div class="token-value" id="tokenOut">—</div>
    </div>
    <div class="token-cell">
      <div class="token-label">合计</div>
      <div class="token-value" id="tokenTotal">—</div>
    </div>
  </section>

  <section class="block">
    <div class="block-title">按模型</div>
    <div id="modelList" class="rows"><div class="empty">—</div></div>
  </section>

  <section class="block">
    <div class="block-title">按会话</div>
    <div id="sessionList" class="rows"><div class="empty">—</div></div>
  </section>

  <div id="warnings" class="warnings hidden"></div>

  <footer class="foot">
    <div id="excludedText" class="foot-line hidden"></div>
    <div class="foot-line">本地会话记录估算 · 非官方账单</div>
  </footer>
</div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose() {
    if (this.listener) this.listener.dispose();
  }
}

module.exports = { MonitorPanelProvider };
