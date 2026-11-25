import { concatBytes, cloneBytes } from './bytes.js';

export const MUTATORS = [
  { id: 'bitflip', name: '位翻转', description: '确定性翻转 1/2/4 个比特，适合发现长度、标签和标志位判断错误。' },
  { id: 'integer-boundary', name: '整数边界', description: '把 u8/u16/u32 字段替换为 0、1、0x7f/0x80、0xff、2^15、2^31-1、0xffffffff 等边界值。' },
  { id: 'block-splice', name: '块拼接', description: '在当前样本和语料库 donor 之间替换、插入或拼接字节块。' },
  { id: 'grammar-structure', name: '语法结构变异', description: '利用靶子声明的 grammar 和运行时 span/node，删除或复制完整 Record/chunk/命令，并改写字段。' },
];

const BOUNDARIES = {
  1: [0x00, 0x01, 0x02, 0x7f, 0x80, 0xfe, 0xff],
  2: [0x0000, 0x0001, 0x007f, 0x0080, 0x00ff, 0x0100, 0x7fff, 0x8000, 0xfffe, 0xffff],
  4: [
    0x00000000, 0x00000001, 0x0000007f, 0x00000080, 0x000000ff,
    0x00000100, 0x0000ffff, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff,
  ],
};

function putInt(bytes, offset, width, value, littleEndian = true) {
  const out = cloneBytes(bytes);
  let v = Number(value) >>> 0;
  for (let i = 0; i < width; i++) {
    const shift = littleEndian ? i * 8 : (width - 1 - i) * 8;
    out[offset + i] = (v >>> shift) & 0xff;
  }
  return out;
}

function validRange(bytes, start, end) {
  return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= bytes.length;
}

function bitFlip(rng, bytes) {
  if (bytes.length === 0) return new Uint8Array([rng.int(0, 255)]);
  const out = cloneBytes(bytes);
  const flips = rng.pick([1, 1, 1, 2, 4]);
  for (let i = 0; i < flips; i++) {
    const index = rng.int(0, out.length - 1);
    const bit = rng.int(0, 7);
    out[index] ^= 1 << bit;
  }
  return out;
}

function integerBoundary(rng, bytes, context = {}) {
  const integerSpans = (context.shape?.spans || []).filter((span) => {
    const width = span.type === 'u8' ? 1 : span.type === 'u16' ? 2 : span.type === 'u32' ? 4 : span.end - span.start;
    return [1, 2, 4].includes(width) && validRange(bytes, span.start, span.end) && span.end - span.start === width;
  });

  if (integerSpans.length > 0 && rng.bool(0.82)) {
    const span = rng.pick(integerSpans);
    const width = span.type === 'u8' ? 1 : span.type === 'u16' ? 2 : span.type === 'u32' ? 4 : span.end - span.start;
    let choices = BOUNDARIES[width];
    if (Array.isArray(span.values) && span.values.length) choices = span.values;
    if (span.enum && typeof span.enum === 'object') {
      const enumValues = Array.isArray(span.enum) ? span.enum : Object.values(span.enum);
      if (enumValues.length) choices = enumValues;
    }
    const value = rng.pick(choices);
    return putInt(bytes, span.start, width, value, true);
  }

  if (bytes.length === 0) return new Uint8Array([rng.pick(BOUNDARIES[1])]);
  const widths = [1, 1, 2, 4].filter((w) => w <= bytes.length);
  const width = rng.pick(widths);
  const offset = rng.int(0, bytes.length - width);
  return putInt(bytes, offset, width, rng.pick(BOUNDARIES[width]), true);
}

