'use strict';

const crypto = require('crypto');
const vscode = require('vscode');

const RANGE_PRESETS = ['last7', 'last30', 'last90', 'thisWeek', 'thisMonth', 'thisQuarter', 'thisYear', 'custom'];
const GRANULARITY_CHOICES = ['auto', 'day', 'week', 'month', 'quarter', 'year'];
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDayKey(value) {
  if (typeof value !== 'string' || !DAY_KEY_RE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function sanitizeRequest(raw) {
  const request = raw && typeof raw === 'object' ? raw : {};
  const preset = RANGE_PRESETS.includes(request.preset) ? request.preset : 'last30';
  const granularity = GRANULARITY_CHOICES.includes(request.granularity) ? request.granularity : 'auto';
  if (preset !== 'custom') return { preset, granularity };
  const fromKey = typeof request.fromKey === 'string' ? request.fromKey : '';
  const toKey = typeof request.toKey === 'string' ? request.toKey : '';
  if (!isRealDayKey(fromKey) || !isRealDayKey(toKey) || fromKey > toKey) {
    return { preset: 'last30', granularity };
  }
  return { preset: 'custom', granularity, fromKey, toKey };
}

class MonitorPanelProvider {
  constructor(extensionUri, monitor) {
    this.extensionUri = extensionUri;
    this.monitor = monitor;
    this.view = null;
    this.lastHistoryRequest = null;
    this.lastHeatmapYear = null;
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
        if (this.lastHistoryRequest) this.postHistory(this.lastHistoryRequest);
        if (this.lastHeatmapYear) this.postHeatmap(this.lastHeatmapYear);
      } else if (message.type === 'refresh') {
        this.monitor.refreshNow('webview');
      } else if (message.type === 'history') {
        this.lastHistoryRequest = sanitizeRequest(message.request);
        this.postHistory(this.lastHistoryRequest);
      } else if (message.type === 'heatmap') {
        const year = Number(message.year);
        if (Number.isInteger(year) && year >= 2000 && year <= 2100) {
          this.lastHeatmapYear = year;
          this.postHeatmap(year);
        }
      } else if (message.type === 'dismissRetention') {
        this.monitor.dismissRetentionNotice();
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

  /**
   * 今日快照到达时顺带重算历史：历史页切换设置（币种/前缀/子代理）后
   * 必须跟着变，否则用户会看到两个自相矛盾的页面。
   */
  postSnapshot(snapshot) {
    this.post({ type: 'snapshot', snapshot });
    if (this.lastHistoryRequest) this.postHistory(this.lastHistoryRequest);
    if (this.lastHeatmapYear) this.postHeatmap(this.lastHeatmapYear);
  }

  postHistory(request) {
    let data;
    try {
      data = this.monitor.queryHistory(request);
    } catch (error) {
      data = { empty: true, reason: 'error', message: `历史查询失败：${error && error.message ? error.message : error}` };
    }
    this.post({ type: 'history', data });
  }

  postHeatmap(year) {
    let data;
    try {
      data = this.monitor.queryHistory({
        preset: 'custom',
        granularity: 'day',
        fromKey: `${year}-01-01`,
        toKey: `${year}-12-31`
      });
    } catch (error) {
      data = { empty: true, reason: 'error', message: `热力图查询失败：${error && error.message ? error.message : error}` };
    }
    this.post({ type: 'heatmap', year, data });
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
<title>消费统计</title>
</head>
<body>
<div id="app">
  <header class="topbar">
    <div class="tabs" role="tablist">
      <button id="tabToday" class="tab is-active" type="button" role="tab" aria-selected="true">今日</button>
      <button id="tabHistory" class="tab" type="button" role="tab" aria-selected="false">历史</button>
    </div>
    <div class="top-actions">
      <span id="marketBadge" class="badge hidden">--</span>
      <button id="refreshBtn" type="button" class="icon-btn" title="刷新">↻</button>
    </div>
  </header>

  <div id="todayPane">
    <div class="date" id="dayLabel">今日消费</div>

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

  <div id="historyPane" class="hidden">
    <div class="chips" id="rangeBar" role="group" aria-label="时间范围">
      <button class="chip" type="button" data-preset="last7">近 7 天</button>
      <button class="chip is-active" type="button" data-preset="last30">近 30 天</button>
      <button class="chip" type="button" data-preset="last90">近 90 天</button>
      <button class="chip" type="button" data-preset="thisWeek">本周</button>
      <button class="chip" type="button" data-preset="thisMonth">本月</button>
      <button class="chip" type="button" data-preset="thisQuarter">本季</button>
      <button class="chip" type="button" data-preset="thisYear">今年</button>
      <button class="chip" type="button" data-preset="custom">自定义</button>
    </div>

    <div id="customRange" class="custom-range hidden">
      <input type="date" id="customFrom" aria-label="开始日期">
      <span class="custom-sep">→</span>
      <input type="date" id="customTo" aria-label="结束日期">
      <button id="customApply" class="chip" type="button">应用</button>
    </div>

    <div class="chips chips-sm" id="granBar" role="group" aria-label="聚合粒度">
      <button class="chip is-active" type="button" data-granularity="auto">自动</button>
      <button class="chip" type="button" data-granularity="day">日</button>
      <button class="chip" type="button" data-granularity="week">周</button>
      <button class="chip" type="button" data-granularity="month">月</button>
      <button class="chip" type="button" data-granularity="quarter">季</button>
      <button class="chip" type="button" data-granularity="year">年</button>
    </div>

    <div id="retentionBanner" class="banner info hidden">
      <span id="retentionText"></span>
      <button id="retentionClose" class="link-btn" type="button">知道了</button>
    </div>

    <div id="historyBanner" class="banner hidden"></div>

    <section class="cards" id="historyCards">
      <div class="card">
        <div class="card-label">合计</div>
        <div class="card-value" id="histTotal">—</div>
        <div class="card-sub" id="histRange">—</div>
      </div>
      <div class="card">
        <div class="card-label">请求</div>
        <div class="card-value" id="histRequests">—</div>
        <div class="card-sub" id="histTokens">—</div>
      </div>
      <div class="card">
        <div class="card-label">日均</div>
        <div class="card-value" id="histAvg">—</div>
        <div class="card-sub" id="histCovered">—</div>
      </div>
      <div class="card">
        <div class="card-label">有记录</div>
        <div class="card-value" id="histDays">—</div>
        <div class="card-sub" id="histGaps">—</div>
      </div>
    </section>

    <section class="block">
      <div class="block-title">消费波动</div>
      <div id="trendChart" class="chart-wrap"><div class="empty">—</div></div>
    </section>

    <section class="block">
      <div class="block-title heatmap-head">
        <span>日历热力图</span>
        <span class="heatmap-year">
          <button id="heatPrevYear" class="icon-btn" type="button" title="上一年">‹</button>
          <span id="heatYear">—</span>
          <button id="heatNextYear" class="icon-btn" type="button" title="下一年">›</button>
        </span>
      </div>
      <div id="heatmap" class="heatmap-wrap"><div class="empty">—</div></div>
      <div class="heat-legend">
        <span>少</span>
        <span class="heat-swatch heat-1"></span>
        <span class="heat-swatch heat-2"></span>
        <span class="heat-swatch heat-3"></span>
        <span class="heat-swatch heat-4"></span>
        <span class="heat-swatch heat-5"></span>
        <span>多</span>
        <span class="heat-legend-sep"></span>
        <span class="heat-swatch zero"></span><span>有记录无消费</span>
        <span class="heat-swatch empty"></span><span>无记录</span>
      </div>
    </section>

    <section class="block">
      <div class="block-title" id="historyModelTitle">按模型</div>
      <div id="historyModels" class="rows"><div class="empty">—</div></div>
    </section>

    <section class="block">
      <div class="block-title" id="periodTitle">明细</div>
      <div id="periodList" class="rows"><div class="empty">—</div></div>
    </section>

    <div id="historyWarnings" class="warnings hidden"></div>

    <footer class="foot">
      <div id="ledgerFoot" class="foot-line">—</div>
      <div class="foot-line">历史金额按当前价目表重算 · 估算值</div>
    </footer>
  </div>
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
