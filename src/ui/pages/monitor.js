import { esc, icon, formatNumber } from '../dom.js';
import { edgeChartSvg } from '../chart.js';

export function renderMonitor(state) {
  const cp = state.checkpoint;
  const stats = cp?.stats || state.runtime?.stats || {};
  const edgeCount = cp?.edgeCounts?.length || state.runtime?.edgeCount || 0;
  const corpusCount = state.corpus?.length || 0;
  const crashCount = state.crashes?.length || 0;
  const totalCrashes = stats.totalCrashes || state.crashes?.reduce((n, c) => n + (c.count || 1), 0) || 0;
  const rate = state.runtime?.rate || 0;
  const status = state.runtime?.status || 'idle';
  const settings = state.settings;
  const maxProgress = settings.maxIterations > 0 ? Math.min(100, ((cp?.mutationCount || 0) / settings.maxIterations) * 100) : null;

  return `
  <div class="page-head">
    <div>
      <h1 class="page-title">运行监控</h1>
      <p class="page-desc">变异引擎运行在 <code>fuzz.worker.js</code>；每个 batch 结束后保存 RNG 状态、边计数、曲线和调度元数据，确认 IndexedDB 落盘后才继续。</p>
    </div>
    <div class="head-actions">
      <button class="btn primary" data-action="toggle-run">${status === 'running' ? icon('pause') + '暂停' : icon('play') + (cp ? '从断点继续' : '启动')}</button>
      <button class="btn ghost danger" data-action="reset-session">重置会话</button>
    </div>
  </div>

  <div class="grid cols-4 mb-4">
    ${metric('执行样本', formatNumber(stats.executions || 0), `本轮变异 ${formatNumber(cp?.mutationCount || 0)}`, '', 'metric-exec')}
    ${metric('执行速度', formatNumber(Math.round(rate)), 'exec / sec（界面采样）', 'cyan', 'metric-rate')}
    ${metric('唯一边', formatNumber(edgeCount), `累计新边事件 ${formatNumber(stats.newEdges || 0)}`, 'accent', 'metric-edges')}
    ${metric('崩溃', formatNumber(crashCount), `总命中 ${formatNumber(totalCrashes)}`, 'red', 'metric-crashes')}
  </div>

  <div class="grid monitor-main">
    <section class="card">
      <div class="card-head">
        <div>
          <h2 class="card-title">边数增长曲线</h2>
          <div class="card-sub">横轴为累计执行数；虚线为去重崩溃数。所有曲线点来自确定性 checkpoint。</div>
        </div>
        <span class="badge accent" id="chart-points-badge">${formatNumber(cp?.curve?.length || 0)} points</span>
      </div>
      <div class="card-body chart-wrap" id="edge-chart-container">${edgeChartSvg(cp?.curve || [])}</div>
    </section>

    <aside class="grid" style="gap:16px">
      <section class="card pad">
        <div class="flex between mb-3">
          <h2 class="card-title">会话状态</h2>
          <span class="badge ${status === 'running' ? 'accent' : status === 'error' ? 'high' : ''}"><span class="status-dot ${status}"></span>${statusLabel(status)}</span>
        </div>
        <dl class="kv">
          <dt>seed</dt><dd class="mono">${esc(settings.seed)}</dd>
          <dt>RNG state</dt><dd class="mono" id="session-rng-state">${esc(cp?.rng?.state ?? '—')}</dd>
          <dt>RNG calls</dt><dd class="mono" id="session-rng-calls">${formatNumber(cp?.rng?.calls || 0)}</dd>
          <dt>batch</dt><dd class="mono">${settings.batchSize} / batch</dd>
          <dt>timeout</dt><dd class="mono">${settings.timeoutMs} ms/exec</dd>
          <dt>memory</dt><dd class="mono">${settings.memoryLimitMB} MiB/exec</dd>
          <dt>语料</dt><dd class="mono" id="session-corpus-count">${formatNumber(corpusCount)}</dd>
        </dl>
        ${maxProgress === null ? '' : `<div class="progress mt-3"><span style="width:${maxProgress}%"></span></div><div class="help mt-2">${formatNumber(cp?.mutationCount)} / ${formatNumber(settings.maxIterations)}</div>`}
      </section>

      <section class="card">
        <div class="card-head"><h2 class="card-title">资源限制命中</h2></div>
        <div class="card-body">
          <div class="grid cols-2" style="gap:10px">
            <div><div class="dim" style="font-size:12px">超时</div><div class="mono" style="font-size:20px;font-weight:800;color:var(--orange)">${formatNumber(stats.timeoutHits || 0)}</div></div>
            <div><div class="dim" style="font-size:12px">内存</div><div class="mono" style="font-size:20px;font-weight:800;color:var(--orange)">${formatNumber(stats.memoryLimitHits || 0)}</div></div>
            <div><div class="dim" style="font-size:12px">输出预算</div><div class="mono" style="font-size:20px;font-weight:800">${formatNumber(stats.resourceCounts?.['output-budget-exceeded'] || 0)}</div></div>
            <div><div class="dim" style="font-size:12px">拒绝输入</div><div class="mono" style="font-size:20px;font-weight:800">${formatNumber(stats.rejected || 0)}</div></div>
          </div>
        </div>
      </section>
    </aside>
  </div>

  <div class="grid cols-2 mt-4">
    <section class="card">
      <div class="card-head"><h2 class="card-title">高权重种子</h2><span class="badge">top 8</span></div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>样本</th><th>来源</th><th class="right">novelty</th><th class="right">选中</th></tr></thead>
          <tbody id="top-seeds-body">
            ${topSeeds(state).map((c) => `
              <tr data-action="preview-corpus" data-id="${esc(c.id)}">
                <td><div class="name-cell truncate" style="max-width:240px">${esc(c.name)}</div><div class="sub-cell">${esc(c.id)}</div></td>
                <td><span class="badge">${esc(c.source)}</span></td>
                <td class="right" style="color:var(--accent);font-weight:800">${formatNumber(c.novelty || 0)}</td>
                <td class="right mono">${formatNumber(c.selectedCount || 0)}</td>
              </tr>`).join('') || '<tr><td colspan="4" class="dim" style="padding:24px;text-align:center">启动后显示</td></tr>'}
          </tbody>
        </table>
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <h2 class="card-title">实时事件</h2>
        <button class="btn small ghost" data-action="clear-logs">清空</button>
      </div>
      <div class="event-log" id="event-log-container">
        ${(state.logs || []).slice(0, 80).map((log) => `<div class="log-line ${esc(log.level || '')}">[${esc(log.time)}] ${esc(log.message)}</div>`).join('') || '<div class="log-line">等待 worker 事件…</div>'}
      </div>
    </section>
  </div>`;
}

