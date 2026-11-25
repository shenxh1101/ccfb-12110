import { Reader, magicEquals, TruncatedInput, ResourceLimitError } from './harness.js';

const MAGIC = 'LZPK';
const END = 0xff;
const STATIC_DICTIONARY = new TextEncoder().encode('roll5-dictionary|tlv-img-lz|0123456789abcdef');

function emit(output, state, value, maxOutput) {
  if (state.outPos >= output.length) {
    throw new ResourceLimitError('output-budget-exceeded', 'decompressed output exceeded declared maxOutput', {
      outPos: state.outPos,
      maxOutput,
    });
  }
  output[state.outPos++] = value & 0xff;
}

function parse(input, ctx) {
  ctx.edge('lz.start');
  if (input.length < 10) throw new TruncatedInput('LZPK header is shorter than 10 bytes');
  if (!magicEquals(input, MAGIC)) {
    ctx.edge('lz.magic.reject');
    throw new TruncatedInput('bad LZPK magic');
  }
  ctx.edge('lz.magic.ok');

  const reader = new Reader(input, ctx, 'lz');
  reader.skip(4);
  const version = reader.u8();
  const flags = reader.u8();
  const maxOutput = reader.u32le();
  ctx.span('version', 4, 5, 'u8', { value: version });
  ctx.span('flags', 5, 6, 'u8', { value: flags });
  ctx.span('max-output', 6, 10, 'u32', { value: maxOutput });

  // The metered allocator rejects 0xffffffff before a giant Uint8Array exists.
  const output = ctx.allocBytes(maxOutput, 'decompressed-output');
  const state = { outPos: 0 };
  let commands = 0;

  while (!reader.eof() && commands < 128) {
    ctx.edge('lz.command');
    const controlOffset = reader.offset;
    const control = reader.u8();
    if (control === END) {
      ctx.edge('lz.end');
      ctx.span('end', controlOffset, reader.offset, 'u8', { value: END });
      break;
    }

    const op = control & 0x03;
    const packedLength = control >> 2;
    ctx.span(`control-${commands}`, controlOffset, controlOffset + 1, 'u8', { op, packedLength });
    ctx.node('command', controlOffset, Math.min(input.length, reader.offset + 8), 'lz-command', {
      op,
      packedLength,
    });

    if (op === 0) {
      ctx.edge('lz.cmd.literal');
      const length = packedLength + 1;
      const bytes = reader.take(length);
      ctx.node('literal-run', controlOffset, reader.offset, { length });
      for (const value of bytes) emit(output, state, value, maxOutput);
      ctx.edge('lz.literal.copy');
    } else if (op === 1) {
      ctx.edge('lz.cmd.match');
      const length = packedLength + 3;
      const distance = reader.u16le();
      ctx.span(`match-distance-${commands}`, reader.offset - 2, reader.offset, 'u16', { value: distance });
      ctx.node('match-run', controlOffset, reader.offset, { length, distance });

      const sourceStart = state.outPos - distance;
      // BUG #lz-negative-distance: a real decoder must reject distance > outPos.
      // This target only checks distance != 0, so a match as the first command
      // reaches a negative history index and is caught by instrumentation.
      ctx.edge('lz.match.distance-unchecked');
      if (distance === 0) {
        ctx.fault('oob-read', 'zero match distance', {
          site: 'lz.match.zero-distance',
          frames: ['decodeMatch', 'parseLzCommands', 'parseLzpk'],
          access: { offset: sourceStart, size: length, bufferLength: state.outPos },
        });
      }
      if (sourceStart < 0) {
        ctx.fault('oob-read', `match distance ${distance} is before output start`, {
          site: 'lz.match.negative-history',
          frames: ['decodeMatch', 'parseLzCommands', 'parseLzpk'],
          access: { offset: sourceStart, size: length, bufferLength: state.outPos },
        });
      }
      for (let i = 0; i < length; i++) {
        const value = output[sourceStart + i];
        emit(output, state, value, maxOutput);
      }
    } else if (op === 2) {
      ctx.edge('lz.cmd.rle');
      const length = packedLength + 2;
      const value = reader.u8();
      ctx.node('rle-run', controlOffset, reader.offset, { length, value });
      for (let i = 0; i < length; i++) emit(output, state, value, maxOutput);
      ctx.edge('lz.rle.expand');
    } else {
      ctx.edge('lz.cmd.dictionary');
      const length = packedLength + 1;
      const dictionaryIndex = reader.u16le();
      ctx.span(`dictionary-index-${commands}`, reader.offset - 2, reader.offset, 'u16', {
        value: dictionaryIndex,
      });
      // BUG #lz-dictionary-index: index + length is never checked against the
      // static dictionary length. Integer-boundary mutation drives index to
      // 0xffff and triggers an instrumented OOB read.
      ctx.edge('lz.dict.index-unchecked');
      for (let i = 0; i < length; i++) {
        const index = dictionaryIndex + i;
        if (index < 0 || index >= STATIC_DICTIONARY.length) {
          ctx.fault('oob-read', `dictionary index ${index} is outside static dictionary`, {
            site: 'lz.dictionary.static-index',
            frames: ['decodeDictionaryToken', 'parseLzCommands', 'parseLzpk'],
            access: { offset: index, size: 1, bufferLength: STATIC_DICTIONARY.length },
          });
        }
        emit(output, state, STATIC_DICTIONARY[index], maxOutput);
      }
    }
    commands++;
  }

  ctx.edge('lz.done');
  return { version, flags, maxOutput, outputSize: state.outPos };
}

