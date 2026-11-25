import { listTargets } from '../targets/index.js';
import { DEFAULT_SETTINGS } from './core/config.js';
import { fnv1aBytes } from './core/hash.js';
import { bytesToBase64, base64ToBytes } from './core/bytes.js';
import { kvGet, kvSet, kvRemove, kvClear, keys } from './data/storage.js';
import { loadSettings, saveSettings, loadActiveTarget, saveActiveTarget } from './state/settings-store.js';
import { renderSidebar, renderTopbar } from './ui/shell.js';
import { renderTargets } from './ui/pages/targets.js';
import { renderCorpus, renderCorpusPreviewModal } from './ui/pages/corpus.js';
import { renderMonitor, updateMonitorLive } from './ui/pages/monitor.js';
import { renderCrashes, renderCrashDetail } from './ui/pages/crashes.js';
import { renderSettings } from './ui/pages/settings.js';
import { esc, icon, readFileAsBytes, downloadJson, downloadBytes } from './ui/dom.js';

const state = {
  ready: false,
  targets: listTargets(),
  targetId: 'tlv',
  settings: { ...DEFAULT_SETTINGS },
  corpus: [],
  crashes: [],
  checkpoint: null,
  route: parseHash(),
  worker: null,
  workerReady: false,
  runtime: {
    status: 'idle',
    rate: 0,
    lastBatchWall: 0,
    lastExecCount: 0,
  },
  logs: [],
  ui: {
    corpusQuery: '',
    busyCrashId: null,
    minimizeProgress: null,
    replay: {},
    selfTest: null,
  },
};

let requestSeq = 0;

async function init() {
  state.settings = await loadSettings();
  state.targetId = await loadActiveTarget();
  if (!state.targets.some((t) => t.id === state.targetId)) state.targetId = state.targets[0].id;
  await loadTargetData(state.targetId);
  createWorker();
  bindEvents();
  if (!location.hash) location.hash = '#/monitor';
  window.addEventListener('hashchange', () => {
    state.route = parseHash();
    render();
  });
  state.ready = true;
  render();
}

function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const name = parts[0] || 'monitor';
  const param = parts[1] ? decodeURIComponent(parts[1]) : null;
  return { name, param };
}

async function loadTargetData(targetId) {
  const target = state.targets.find((t) => t.id === targetId);
  const [storedCorpus, crashes, checkpoint] = await Promise.all([
    kvGet(keys.targetCorpus(targetId), null),
    kvGet(keys.targetCrashes(targetId), []),
    kvGet(keys.targetCheckpoint(targetId), null),
  ]);
  if (Array.isArray(storedCorpus)) {
    state.corpus = storedCorpus;
  } else {
    state.corpus = (target?.seeds || []).map((seed) => {
      const hash = fnv1aBytes(seed.bytes);
      return {
        id: `seed-${targetId}-${hash.slice(0, 8)}`,
        targetId,
        name: seed.name,
        bytes: seed.bytes,
        hash,
        size: seed.bytes.length,
        source: 'built-in-seed',
        selectedCount: 0,
        novelty: 0,
        newEdgeCount: 0,
        edgeCount: 0,
        createdAt: Date.now(),
      };
    });
    await kvSet(keys.targetCorpus(targetId), state.corpus);
  }
  state.crashes = Array.isArray(crashes) ? crashes : [];
  state.checkpoint = checkpoint;
  applyCheckpointMeta();
  state.runtime.status = checkpoint ? 'paused' : 'idle';
  state.runtime.rate = 0;
  state.runtime.lastExecCount = checkpoint?.stats?.executions || 0;
}

function applyCheckpointMeta() {
  if (!state.checkpoint) return;
  const meta = new Map((state.checkpoint.corpusMeta || []).map((m) => [m.id, m]));
  state.corpus = state.corpus.map((item) => ({ ...item, ...(meta.get(item.id) || {}) }));
}

function createWorker() {
  state.worker?.terminate();
  const worker = new Worker(new URL('./worker/fuzz.worker.js', import.meta.url), { type: 'module' });
  state.worker = worker;
  worker.onmessage = (event) => handleWorkerMessage(event.data || {}).catch((error) => {
    console.error(error);
    toast('Worker 消息处理失败', error.message, 'error');
  });
  worker.onerror = (error) => {
    state.workerReady = false;
    state.runtime.status = 'error';
    pushLog(`worker error: ${error.message}`, 'crash');
    renderChrome();
    renderView();
  };
  state.workerReady = true;
}

