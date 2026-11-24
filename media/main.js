(function () {
  'use strict';

  const api = acquireVsCodeApi();
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const nodes = {
    tabToday: document.getElementById('tabToday'),
    tabHistory: document.getElementById('tabHistory'),
    todayPane: document.getElementById('todayPane'),
    historyPane: document.getElementById('historyPane'),
    rangeBar: document.getElementById('rangeBar'),
    granBar: document.getElementById('granBar'),
    customRange: document.getElementById('customRange'),
    customFrom: document.getElementById('customFrom'),
    customTo: document.getElementById('customTo'),
    customApply: document.getElementById('customApply'),
    retentionBanner: document.getElementById('retentionBanner'),
    retentionText: document.getElementById('retentionText'),
    retentionClose: document.getElementById('retentionClose'),
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
    excludedText: document.getElementById('excludedText'),
    historyBanner: document.getElementById('historyBanner'),
    histTotal: document.getElementById('histTotal'),
    histRange: document.getElementById('histRange'),
    histRequests: document.getElementById('histRequests'),
    histTokens: document.getElementById('histTokens'),
    histAvg: document.getElementById('histAvg'),
    histCovered: document.getElementById('histCovered'),
    histDays: document.getElementById('histDays'),
    histGaps: document.getElementById('histGaps'),
    trendChart: document.getElementById('trendChart'),
    heatmap: document.getElementById('heatmap'),
    heatYear: document.getElementById('heatYear'),
    heatPrevYear: document.getElementById('heatPrevYear'),
    heatNextYear: document.getElementById('heatNextYear'),
    historyModelTitle: document.getElementById('historyModelTitle'),
    historyModels: document.getElementById('historyModels'),
    periodTitle: document.getElementById('periodTitle'),
    periodList: document.getElementById('periodList'),
    historyWarnings: document.getElementById('historyWarnings'),
    ledgerFoot: document.getElementById('ledgerFoot')
  };

  function pad2(value) {
    return value < 10 ? '0' + value : String(value);
  }

  function todayBeijingKey() {
    return beijingDayKey(0);
  }

  function beijingDayKey(offsetDays) {
    const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const utc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + (offsetDays || 0));
    const date = new Date(utc);
    return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
  }

  const persisted = api.getState() || {};
  const currentBeijingYear = Number(todayBeijingKey().slice(0, 4));
  const PRESETS = ['last7', 'last30', 'last90', 'thisWeek', 'thisMonth', 'thisQuarter', 'thisYear', 'custom'];
  const GRANULARITIES = ['auto', 'day', 'week', 'month', 'quarter', 'year'];
  const state = {
    tab: persisted.tab === 'history' ? 'history' : 'today',
    preset: PRESETS.includes(persisted.preset) ? persisted.preset : 'last30',
    granularity: GRANULARITIES.includes(persisted.granularity) ? persisted.granularity : 'auto',
    customFrom: typeof persisted.customFrom === 'string' ? persisted.customFrom : null,
    customTo: typeof persisted.customTo === 'string' ? persisted.customTo : null,
    heatmapYear: Number.isInteger(persisted.heatmapYear) ? persisted.heatmapYear : currentBeijingYear,
    history: null,
    heatmap: null
  };
  if (state.preset === 'custom' && (!state.customFrom || !state.customTo)) {
    state.customFrom = beijingDayKey(-29);
    state.customTo = todayBeijingKey();
  }

  function persistState() {
    api.setState({
      tab: state.tab,
      preset: state.preset,
      granularity: state.granularity,
      customFrom: state.customFrom,
      customTo: state.customTo,
      heatmapYear: state.heatmapYear
    });
  }

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
    if (!node) return;
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

  function renderWarnings(container, warnings) {
    clear(container);
    for (const warning of warnings || []) {
      const line = document.createElement('div');
      line.className = 'warning-item';
      line.textContent = '⚠ ' + warning.message;
      container.appendChild(line);
    }
    setHidden(container, !(warnings && warnings.length));
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
      setHidden(nodes.marketBadge, false);
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
    if (snapshot.prefill) {
      clear(nodes.sessionList);
      nodes.sessionList.appendChild(createEmpty('正在扫描按会话明细…'));
    } else {
      renderSessions(snapshot.bySession || [], symbol);
    }
    renderWarnings(nodes.warnings, snapshot.warnings || []);

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

  // ---------- 历史页 ----------

  function shortLabel(period, granularity) {
    if (granularity === 'day' && /^\d{4}-\d{2}-\d{2}$/.test(period.label)) return period.label.slice(5);
    return period.label;
  }

  function compactPeriodLabel(period, granularity) {
    const key = String(period && period.key || '');
    if (granularity === 'day') return key.slice(5);
    if (granularity === 'week') {
      const match = /W(\d+)$/.exec(key);
      return match ? `W${match[1]}` : key;
    }
    if (granularity === 'month') return `${Number(key.slice(5))}月`;
    if (granularity === 'quarter') return `Q${key.slice(-1)}`;
    return key;
  }

  function formatChange(pct) {
    if (pct === null || pct === undefined) return null;
    const value = pct * 100;
    if (!Number.isFinite(value)) return null;
    if (Math.abs(value) < 0.05) return { text: '持平', cls: 'flat' };
    return {
      text: (value > 0 ? '+' : '') + value.toFixed(1) + '%',
      cls: value > 0 ? 'up' : 'down'
    };
  }

  function changeTitle(period) {
    if (period.previousIncomplete) {
      return period.previousReason === 'partial-range'
        ? '上一周期在所选范围内不完整，不能作为环比基线'
        : '上一周期早于账本可复核范围，不能作为环比基线';
    }
    if (period.previousCost === null) return '上一周期无数据，无法比较';
    return `上一周期 ${formatMoney(period.previousCost, state.history ? state.history.currencySymbol : '¥')}`;
  }

  function renderPeriods(data) {
    clear(nodes.periodList);
    const periods = (data.periods || []).slice().reverse();
    nodes.periodTitle.textContent = `明细（${(data.periods || []).length} 个${granularityName(data.granularity)}）`;

    if (!periods.length) {
      nodes.periodList.appendChild(createEmpty('该范围内没有数据'));
      return;
    }

    for (const period of periods) {
      const tags = [];
      if (period.inProgress) tags.push('进行中');
      else if (period.partial) tags.push('不完整');
      if (period.staleDays > 0) tags.push('口径过期');
      if (period.frozenDays > 0) tags.push('仅账本');

      const change = formatChange(period.changePct);
      const subParts = [`${period.requests} 次`, `${formatTokens((period.tokens || {}).total)} tokens`];
      if (period.daysWithData === 0) subParts.push('无记录');
      else if (period.noRecordDays > 0) subParts.push(`含 ${period.noRecordDays} 天无记录`);

      // 有账本记录但当前口径下没有任何计入的请求：不能显示成“这天没花钱”。
      const noQualified = period.cost === 0 && period.requests === 0 && period.daysWithData > 0;
      if (noQualified) tags.push('无计入消费');

      const row = createRow(
        shortLabel(period, data.granularity),
        subParts.join(' · '),
        formatMoney(period.cost, data.currencySymbol),
        tags,
        noQualified
          ? `${period.fromKey} → ${period.toKey}：有账本记录，但均为未计入的模型（见 modelPrefixes 设置）`
          : `${period.fromKey} → ${period.toKey}`
      );

      if (change) {
        const changeNode = document.createElement('span');
        changeNode.className = 'change ' + change.cls;
        changeNode.textContent = '环比 ' + change.text;
        changeNode.title = changeTitle(period);
        row.appendChild(changeNode);
      } else if (period.previousCost === null) {
        const changeNode = document.createElement('span');
        changeNode.className = 'change flat';
        changeNode.textContent = '环比 —';
        changeNode.title = changeTitle(period);
        row.appendChild(changeNode);
      }
      nodes.periodList.appendChild(row);
    }
  }

  function granularityName(granularity) {
    switch (granularity) {
      case 'week': return '周';
      case 'month': return '月';
      case 'quarter': return '季';
      case 'year': return '年';
      default: return '天';
    }
  }

  // ---------- 图表 ----------

  function svgNode(name, attrs) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, String(value));
    return node;
  }

  function svgTextNode(text, attrs) {
    const node = svgNode('text', attrs);
    node.textContent = text;
    return node;
  }

  function renderTrendChart(periods, symbol, granularity) {
    clear(nodes.trendChart);
    const list = Array.isArray(periods) ? periods : [];
    if (!list.length || !list.some(period => Number(period.cost) > 0)) {
      nodes.trendChart.appendChild(createEmpty('该范围内暂无计入消费的数据'));
      return;
    }

    // 侧边栏宽度会变化：按容器实际宽度渲染，避免固定 560 宽 viewBox 在
    // 300px 侧边栏里把 10px 标签缩成 5px。
    const W = Math.max(280, Math.floor((nodes.trendChart && nodes.trendChart.clientWidth) || 360));
    const H = 180;
    const left = 48;
    const right = 10;
    const top = 12;
    const bottom = 28;
    const plotW = W - left - right;
    const plotH = H - top - bottom;
    const maxCost = Math.max(...list.map(period => Number(period.cost) || 0), 0.000001);
    const xFor = index => (list.length === 1 ? left + plotW / 2 : left + (index / (list.length - 1)) * plotW);
    const yFor = value => top + plotH - (Math.max(0, Number(value) || 0) / maxCost) * plotH;

    const root = svgNode('svg', {
      viewBox: `0 0 ${W} ${H}`,
      class: 'chart-svg',
      role: 'img',
      'aria-label': '消费波动图'
    });

    const ticks = [0, maxCost / 2, maxCost];
    for (const value of ticks) {
      const y = yFor(value);
      root.appendChild(svgNode('line', {
        x1: left,
        y1: y,
        x2: W - right,
        y2: y,
        class: 'chart-grid'
      }));
      root.appendChild(svgTextNode(formatMoney(value, symbol), {
        x: left - 6,
        y: y + 3,
        class: 'chart-axis',
        'text-anchor': 'end'
      }));
    }

    const labelCount = Math.min(W < 360 ? 4 : 6, list.length);
    const labelIndices = new Set();
    if (labelCount === 1) {
      labelIndices.add(0);
    } else {
      for (let i = 0; i < labelCount; i += 1) {
        labelIndices.add(Math.round((i * (list.length - 1)) / (labelCount - 1)));
      }
    }
    for (const index of labelIndices) {
      const period = list[index];
      root.appendChild(svgTextNode(compactPeriodLabel(period, granularity), {
        x: xFor(index),
        y: H - 8,
        class: 'chart-axis',
        'text-anchor': 'middle'
      }));
    }

    if (list.length > 1) {
      const points = list.map((period, index) => `${xFor(index).toFixed(1)},${yFor(period.cost).toFixed(1)}`);
      const area = [`M ${xFor(0).toFixed(1)} ${top + plotH}`, ...points.map(point => `L ${point}`), `L ${xFor(list.length - 1).toFixed(1)} ${top + plotH}`, 'Z'].join(' ');
      root.appendChild(svgNode('path', { d: area, class: 'chart-area' }));
      root.appendChild(svgNode('path', { d: 'M ' + points.join(' L '), class: 'chart-line' }));
    }

    for (let index = 0; index < list.length; index += 1) {
      const period = list[index];
      const slotWidth = plotW / Math.max(1, list.length);
      const hit = svgNode('rect', {
        x: left + index * slotWidth,
        y: top,
        width: slotWidth,
        height: plotH,
        class: 'chart-hit'
      });
      const title = svgNode('title');
      const bits = [
        period.label,
        `${formatMoney(period.cost, symbol)} · ${period.requests} 次 · ${formatTokens((period.tokens || {}).total)} tokens`
      ];
      if (period.inProgress) bits.push('进行中');
      else if (period.partial) bits.push('不完整');
      if (period.frozenDays > 0) bits.push('含仅账本日期');
      if (period.staleDays > 0) bits.push('含口径过期日期');
      title.textContent = bits.join(' · ');
      hit.appendChild(title);
      root.appendChild(hit);

      if (Number(period.cost) > 0) {
        root.appendChild(svgNode('circle', {
          cx: xFor(index),
          cy: yFor(period.cost),
          r: list.length > 90 ? 1.4 : 2.2,
          class: 'chart-dot'
        }));
      }
    }

    nodes.trendChart.appendChild(root);
  }

  // ---------- 热力图 ----------

  function heatTitle(dateKey, day, future, installDate, symbol) {
    if (future) return `${dateKey} · 未来日期`;
    if (!day || !day.hasRecord) return `${dateKey} · 无记录`;
    const bits = [
      `${dateKey} · ${formatMoney(day.cost, symbol)} · ${day.requests || 0} 次 · ${formatTokens((day.tokens || {}).total)} tokens`
    ];
    if (day.frozen) bits.push('仅账本快照，无法复核');
    if (day.stale) bits.push('峰谷口径已过期');
    if (dateKey === installDate) bits.push('安装日');
    return bits.join(' · ');
  }

  function renderHeatmap(data, year) {
    clear(nodes.heatmap);
    nodes.heatYear.textContent = String(year);
    nodes.heatPrevYear.disabled = year <= 2000;
    nodes.heatNextYear.disabled = year >= currentBeijingYear;
    if (!data || data.reason === 'error' || data.reason === 'unavailable') {
      nodes.heatmap.appendChild(createEmpty((data && data.message) || '热力图不可用'));
      return;
    }

    const symbol = data.currencySymbol || '¥';
    const todayKey = data.todayKey || todayBeijingKey();
    const installDate = data.installDate || (data.ledger && data.ledger.installDate) || null;
    const dayMap = new Map((data.days || []).map(day => [day.dateKey, day]));
    const first = new Date(Date.UTC(year, 0, 1));
    const firstWeekday = (first.getUTCDay() + 6) % 7; // 0=周一
    const daysInYear = Math.round((Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / (24 * 60 * 60 * 1000));
    let maxCost = 0;
    for (const day of dayMap.values()) {
      if (Number(day.cost) > maxCost) maxCost = Number(day.cost);
    }

    const body = document.createElement('div');
    body.className = 'heatmap-body';

    const weekdays = document.createElement('div');
    weekdays.className = 'heatmap-weekdays';
    for (const label of ['一', '二', '三', '四', '五', '六', '日']) {
      const item = document.createElement('span');
      item.textContent = label;
      weekdays.appendChild(item);
    }
    body.appendChild(weekdays);

    const scroll = document.createElement('div');
    scroll.className = 'heatmap-scroll';
    const grid = document.createElement('div');
    grid.className = 'heatmap-grid';

    for (let i = 0; i < firstWeekday; i += 1) {
      const blank = document.createElement('span');
      blank.className = 'heat-cell blank';
      grid.appendChild(blank);
    }

    for (let dayIndex = 0; dayIndex < daysInYear; dayIndex += 1) {
      const date = new Date(Date.UTC(year, 0, 1 + dayIndex));
      const dateKey = `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
      const day = dayMap.get(dateKey) || null;
      const future = dateKey > todayKey;
      const hasRecord = Boolean(day && day.hasRecord);
      const cost = day ? Number(day.cost) || 0 : 0;

      const cell = document.createElement('span');
      cell.className = 'heat-cell';
      if (future) cell.classList.add('future');
      else if (!hasRecord) cell.classList.add('empty');
      else if (cost <= 0) cell.classList.add('zero');
      else if (maxCost > 0) {
        const level = Math.max(1, Math.min(5, 1 + Math.floor((cost / maxCost) * 4.999)));
        cell.classList.add('heat-' + level);
      } else {
        cell.classList.add('heat-1');
      }
      if (dateKey === installDate) cell.classList.add('install');
      cell.title = heatTitle(dateKey, day, future, installDate, symbol);
      cell.setAttribute('aria-label', cell.title);
      grid.appendChild(cell);
    }

    const trailing = (7 - ((firstWeekday + daysInYear) % 7)) % 7;
    for (let i = 0; i < trailing; i += 1) {
      const blank = document.createElement('span');
      blank.className = 'heat-cell blank';
      grid.appendChild(blank);
    }

    scroll.appendChild(grid);
    body.appendChild(scroll);
    nodes.heatmap.appendChild(body);
  }

  // ---------- 历史渲染 ----------

  function renderHistoryModels(models, symbol) {
    clear(nodes.historyModels);
    if (!models || !models.length) {
      nodes.historyModels.appendChild(createEmpty('该范围内没有计入统计的模型'));
      nodes.historyModelTitle.textContent = '按模型';
      return;
    }
    nodes.historyModelTitle.textContent = `按模型（${models.length} 个）`;
    for (const model of models) {
      const tags = [];
      if (model.custom) tags.push('自定义价目');
      if (model.estimated) tags.push('估算');
      const tokens = model.tokens || {};
      const sub = `${model.requests} 次 · 缓存 ${formatTokens(tokens.cacheHit)} · 出 ${formatTokens(tokens.output)}`;
      nodes.historyModels.appendChild(createRow(model.model, sub, formatMoney(model.cost, symbol), tags, `合计 ${exactTokens(tokens.total)} tokens`));
    }
  }

  function renderRetention(data) {
    if (data && data.retentionNotice && Number.isFinite(data.retentionDays)) {
      nodes.retentionText.textContent = `Claude Code 默认在 ${data.retentionDays} 天后删除本地会话记录（cleanupPeriodDays），可回溯的历史上限受此限制；已记入账本的数据不受影响。如需长期回溯，可在 ~/.claude/settings.json 中调大该值。`;
      setHidden(nodes.retentionBanner, false);
    } else {
      setHidden(nodes.retentionBanner, true);
    }
  }

  function renderHistory(data) {
    state.history = data;
    if (!data || data.reason === 'unavailable' || data.reason === 'error') {
      setHidden(nodes.historyBanner, false);
      nodes.historyBanner.textContent = '⚠ ' + ((data && data.message) || '历史数据不可用。');
      for (const node of [nodes.histTotal, nodes.histRequests, nodes.histAvg, nodes.histDays]) node.textContent = '—';
      for (const node of [nodes.histRange, nodes.histTokens, nodes.histCovered, nodes.histGaps]) node.textContent = '—';
      clear(nodes.historyModels);
      nodes.historyModels.appendChild(createEmpty('—'));
      clear(nodes.periodList);
      nodes.periodList.appendChild(createEmpty('—'));
      clear(nodes.trendChart);
      nodes.trendChart.appendChild(createEmpty('—'));
      setHidden(nodes.historyWarnings, true);
      setHidden(nodes.retentionBanner, true);
      nodes.ledgerFoot.textContent = '—';
      return;
    }

    setHidden(nodes.historyBanner, true);
    const summary = data.summary || {};
    const symbol = data.currencySymbol || '¥';

    nodes.histTotal.textContent = formatMoney(summary.totalCost, symbol);
    nodes.histRange.textContent = `${data.fromKey.slice(5)} → ${data.toKey.slice(5)}`;
    nodes.histRequests.textContent = exactFormatter.format(summary.requests || 0) + ' 次';
    nodes.histTokens.textContent = formatTokens((summary.tokens || {}).total) + ' tokens';
    nodes.histAvg.textContent = formatMoney(summary.avgPerDay, symbol);
    nodes.histCovered.textContent = `覆盖 ${summary.coveredDays || 0} 天`;
    nodes.histDays.textContent = (summary.daysWithData || 0) + ' 天';
    nodes.histGaps.textContent = summary.noRecordDays ? `${summary.noRecordDays} 天无记录` : '无空缺';

    renderHistoryModels(summary.byModel || [], symbol);
    renderPeriods(data);
    renderTrendChart(data.periods || [], symbol, data.granularity);
    renderRetention(data);

    const warnings = (data.warnings || []).slice();
    if (summary.daysWithData > 0 && summary.requests === 0) {
      warnings.push({
        message: '该范围内有账本记录，但没有符合当前模型前缀的请求，因此合计为 0。检查 modelPrefixes 设置或切换币种后重试。'
      });
    }
    renderWarnings(nodes.historyWarnings, warnings);

    const ledger = data.ledger || {};
    const footParts = [];
    if (ledger.days) footParts.push(`账本 ${ledger.days} 天`);
    if (ledger.installDate) footParts.push(`安装日 ${ledger.installDate}`);
    if (summary.frozenDays) footParts.push(`${summary.frozenDays} 天仅有账本快照`);
    if (data.scanning) footParts.push('正在扫描校正');
    if (data.liveTodayApplied) footParts.push('今日已并入实时值');
    nodes.ledgerFoot.textContent = footParts.join(' · ') || '—';

    if (data.empty) {
      const suspended = data.suspended || (data.ledger && data.ledger.suspended);
      nodes.historyBanner.textContent = suspended
        ? '历史账本已清除，本次会话暂停自动写入；重新加载 VS Code 后会从日志重新生成历史。'
        : data.scanning
          ? '尚无账本记录，正在扫描本地日志…'
          : '尚无历史数据。若刚安装扩展，需要一次完整扫描后才会出现历史。';
      setHidden(nodes.historyBanner, false);
    }
  }

  // ---------- 请求与交互 ----------

  function requestHistory() {
    const request = { preset: state.preset, granularity: state.granularity };
    if (state.preset === 'custom') {
      request.fromKey = state.customFrom;
      request.toKey = state.customTo;
    }
    api.postMessage({ type: 'history', request });
  }

  function requestHeatmap() {
    api.postMessage({ type: 'heatmap', year: state.heatmapYear });
  }

  function syncChips() {
    for (const chip of nodes.rangeBar.querySelectorAll('.chip')) {
      chip.classList.toggle('is-active', chip.dataset.preset === state.preset);
    }
    for (const chip of nodes.granBar.querySelectorAll('.chip')) {
      chip.classList.toggle('is-active', chip.dataset.granularity === state.granularity);
    }
  }

  function syncCustomRange() {
    const isCustom = state.preset === 'custom';
    setHidden(nodes.customRange, !isCustom);
    if (!isCustom) return;
    const today = todayBeijingKey();
    nodes.customFrom.max = today;
    nodes.customTo.max = today;
    nodes.customFrom.value = state.customFrom || beijingDayKey(-29);
    nodes.customTo.value = state.customTo || today;
  }

  function applyCustomRange() {
    const from = nodes.customFrom.value;
    const to = nodes.customTo.value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
      nodes.historyBanner.textContent = '自定义日期无效：开始日期不能晚于结束日期。';
      setHidden(nodes.historyBanner, false);
      return false;
    }
    state.customFrom = from;
    state.customTo = to;
    persistState();
    requestHistory();
    return true;
  }

  function showTab(tab) {
    state.tab = tab;
    persistState();
    const isHistory = tab === 'history';
    nodes.tabToday.classList.toggle('is-active', !isHistory);
    nodes.tabToday.setAttribute('aria-selected', String(!isHistory));
    nodes.tabHistory.classList.toggle('is-active', isHistory);
    nodes.tabHistory.setAttribute('aria-selected', String(isHistory));
    setHidden(nodes.todayPane, isHistory);
    setHidden(nodes.historyPane, !isHistory);
    syncCustomRange();
    if (isHistory) {
      if (!state.history) {
        nodes.histTotal.textContent = '—';
        clear(nodes.periodList);
        nodes.periodList.appendChild(createEmpty('正在汇总…'));
      }
      requestHistory();
      requestHeatmap();
    }
  }

  nodes.tabToday.addEventListener('click', () => showTab('today'));
  nodes.tabHistory.addEventListener('click', () => showTab('history'));

  nodes.rangeBar.addEventListener('click', event => {
    const button = event.target.closest('.chip');
    if (!button || !button.dataset.preset) return;
    state.preset = button.dataset.preset;
    if (state.preset === 'custom' && (!state.customFrom || !state.customTo)) {
      state.customFrom = beijingDayKey(-29);
      state.customTo = todayBeijingKey();
    }
    syncChips();
    syncCustomRange();
    persistState();
    if (state.preset === 'custom') {
      applyCustomRange();
    } else {
      requestHistory();
    }
  });

  nodes.granBar.addEventListener('click', event => {
    const button = event.target.closest('.chip');
    if (!button || !button.dataset.granularity) return;
    state.granularity = button.dataset.granularity;
    syncChips();
    persistState();
    requestHistory();
  });

  nodes.customApply.addEventListener('click', () => applyCustomRange());

  nodes.heatPrevYear.addEventListener('click', () => {
    if (state.heatmapYear <= 2000) return;
    state.heatmapYear -= 1;
    persistState();
    requestHeatmap();
  });

  nodes.heatNextYear.addEventListener('click', () => {
    if (state.heatmapYear >= currentBeijingYear) return;
    state.heatmapYear += 1;
    persistState();
    requestHeatmap();
  });

  nodes.retentionClose.addEventListener('click', () => {
    setHidden(nodes.retentionBanner, true);
    api.postMessage({ type: 'dismissRetention' });
  });

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
    else if (message.type === 'history') renderHistory(message.data);
    else if (message.type === 'heatmap') {
      state.heatmap = message.data;
      state.heatmapYear = Number(message.year) || state.heatmapYear;
      renderHeatmap(message.data, state.heatmapYear);
    }
  });

  let chartResizeFrame = 0;
  function scheduleChartResize() {
    if (!state.history) return;
    if (chartResizeFrame) cancelAnimationFrame(chartResizeFrame);
    chartResizeFrame = requestAnimationFrame(() => {
      chartResizeFrame = 0;
      renderTrendChart(state.history.periods || [], state.history.currencySymbol, state.history.granularity);
    });
  }
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(scheduleChartResize).observe(nodes.trendChart);
  } else {
    window.addEventListener('resize', scheduleChartResize);
  }

  syncChips();
  showTab(state.tab);
  api.postMessage({ type: 'ready' });
})();
