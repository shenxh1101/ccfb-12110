import { esc, icon, formatNumber, formatBytes } from '../dom.js';
import { bytesToHex } from '../../core/bytes.js';

export function renderCorpus(state) {
  const target = state.targets.find((t) => t.id === state.targetId);
  const corpus = state.corpus || [];
  const totalBytes = corpus.reduce((sum, item) => sum + (item.size || item.bytes?.length || 0), 0);

  return `
  <div class="page-head">
    <div>
      <h1 class="page-title">语料库 · ${esc(target?.name || '')}</h1>
      <p class="page-desc">内置语法种子、发现新边后自动入队的样本和导入样本都保存在 IndexedDB。可导出 JSON 包用于跨机器复现。</p>
    </div>
    <div class="head-actions">
      <input id="corpus-raw-input" type="file" multiple hidden />
      <input id="corpus-json-input" type="file" accept="application/json,.json" multiple hidden />
      <button class="btn" data-action="trigger-import-raw">${icon('upload')}导入原始样本</button>
      <button class="btn" data-action="trigger-import-json">${icon('upload')}导入 JSON</button>
      <button class="btn primary" data-action="export-corpus">${icon('download')}导出语料</button>
      <button class="btn ghost" data-action="new-seed">＋ 新建</button>
    </div>
  </div>

  <div class="grid cols-4 mb-4">
    <div class="card pad metric"><div class="metric-label">样本数</div><div class="metric-value">${formatNumber(corpus.length)}</div></div>
    <div class="card pad metric cyan"><div class="metric-label">总大小</div><div class="metric-value">${formatBytes(totalBytes)}</div></div>
    <div class="card pad metric accent"><div class="metric-label">内置种子</div><div class="metric-value">${formatNumber(corpus.filter((c) => c.source === 'built-in-seed').length)}</div></div>
    <div class="card pad metric"><div class="metric-label">新边样本</div><div class="metric-value">${formatNumber(corpus.filter((c) => (c.newEdgeCount || 0) > 0).length)}</div></div>
  </div>

  <section class="card">
    <div class="card-head">
      <div>
        <h2 class="card-title">样本队列</h2>
        <div class="card-sub">novelty 是该样本作为父样本时为全局覆盖率贡献的新边数；调度器会给高 novelty 种子更高权重。</div>
      </div>
      <input class="search" style="max-width:260px" placeholder="搜索名称 / 来源 / hash" data-action="corpus-search" value="${esc(state.ui?.corpusQuery || '')}" />
    </div>
    <div class="table-wrap">
      ${corpus.length === 0 ? `
        <div class="empty" style="margin:18px">
          <div class="empty-icon">🗂️</div><h3>当前靶子还没有语料</h3>
          <p>导入样本，或回到监控页启动；首次启动会自动写入 ${target?.seeds.length || 0} 个内置种子。</p>
          <button class="btn primary" data-action="trigger-import-raw">${icon('upload')}导入文件</button>
        </div>` : renderTable(state)}
    </div>
  </section>`;
}

function renderTable(state) {
  const query = (state.ui?.corpusQuery || '').trim().toLowerCase();
  const rows = (state.corpus || []).filter((item) => {
    if (!query) return true;
    return [item.name, item.id, item.hash, item.source].some((v) => String(v || '').toLowerCase().includes(query));
  });

  return `
  <table class="data">
    <thead>
      <tr>
        <th>名称 / ID</th><th>来源</th><th>大小</th><th>Hash</th>
        <th class="right">选中</th><th class="right">Novelty</th><th class="right">边数</th><th class="right">操作</th>
      </tr>
    </thead>
    <tbody>
      ${rows.map((item) => `
        <tr data-action="preview-corpus" data-id="${esc(item.id)}">
          <td style="min-width:220px">
            <div class="name-cell">${esc(item.name)}</div>
            <div class="sub-cell">${esc(item.id)}</div>
          </td>
          <td><span class="badge ${String(item.source).startsWith('mutation') ? 'accent' : 'cyan'}">${esc(item.source)}</span></td>
          <td class="mono nowrap">${formatBytes(item.size || item.bytes?.length || 0)}</td>
          <td class="mono-cell">${esc((item.hash || '').slice(0, 12))}</td>
          <td class="right mono">${formatNumber(item.selectedCount || 0)}</td>
          <td class="right"><strong style="color:var(--accent)">${formatNumber(item.novelty || 0)}</strong></td>
          <td class="right mono">${formatNumber(item.edgeCount || 0)}</td>
          <td>
            <div class="row-actions" @click.stop>
              <button class="btn small ghost" data-action="download-corpus" data-id="${esc(item.id)}">${icon('download')}</button>
              <button class="btn small danger" data-action="delete-corpus" data-id="${esc(item.id)}">${icon('trash')}</button>
            </div>
          </td>
        </tr>`).join('')}
    </tbody>
  </table>
  ${rows.length === 0 ? '<div class="empty" style="margin:18px">没有匹配的语料样本。</div>' : ''}`;
}

export function renderCorpusPreviewModal(item) {
  const bytes = item.bytes instanceof Uint8Array ? item.bytes : new Uint8Array();
  return `
    <div class="modal-backdrop" data-action="close-modal">
      <div class="modal" data-modal-stop>
        <div class="modal-head">
          <div>
            <h2 class="card-title">${esc(item.name)}</h2>
            <div class="card-sub mono">${esc(item.id)} · ${bytes.length} bytes · ${esc(item.source)}</div>
          </div>
          <button class="btn small ghost" data-action="close-modal">${icon('x')}</button>
        </div>
        <div class="modal-body">
          <div class="kv mb-3">
            <dt>hash</dt><dd class="mono">${esc(item.hash)}</dd>
            <dt>parent</dt><dd class="mono">${esc(item.parentId || '—')}</dd>
          </div>
          <div class="hex-view">${esc(bytesToHex(bytes))}</div>
        </div>
        <div class="modal-foot">
          <button class="btn danger" data-action="delete-corpus" data-id="${esc(item.id)}">${icon('trash')}删除</button>
          <button class="btn primary" data-action="download-corpus" data-id="${esc(item.id)}">${icon('download')}下载</button>
        </div>
      </div>
    </div>`;
}
