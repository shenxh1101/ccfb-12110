import { Reader, magicEquals, TruncatedInput } from './harness.js';

const MAGIC = 'IMG1';
const CHUNK_THUMBNAIL = 0xdb;
const CHUNK_PALETTE = 0x50;

function parse(input, ctx) {
  ctx.edge('image.start');
  if (input.length < 14) throw new TruncatedInput('IMG1 header is shorter than 14 bytes');
  if (!magicEquals(input, MAGIC)) {
    ctx.edge('image.magic.reject');
    throw new TruncatedInput('bad IMG1 magic');
  }
  ctx.edge('image.magic.ok');

  const reader = new Reader(input, ctx, 'image');
  reader.skip(4);
  const width = reader.u16le();
  const height = reader.u16le();
  const bpp = reader.u8();
  const flags = reader.u8();
  const pixelOffset = reader.u32le();

  ctx.span('width', 4, 6, 'u16', { value: width });
  ctx.span('height', 6, 8, 'u16', { value: height });
  ctx.span('bpp', 8, 9, 'u8', { value: bpp, values: [1, 2, 4, 8, 16, 24, 32] });
  ctx.span('flags', 9, 10, 'u8', { value: flags });
  ctx.span('pixel-offset', 10, 14, 'u32', { value: pixelOffset });

  if (![1, 2, 4, 8, 16, 24, 32].includes(bpp)) ctx.edge('image.bpp.nonstandard');
  else ctx.edge('image.bpp.standard');

  if (flags & 0x01) {
    ctx.edge('image.probe-last-pixel');
    const bytesPerPixel = Math.max(1, (bpp + 7) >> 3);
    const rawStride = width * bytesPerPixel;
    const stride = (rawStride + 3) & ~3;
    // Meter only one aligned row; do not allocate height * stride here.
    ctx.alloc(stride, 'aligned-scanline');
    const lastRowBytes = Math.imul(Math.max(0, height - 1), stride) >>> 0;
    const sampleOffset = (pixelOffset + lastRowBytes + Math.max(0, stride - 1)) >>> 0;
    ctx.span('last-pixel-probe', sampleOffset, sampleOffset + 1, 'pointer', {
      width,
      height,
      stride,
      sampleOffset,
    });
    // BUG #image-last-pixel: dimensions and pixelOffset are used to probe the
    // final pixel without checking sampleOffset against input.byteLength.
    reader.unsafeU8At(
      sampleOffset,
      ['readLastPixelProbe', 'parseImgHeader', 'parseImage'],
      'image.last-pixel.probe-offset',
    );
  }

  if (reader.offset >= input.length) {
    ctx.edge('image.no-chunk-table');
    ctx.edge('image.done');
    return { width, height, bpp, flags, pixelOffset, chunks: 0 };
  }

  ctx.edge('image.chunk-table');
  const chunkCount = reader.u8();
  ctx.span('chunk-count', 14, 15, 'u8', { value: chunkCount });
  const safeCount = Math.min(chunkCount, 16);
  const chunks = [];

  for (let i = 0; i < safeCount; i++) {
    ctx.edge('image.chunk');
    const chunkStart = reader.offset;
    const type = reader.u8();
    const offset = reader.u32le();
    const length = reader.u16le();
    const chunkEnd = reader.offset;
    chunks.push({ type, offset, length });
    ctx.span(`chunk-${i}-length`, chunkEnd - 2, chunkEnd, 'u16', { value: length, lengthField: true });
    ctx.span(`chunk-${i}-header`, chunkStart, chunkEnd, 'image-chunk-header', { type, offset, length });
    ctx.node('image-chunk', chunkStart, chunkEnd, { type, offset, length });

    if (type === CHUNK_THUMBNAIL) {
      ctx.edge('image.chunk.thumbnail');
      const guardOffset = (offset + length) >>> 0;
      // BUG #image-chunk-guard: the 6-byte chunk header is validated, but the
      // guard word after offset+length is read through the unchecked pointer.
      ctx.edge('image.chunk.guard-read');
      reader.unsafeU32LeAt(
        guardOffset,
        ['readChunkGuardWord', 'parseChunkTable', 'parseImgHeader', 'parseImage'],
        'image.chunk.guard-u32',
      );
    } else if (type === CHUNK_PALETTE) {
      ctx.edge('image.chunk.palette');
      // Palette path is intentionally safe and gives coverage-guided mutation
      // a different branch to preserve.
      if (offset < input.length && length <= input.length - offset) {
        reader.input.subarray(offset, offset + Math.min(length, 16));
      }
    } else {
      ctx.edge('image.chunk.unknown');
    }
  }

  ctx.edge('image.done');
  return { width, height, bpp, flags, pixelOffset, chunks };
}

