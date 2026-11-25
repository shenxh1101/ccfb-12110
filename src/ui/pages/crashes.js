import { esc, icon, formatNumber, formatTime, formatBytes } from '../dom.js';
import { hexDump } from '../../core/bytes.js';

export function renderCrashes(state) {
  const crashes = state.crashes || [];
  return `
  <div class="page-head">
    <div>
      <h1 class="page-title">崩溃详情与指纹去重</h1>
      <p class="page-desc">指纹由靶子 ID、错误类型和稳定插桩调用栈计算；offset、样本字节和命中次数不参与指纹，因此同一根因始终只有一条记录。</p>
    </div>
    <div class="head-actions">
      <button class="btn" data-action="export-crashes" ${crashes.length ? '' : 'disabled'}>${icon('download')}导出崩溃包</button>
      <button class="btn ghost danger" data-action="clear-crashes" ${crashes.length ? '' : 'disabled'}>${icon('trash')}清空崩溃</button>
    </div>
  </div>

  <div class="grid cols-4 mb-4">
    <div class="card pad metric red"><div class="metric-label">唯一根因</div><div class="metric-value">${formatNumber(crashes.length)}</div></div>
    <div class="card pad metric"><div class="metric-label">总命中</div><div class="metric-value">${formatNumber(crashes.reduce((n, c) => n + (c.count || 1), 0))}</div></div>
    <div class="card pad metric accent"><div class="metric-label">OOB 读</div><div class="metric-value">${formatNumber(crashes.filter((c) => c.kind === 'oob-read').length)}</div></div>
    <div class="card pad metric cyan"><div class="metric-label">已最小化并复现</div><div class="metric-value">${formatNumber(crashes.filter((c) => c.minimized?.reproduced).length)}</div></div>
  </div>

  <section class="card">
    <div class="table-wrap">
      ${crashes.length === 0 ? `
        <div class="empty" style="margin:18px">
          <div class="empty-icon">🧪</div>
          <h3>还没有崩溃</h3>
          <p>固定种子通常会在数百到数千次执行内触发三个靶子内置的越界读。去监控页启动工作台。</p>
          <button class="btn primary" data-action="navigate" data-route="monitor">${icon('play')}去运行</button>
        </div>` : `
        <table class="data">
          <thead><tr><th>指纹 / 标题</th><th>类型</th><th class="right">命中</th><th>样本</th><th>最近出现</th><th class="right">操作</th></tr></thead>
          <tbody>
            ${crashes.map((crash) => `
              <tr data-action="open-crash" data-id="${esc(crash.fingerprint)}">
                <td style="min-width:330px">
                  <div class="name-cell">${esc(crash.title || crash.message)}</div>
                  <div class="sub-cell fingerprint">${esc(crash.fingerprint)}</div>
                </td>
                <td><span class="badge ${crash.severity === 'high' ? 'high' : 'medium'}">${esc(crash.kind)}</span></td>
                <td class="right mono">${formatNumber(crash.count)}</td>
                <td class="mono nowrap">${formatBytes(crash.size)}${crash.minimized ? `<br><span style="color:var(--accent)">min ${formatBytes(crash.minimized.size)}</span>` : ''}</td>
                <td class="dim nowrap">${formatTime(crash.lastSeen)}</td>
                <td><div class="row-actions">
                  <button class="btn small" data-action="minimize-crash" data-id="${esc(crash.fingerprint)}">${icon('minimize')}最小化</button>
                  <button class="btn small ghost" data-action="open-crash" data-id="${esc(crash.fingerprint)}">详情</button>
                </div></td>
              </tr>`).join('')}
          </tbody>
        </table>`}
    </div>
  </section>`;
}