function blockSplice(rng, bytes, context = {}) {
  const corpus = context.corpus || [];
  const donorEntry = corpus.length ? rng.pick(corpus) : { bytes };
  const donor = donorEntry.bytes || donorEntry.data || bytes;
  if (!donor || donor.length === 0 || bytes.length === 0) {
    return concatBytes(bytes, new Uint8Array([rng.int(0, 255)]));
  }

  const mode = rng.int(0, 2);
  if (mode === 0) {
    const maxBlock = Math.min(48, bytes.length, donor.length);
    const blockLength = rng.int(1, maxBlock);
    const targetOffset = rng.int(0, bytes.length - blockLength);
    const donorOffset = rng.int(0, donor.length - blockLength);
    const out = cloneBytes(bytes);
    out.set(donor.subarray(donorOffset, donorOffset + blockLength), targetOffset);
    return out;
  }

  if (mode === 1) {
    const cutA = rng.int(0, bytes.length);
    const cutB = rng.int(0, donor.length);
    const out = concatBytes(bytes.subarray(0, cutA), donor.subarray(cutB));
    return out.length > 8192 ? out.subarray(0, 8192) : out;
  }

  const maxBlock = Math.min(64, donor.length);
  const blockLength = rng.int(1, maxBlock);
  const donorOffset = rng.int(0, donor.length - blockLength);
  const at = rng.int(0, bytes.length);
  const out = concatBytes(
    bytes.subarray(0, at),
    donor.subarray(donorOffset, donorOffset + blockLength),
    bytes.subarray(at),
  );
  return out.length > 8192 ? out.subarray(0, 8192) : out;
}

function enumChoices(span) {
  if (Array.isArray(span.values) && span.values.length) return span.values;
  if (span.enum && typeof span.enum === 'object') {
    return Array.isArray(span.enum) ? span.enum : Object.values(span.enum);
  }
  return null;
}

function grammarStructure(rng, bytes, context = {}) {
  const nodes = (context.shape?.nodes || []).filter((node) =>
    validRange(bytes, node.start, node.end) && node.end - node.start < bytes.length,
  );
  const numericSpans = (context.shape?.spans || []).filter((span) => {
    const width = span.end - span.start;
    return [1, 2, 4].includes(width) && validRange(bytes, span.start, span.end);
  });

  if (nodes.length > 0 && (numericSpans.length === 0 || rng.bool(0.68))) {
    const node = rng.pick(nodes);
    const operation = rng.pick(['duplicate', 'duplicate', 'delete']);
    const block = bytes.subarray(node.start, node.end);

    if (operation === 'delete' && bytes.length - block.length > 0) {
      return concatBytes(bytes.subarray(0, node.start), bytes.subarray(node.end));
    }

    // Duplicate immediately after the selected syntax node.
    return concatBytes(
      bytes.subarray(0, node.end),
      block,
      bytes.subarray(node.end),
    );
  }

  if (numericSpans.length > 0) {
    const span = rng.pick(numericSpans);
    const width = span.end - span.start;
    const choices = enumChoices(span) || BOUNDARIES[width] || BOUNDARIES[1];
    return putInt(bytes, span.start, width, rng.pick(choices), true);
  }

  // Declarative fallback: mutate a tag/length-like byte while preserving magic.
  const start = Math.min(4, bytes.length - 1);
  if (bytes.length > start) {
    const out = cloneBytes(bytes);
    out[rng.int(start, out.length - 1)] = rng.pick(BOUNDARIES[1]);
    return out;
  }
  return bitFlip(rng, bytes);
}

const IMPLEMENTATIONS = {
  bitflip: bitFlip,
  'integer-boundary': integerBoundary,
  'block-splice': blockSplice,
  'grammar-structure': grammarStructure,
};

export function mutate(mutatorId, rng, bytes, context = {}) {
  const fn = IMPLEMENTATIONS[mutatorId];
  if (!fn) throw new RangeError(`unknown mutator: ${mutatorId}`);
  return fn(rng, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []), context);
}

export function chooseMutator(rng, weights) {
  const ids = MUTATORS.map((m) => m.id);
  const w = ids.map((id) => Math.max(0, Number(weights?.[id] ?? 1)));
  return ids[rng.weightedIndex(w)];
}
