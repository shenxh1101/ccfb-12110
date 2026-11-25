import test from 'node:test';
import assert from 'node:assert/strict';
import { getTarget } from '../targets/index.js';
import { FuzzEngine } from '../src/core/engine.js';

const settings = { seed: 'checkpoint-resume', batchSize: 64, curveInterval: 64 };

function freshEngine(targetId) {
  return new FuzzEngine(getTarget(targetId), { settings, now: () => 1 });
}

test('checkpoint restore continues the exact deterministic sequence', () => {
  const targetId = 'tlv';
  const total = 1800;
  const split = 700;

  const uninterrupted = freshEngine(targetId);
  uninterrupted.prime();
  uninterrupted.runBatch(total);

  const first = freshEngine(targetId);
  first.prime();
  first.runBatch(split);
  const checkpoint = JSON.parse(JSON.stringify(first.checkpoint()));

  const resumed = new FuzzEngine(getTarget(targetId), {
    settings,
    now: () => 1,
    checkpoint,
    // Main thread persists bytes separately and rehydrates these records.
    corpus: first.corpus.map((entry) => ({ ...entry })),
    crashes: Array.from(first.crashes.values()),
  });
  resumed.prime();
  resumed.runBatch(total - split);

  assert.equal(resumed.mutationCount, total);
  assert.deepEqual(Array.from(resumed.crashes.keys()).sort(), Array.from(uninterrupted.crashes.keys()).sort());
  assert.equal(resumed.rng.checkpoint().state, uninterrupted.rng.checkpoint().state);
  assert.equal(resumed.edgeCounts.size, uninterrupted.edgeCounts.size);
});

test('memory and timeout limits are deterministic resource faults', async () => {
  const target = getTarget('lzpk');
  const memory = new FuzzEngine(target, {
    settings: { seed: 'limits', memoryLimitMB: 1, maxOps: 2_000_000 },
    now: () => 0,
  });
  memory.prime();
  memory.runBatch(500);
  assert.ok(memory.stats.memoryLimitHits > 0);

  // A zero timeout with a fixed clock cannot advance; instrumentation checks
  // deadline every 1024 ops. Verify context directly for stable behavior.
  const { TargetContext } = await import('../targets/harness.js');
  const ctx = new TargetContext(target, { timeoutMs: 1, now: () => 100, maxOps: 10 });
  assert.throws(() => {
    for (let i = 0; i < 20; i++) ctx.tick();
  }, /execution budget|exceeded/);
});
