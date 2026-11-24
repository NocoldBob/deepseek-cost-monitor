'use strict';

const vscode = require('vscode');

const SECTION = 'deepseekCostMonitor';

const moneyFormatter = new Intl.NumberFormat('zh-CN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 4
});

function formatMoney(value, symbol) {
  const amount = Number(value) || 0;
  if (amount > 0 && amount < 0.0001) return `${symbol}<0.0001`;
  return `${symbol}${moneyFormatter.format(amount)}`;
}

function formatTokens(value) {
  const number = Number(value) || 0;
  return new Intl.NumberFormat('zh-CN').format(number);
}

class StatusBar {
  constructor(monitor) {
    this.monitor = monitor;
    this.lastSnapshot = monitor.snapshot;
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.name = 'DeepSeek 今日消费';
    this.item.command = 'deepseekCostMonitor.focus';
    this.disposables = [];
    this.disposables.push(monitor.onDidChange(snapshot => this.update(snapshot)));
    this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration(`${SECTION}.showStatusBar`)) this.applyVisibility();
    }));
    this.render(this.lastSnapshot);
    this.applyVisibility();
  }

  isEnabled() {
    const config = vscode.workspace.getConfiguration(SECTION);
    return config.get('showStatusBar', true) !== false;
  }

  applyVisibility() {
    if (this.isEnabled()) {
      if (!this.lastSnapshot) this.item.text = '$(loading~spin) DeepSeek 计算中…';
      this.item.show();
    } else {
      this.item.hide();
    }
  }

  update(snapshot) {
    this.lastSnapshot = snapshot;
    this.render(snapshot);
    this.applyVisibility();
  }

  render(snapshot) {
    if (!snapshot) {
      this.item.text = '$(loading~spin) DeepSeek 计算中…';
      this.item.tooltip = '正在扫描本地会话记录…';
      return;
    }
    if (snapshot.error && (!snapshot.totals || snapshot.totals.requests === 0)) {
      this.item.text = '$(warning) DeepSeek --';
      this.item.tooltip = `今日消费监控异常：${snapshot.error}`;
      return;
    }

    const symbol = snapshot.currencySymbol || '¥';
    const totals = snapshot.totals || { cost: 0, requests: 0, tokens: {} };
    this.item.text = `$(graph) 今日 DeepSeek ${formatMoney(totals.cost, symbol)}`;

    const lines = [];
    lines.push(`**DeepSeek 今日消费估算**（${snapshot.dayLabel || ''}）`);
    lines.push('');
    lines.push(`金额：${formatMoney(totals.cost, symbol)}　请求：${totals.requests || 0} 次`);
    if (totals.tokens) {
      lines.push(`未命中输入：${formatTokens(totals.tokens.cacheMiss)}　命中缓存：${formatTokens(totals.tokens.cacheHit)}`);
      lines.push(`输出：${formatTokens(totals.tokens.output)}　合计：${formatTokens(totals.tokens.total)}`);
    }
    if (snapshot.market) {
      const marketText = snapshot.market.isHoliday ? '节假日（低谷）' : snapshot.market.label;
      lines.push(`当前计价：${marketText}`);
    }
    lines.push(`更新：${snapshot.updatedLabel || '--:--:--'}`);
    if (snapshot.error) lines.push('');
    if (snapshot.error) lines.push(`⚠ ${snapshot.error}${snapshot.stale ? '（显示上次结果）' : ''}`);
    lines.push('');
    lines.push('按官方价目估算，非官方账单。点击打开面板。');
    const tooltip = new vscode.MarkdownString(lines.join('\n'));
    this.item.tooltip = tooltip;
  }

  dispose() {
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables = [];
    this.item.dispose();
  }
}

module.exports = { StatusBar };
