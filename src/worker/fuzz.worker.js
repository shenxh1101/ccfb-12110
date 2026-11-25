/// <reference lib="webworker" />
import { getTarget } from '../../targets/index.js';
import { FuzzEngine } from '../core/engine.js';
import { minimizeCrash } from '../core/minimizer.js';
import { executeTarget } from '../core/executor.js';
import { executorLimits } from '../core/config.js';

const ctx = self;

/** @type {FuzzEngine | null} */
let engine = null;
let engineKey = null;
let running = false;
let loopActive = false;
let runToken = 0;
let batchCounter = 0;
const persistAcks = new Map();

ctx.onmessage = async (event) => {
  const message = event.data || {};
  try {
    if (message.type === 'START') return await handleStart(message);
    if (message.type === 'HYDRATE') return handleHydrate(message);
    if (message.type === 'PAUSE') return handlePause();
    if (message.type === 'RESUME') return handleResume();
    if (message.type === 'PERSIST_ACK') return resolveAck(message.batchId, null);
    if (message.type === 'PERSIST_ERROR') return resolveAck(message.batchId, new Error(message.error || 'persist failed'));
    if (message.type === 'MINIMIZE') return await handleMinimize(message);
    if (message.type === 'REPLAY') return handleReplay(message);
    if (message.type === 'RUN_SELFTEST') return await handleSelfTest(message);
  } catch (error) {
    post({ type: 'WORKER_ERROR', message: serializeWorkerError(error, message.requestId) });
  }
};

function post(message) {
  ctx.postMessage(message);
}

async function handleStart(message) {
  const key = `${message.targetId}:${message.reset ? 'reset' : 'resume'}`;
  if (!engine || engine.target.id !== message.targetId || message.reset || engineKey !== stableKey(message)) {
    engine = buildEngine(message);
    engineKey = stableKey(message);
  } else {
    engine.settings = normalizeIncomingSettings(message.settings);
    engine.limits = executorLimits(engine.settings);
  }

  if (running || loopActive) {
    post({ type: 'STATUS', status: 'running' });
    return;
  }
  runToken++;
  void runLoop(runToken);
}

function stableKey(message) {
  return JSON.stringify({
    targetId: message.targetId,
    seed: message.settings?.seed,
    hasCheckpoint: Boolean(message.checkpoint),
    corpus: message.corpus?.length || 0,
  });
}

function handleHydrate(message) {
  running = false;
  runToken++;
  engine = buildEngine(message);
  engineKey = stableKey(message);
  post({ type: 'STATUS', status: message.autostart ? 'running' : 'paused', targetId: message.targetId });
  if (message.autostart) {
    runToken++;
    void runLoop(runToken);
  }
}

function normalizeIncomingSettings(settings) {
  // Engine constructor normalizes; this avoids a second import cycle.
  return settings;
}

function buildEngine(message) {
  const target = getTarget(message.targetId);
  if (!target) throw new Error(`unknown target: ${message.targetId}`);
  const created = new FuzzEngine(target, {
    settings: message.settings,
    corpus: message.corpus || [],
    crashes: message.crashes || [],
    checkpoint: message.reset ? null : message.checkpoint,
    now: () => Date.now(),
  });
  created.prime();
  return created;
}

function handlePause() {
  running = false;
  runToken++;
  post({ type: 'STATUS', status: 'paused' });
}

function handleResume() {
  if (!engine) throw new Error('no engine session');
  if (running || loopActive) {
    post({ type: 'STATUS', status: running ? 'running' : 'paused' });
    return;
  }
  runToken++;
  void runLoop(runToken);
}

async function runLoop(token) {
  loopActive = true;
  running = true;
  post({ type: 'STATUS', status: 'running', targetId: engine.target.id });

  try {
    while (running && token === runToken) {
      const batch = engine.runBatch(engine.settings.batchSize);
      batchCounter++;
      const batchId = `b${batchCounter}-${engine.mutationCount}`;
      post({
        type: 'BATCH',
        batchId,
        targetId: engine.target.id,
        checkpoint: batch.checkpoint,
        events: batch.events,
      });

      // Durable UI persistence acknowledges before the RNG advances further.
      // This gives refresh-safe checkpoint semantics at batch boundaries.
      await waitForAck(batchId);

      if (engine.settings.maxIterations > 0 && engine.mutationCount >= engine.settings.maxIterations) {
        running = false;
        post({ type: 'STATUS', status: 'completed', targetId: engine.target.id });
        break;
      }

      // Macrotask boundary ensures PAUSE / MINIMIZE messages can be delivered.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } catch (error) {
    running = false;
    post({ type: 'WORKER_ERROR', message: serializeWorkerError(error) });
    post({ type: 'STATUS', status: 'error', targetId: engine?.target.id });
  } finally {
    loopActive = false;
    if (!running) post({ type: 'STATUS', status: 'paused', targetId: engine?.target.id });
  }
}

function waitForAck(batchId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      persistAcks.delete(batchId);
      reject(new Error(`persistence acknowledgement timeout for ${batchId}`));
    }, 10_000);
    persistAcks.set(batchId, { resolve, reject, timer });
  });
}