const seeds = [
  {
    name: 'one-by-one-img1.img',
    bytes: new Uint8Array([
      0x49, 0x4d, 0x47, 0x31,
      0x01, 0x00, 0x01, 0x00,
      0x08, 0x01,
      0x0e, 0x00, 0x00, 0x00,
      0x01,
      CHUNK_THUMBNAIL,
      0x18, 0x00, 0x00, 0x00,
      0x00, 0x00,
      0x00, 0x00,
      0xde, 0xad, 0xbe, 0xef,
    ]),
  },
  {
    name: 'vga-nochunks.img',
    bytes: new Uint8Array([
      0x49, 0x4d, 0x47, 0x31,
      0x40, 0x01, 0xe0, 0x01,
      0x18, 0x00,
      0x20, 0x00, 0x00, 0x00,
    ]),
  },
  {
    name: 'palette-chunk.img',
    bytes: new Uint8Array([
      0x49, 0x4d, 0x47, 0x31,
      0x10, 0x00, 0x10, 0x00,
      0x08, 0x00,
      0x0f, 0x00, 0x00, 0x00,
      0x01,
      CHUNK_PALETTE,
      0x20, 0x00, 0x00, 0x00,
      0x06, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0xff, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00, 0xff,
    ]),
  },
];

export const imageHeaderTarget = {
  id: 'image-header',
  name: 'IMG1 图片头',
  version: '1.4.0',
  kind: 'image',
  description: '小端 IMG1 头、对齐 stride 计算和 chunk 表。边界宽高/偏移可触发末像素探针与 chunk guard 越界读。',
  file: 'targets/image-header.js',
  magic: MAGIC,
  grammar: {
    root: 'ImageHeader',
    byteOrder: 'little-endian',
    rules: [
      {
        id: 'ImageHeader',
        kind: 'seq',
        fields: [
          { name: 'magic', type: 'const', size: 4, value: MAGIC },
          { name: 'width', type: 'u16' },
          { name: 'height', type: 'u16' },
          { name: 'bpp', type: 'u8', values: [1, 2, 4, 8, 16, 24, 32] },
          { name: 'flags', type: 'u8', bits: { probeLastPixel: 0x01 } },
          { name: 'pixelOffset', type: 'u32' },
          { name: 'chunkCount', type: 'u8', optional: true },
          { name: 'chunks', type: 'repeat', node: 'ImageChunk', countFrom: 'chunkCount' },
        ],
      },
      {
        id: 'ImageChunk',
        kind: 'seq',
        fields: [
          { name: 'type', type: 'u8', enum: { thumbnail: CHUNK_THUMBNAIL, palette: CHUNK_PALETTE } },
          { name: 'offset', type: 'u32' },
          { name: 'length', type: 'u16' },
        ],
      },
    ],
    structuralNodes: ['image-chunk'],
  },
  instrumentation: [
    { id: 'image.magic.ok', label: '图片魔数正确', kind: 'branch' },
    { id: 'image.probe-last-pixel', label: '计算并访问末像素', kind: 'branch' },
    { id: 'image.last-pixel.probe-offset', label: '末像素偏移解引用（漏洞点）', kind: 'oob-site' },
    { id: 'image.chunk-table', label: '进入 chunk 表', kind: 'edge' },
    { id: 'image.chunk.thumbnail', label: '缩略图 chunk', kind: 'branch' },
    { id: 'image.chunk.guard-u32', label: '读取 chunk guard（漏洞点）', kind: 'oob-site' },
  ],
  edges: [
    { id: 'image.start', from: 'entry', to: 'magic', label: '开始' },
    { id: 'image.magic.ok', from: 'magic', to: 'header', label: '魔数正确' },
    { id: 'image.magic.reject', from: 'magic', to: 'reject', label: '魔数错误' },
    { id: 'image.bpp.standard', from: 'bpp', to: 'standard', label: '标准位深' },
    { id: 'image.bpp.nonstandard', from: 'bpp', to: 'nonstandard', label: '非标准位深' },
    { id: 'image.probe-last-pixel', from: 'flags', to: 'last-pixel', label: '启用末像素探针' },
    { id: 'image.chunk-table', from: 'header', to: 'chunks', label: 'chunk 表' },
    { id: 'image.no-chunk-table', from: 'header', to: 'pixels', label: '无 chunk 表' },
    { id: 'image.chunk', from: 'chunk-loop', to: 'chunk', label: '下一个 chunk' },
    { id: 'image.chunk.thumbnail', from: 'type', to: 'thumbnail', label: '缩略图' },
    { id: 'image.chunk.guard-read', from: 'thumbnail', to: 'guard', label: '读取 guard' },
    { id: 'image.chunk.palette', from: 'type', to: 'palette', label: '调色板' },
    { id: 'image.chunk.unknown', from: 'type', to: 'unknown', label: '未知 chunk' },
    { id: 'image.done', from: 'parse', to: 'exit', label: '完成' },
  ],
  seeds,
  parse,
};
