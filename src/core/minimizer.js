import { executeTarget } from './executor.js';
import { cloneBytes, concatBytes } from './bytes.js';

const SIMPLE_VALUES = [0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff];

function removeRange(bytes, start, end) {
  return concatBytes(bytes.subarray(0, start), bytes.subarray(end));
}

function patchInt(bytes, start, width, value) {
  const out = cloneBytes(bytes);
  for (let i = 0; i < width; i++) out[start + i] = (Number(value) >>> (8 * i)) & 0xff;
  return out;
}

const LENGTH_VALUES = [0, 1, 2, 3, 4, 5, 8, 12, 16, 24, 32, 64, 127, 128, 255, 256, 1024, 65535];

export async function minimizeCrash(target, originalBytes, expectedFingerprint, options = {}) {
  const limitOptions = options.limits || options;
  const maxChecks = options.maxChecks ?? 900;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const shouldYield = options.yield !== false;
  const yieldFn = options.yieldFn || (() => new Promise((resolve) => setTimeout(resolve, 0)));

  let current = cloneBytes(originalBytes);
  let checks = 0;
  let removedBytes = 0;
  const steps = [];

  const verify = (candidate) => {
    checks++;
    const result = executeTarget(target, candidate, limitOptions);
    return Boolean(result.crash && result.fingerprint === expectedFingerprint);
  };

  const report = (phase) => {
    onProgress?.({ phase, size: current.length, checks, removedBytes });
  };

  report('verify-original');
  const initial = executeTarget(target, current, limitOptions);
  checks++;
  if (!initial.crash || initial.fingerprint !== expectedFingerprint) {
    return {
      ok: false,
      reason: 'original sample did not reproduce the expected fingerprint',
      result: initial,
      checks,
    };
  }

  const lengthAwarePass = () => {
    const probe = executeTarget(target, current, limitOptions);
    checks++;
    const lengthSpans = (probe.spans || []).filter(
      (span) => span.lengthField === true || /(^|-|_)length$/i.test(span.name || ''),
    );

    for (const span of lengthSpans) {
      const width = span.type === 'u8' ? 1 : span.type === 'u16' ? 2 : span.type === 'u32' ? 4 : span.end - span.start;
      if (![1, 2, 4].includes(width) || span.start < 0 || span.end > current.length) continue;

      for (const value of LENGTH_VALUES) {
        if (width === 1 && value > 0xff) continue;
        if (width === 2 && value > 0xffff) continue;
        const patched = patchInt(current, span.start, width, value);
        const contentEnd = span.end + value;
        for (const extra of [0, 1, 2, 3, 4, 5, 8, 12, 16]) {
          const truncateAt = Math.min(patched.length, Math.max(span.end, contentEnd + extra));
          const candidate = patched.subarray(0, truncateAt);
          if (verify(candidate)) {
            removedBytes += current.length - candidate.length;
            current = candidate.slice();
            steps.push({ type: 'coordinated-length', span: span.name, value, size: current.length });
            report('coordinated-length');
            return true;
          }
        }
      }
    }
    return false;
  };

  const removalPass = async () => {
    let changedAny = false;
    let granularity = Math.max(1, Math.floor(current.length / 2));
    while (granularity >= 1 && checks < maxChecks) {
      let changed = true;
      while (changed && checks < maxChecks) {
        changed = false;
        for (let start = 0; start < current.length; start += granularity) {
          const end = Math.min(current.length, start + granularity);
          const candidate = removeRange(current, start, end);
          if (candidate.length === current.length) continue;
          if (verify(candidate)) {
            removedBytes += current.length - candidate.length;
            current = candidate;
            changed = true;
            changedAny = true;
            steps.push({ type: 'remove-block', start, end, size: current.length });
            report('remove-block');
            break;
          }
          if (shouldYield && checks % 25 === 0) await yieldFn();
        }
        if (shouldYield && checks % 25 === 0) await yieldFn();
      }

      if (granularity === 1) break;
      granularity = Math.max(1, Math.floor(granularity / 2));
      steps.push({ type: 'granularity', granularity });
      report('granularity');
    }
    return changedAny;
  };

  const simplifyPass = async () => {
    let changedAny = false;
    // Changing a length/tag/integer field can unlock further deletion, so keep
    // this as one pass and let the caller run removal again afterwards.
    for (let index = 0; index < current.length && checks < maxChecks; index++) {
      const original = current[index];
      for (const value of SIMPLE_VALUES) {
        if (value === original) continue;
        const candidate = cloneBytes(current);
        candidate[index] = value;
        if (verify(candidate)) {
          current = candidate;
          changedAny = true;
          steps.push({ type: 'simplify-byte', index, value });
          report('simplify-byte');
          break;
        }
      }
      if (shouldYield && checks % 25 === 0) await yieldFn();
    }
    return changedAny;
  };

  // Alternate deletion and semantic byte normalization. A length field first
  // has to be simplified before its now-unreferenced trailing bytes can be
  // deleted, which a single ddmin-then-byte pass would miss.
  await removalPass();
  lengthAwarePass();
  await removalPass();
  for (let round = 0; round < 3 && checks < maxChecks; round++) {
    const simplified = await simplifyPass();
    const lengthChanged = lengthAwarePass();
    const removed = await removalPass();
    if (!simplified && !lengthChanged && !removed) break;
  }

  report('final-verify');
  const finalResult = executeTarget(target, current, limitOptions);
  checks++;
  const reproduced = Boolean(finalResult.crash && finalResult.fingerprint === expectedFingerprint);

  return {
    ok: reproduced,
    reproduced,
    fingerprint: finalResult.fingerprint,
    expectedFingerprint,
    bytes: current,
    originalSize: originalBytes.length,
    minimizedSize: current.length,
    removedBytes: originalBytes.length - current.length,
    reductionRatio: originalBytes.length ? current.length / originalBytes.length : 1,
    checks,
    steps: steps.length,
    result: finalResult,
    truncatedByCheckBudget: checks >= maxChecks,
  };
}