export function renderCrashDetail(state, fingerprint) {
  const crash = state.crashes.find((c) => c.fingerprint === fingerprint || c.id === fingerprint);
  if (!crash) {
    return `
      <div class="page-head"><div><h1 class="page-title">崩溃不存在</h1></div></div>
      <div class="empty"><p>该指纹可能已被清空。</p><button class="btn primary" data-action="navigate" data-route="crashes">返回列表</button></div>`;
  }

  const busy = state.ui?.busyCrashId === crash.fingerprint;
  const progress = state.ui?.minimizeProgress;
  const replay = state.ui?.replay?.[crash.fingerprint] || crash.reproduction?.lastResult || crash.reproduction;
  const sampleBytes = crash.sample instanceof Uint8Array ? crash.sample : new Uint8Array();
  const minBytes = crash.minimized?.bytes instanceof Uint8Array ? crash.minimized.bytes : null;

  return `
  <div class="page-head">
    <div>
      <button class="btn small ghost mb-3" data-action="navigate" data-route="crashes">← 返回崩溃列表</button>
      <h1 class="page-title">${esc(crash.title || crash.kind)}</h1>
      <p class="page-desc fingerprint">${esc(crash.fingerprint)}</p>
    </div>
    <div class="head-actions">
      <button class="btn" data-action="replay-crash" data-id="${esc(crash.fingerprint)}" ${busy ? 'disabled' : ''}>${icon('replay')}重新验证</button>
      <button class="btn primary" data-action="minimize-crash" data-id="${esc(crash.fingerprint)}" ${busy ? 'disabled' : ''}>${icon('minimize')}${crash.minimized ? '再次最小化' : '最小化样本'}</button>
    </div>
  </div>

  <div class="detail-grid">
    <div style="display:grid;gap:16px;min-width:0">
      <section class="card pad">
        <h2 class="card-title mb-3">错误与栈指纹</h2>
        <dl class="kv">
          <dt>类型</dt><dd><span class="badge high">${esc(crash.kind)}</span></dd>
          <dt>消息</dt><dd>${esc(crash.message)}</dd>
          <dt>插桩站点</dt><dd class="mono">${esc(crash.site || '—')}</dd>
          <dt>稳定调用栈</dt><dd class="mono">${(crash.frames || []).map(esc).join(' ← ') || '—'}</dd>
          ${crash.access ? `<dt>访问</dt><dd class="mono">offset=${esc(crash.access.offset)} size=${esc(crash.access.size)} buffer=${esc(crash.access.bufferLength)}</dd>` : ''}
        </dl>
        <details class="mt-3">
          <summary class="dim" style="cursor:pointer">查看原始 JS stack</summary>
          <pre class="stack-view mt-2">${esc(crash.stack || '无 stack')}</pre>
        </details>
      </section>

      ${busy && progress ? `
        <section class="card pad">
          <div class="flex" style="justify-content:space-between">
            <strong>正在确定性最小化…</strong><span class="mono accent">${progress.size} B · ${progress.checks} checks</span>
          </div>
          <div class="progress mt-3"><span style="width:${Math.min(95, (progress.checks / 1200) * 100)}%"></span></div>
          <div class="help mt-2">阶段：${esc(progress.phase)}</div>
        </section>` : ''}

      ${crash.minimized ? renderMinimized(crash) : ''}

      <section class="card">
        <div class="card-head"><h2 class="card-title">原始崩溃样本 · ${formatBytes(sampleBytes.length)}</h2>
          <button class="btn small" data-action="download-sample" data-id="${esc(crash.fingerprint)}" data-kind="original">${icon('download')}下载</button>
        </div>
        <div class="card-body"><div class="hex-view">${esc(hexDump(sampleBytes))}</div></div>
      </section>

      ${minBytes ? `
      <section class="card">
        <div class="card-head"><h2 class="card-title">最小复现文件 · ${formatBytes(minBytes.length)}</h2>
          <button class="btn small primary" data-action="download-sample" data-id="${esc(crash.fingerprint)}" data-kind="minimized">${icon('download')}下载</button>
        </div>
        <div class="card-body"><div class="hex-view">${esc(hexDump(minBytes))}</div></div>
      </section>` : ''}
    </div>

    <aside style="display:grid;gap:16px;min-width:0">
      <section class="card pad">
        <h2 class="card-title mb-3">复现状态</h2>
        ${renderReplay(replay, crash)}
      </section>
      <section class="card pad">
        <h2 class="card-title mb-3">统计</h2>
        <dl class="kv">
          <dt>命中次数</dt><dd class="mono">${formatNumber(crash.count)}</dd>
          <dt>首次</dt><dd>${formatTime(crash.firstSeen)}</dd>
          <dt>最近</dt><dd>${formatTime(crash.lastSeen)}</dd>
          <dt>首次 exec</dt><dd class="mono">${formatNumber(crash.firstExecution)}</dd>
          <dt>最近 exec</dt><dd class="mono">${formatNumber(crash.lastExecution)}</dd>
          <dt>发现变异器</dt><dd><span class="badge accent">${esc(crash.mutator || '—')}</span></dd>
          <dt>父样本</dt><dd class="mono" style="font-size:11px">${esc(crash.parentId || '—')}</dd>
        </dl>
      </section>
    </aside>
  </div>`;
}

function renderMinimized(crash) {
  const m = crash.minimized;
  const ratio = Math.round((m.reductionRatio ?? (m.size / Math.max(1, crash.size))) * 100);
  return `
    <section class="card pad" style="border-color:rgba(200,255,61,.35)">
      <div class="flex" style="justify-content:space-between;gap:12px;flex-wrap:wrap">
        <div>
          <h2 class="card-title">最小化完成</h2>
          <div class="card-sub">${crash.size} B → ${m.size} B（${ratio}%） · ${formatNumber(m.checks)} 次验证 · ${formatNumber(m.steps)} 步</div>
        </div>
        <span class="badge ${m.reproduced ? 'ok' : 'high'}">${m.reproduced ? icon('check') + '同指纹复现成功' : '复现失败'}</span>
      </div>
      <div class="progress mt-3"><span style="width:${100 - ratio}%"></span></div>
      <div class="help mt-2">最终文件已重新送入同一个靶子执行，并校验 fingerprint 完全一致。</div>
    </section>`;
}

function renderReplay(replay, crash) {
  if (!replay) {
    return `<div class="empty" style="padding:26px 14px"><p>尚未手动验证。最小化完成时会自动执行最终验证。</p></div>`;
  }
  const ok = replay.fingerprint === crash.fingerprint && (replay.crash || replay.ok === false);
  return `
    <div class="instrument-list">
      <div class="instrument-item ${ok ? '' : 'oob-site'}">
        <i class="pin" style="background:${ok ? 'var(--green)' : 'var(--red)'}"></i>
        <div>
          <div class="instrument-label">${ok ? '复现同一根因' : '结果不一致'}</div>
          <div class="instrument-id">${esc(replay.fingerprint || replay.error?.code || 'no fingerprint')}</div>
        </div>
        <span class="badge ${ok ? 'ok' : 'high'}">${ok ? 'PASS' : 'FAIL'}</span>
      </div>
    </div>
    <dl class="kv mt-3">
      <dt>耗时</dt><dd class="mono">${Math.round(replay.durationMs || 0)} ms</dd>
      <dt>内存峰值</dt><dd class="mono">${formatBytes(replay.memoryPeak || 0)}</dd>
      <dt>边数</dt><dd class="mono">${formatNumber(replay.edgeCount || 0)}</dd>
    </dl>`;
}