function bindEvents() {
  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  document.addEventListener('input', onInput);
  document.addEventListener('submit', onSubmit);
}

async function onClick(event) {
  const el = event.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  const id = el.dataset.id;

  switch (action) {
    case 'navigate':
      location.hash = `#/${el.dataset.route || 'monitor'}`;
      break;
    case 'select-target':
      await switchTarget(id);
      break;
    case 'target-select':
      // handled by change
      break;
    case 'toggle-run':
      await toggleRun();
      break;
    case 'pause-run':
      pauseRun();
      break;
    case 'reset-session':
      await resetSession();
      break;
    case 'clear-logs':
      state.logs = [];
      renderView();
      break;
    case 'trigger-import-raw':
      document.getElementById('corpus-raw-input')?.click();
      break;
    case 'trigger-import-json':
      document.getElementById('corpus-json-input')?.click();
      break;
    case 'export-corpus':
      exportCorpus();
      break;
    case 'new-seed':
      openNewSeedModal();
      break;
    case 'create-seed-from-modal':
      await createSeedFromModal();
      break;
    case 'preview-corpus':
      openCorpusPreview(id);
      break;
    case 'download-corpus':
      downloadCorpus(id);
      break;
    case 'delete-corpus':
      await deleteCorpus(id);
      break;
    case 'open-crash':
      location.hash = `#/crashes/${encodeURIComponent(id)}`;
      break;
    case 'minimize-crash':
      startMinimize(id);
      break;
    case 'replay-crash':
      replayCrash(id);
      break;
    case 'download-sample':
      downloadSample(id, el.dataset.kind);
      break;
    case 'export-crashes':
      exportCrashes();
      break;
    case 'clear-crashes':
      await clearCrashes();
      break;
    case 'run-selftest':
      runSelfTest();
      break;
    case 'reset-settings-defaults':
      state.settings = { ...DEFAULT_SETTINGS, mutatorWeights: { ...DEFAULT_SETTINGS.mutatorWeights }, scheduler: { ...DEFAULT_SETTINGS.scheduler } };
      await saveSettings(state.settings);
      renderView();
      toast('设置已恢复默认', '保存并应用默认参数');
      break;
    case 'export-workspace':
      await exportWorkspace();
      break;
    case 'trigger-workspace-import':
      document.getElementById('workspace-import-input')?.click();
      break;
    case 'clear-all-data':
      await clearAllData();
      break;
    case 'view-source':
      await openSourceModal(id);
      break;
    case 'view-registration':
      openRegistrationModal();
      break;
    case 'close-modal':
      // Clicks inside .modal bubble through the backdrop's data-action. Only
      // treat the backdrop itself as dismissal; actual close buttons are <el>.
      if (el.classList.contains('modal-backdrop') && event.target.closest('.modal')) break;
      closeModal();
      break;
    default:
      break;
  }
}

async function onChange(event) {
  const el = event.target;
  if (el.id === 'global-target-select' && el.dataset.action === 'target-select') {
    await switchTarget(el.value);
    return;
  }
  if (el.id === 'corpus-raw-input') {
    await importRawFiles(el.files);
    el.value = '';
  } else if (el.id === 'corpus-json-input') {
    await importCorpusJson(el.files);
    el.value = '';
  } else if (el.id === 'workspace-import-input') {
    await importWorkspace(el.files);
    el.value = '';
  } else if (el.dataset.action === 'corpus-search') {
    state.ui.corpusQuery = el.value;
    renderView();
    const next = document.querySelector('[data-action="corpus-search"]');
    if (next) {
      next.focus();
      next.setSelectionRange(next.value.length, next.value.length);
    }
  }
}

function onInput(event) {
  const el = event.target;
  if (el.dataset.action === 'weight-input' && el.dataset.output) {
    const output = document.getElementById(el.dataset.output);
    if (output) output.value = el.value;
  }
}

