import { esc, icon, formatNumber } from '../dom.js';
import { MUTATORS } from '../../core/mutators.js';
import { DEFAULT_SETTINGS } from '../../core/config.js';

export function renderSettings(state) {
  const s = state.settings;
  const selfTest = state.ui?.selfTest;
  return `
  <div class="page-head">
    <div>
      <h1 class="page-title">设置与确定性</h1>
      <p class="page-desc">所有变异和调度随机数来自可 checkpoint 的 mulberry32 PRNG；墙钟只用于速率显示和超时保护，不参与选种或变异决策。</p>
    </div>
    <div class="head-actions">
      <button class="btn" data-action="run-selftest">${icon('check')}运行确定性自检</button>
      <button class="btn primary" type="submit" form="settings-form">保存设置</button>
    </div>
  </div>

  <form id="settings-form" class="grid cols-2" data-action="save-settings">
    <section class="card pad">
      <h2 class="card-title mb-3">复现与会话</h2>
      <div class="field-row">
        <label class="field">随机种子
          <input type="text" name="seed" value="${esc(s.seed)}" required />
        </label>
        <label class="field">Batch 大小
          <input type="number" name="batchSize" min="1" max="1024" value="${s.batchSize}" />
        </label>
      </div>
      <div class="field-row mt-3">
        <label class="field">最大变异次数（0 = 手动暂停）
          <input type="number" name="maxIterations" min="0" max="10000000" value="${s.maxIterations}" />
        </label>
        <label class="field">曲线采样间隔
          <input type="number" name="curveInterval" min="1" max="10000" value="${s.curveInterval}" />
        </label>
      </div>
      <div class="help mt-3">修改种子会创建新的确定性序列；建议在“重置会话”后运行。已有 checkpoint 会优先用于断点续跑。</div>

      <h3 class="section-title">单次执行限制</h3>
      <div class="field-row">
        <label class="field">超时（ms）
          <input type="number" name="timeoutMs" min="1" max="30000" value="${s.timeoutMs}" />
        </label>
        <label class="field">内存上限（MiB，插桩分配器）
          <input type="number" name="memoryLimitMB" min="1" max="1024" value="${s.memoryLimitMB}" />
        </label>
      </div>
      <div class="field-row mt-3">
        <label class="field">确定性操作预算
          <input type="number" name="maxOps" min="1000" step="1000" value="${s.maxOps}" />
        </label>
        <label class="field">最大输入（bytes）
          <input type="number" name="maxInputBytes" min="64" max="1048576" value="${s.maxInputBytes}" />
        </label>
      </div>
    </section>

    <section class="card pad">
      <h2 class="card-title mb-3">变异器权重</h2>
      ${MUTATORS.map((m) => `
        <div class="weight-row">
          <label for="weight-${m.id}">${esc(m.name)}</label>
          <input id="weight-${m.id}" type="range" min="0" max="10" step="1" name="weight_${m.id}" value="${s.mutatorWeights[m.id] ?? 1}" data-action="weight-input" data-output="out-${m.id}" />
          <output id="out-${m.id}">${s.mutatorWeights[m.id] ?? 1}</output>
          <div class="help" style="grid-column:2/4">${esc(m.description)}</div>
        </div>`).join('')}

      <h3 class="section-title">新边种子调度</h3>
      <label class="field">novelty 权重 <span class="help">新边数 × 该系数加入种子权重</span>
        <input type="number" step="0.5" name="noveltyWeight" value="${s.scheduler.noveltyWeight}" />
      </label>
      <label class="field mt-3">使用次数惩罚系数
        <input type="number" step="0.02" name="useCountPenalty" value="${s.scheduler.useCountPenalty}" />
      </label>
      <div class="flex mt-4">
        <button class="btn" type="button" data-action="reset-settings-defaults">恢复默认</button>
        <button class="btn primary" type="submit">保存设置</button>
      </div>
    </section>
  </form>

  <div class="grid cols-2 mt-4">
    <section class="card pad">
      <h2 class="card-title mb-3">确定性自检</h2>
      <p class="muted">在 Worker 外/内分别创建两个相同种子的引擎，各跑 1200 次，比较崩溃指纹、命中次数和 RNG 终态。</p>
      <button class="btn primary" data-action="run-selftest">${icon('check')}运行 1200 × 2 自检</button>
      ${renderSelfTest(selfTest)}
    </section>

    <section class="card pad">
      <h2 class="card-title mb-3">持久化与数据迁移</h2>
      <p class="muted">语料、崩溃样本、最小化结果和 checkpoint 存储在浏览器 IndexedDB。可导出整个工作台 JSON，在另一浏览器恢复。</p>
      <input id="workspace-import-input" type="file" accept="application/json,.json" hidden />
      <div class="flex flex-wrap">
        <button class="btn primary" data-action="export-workspace">${icon('download')}导出整个工作台</button>
        <button class="btn" data-action="trigger-workspace-import">${icon('upload')}导入工作台</button>
      </div>
      <h3 class="section-title" style="color:var(--red)">危险区</h3>
      <button class="btn danger" data-action="clear-all-data">${icon('trash')}清空全部目标数据并刷新</button>
    </section>
  </div>`;
}

function renderSelfTest(result) {
  if (!result) return `<div class="help mt-3">尚未运行。</div>`;
  if (result.status === 'running') {
    return `<div class="mt-3"><div class="progress"><span style="width:55%"></span></div><div class="help mt-2">两个引擎正在并行执行确定性序列…</div></div>`;
  }
  const r = result.result;
  if (!r) return '';
  return `
    <div class="instrument-list mt-3">
      <div class="instrument-item ${r.ok ? '' : 'oob-site'}">
        <i class="pin" style="background:${r.ok ? 'var(--green)' : 'var(--red)'}"></i>
        <div>
          <div class="instrument-label">${r.ok ? 'PASS：崩溃集合一致' : 'FAIL：检测到分歧'}</div>
          <div class="instrument-id">A=${r.a.fps.length} fps / B=${r.b.fps.length} fps · edges ${r.a.edges}/${r.b.edges}</div>
        </div>
      </div>
    </div>
    <pre class="stack-view mt-3">${esc(JSON.stringify({ fingerprints: r.a.fps, rngA: r.a.rng.state, rngB: r.b.rng.state }, null, 2))}</pre>`;
}

export function settingsToForm(settings) {
  return { ...DEFAULT_SETTINGS, ...settings };
}