function metric(label, value, foot, tone, id) {
  return `<div class="card pad metric ${tone}"><div class="metric-label">${label}</div><div class="metric-value" ${id ? `id="${id}"` : ''}>${value}</div><div class="metric-foot" ${id ? `id="${id}-foot"` : ''}>${foot}</div></div>`;
}

function topSeeds(state) {
  return (state.corpus || [])
    .slice()
    .sort((a, b) => (b.novelty || 0) - (a.novelty || 0) || (b.selectedCount || 0) - (a.selectedCount || 0))
    .slice(0, 8);
}

function statusLabel(status) {
  return { idle: '未开始', running: '变异中', paused: '已暂停', completed: '已完成', error: '错误' }[status] || status;
}

export function updateMonitorLive(state) {
  if (state.route?.name !== 'monitor') return;
  const cp = state.checkpoint;
  const stats = cp?.stats || {};
  const setText = (id, text) => {
    const node = document.getElementById(id);
    if (node && node.textContent !== text) node.textContent = text;
  };

  setText('metric-exec', formatNumber(stats.executions || 0));
  setText('metric-exec-foot', `本轮变异 ${formatNumber(cp?.mutationCount || 0)}`);
  setText('metric-rate', formatNumber(Math.round(state.runtime?.rate || 0)));
  setText('metric-edges', formatNumber(cp?.edgeCounts?.length || 0));
  setText('metric-edges-foot', `累计新边事件 ${formatNumber(stats.newEdges || 0)}`);
  setText('metric-crashes', formatNumber(state.crashes?.length || 0));
  const totalHits = stats.totalCrashes || state.crashes?.reduce((n, c) => n + (c.count || 1), 0) || 0;
  setText('metric-crashes-foot', `总命中 ${formatNumber(totalHits)}`);
  setText('chart-points-badge', `${formatNumber(cp?.curve?.length || 0)} points`);
  setText('session-rng-state', cp?.rng?.state ?? '—');
  setText('session-rng-calls', formatNumber(cp?.rng?.calls || 0));
  setText('session-corpus-count', formatNumber(state.corpus?.length || 0));

  const seedsBody = document.getElementById('top-seeds-body');
  if (seedsBody) {
    seedsBody.innerHTML = topSeeds(state).map((c) => `
      <tr data-action="preview-corpus" data-id="${esc(c.id)}">
        <td><div class="name-cell truncate" style="max-width:240px">${esc(c.name)}</div><div class="sub-cell">${esc(c.id)}</div></td>
        <td><span class="badge">${esc(c.source)}</span></td>
        <td class="right" style="color:var(--accent);font-weight:800">${formatNumber(c.novelty || 0)}</td>
        <td class="right mono">${formatNumber(c.selectedCount || 0)}</td>
      </tr>`).join('') || '<tr><td colspan="4" class="dim" style="padding:24px;text-align:center">启动后显示</td></tr>';
  }

  const now = performance.now();
  if (!state.ui.lastChartRender || now - state.ui.lastChartRender > 350) {
    const chart = document.getElementById('edge-chart-container');
    if (chart) chart.innerHTML = edgeChartSvg(cp?.curve || []);
    state.ui.lastChartRender = now;
  }

  const log = document.getElementById('event-log-container');
  if (log) {
    log.innerHTML = (state.logs || []).slice(0, 80)
      .map((item) => `<div class="log-line ${esc(item.level || '')}">[${esc(item.time)}] ${esc(item.message)}</div>`)
      .join('') || '<div class="log-line">等待 worker 事件…</div>';
  }
}
