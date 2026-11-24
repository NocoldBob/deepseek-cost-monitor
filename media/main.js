(function () {
  'use strict';

  const api = acquireVsCodeApi();

  const nodes = {
    dayLabel: document.getElementById('dayLabel'),
    marketBadge: document.getElementById('marketBadge'),
    refreshBtn: document.getElementById('refreshBtn'),
    banner: document.getElementById('banner'),
    amountValue: document.getElementById('amountValue'),
    requestsText: document.getElementById('requestsText'),
    updatedText: document.getElementById('updatedText'),
    tokenMiss: document.getElementById('tokenMiss'),
    tokenHit: document.getElementById('tokenHit'),
    tokenOut: document.getElementById('tokenOut'),
    tokenTotal: document.getElementById('tokenTotal'),
    modelList: document.getElementById('modelList'),
    sessionList: document.getElementById('sessionList'),
    warnings: document.getElementById('warnings'),
    excludedText: document.getElementById('excludedText')
  };

  const moneyFormatter = new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4
  });
  const exactFormatter = new Intl.NumberFormat('zh-CN');

  function formatMoney(value, symbol) {
    const prefix = symbol || '¥';
    const amount = Number(value) || 0;
    if (amount > 0 && amount < 0.0001) return prefix + '<0.0001';
    return prefix + moneyFormatter.format(amount);
  }

  function compactNumber(number) {
    return number.toFixed(2).replace(/\.?0+$/, '');
  }

  function formatTokens(value) {
    const number = Number(value) || 0;
    if (!number) return '0';
    if (number >= 1e9) return compactNumber(number / 1e9) + 'B';
    if (number >= 1e6) return compactNumber(number / 1e6) + 'M';
    if (number >= 10000) return compactNumber(number / 1000) + 'k';
    return exactFormatter.format(number);
  }

  function exactTokens(value) {
    return exactFormatter.format(Number(value) || 0);
  }

  function setToken(node, value) {
    node.textContent = formatTokens(value);
    node.title = exactTokens(value);
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function setHidden(node, hidden) {
    node.classList.toggle('hidden', Boolean(hidden));
  }

  function createEmpty(text) {
    const node = document.createElement('div');
    node.className = 'empty';
    node.textContent = text;
    return node;
  }

  function createRow(name, sub, cost, tags, title) {
    const row = document.createElement('div');
    row.className = 'row';

    const head = document.createElement('div');
    head.className = 'row-head';

    const nameNode = document.createElement('span');
    nameNode.className = 'row-name';
    nameNode.textContent = name;
    head.appendChild(nameNode);

    for (const tag of tags || []) {
      const tagNode = document.createElement('span');
      tagNode.className = 'tag';
      tagNode.textContent = tag;
      head.appendChild(tagNode);
    }

    const costNode = document.createElement('span');
    costNode.className = 'row-cost';
    costNode.textContent = cost;
    head.appendChild(costNode);

    const subNode = document.createElement('div');
    subNode.className = 'row-sub';
    subNode.textContent = sub;
    if (title) subNode.title = title;

    row.appendChild(head);
    row.appendChild(subNode);
    return row;
  }

  function renderModels(models, symbol) {
    clear(nodes.modelList);
    if (!models.length) {
      nodes.modelList.appendChild(createEmpty('今日暂无 DeepSeek 请求'));
      return;
    }
    for (const model of models) {
      const tokens = model.tokens || {};
      const tags = [];
      if (model.custom) tags.push('自定义价目');
      if (model.estimated) tags.push('估算');
      const sub = `${model.requests} 次 · 入 ${formatTokens(tokens.cacheMiss)} · 缓存 ${formatTokens(tokens.cacheHit)} · 出 ${formatTokens(tokens.output)}`;
      const title = `未命中输入 ${exactTokens(tokens.cacheMiss)}；命中缓存 ${exactTokens(tokens.cacheHit)}；输出 ${exactTokens(tokens.output)}；合计 ${exactTokens(tokens.total)}`;
      nodes.modelList.appendChild(createRow(model.model, sub, formatMoney(model.cost, symbol), tags, title));
    }
  }

  function renderSessions(sessions, symbol) {
    clear(nodes.sessionList);
    if (!sessions.length) {
      nodes.sessionList.appendChild(createEmpty('今日暂无 DeepSeek 请求'));
      return;
    }
    for (const session of sessions) {
      const tags = session.includesSubagents ? ['含子代理'] : [];
      const sub = `#${session.shortId} · ${session.requests} 次 · ${formatTokens((session.tokens || {}).total)} tokens`;
      const title = `会话 ${session.sessionId}`;
      nodes.sessionList.appendChild(createRow(session.cwdLabel || '未知项目', sub, formatMoney(session.cost, symbol), tags, title));
    }
  }

  function showLoading() {
    nodes.dayLabel.textContent = '今日消费';
    nodes.amountValue.textContent = '—';
    nodes.requestsText.textContent = '正在计算…';
    nodes.updatedText.textContent = '';
    setHidden(nodes.marketBadge, true);
    setHidden(nodes.banner, true);
    for (const node of [nodes.tokenMiss, nodes.tokenHit, nodes.tokenOut, nodes.tokenTotal]) {
      node.textContent = '—';
      node.title = '';
    }
    clear(nodes.modelList);
    nodes.modelList.appendChild(createEmpty('正在扫描会话记录…'));
    clear(nodes.sessionList);
    nodes.sessionList.appendChild(createEmpty('正在扫描会话记录…'));
    clear(nodes.warnings);
    setHidden(nodes.warnings, true);
    setHidden(nodes.excludedText, true);
  }

  function render(snapshot) {
    if (!snapshot) {
      showLoading();
      return;
    }
    const totals = snapshot.totals || {};
    const tokens = totals.tokens || {};
    const symbol = snapshot.currencySymbol || '¥';

    nodes.dayLabel.textContent = snapshot.dayLabel || '今日消费';
    nodes.amountValue.textContent = formatMoney(totals.cost, symbol);
    nodes.requestsText.textContent = `${totals.requests || 0} 次请求`;
    nodes.updatedText.textContent = snapshot.updatedLabel ? `更新 ${snapshot.updatedLabel}` : '';

    setToken(nodes.tokenMiss, tokens.cacheMiss);
    setToken(nodes.tokenHit, tokens.cacheHit);
    setToken(nodes.tokenOut, tokens.output);
    setToken(nodes.tokenTotal, tokens.total);

    if (snapshot.market) {
      nodes.marketBadge.textContent = snapshot.market.isHoliday ? '节假日 · 低谷' : snapshot.market.label;
      nodes.marketBadge.className = 'badge market-' + snapshot.market.mode;
    } else {
      setHidden(nodes.marketBadge, true);
    }

    if (snapshot.error) {
      nodes.banner.textContent = '⚠ ' + snapshot.error + (snapshot.stale ? '（显示上次结果）' : '');
      setHidden(nodes.banner, false);
    } else {
      setHidden(nodes.banner, true);
    }

    renderModels(snapshot.byModel || [], symbol);
    renderSessions(snapshot.bySession || [], symbol);

    const warnings = snapshot.warnings || [];
    clear(nodes.warnings);
    for (const warning of warnings) {
      const line = document.createElement('div');
      line.className = 'warning-item';
      line.textContent = '⚠ ' + warning.message;
      nodes.warnings.appendChild(line);
    }
    setHidden(nodes.warnings, warnings.length === 0);

    const excluded = snapshot.excluded || {};
    const parts = [];
    if (excluded.nonDeepseekRequests > 0) {
      const models = (excluded.nonDeepseekModels || []).join('、');
      parts.push(`已排除 ${excluded.nonDeepseekRequests} 次非 DeepSeek 请求${models ? '（' + models + '）' : ''}`);
    }
    if (excluded.syntheticRequests > 0) {
      parts.push(`已忽略 ${excluded.syntheticRequests} 条系统消息`);
    }
    nodes.excludedText.textContent = parts.join(' · ');
    setHidden(nodes.excludedText, parts.length === 0);
  }

  nodes.refreshBtn.addEventListener('click', () => {
    nodes.refreshBtn.classList.add('spinning');
    api.postMessage({ type: 'refresh' });
    setTimeout(() => nodes.refreshBtn.classList.remove('spinning'), 800);
  });

  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'snapshot') render(message.snapshot);
    else if (message.type === 'loading') showLoading();
  });

  api.postMessage({ type: 'ready' });
})();