async function onSubmit(event) {
  const form = event.target;
  if (form.id !== 'settings-form') return;
  event.preventDefault();
  const formData = new FormData(form);
  const weights = {};
  for (const key of Object.keys(DEFAULT_SETTINGS.mutatorWeights)) {
    weights[key] = Number(formData.get(`weight_${key}`));
  }
  state.settings = {
    ...state.settings,
    seed: String(formData.get('seed') || DEFAULT_SETTINGS.seed),
    batchSize: Number(formData.get('batchSize')),
    maxIterations: Number(formData.get('maxIterations')),
    curveInterval: Number(formData.get('curveInterval')),
    timeoutMs: Number(formData.get('timeoutMs')),
    memoryLimitMB: Number(formData.get('memoryLimitMB')),
    maxOps: Number(formData.get('maxOps')),
    maxInputBytes: Number(formData.get('maxInputBytes')),
    mutatorWeights: weights,
    scheduler: {
      ...state.settings.scheduler,
      noveltyWeight: Number(formData.get('noveltyWeight')),
      useCountPenalty: Number(formData.get('useCountPenalty')),
    },
  };
  state.settings = await saveSettings(state.settings);
  toast('设置已保存', '新启动/重建的会话会使用这些限制和权重', 'success');
}

async function switchTarget(targetId) {
  if (!targetId || targetId === state.targetId) {
    render();
    return;
  }
  pauseRun();
  state.targetId = targetId;
  await saveActiveTarget(targetId);
  await loadTargetData(targetId);
  state.route = { name: 'monitor', param: null };
  location.hash = '#/monitor';
  render();
}

async function toggleRun() {
  if (state.runtime.status === 'running') {
    pauseRun();
    return;
  }
  await saveSettings(state.settings);
  state.runtime.status = 'running';
  state.runtime.lastBatchWall = performance.now();
  state.runtime.lastExecCount = state.checkpoint?.stats?.executions || 0;
  renderChrome();
  renderView();
  state.worker.postMessage({
    type: 'START',
    targetId: state.targetId,
    settings: state.settings,
    corpus: state.corpus,
    crashes: state.crashes,
    checkpoint: state.checkpoint,
  });
}

function pauseRun() {
  state.runtime.status = 'paused';
  state.worker?.postMessage({ type: 'PAUSE' });
  updateStatusChrome();
  if (state.route.name === 'monitor') renderView();
}

async function resetSession() {
  const ok = window.confirm('重置会删除当前 checkpoint、统计和崩溃记录，并移除变异生成的语料；导入和内置种子保留。确定？');
  if (!ok) return;
  pauseRun();
  state.crashes = [];
  state.checkpoint = null;
  state.logs = [];
  state.corpus = state.corpus.filter((c) => c.source === 'built-in-seed' || c.source === 'imported' || c.source === 'import-json');
  await Promise.all([
    kvRemove(keys.targetCheckpoint(state.targetId)),
    kvRemove(keys.targetCrashes(state.targetId)),
    kvSet(keys.targetCorpus(state.targetId), state.corpus),
  ]);
  createWorker();
  toast('会话已重置', 'RNG 将从设置中的种子重新开始', 'success');
  render();
}

async function handleWorkerMessage(message) {
  switch (message.type) {
    case 'STATUS':
      state.runtime.status = message.status;
      updateStatusChrome();
      if (state.route.name === 'monitor') renderView();
      break;
    case 'BATCH':
      try {
        await handleBatch(message);
        state.worker.postMessage({ type: 'PERSIST_ACK', batchId: message.batchId });
      } catch (error) {
        state.worker.postMessage({ type: 'PERSIST_ERROR', batchId: message.batchId, error: error.message });
        throw error;
      }
      break;
    case 'MINIMIZE_PROGRESS':
      if (message.requestId && state.ui.busyCrashId) {
        state.ui.minimizeProgress = message.progress;
        if (state.route.name === 'crash-detail') renderView();
      }
      break;
    case 'MINIMIZE_RESULT':
      await handleMinimizeResult(message);
      break;
    case 'REPLAY_RESULT':
      state.ui.replay[message.crashId || message.requestId] = message.result;
      await persistCrashes();
      if (state.route.name === 'crash-detail') renderView();
      toast('验证完成', message.result?.fingerprint || message.result?.error?.code || 'done', message.result?.crash ? 'success' : 'error');
      break;
    case 'SELFTEST_RESULT':
      state.ui.selfTest = { status: 'done', result: message };
      renderView();
      break;
    case 'WORKER_ERROR':
      state.runtime.status = 'error';
      pushLog(message.message?.message || 'worker error', 'crash');
      toast('Worker 错误', message.message?.message || 'unknown', 'error');
      renderChrome();
      renderView();
      break;
    default:
      break;
  }
}