// Synchronous convenience for tests and non-UI callers.
export function minimizeCrashSync(target, originalBytes, expectedFingerprint, options = {}) {
  let current = cloneBytes(originalBytes);
  const maxChecks = options.maxChecks ?? 2000;
  let checks = 0;
  const verify = (candidate) => {
    checks++;
    const result = executeTarget(target, candidate, options);
    return Boolean(result.crash && result.fingerprint === expectedFingerprint);
  };
  if (!verify(current)) return { ok: false, checks };

  const lengthAwarePass = () => {
    const probe = executeTarget(target, current, options);
    checks++;
    const lengthSpans = (probe.spans || []).filter(
      (span) => span.lengthField === true || /(^|-|_)length$/i.test(span.name || ''),
    );
    for (const span of lengthSpans) {
      const width = span.type === 'u8' ? 1 : span.type === 'u16' ? 2 : span.type === 'u32' ? 4 : span.end - span.start;
      if (![1, 2, 4].includes(width)) continue;
      for (const value of LENGTH_VALUES) {
        if (width === 1 && value > 0xff) continue;
        if (width === 2 && value > 0xffff) continue;
        const patched = patchInt(current, span.start, width, value);
        for (const extra of [0, 1, 2, 3, 4, 5, 8, 12, 16]) {
          const truncateAt = Math.min(patched.length, Math.max(span.end, span.end + value + extra));
          if (verify(patched.subarray(0, truncateAt))) {
            current = patched.subarray(0, truncateAt).slice();
            return true;
          }
        }
      }
    }
    return false;
  };

  const removalPass = () => {
    let changedAny = false;
    let granularity = Math.max(1, Math.floor(current.length / 2));
    while (granularity >= 1 && checks < maxChecks) {
      let changed = true;
      while (changed) {
        changed = false;
        for (let start = 0; start < current.length; start += granularity) {
          const candidate = removeRange(current, start, Math.min(current.length, start + granularity));
          if (verify(candidate)) {
            current = candidate;
            changed = true;
            changedAny = true;
            break;
          }
        }
      }
      if (granularity === 1) break;
      granularity = Math.max(1, Math.floor(granularity / 2));
    }
    return changedAny;
  };

  const simplifyPass = () => {
    let changedAny = false;
    for (let index = 0; index < current.length; index++) {
      for (const value of SIMPLE_VALUES) {
        if (value === current[index]) continue;
        const candidate = cloneBytes(current);
        candidate[index] = value;
        if (verify(candidate)) {
          current = candidate;
          changedAny = true;
          break;
        }
      }
    }
    return changedAny;
  };

  removalPass();
  lengthAwarePass();
  removalPass();
  for (let round = 0; round < 3 && checks < maxChecks; round++) {
    const simplified = simplifyPass();
    const lengthChanged = lengthAwarePass();
    const removed = removalPass();
    if (!simplified && !lengthChanged && !removed) break;
  }

  const result = executeTarget(target, current, options);
  return {
    ok: result.crash && result.fingerprint === expectedFingerprint,
    bytes: current,
    minimizedSize: current.length,
    originalSize: originalBytes.length,
    checks,
    result,
  };
}
