import test from 'node:test';
import assert from 'node:assert/strict';

import { listTargets, getTarget } from '../targets/index.js';
import { FuzzEngine } from '../src/core/engine.js';
import { minimizeCrashSync } from '../src/core/minimizer.js';

function runDeterministic(targetId, iterations = 2500) {
  const target = getTarget(targetId);
  const engine = new FuzzEngine(target, {
    now: () => 1700000000000,
    settings: {
      seed: 'test-seed-roll5',
      batchSize: 128,
      curveInterval: 128,
      timeoutMs: 1000,
      memoryLimitMB: 64,
    },
  });
  engine.prime();
  let remaining = iterations;
  while (remaining > 0) {
    const n = Math.min(128, remaining);
    engine.runBatch(n);
    remaining -= n;
  }
  return engine;
}

test('registry exposes three instrumented targets', () => {
  const ids = listTargets().map((t) => t.id).sort();
  assert.deepEqual(ids, ['image-header', 'lzpk', 'tlv']);
  for (const target of listTargets()) {
    assert.ok(target.grammar.rules.length > 0);
    assert.ok(target.instrumentation.length > 0);
    assert.ok(target.edges.length > 0);
    assert.ok(target.seeds.length > 0);
  }
});

for (const targetId of ['tlv', 'image-header', 'lzpk']) {
  test(`${targetId}: same seed produces the same crash fingerprint set`, () => {
    const a = runDeterministic(targetId);
    const b = runDeterministic(targetId);
    const fpsA = Array.from(a.crashes.keys()).sort();
    const fpsB = Array.from(b.crashes.keys()).sort();
    assert.ok(fpsA.length >= 1, `expected at least one crash, got stats ${JSON.stringify(a.stats)}`);
    assert.deepEqual(fpsB, fpsA);

    const countsA = fpsA.map((fp) => a.crashes.get(fp).count);
    const countsB = fpsB.map((fp) => b.crashes.get(fp).count);
    assert.deepEqual(countsB, countsA);
    assert.equal(a.rng.checkpoint().state, b.rng.checkpoint().state);
  });

  test(`${targetId}: every crash minimizes and replays the same fingerprint`, () => {
    const engine = runDeterministic(targetId, 1800);
    assert.ok(engine.crashes.size >= 1);
    for (const crash of engine.crashes.values()) {
      const minimized = minimizeCrashSync(getTarget(targetId), crash.sample, crash.fingerprint, {
        timeoutMs: 1000,
        maxMemoryBytes: 64 * 1024 * 1024,
        maxOps: 2_000_000,
        maxChecks: 1200,
      });
      assert.equal(minimized.ok, true, `minimization failed for ${crash.fingerprint}`);
      assert.equal(minimized.result.fingerprint, crash.fingerprint);
      assert.ok(minimized.bytes.length <= crash.sample.length);
    }
  });
}