async function handleBatch(message) {
  const targetId = message.targetId;
  const sameTarget = targetId === state.targetId;
  const events = message.events || {};

  if (sameTarget) {
    for (const entry of events.newCorpus || []) upsertCorpus(entry);
    for (const crash of events.newCrashes || []) upsertCrash(crash);
    for (const crash of events.updatedCrashes || []) upsertCrash(crash);
    state.checkpoint = message.checkpoint;
    applyCheckpointMeta();
    updateRate(message.checkpoint);

    for (const crash of events.newCrashes || []) {
      pushLog(`新根因 ${crash.fingerprint} · ${crash.title}`, 'crash');
    }
    if ((events.newCorpus || []).length) {
      pushLog(`+${events.newCorpus.length} 个新边语料，边数=${message.checkpoint.edgeCounts.length}`, 'ok');
    }
    if ((events.resourceEvents || []).length) {
      const kinds = new Set(events.resourceEvents.map((e) => e.resource));
      pushLog(`资源限制：${Array.from(kinds).join(', ')}`, 'warn');
    }
  }

  // Persist even if the user switched targets while the batch was running.
  await kvSet(keys.targetCheckpoint(targetId), message.checkpoint);
  if (events.newCorpus?.length) {
    if (sameTarget) await persistCorpus();
    else {
      const corpus = await kvGet(keys.targetCorpus(targetId), []);
      for (const entry of events.newCorpus) if (!corpus.some((c) => c.id === entry.id)) corpus.push(entry);
      await kvSet(keys.targetCorpus(targetId), corpus);
    }
  }
  if (events.newCrashes?.length || events.updatedCrashes?.length) {
    if (sameTarget) await persistCrashes();
    else {
      const crashes = await kvGet(keys.targetCrashes(targetId), []);
      for (const crash of [...events.newCrashes, ...events.updatedCrashes]) {
        const index = crashes.findIndex((c) => c.fingerprint === crash.fingerprint);
        if (index >= 0) crashes[index] = crash;
        else crashes.push(crash);
      }
      await kvSet(keys.targetCrashes(targetId), crashes);
    }
  }

  if (sameTarget) {
    if (events.newCrashes?.length) renderChrome();
    else updateStatusChrome();
    updateMonitorLive(state);
    if (events.newCrashes?.length && state.route.name === 'crashes' && !state.route.param) renderView();
  }
}

function updateRate(checkpoint) {
  const now = performance.now();
  const execs = checkpoint?.stats?.executions || 0;
  if (state.runtime.lastBatchWall) {
    const elapsed = Math.max(0.001, (now - state.runtime.lastBatchWall) / 1000);
    const instant = Math.max(0, (execs - state.runtime.lastExecCount) / elapsed);
    state.runtime.rate = state.runtime.rate ? state.runtime.rate * 0.55 + instant * 0.45 : instant;
  }
  state.runtime.lastBatchWall = now;
  state.runtime.lastExecCount = execs;
}

function upsertCorpus(entry) {
  const index = state.corpus.findIndex((c) => c.id === entry.id || c.hash === entry.hash);
  if (index >= 0) state.corpus[index] = { ...state.corpus[index], ...entry };
  else state.corpus.push(entry);
}

function upsertCrash(crash) {
  const index = state.crashes.findIndex((c) => c.fingerprint === crash.fingerprint);
  if (index >= 0) {
    // Preserve UI replay state if worker copy lacks transient fields.
    const previous = state.crashes[index];
    state.crashes[index] = { ...previous, ...crash, minimized: crash.minimized || previous.minimized };
  } else state.crashes.unshift(crash);
}

async function persistCorpus() {
  await kvSet(keys.targetCorpus(state.targetId), state.corpus);
}
async function persistCrashes() {
  await kvSet(keys.targetCrashes(state.targetId), state.crashes);
}

async function switchTargetDataAfterImport() {
  await persistCorpus();
  if (state.runtime.status === 'running') pauseRun();
  // Rebuild worker engine from the latest checkpoint without auto-running.
  state.worker.postMessage({
    type: 'HYDRATE',
    targetId: state.targetId,
    settings: state.settings,
    corpus: state.corpus,
    crashes: state.crashes,
    checkpoint: state.checkpoint,
  });
}

