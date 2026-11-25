// Byte helpers shared by UI, persistence, mutators and tests.

export function bytesToBase64(bytes) {
  const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < value.length; i += chunkSize) {
    binary += String.fromCharCode(...value.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function base64ToBytes(base64) {
  const binary = atob(String(base64 || ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToHex(bytes, separator = ' ') {
  return Array.from(bytes || [])
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(separator);
}

export function hexToBytes(hex) {
  const clean = String(hex || '').replace(/0x/gi, '').replace(/[^0-9a-f]/gi, '');
  const aligned = clean.length % 2 ? `0${clean}` : clean;
  const out = new Uint8Array(aligned.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(aligned.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function concatBytes(...arrays) {
  const total = arrays.reduce((sum, arr) => sum + (arr?.length || 0), 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    if (!arr) continue;
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
}

export function cloneBytes(bytes) {
  return new Uint8Array(bytes || []);
}

export function equalBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function hashInputBytes(bytes, hashFn) {
  return hashFn(bytes);
}

export function hexDump(bytes, options = {}) {
  const width = options.width || 16;
  const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const lines = [];
  for (let offset = 0; offset < value.length; offset += width) {
    const slice = value.subarray(offset, Math.min(offset + width, value.length));
    const hex = Array.from(slice)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ');
    const paddedHex = hex.padEnd(width * 3 - 1, ' ');
    const ascii = Array.from(slice)
      .map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.'))
      .join('');
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${paddedHex}  |${ascii}|`);
  }
  return lines.join('\n');
}

export function formatBytes(size) {
  const n = Number(size) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}
