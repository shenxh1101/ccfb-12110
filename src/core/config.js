export const DEFAULT_SETTINGS = Object.freeze({
  seed: 'roll5-deterministic',
  batchSize: 64,
  maxIterations: 0, // 0 means run until paused.
  timeoutMs: 250,
  memoryLimitMB: 64,
  maxOps: 2_000_000,
  maxInputBytes: 8192,
  maxCorpus: 600,
  curveInterval: 64,
  mutatorWeights: Object.freeze({
    bitflip: 3,
    'integer-boundary': 4,
    'block-splice': 2,
    'grammar-structure': 5,
  }),
  scheduler: Object.freeze({
    noveltyWeight: 8,
    edgeWeight: 0.35,
    useCountPenalty: 0.18,
  }),
});

export function normalizeSettings(input = {}) {
  const merged = {
    ...DEFAULT_SETTINGS,
    ...input,
    mutatorWeights: {
      ...DEFAULT_SETTINGS.mutatorWeights,
      ...(input.mutatorWeights || {}),
    },
    scheduler: {
      ...DEFAULT_SETTINGS.scheduler,
      ...(input.scheduler || {}),
    },
  };
  merged.batchSize = clampInt(merged.batchSize, 1, 1024, 64);
  merged.maxIterations = clampInt(merged.maxIterations, 0, 10_000_000, 0);
  merged.timeoutMs = clampInt(merged.timeoutMs, 1, 30_000, 250);
  merged.memoryLimitMB = clampInt(merged.memoryLimitMB, 1, 1024, 64);
  merged.maxOps = clampInt(merged.maxOps, 1000, 100_000_000, 2_000_000);
  merged.maxInputBytes = clampInt(merged.maxInputBytes, 64, 1024 * 1024, 8192);
  merged.maxCorpus = clampInt(merged.maxCorpus, 10, 10000, 600);
  merged.curveInterval = clampInt(merged.curveInterval, 1, 10000, 64);
  return merged;
}

function clampInt(value, min, max, fallback) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function executorLimits(settings) {
  return {
    timeoutMs: settings.timeoutMs,
    maxMemoryBytes: Math.floor(settings.memoryLimitMB * 1024 * 1024),
    maxOps: settings.maxOps,
  };
}