async function addCorpusBytes(bytes, name, source = 'imported', extra = {}) {
  const hash = fnv1aBytes(bytes);
  if (state.corpus.some((c) => c.hash === hash)) return { duplicate: true };
  const target = state.targets.find((t) => t.id === state.targetId);
  const entry = {
    id: `corpus-${state.targetId}-${hash.slice(0, 10)}-${++requestSeq}`,
    targetId: state.targetId,
    name: name || `${hash}.bin`,
    bytes,
    hash,
    size: bytes.length,
    source,
    parentId: null,
    generation: 0,
    selectedCount: 0,
    novelty: 0,
    newEdgeCount: 0,
    edgeCount: 0,
    createdAt: Date.now(),
    ...extra,
  };
  // Ensure built-in seeds exist in state if user opens empty storage.
  if (state.corpus.length === 0 && target) {
    for (const seed of target.seeds) {
      const seedHash = fnv1aBytes(seed.bytes);
      state.corpus.push({
        id: `seed-${target.id}-${seedHash.slice(0, 8)}`,
        targetId,
        name: seed.name,
        bytes: seed.bytes,
        hash: seedHash,
        size: seed.bytes.length,
        source: 'built-in-seed',
        createdAt: Date.now(),
      });
    }
  }
  state.corpus.push(entry);
  return { entry, duplicate: false };
}

async function importRawFiles(files) {
  let added = 0;
  let duplicates = 0;
  for (const file of Array.from(files || [])) {
    const bytes = await readFileAsBytes(file);
    const result = await addCorpusBytes(bytes, file.name, 'imported');
    if (result.duplicate) duplicates++;
    else added++;
  }
  await switchTargetDataAfterImport();
  render();
  toast('原始样本导入完成', `新增 ${added}，去重 ${duplicates}`, added ? 'success' : undefined);
}

async function importCorpusJson(files) {
  let added = 0;
  for (const file of Array.from(files || [])) {
    const text = await file.text();
    const json = JSON.parse(text);
    const entries = json.entries || json.seeds || json.corpus || [];
    for (const item of entries) {
      const bytes = item.bytes instanceof Uint8Array
        ? item.bytes
        : item.bytesBase64 ? base64ToBytes(item.bytesBase64)
        : item.base64 ? base64ToBytes(item.base64)
        : item.hex ? hexToBytesSafe(item.hex) : null;
      if (!bytes) continue;
      const result = await addCorpusBytes(bytes, item.name || 'imported.json', item.source || 'import-json', item);
      if (!result.duplicate) added++;
    }
  }
  await switchTargetDataAfterImport();
  render();
  toast('JSON 语料导入完成', `新增 ${added} 个样本`, 'success');
}

function hexToBytesSafe(hex) {
  try {
    const clean = String(hex).replace(/[^0-9a-f]/gi, '');
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    return out;
  } catch {
    return null;
  }
}

function exportCorpus() {
  const payload = {
    format: 'fuzz-workbench-corpus',
    version: 1,
    targetId: state.targetId,
    exportedAt: new Date().toISOString(),
    seed: state.settings.seed,
    entries: state.corpus.map((item) => {
      const { bytes, ...meta } = item;
      return { ...meta, bytesBase64: bytesToBase64(bytes) };
    }),
  };
  downloadJson(`${state.targetId}-corpus-${Date.now()}.json`, payload);
  toast('语料已导出', `${state.corpus.length} 个样本`);
}

function downloadCorpus(id) {
  const item = state.corpus.find((c) => c.id === id);
  if (!item) return;
  downloadBytes(item.name.endsWith('.bin') || item.name.includes('.') ? item.name : `${item.name}.bin`, item.bytes);
}

async function deleteCorpus(id) {
  if (!window.confirm('删除这个语料样本？')) return;
  state.corpus = state.corpus.filter((c) => c.id !== id);
  await persistCorpus();
  closeModal();
  await switchTargetDataAfterImport();
  render();
}

function openCorpusPreview(id) {
  const item = state.corpus.find((c) => c.id === id);
  if (!item) return;
  document.getElementById('modal-root').innerHTML = renderCorpusPreviewModal(item);
}

