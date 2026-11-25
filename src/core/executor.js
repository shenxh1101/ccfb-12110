import { TargetContext, TargetFault, ResourceLimitError, TruncatedInput } from '../../targets/harness.js';
import { buildFingerprint, crashTitle } from './fingerprint.js';

// Execute one input exactly once. This module is isomorphic: used by the
// Web Worker in the browser and by deterministic Node tests.
export function executeTarget(target, input, options = {}) {
  if (!target || typeof target.parse !== 'function') {
    throw new TypeError('target must expose a parse(Uint8Array, TargetContext) function');
  }
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || []);
  const ctx = new TargetContext(target, options);
  const started = ctx.now();

  try {
    target.parse(bytes, ctx);
    const durationMs = Math.max(0, ctx.now() - started);
    return {
      ok: true,
      crash: false,
      resource: null,
      targetId: target.id,
      durationMs,
      operations: ctx.operations,
      memoryPeak: ctx.peakMemory,
      edges: ctx.coverageEntries().filter((e) => e.count > 0),
      spans: ctx.spans,
      nodes: ctx.nodes,
      logs: ctx.logs,
    };
  } catch (error) {
    const durationMs = Math.max(0, ctx.now() - started);
    const edges = ctx.coverageEntries().filter((e) => e.count > 0);
    const common = {
      targetId: target.id,
      durationMs,
      operations: ctx.operations,
      memoryPeak: ctx.peakMemory,
      edges,
      spans: ctx.spans,
      nodes: ctx.nodes,
      logs: ctx.logs,
    };

    if (error instanceof TruncatedInput) {
      return { ...common, ok: false, crash: false, resource: null, rejected: true, error: serializeError(error) };
    }

    if (error instanceof ResourceLimitError) {
      return {
        ...common,
        ok: false,
        crash: false,
        resource: error.code,
        rejected: false,
        error: serializeError(error),
      };
    }

    // TargetFault and unexpected runtime errors are both crashes. Unexpected
    // TypeErrors usually mean the parser itself indexed undefined / bad state.
    const errorInfo = {
      name: error?.name || 'Error',
      kind: error instanceof TargetFault ? error.kind : `uncaught-${error?.name || 'Error'}`,
      message: error?.message || String(error),
      site: error?.site || null,
      frames: error?.frames || [],
      access: error?.access || null,
      stack: error?.stack || '',
    };
    const fp = buildFingerprint(target, { ...errorInfo, stack: error.stack });
    return {
      ...common,
      ok: false,
      crash: true,
      resource: null,
      fingerprint: fp.fingerprint,
      fingerprintMaterial: fp.material,
      fingerprintFrames: fp.frames,
      title: crashTitle(errorInfo),
      error: serializeError(error),
    };
  }
}

function serializeError(error) {
  return {
    name: error?.name || 'Error',
    kind: error?.kind || null,
    code: error?.code || null,
    message: error?.message || String(error),
    stack: error?.stack || '',
    site: error?.site || null,
    frames: error?.frames || [],
    access: error?.access || null,
    details: error?.faultDetails || error?.details || null,
  };
}
