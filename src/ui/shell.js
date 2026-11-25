import { esc, icon, formatNumber } from './dom.js';

const NAV = [
  { route: 'targets', label: '目标', icon: 'target' },
  { route: 'corpus', label: '语料库', icon: 'corpus' },
  { route: 'monitor', label: '运行监控', icon: 'monitor' },
  { route: 'crashes', label: '崩溃详情', icon: 'crash' },
  { route: 'settings', label: '设置', icon: 'settings' },
];

export function renderSidebar(state) {
  const crashCount = state.crashes?.length || 0;
  const current = state.route?.name || 'monitor';
  return `
    <div class="brand">
      <div class="brand-mark">${icon('flask')}</div>
      <div>
        <div class="brand-name">FuzzBench</div>
        <div class="brand-sub">browser target lab</div>
      </div>
    </div>
    <nav class="nav" aria-label="主导航">
      <div class="nav-label">工作台</div>
      ${NAV.map((item) => `
        <button class="nav-item ${current === item.route || (item.route === 'crashes' && current === 'crash-detail') ? 'active' : ''}"
          data-action="navigate" data-route="${item.route}">
          ${icon(item.icon)}
          <span>${item.label}</span>
          ${item.route === 'crashes' && crashCount ? `<span class="nav-badge">${formatNumber(crashCount)}</span>` : '<span class="nav-dot"></span>'}
        </button>`).join('')}
    </nav>
    <div class="sidebar-foot">
      <div class="determinism-pill">
        <span class="status-dot ${state.runtime?.status === 'running' ? 'running' : state.runtime?.status === 'error' ? 'error' : 'paused'}"></span>
        <span>确定性种子 <strong>${esc(String(state.settings?.seed || '').slice(0, 14))}</strong></span>
      </div>
      <div class="help mt-2">相同种子、语料和调度状态会得到相同崩溃指纹集合。</div>
    </div>`;
}

export function renderTopbar(state) {
  const target = state.targets.find((t) => t.id === state.targetId);
  const status = state.runtime?.status || 'idle';
  const statusLabel = {
    idle: '未开始',
    running: '运行中',
    paused: '已暂停 / 可续跑',
    completed: '已完成',
    error: '工作器错误',
  }[status] || status;
  const running = status === 'running';
  return `
    <div class="target-switcher">
      <label class="dim" for="global-target-select">靶子</label>
      <select id="global-target-select" data-action="target-select">
        ${state.targets.map((t) => `<option value="${esc(t.id)}" ${t.id === state.targetId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
      </select>
      <span class="badge cyan">${esc(target?.version || '')}</span>
    </div>
    <div class="flex" style="margin-left:auto">
      <span id="global-status-pill" class="badge ${running ? 'accent' : status === 'error' ? 'high' : ''}">
        <span class="status-dot ${status}"></span><span id="global-status-label">${esc(statusLabel)}</span>
      </span>
      <button id="topbar-run" class="btn ${running ? '' : 'primary'}" data-action="toggle-run" ${status === 'error' && !state.workerReady ? 'disabled' : ''}>
        ${running ? icon('pause') + '暂停' : icon('play') + (state.checkpoint ? '继续' : '开始')}
      </button>
    </div>`;
}