function openNewSeedModal() {
  document.getElementById('modal-root').innerHTML = `
  <div class="modal-backdrop" data-action="close-modal">
    <div class="modal">
      <div class="modal-head"><h2 class="card-title">新建语料样本</h2><button class="btn small ghost" data-action="close-modal">${icon('x')}</button></div>
      <div class="modal-body">
        <label class="field mb-3">名称<input id="new-seed-name" type="text" value="manual-seed.bin" /></label>
        <label class="field">内容（UTF-8 文本或 Hex）
          <textarea id="new-seed-content" rows="8" placeholder="TLV1... 或 54 4c 56 31 01 00"></textarea>
        </label>
        <label class="field mt-3"><input id="new-seed-hex" type="checkbox" />内容按 Hex 解析</label>
      </div>
      <div class="modal-foot">
        <button class="btn ghost" data-action="close-modal">取消</button>
        <button class="btn primary" data-action="create-seed-from-modal">创建</button>
      </div>
    </div>
  </div>`;
}

async function createSeedFromModal() {
  const name = document.getElementById('new-seed-name')?.value || 'manual-seed.bin';
  const content = document.getElementById('new-seed-content')?.value || '';
  const isHex = document.getElementById('new-seed-hex')?.checked;
  const bytes = isHex ? hexToBytesSafe(content) : new TextEncoder().encode(content);
  if (!bytes || bytes.length === 0) {
    toast('样本为空', '请输入文本或有效 Hex', 'error');
    return;
  }
  await addCorpusBytes(bytes, name, 'manual');
  await switchTargetDataAfterImport();
  closeModal();
  render();
  toast('样本已加入语料库', `${bytes.length} bytes`, 'success');
}

function startMinimize(fingerprint) {
  const crash = state.crashes.find((c) => c.fingerprint === fingerprint);
  if (!crash) return;
  state.ui.busyCrashId = fingerprint;
  state.ui.minimizeProgress = { phase: 'queued', size: crash.size, checks: 0 };
  if (state.runtime.status === 'running') pauseRun();
  state.route = { name: 'crashes', param: fingerprint };
  if (location.hash !== `#/crashes/${encodeURIComponent(fingerprint)}`) {
    location.hash = `#/crashes/${encodeURIComponent(fingerprint)}`;
  }
  render();
  state.worker.postMessage({
    type: 'MINIMIZE',
    requestId: `min-${++requestSeq}`,
    crashId: fingerprint,
    targetId: state.targetId,
    fingerprint,
    bytes: crash.sample,
    settings: state.settings,
  });
}

async function handleMinimizeResult(message) {
  const crash = state.crashes.find((c) => c.fingerprint === message.crashId);
  state.ui.busyCrashId = null;
  state.ui.minimizeProgress = null;
  if (crash && message.ok) {
    crash.minimized = {
      bytes: message.bytes,
      size: message.minimizedSize,
      originalSize: message.originalSize,
      removedBytes: message.removedBytes,
      reductionRatio: message.minimizedSize / Math.max(1, message.originalSize),
      checks: message.checks,
      steps: message.steps,
      reproduced: message.reproduced,
      fingerprint: message.fingerprint,
      minimizedAt: Date.now(),
    };
    crash.reproduction = {
      lastAt: Date.now(),
      fingerprint: message.fingerprint,
      ...(message.resultSummary || {}),
    };
    state.ui.replay[crash.fingerprint] = message.resultSummary;
    await persistCrashes();
    toast('最小化并复现成功', `${message.originalSize} B → ${message.minimizedSize} B`, 'success');
  } else {
    toast('最小化失败', message.reason || '最终验证未保持同一指纹', 'error');
  }
  render();
}

function replayCrash(fingerprint) {
  const crash = state.crashes.find((c) => c.fingerprint === fingerprint);
  if (!crash) return;
  const bytes = crash.minimized?.bytes || crash.sample;
  state.ui.replay[fingerprint] = { running: true };
  renderView();
  state.worker.postMessage({
    type: 'REPLAY',
    requestId: `replay-${++requestSeq}`,
    crashId: fingerprint,
    targetId: state.targetId,
    bytes,
    settings: state.settings,
  });
}

function downloadSample(fingerprint, kind) {
  const crash = state.crashes.find((c) => c.fingerprint === fingerprint);
  if (!crash) return;
  if (kind === 'minimized' && crash.minimized?.bytes) {
    downloadBytes(`${state.targetId}-${fingerprint}.min.bin`, crash.minimized.bytes);
  } else {
    downloadBytes(`${state.targetId}-${fingerprint}.bin`, crash.sample);
  }
}

