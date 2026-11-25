import { getTarget, listTargets } from '../targets/index.js';
import { FuzzEngine } from '../src/core/engine.js';
import { minimizeCrashSync } from '../src/core/minimizer.js';
import { bytesToHex } from '../src/core/bytes.js';

const iterations = Number(process.argv[2]) || 3000;
const only = process.argv[3];

for (const target of listTargets()) {
  if (only && target.id !== only) continue;
  const engine = new FuzzEngine(getTarget(target.id), {
    now: () => 1700000000000,
    settings: { seed: 'roll5-deterministic', batchSize: 128, curveInterval: 128 },
  });
  engine.prime();
  let left = iterations;
  while (left > 0) {
    const n = Math.min(128, left);
    engine.runBatch(n);
    left -= n;
  }
  console.log(`\n=== ${target.id} ===`);
  console.log('stats', engine.stats);
  console.log('edges', engine.edgeCounts.size, 'corpus', engine.corpus.length, 'crashes', engine.crashes.size);
  for (const crash of engine.crashes.values()) {
    const min = minimizeCrashSync(target, crash.sample, crash.fingerprint, {
      timeoutMs: 1000,
      maxMemoryBytes: 64 * 1024 * 1024,
      maxOps: 2_000_000,
    });
    console.log('\n', crash.fingerprint, crash.kind, 'count', crash.count);
    console.log(' title:', crash.title);
    console.log(' frames:', crash.frames.join(' <- '));
    console.log(' sample', crash.size, bytesToHex(crash.sample));
    console.log(' min', min.ok, min.minimizedSize, bytesToHex(min.bytes));
  }
}