function ctrlLiteral(lengthMinusOne) {
  return ((lengthMinusOne & 0x3f) << 2) | 0x00;
}
function ctrlMatch(lengthMinusThree) {
  return ((lengthMinusThree & 0x3f) << 2) | 0x01;
}
function ctrlRle(lengthMinusTwo) {
  return ((lengthMinusTwo & 0x3f) << 2) | 0x02;
}
function ctrlDictionary(lengthMinusOne) {
  return ((lengthMinusOne & 0x3f) << 2) | 0x03;
}

const seeds = [
  {
    name: 'literal-hello.lz',
    bytes: new Uint8Array([
      0x4c, 0x5a, 0x50, 0x4b, 0x01, 0x00, 0x00, 0x04, 0x00, 0x00,
      ctrlLiteral(4), 0x68, 0x65, 0x6c, 0x6c, 0x6f,
      END,
    ]),
  },
  {
    name: 'literal-match.lz',
    bytes: new Uint8Array([
      0x4c, 0x5a, 0x50, 0x4b, 0x01, 0x00, 0x00, 0x04, 0x00, 0x00,
      ctrlLiteral(2), 0x61, 0x62, 0x63,
      ctrlMatch(1), 0x03, 0x00,
      END,
    ]),
  },
  {
    name: 'dictionary.lz',
    bytes: new Uint8Array([
      0x4c, 0x5a, 0x50, 0x4b, 0x01, 0x00, 0x00, 0x04, 0x00, 0x00,
      ctrlDictionary(3), 0x00, 0x00,
      END,
    ]),
  },
  {
    name: 'rle.lz',
    bytes: new Uint8Array([
      0x4c, 0x5a, 0x50, 0x4b, 0x01, 0x00, 0x00, 0x04, 0x00, 0x00,
      ctrlRle(7), 0x5a,
      END,
    ]),
  },
];

export const lzTarget = {
  id: 'lzpk',
  name: 'LZPK 自定义压缩流',
  version: '0.4.2',
  kind: 'compression',
  description: '命令式压缩格式：literal、重叠 match、RLE 和静态字典引用。距离/字典索引缺少校验会导致历史缓冲越界读。',
  file: 'targets/puff.js',
  magic: MAGIC,
  grammar: {
    root: 'LzStream',
    byteOrder: 'little-endian',
    rules: [
      {
        id: 'LzStream',
        kind: 'seq',
        fields: [
          { name: 'magic', type: 'const', size: 4, value: MAGIC },
          { name: 'version', type: 'u8', values: [1] },
          { name: 'flags', type: 'u8' },
          { name: 'maxOutput', type: 'u32' },
          { name: 'commands', type: 'repeat', node: 'LzCommand' },
          { name: 'end', type: 'u8', value: END },
        ],
      },
      {
        id: 'LzCommand',
        kind: 'choice',
        tag: { field: 'control', lowBits: 2 },
        choices: [
          { op: 0, name: 'literal', fields: [{ name: 'length', type: 'packed6+1' }, { name: 'bytes', type: 'bytes', lengthFrom: 'length' }] },
          { op: 1, name: 'match', fields: [{ name: 'length', type: 'packed6+3' }, { name: 'distance', type: 'u16' }] },
          { op: 2, name: 'rle', fields: [{ name: 'length', type: 'packed6+2' }, { name: 'value', type: 'u8' }] },
          { op: 3, name: 'dictionary', fields: [{ name: 'length', type: 'packed6+1' }, { name: 'dictionaryIndex', type: 'u16' }] },
        ],
      },
    ],
    structuralNodes: ['command', 'literal-run', 'match-run', 'rle-run'],
  },
  instrumentation: [
    { id: 'lz.magic.ok', label: 'LZPK 魔数正确', kind: 'branch' },
    { id: 'lz.cmd.literal', label: 'literal 命令', kind: 'branch' },
    { id: 'lz.cmd.match', label: 'match 命令', kind: 'branch' },
    { id: 'lz.match.negative-history', label: '负 distance 历史读取（漏洞点）', kind: 'oob-site' },
    { id: 'lz.cmd.rle', label: 'RLE 命令', kind: 'branch' },
    { id: 'lz.cmd.dictionary', label: 'dictionary 命令', kind: 'branch' },
    { id: 'lz.dictionary.static-index', label: '字典索引越界（漏洞点）', kind: 'oob-site' },
  ],
  edges: [
    { id: 'lz.start', from: 'entry', to: 'magic', label: '开始' },
    { id: 'lz.magic.ok', from: 'magic', to: 'header', label: '魔数正确' },
    { id: 'lz.magic.reject', from: 'magic', to: 'reject', label: '魔数错误' },
    { id: 'lz.command', from: 'loop', to: 'control', label: '下一条命令' },
    { id: 'lz.cmd.literal', from: 'control', to: 'literal', label: 'literal' },
    { id: 'lz.literal.copy', from: 'literal', to: 'emit', label: '复制字面量' },
    { id: 'lz.cmd.match', from: 'control', to: 'match', label: 'match' },
    { id: 'lz.match.distance-unchecked', from: 'match', to: 'history', label: '未校验 distance' },
    { id: 'lz.cmd.rle', from: 'control', to: 'rle', label: 'RLE' },
    { id: 'lz.rle.expand', from: 'rle', to: 'emit', label: '展开 RLE' },
    { id: 'lz.cmd.dictionary', from: 'control', to: 'dictionary', label: 'dictionary' },
    { id: 'lz.dict.index-unchecked', from: 'dictionary', to: 'static-dict', label: '未校验字典索引' },
    { id: 'lz.end', from: 'control', to: 'exit', label: 'END 标记' },
    { id: 'lz.done', from: 'stream', to: 'exit', label: '解析完成' },
  ],
  seeds,
  parse,
};