function exportCrashes() {
  const payload = {
    format: 'fuzz-workbench-crashes',
    version: 1,
    targetId: state.targetId,
    exportedAt: new Date().toISOString(),
    crashes: state.crashes.map((crash) => ({
      ...crash,
      sampleBase64: bytesToBase64(crash.sample),
      sample: undefined,
      minimized: crash.minimized
        ? { ...crash.minimized, bytesBase64: bytesToBase64(crash.minimized.bytes), bytes: undefined }
        : null,
    })),
  };
  downloadJson(`${state.targetId}-crashes-${Date.now()}.json`, payload);
}

async function clearCrashes() {
  if (!window.confirm('清空当前靶子的所有去重崩溃记录？')) return;
  state.crashes = [];
  state.ui.replay = {};
  await kvRemove(keys.targetCrashes(state.targetId));
  render();
}

function runSelfTest() {
  state.ui.selfTest = { status: 'running' };
  renderView();
  state.worker.postMessage({
    type: 'RUN_SELFTEST',
    requestId: `selftest-${++requestSeq}`,
    targetId: state.targetId,
    seed: state.settings.seed,
    iterations: 1200,
  });
}

async function exportWorkspace() {
  const targets = {};
  for (const target of state.targets) {
    const [corpus, crashes, checkpoint] = await Promise.all([
      kvGet(keys.targetCorpus(target.id), []),
      kvGet(keys.targetCrashes(target.id), []),
      kvGet(keys.targetCheckpoint(target.id), null),
    ]);
    targets[target.id] = {
      checkpoint,
      corpus: corpus.map((item) => ({ ...item, bytes: undefined, bytesBase64: bytesToBase64(item.bytes) })),
      crashes: crashes.map((crash) => ({
        ...crash,
        sample: undefined,
        sampleBase64: bytesToBase64(crash.sample),
        minimized: crash.minimized
          ? { ...crash.minimized, bytes: undefined, bytesBase64: bytesToBase64(crash.minimized.bytes) }
          : null,
      })),
    };
  }
  downloadJson(`fuzz-workspace-${Date.now()}.json`, {
    format: 'fuzz-workbench',
    version: 1,
    exportedAt: new Date().toISOString(),
    activeTarget: state.targetId,
    settings: state.settings,
    targets,
  });
  toast('工作台已导出', '包含语料、崩溃、最小样本和 checkpoint');
}

async function importWorkspace(files) {
  const file = files?.[0];
  if (!file) return;
  if (!window.confirm('导入会覆盖浏览器中同 ID 的现有工作台数据，确定继续？')) return;
  const json = JSON.parse(await file.text());
  if (json.format !== 'fuzz-workbench') throw new Error('not a FuzzBench workspace file');
  if (json.settings) await saveSettings(json.settings);
  for (const [targetId, data] of Object.entries(json.targets || {})) {
    const corpus = (data.corpus || []).map((item) => ({
      ...item,
      bytes: base64ToBytes(item.bytesBase64),
      bytesBase64: undefined,
    }));
    const crashes = (data.crashes || []).map((crash) => ({
      ...crash,
      sample: base64ToBytes(crash.sampleBase64),
      sampleBase64: undefined,
      minimized: crash.minimized?.bytesBase64
        ? { ...crash.minimized, bytes: base64ToBytes(crash.minimized.bytesBase64), bytesBase64: undefined }
        : crash.minimized,
    }));
    await kvSet(keys.targetCorpus(targetId), corpus);
    await kvSet(keys.targetCrashes(targetId), crashes);
    await kvSet(keys.targetCheckpoint(targetId), data.checkpoint || null);
  }
  toast('工作台已导入', '页面即将刷新', 'success');
  setTimeout(() => location.reload(), 700);
}

async function clearAllData() {
  if (!window.confirm('将删除所有靶子的语料、崩溃、checkpoint 和设置，确定？')) return;
  await kvClear();
  location.reload();
}