function resolveAck(batchId, error) {
  const ack = persistAcks.get(batchId);
  if (!ack) return;
  clearTimeout(ack.timer);
  persistAcks.delete(batchId);
  if (error) ack.reject(error);
  else ack.resolve();
}

async function handleMinimize(message) {
  running = false;
  runToken++;
  const target = getTarget(message.targetId);
  if (!target) throw new Error(`unknown target: ${message.targetId}`);
  const bytes = message.bytes instanceof Uint8Array ? message.bytes : new Uint8Array(message.bytes || []);
  const limits = {
    ...executorLimits(message.settings || {}),
    timeoutMs: Math.max(1000, message.settings?.timeoutMs || 1000),
  };

  post({ type: 'MINIMIZE_STATUS', requestId: message.requestId, status: 'running' });
  const result = await minimizeCrash(target, bytes, message.fingerprint, {
    ...limits,
    maxChecks: message.maxChecks || 1200,
    onProgress: (progress) => {
      post({ type: 'MINIMIZE_PROGRESS', requestId: message.requestId, progress });
    },
  });

  post({
    type: 'MINIMIZE_RESULT',
    requestId: message.requestId,
    crashId: message.crashId,
    targetId: message.targetId,
    ok: result.ok,
    reason: result.reason || null,
    originalSize: result.originalSize,
    minimizedSize: result.minimizedSize,
    removedBytes: result.removedBytes,
    reductionRatio: result.reductionRatio,
    checks: result.checks,
    steps: result.steps,
    bytes: result.bytes || null,
    fingerprint: result.fingerprint || null,
    reproduced: Boolean(result.reproduced),
    resultSummary: result.result
      ? {
          crash: result.result.crash,
          fingerprint: result.result.fingerprint,
          title: result.result.title,
          durationMs: result.result.durationMs,
          memoryPeak: result.result.memoryPeak,
          edges: result.result.edges?.length || 0,
        }
      : null,
  });
}

function handleReplay(message) {
  const target = getTarget(message.targetId);
  if (!target) throw new Error(`unknown target: ${message.targetId}`);
  const bytes = message.bytes instanceof Uint8Array ? message.bytes : new Uint8Array(message.bytes || []);
  const result = executeTarget(target, bytes, executorLimits(message.settings || {}));
  post({
    type: 'REPLAY_RESULT',
    requestId: message.requestId,
    crashId: message.crashId,
    result: {
      ok: result.ok,
      crash: result.crash,
      rejected: result.rejected,
      resource: result.resource,
      fingerprint: result.fingerprint || null,
      title: result.title || null,
      durationMs: result.durationMs,
      operations: result.operations,
      memoryPeak: result.memoryPeak,
      edgeCount: result.edges.length,
      edges: result.edges,
      error: result.error
        ? {
            name: result.error.name,
            code: result.error.code,
            kind: result.error.kind,
            message: result.error.message,
            stack: result.error.stack,
            site: result.error.site,
            frames: result.error.frames,
            access: result.error.access,
          }
        : null,
    },
  });
}

async function handleSelfTest(message) {
  // Two independent engines with the same seed must produce identical crash
  // fingerprint sets. Exposed as a Settings diagnostic.
  const target = getTarget(message.targetId);
  const iterations = message.iterations || 1200;
  function sample() {
    const e = new FuzzEngine(target, { settings: { seed: message.seed || 'selftest', batchSize: 128 }, now: () => 0 });
    e.prime();
    let left = iterations;
    while (left > 0) {
      const n = Math.min(128, left);
      e.runBatch(n);
      left -= n;
    }
    return {
      fps: Array.from(e.crashes.keys()).sort(),
      counts: Array.from(e.crashes.values()).map((c) => c.count).sort((a, b) => a - b),
      edges: e.edgeCounts.size,
      rng: e.rng.checkpoint(),
    };
  }
  const a = sample();
  const b = sample();
  const ok = JSON.stringify(a.fps) === JSON.stringify(b.fps) && JSON.stringify(a.counts) === JSON.stringify(b.counts);
  post({ type: 'SELFTEST_RESULT', requestId: message.requestId, ok, a, b });
}

function serializeWorkerError(error, requestId) {
  return {
    requestId: requestId || null,
    name: error?.name || 'Error',
    message: error?.message || String(error),
    stack: error?.stack || '',
  };
}
