import { cyrb53 } from './hash.js';

// Normalize JS stack frames so query strings, blob URLs and line/column churn
// do not split one root cause into several crashes.
export function normalizeJsStack(stack, limit = 8) {
  if (!stack) return [];
  return String(stack)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at ') || line.includes('@'))
    .map((line) => {
      let text = line.replace(/^at\s+/, '');
      const atIndex = text.lastIndexOf(' (');
      let fn = '';
      let location = text;
      if (atIndex >= 0 && text.endsWith(')')) {
        fn = text.slice(0, atIndex);
        location = text.slice(atIndex + 2, -1);
      } else {
        const nativeAt = text.indexOf('@');
        if (nativeAt >= 0) {
          fn = text.slice(0, nativeAt);
          location = text.slice(nativeAt + 1);
        }
      }
      location = location
        .replace(/[?#].*$/, '')
        .replace(/^blob:[^/]+\//, '')
        .replace(/^https?:\/\/[^/]+\//, '')
        .replace(/^file:\/\//, '');
      // Keep source file and function, drop exact line/column for root-cause ID.
      location = location.replace(/:\d+:\d+$/, '');
      return { fn: fn || '<anonymous>', location };
    })
    .filter((frame) => frame.location && !frame.location.includes('node:internal'))
    .slice(0, limit);
}

export function buildFingerprint(target, errorInfo) {
  const declaredFrames = Array.isArray(errorInfo?.frames) ? errorInfo.frames : [];
  const jsFrames = normalizeJsStack(errorInfo?.stack).map((f) => `${f.fn}@${f.location}`);
  const hasDeclaredStack = declaredFrames.length > 0;
  const normalizedFrames = hasDeclaredStack
    ? declaredFrames.slice(0, 6).map((frame) => String(frame))
    : jsFrames.slice(0, 5);

  // The fingerprint is deliberately stack-first. A stable site label is only
  // a fallback for unexpected errors without target-declared stack frames;
  // otherwise adjacent distance checks in decodeMatch would be split although
  // they share one missing-validation root cause.
  const material = hasDeclaredStack
    ? [target?.id || 'unknown-target', errorInfo?.kind || errorInfo?.name || 'Error', ...normalizedFrames.slice(0, 5)].join('\n')
    : [
        target?.id || 'unknown-target',
        errorInfo?.kind || errorInfo?.name || 'Error',
        errorInfo?.site || normalizedFrames[0] || 'unknown-site',
        ...normalizedFrames.slice(0, 4),
      ].join('\n');

  return {
    fingerprint: `fp_${cyrb53(material)}`,
    material,
    frames: normalizedFrames,
    jsFrames,
  };
}

export function crashTitle(errorInfo) {
  if (!errorInfo) return 'unknown crash';
  if (errorInfo.kind === 'oob-read') {
    const access = errorInfo.access || {};
    return `越界读 @ ${errorInfo.site || errorInfo.frames?.[0] || 'unknown'} (offset ${access.offset ?? '?'}, length ${access.bufferLength ?? '?'})`;
  }
  return `${errorInfo.kind || errorInfo.name || 'Error'}: ${errorInfo.message || ''}`.slice(0, 180);
}