async function openSourceModal(targetId) {
  const target = state.targets.find((t) => t.id === targetId);
  const response = await fetch(`/${target.file}`);
  const source = await response.text();
  document.getElementById('modal-root').innerHTML = `
  <div class="modal-backdrop" data-action="close-modal">
    <div class="modal" style="width:min(980px,100%)">
      <div class="modal-head">
        <div><h2 class="card-title">${esc(target.file)}</h2><div class="card-sub">${esc(target.name)}</div></div>
        <button class="btn small ghost" data-action="close-modal">${icon('x')}</button>
      </div>
      <div class="modal-body"><pre class="stack-view" style="color:#c9d7e8;max-height:65vh">${esc(source)}</pre></div>
    </div>
  </div>`;
}

function openRegistrationModal() {
  document.getElementById('modal-root').innerHTML = `
  <div class="modal-backdrop" data-action="close-modal">
    <div class="modal">
      <div class="modal-head"><h2 class="card-title">注册一个新靶子</h2><button class="btn small ghost" data-action="close-modal">${icon('x')}</button></div>
      <div class="modal-body">
        <p class="muted">在 <code>targets/</code> 新建 <code>my-format.js</code>，导出 target 对象，然后加入 <code>targets/index.js</code>。</p>
        <pre class="stack-view" style="color:#c9d7e8">import { registerTarget } from './index.js';

registerTarget({
  id: 'my-format',
  name: 'My Format',
  grammar: { rules: [/* 声明字段和重复节点 */] },
  instrumentation: [/* 插桩点 */],
  edges: [{ id: 'my.edge', from: 'a', to: 'b' }],
  seeds: [{ name: 'seed.bin', bytes: new Uint8Array([/* ... */]) }],
  parse(input, ctx) {
    ctx.edge('my.edge');
    // 使用 targets/harness.js 的 Reader；
    // 越界时调用 ctx.fault('oob-read', ...).
  },
});</pre>
      </div>
      <div class="modal-foot"><button class="btn primary" data-action="close-modal">知道了</button></div>
    </div>
  </div>`;
}

function closeModal() {
  document.getElementById('modal-root').innerHTML = '';
}

function pushLog(message, level = '') {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  state.logs.unshift({ time, message, level });
  state.logs = state.logs.slice(0, 120);
}

function toast(title, message = '', type = 'info') {
  const root = document.getElementById('toast-root');
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.innerHTML = `<div class="toast-title">${esc(title)}</div>${message ? `<div class="toast-msg">${esc(message)}</div>` : ''}`;
  root.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    setTimeout(() => node.remove(), 180);
  }, 3600);
}

function updateStatusChrome() {
  const pill = document.getElementById('global-status-pill');
  const run = document.getElementById('topbar-run');
  const status = state.runtime.status;
  if (pill) {
    pill.className = `badge ${status === 'running' ? 'accent' : status === 'error' ? 'high' : ''}`;
    pill.innerHTML = `<span class="status-dot ${status}"></span><span id="global-status-label">${statusLabel(status)}</span>`;
  }
  if (run) {
    run.className = `btn ${status === 'running' ? '' : 'primary'}`;
    run.innerHTML = status === 'running' ? `${icon('pause')}暂停` : `${icon('play')}${state.checkpoint ? '继续' : '开始'}`;
  }
}

function statusLabel(status) {
  return { idle: '未开始', running: '运行中', paused: '已暂停 / 可续跑', completed: '已完成', error: '工作器错误' }[status] || status;
}

function renderChrome() {
  document.getElementById('sidebar').innerHTML = renderSidebar(state);
  document.getElementById('topbar').innerHTML = renderTopbar(state);
}

function renderView() {
  const view = document.getElementById('view');
  const route = state.route;
  if (route.name === 'targets') view.innerHTML = renderTargets(state);
  else if (route.name === 'corpus') view.innerHTML = renderCorpus(state);
  else if (route.name === 'monitor') view.innerHTML = renderMonitor(state);
  else if (route.name === 'crashes' && route.param) view.innerHTML = renderCrashDetail(state, route.param);
  else if (route.name === 'crashes') view.innerHTML = renderCrashes(state);
  else if (route.name === 'settings') view.innerHTML = renderSettings(state);
  else view.innerHTML = renderMonitor(state);
}

function render() {
  state.route = parseHash();
  renderChrome();
  renderView();
}

init().catch((error) => {
  console.error(error);
  document.body.insertAdjacentHTML('beforeend', `<div style="padding:24px;color:#ff8a95">初始化失败：${esc(error.message)}</div>`);
});
