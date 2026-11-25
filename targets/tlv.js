import { Reader, magicEquals, TruncatedInput } from './harness.js';

const MAGIC = 'TLV1';

export const TLV_TAGS = {
  VERSION: 0x01,
  U32: 0x02,
  STRING: 0x03,
  BLOB_CRC: 0x04,
  NESTED: 0x10,
  OFFSET_TABLE: 0x30,
  END: 0x00,
};

function parseRecordLoop(input, reader, ctx, end, depth = 0) {
  let records = 0;
  while (reader.offset < end && !reader.eof() && records < 32) {
    ctx.edge('tlv.record');
    ctx.tick();
    const recordStart = reader.offset;
    const tag = reader.u8();
    const length = reader.u8();
    ctx.span('record-tag', recordStart, recordStart + 1, 'u8', { tag });
    ctx.span('record-length', recordStart + 1, recordStart + 2, 'u8', { value: length, lengthField: true });
    const valueStart = reader.offset;
    const valueEnd = Math.min(input.length, valueStart + length);
    ctx.span(`record-${records}`, recordStart, valueEnd, 'tlv-record', { tag, length, node: 'record' });
    ctx.node('record', recordStart, valueEnd, { tag, length, depth });

    if (tag === TLV_TAGS.END) {
      ctx.edge('tlv.tag.end');
      break;
    }

    if (tag === TLV_TAGS.VERSION) {
      ctx.edge('tlv.tag.version');
      const value = reader.take(Math.min(1, length));
      if (value.length === 1) ctx.span('version-value', valueStart, valueStart + 1, 'u8');
      reader.skip(Math.max(0, length - value.length));
    } else if (tag === TLV_TAGS.U32) {
      ctx.edge('tlv.tag.u32');
      if (length >= 4) {
        const value = reader.u32le();
        ctx.span('u32-value', valueStart, valueStart + 4, 'u32', { value });
        reader.skip(Math.max(0, length - 4));
      } else {
        reader.skip(length);
      }
    } else if (tag === TLV_TAGS.STRING) {
      ctx.edge('tlv.tag.string');
      const raw = reader.take(length);
      const text = new TextDecoder('utf-8', { fatal: false }).decode(raw);
      ctx.span('string-value', valueStart, valueStart + length, 'string', { text });
    } else if (tag === TLV_TAGS.BLOB_CRC) {
      ctx.edge('tlv.tag.blob-crc');
      reader.skip(length);
      // BUG #tlv-crc: the declared value is bounds-checked, but the mandatory
      // trailing CRC is read through the unchecked pointer primitive. A
      // truncated blob record reaches an OOB read here.
      ctx.edge('tlv.blob.crc-read');
      const crc = reader.unsafeU32LeAt(
        reader.offset,
        ['readBlobCrc', 'parseTlvRecord', 'parseTlv'],
        'tlv.blob-crc.trailing-u32',
      );
      ctx.span('blob-crc', reader.offset - 4, reader.offset, 'u32', { crc });
    } else if (tag === TLV_TAGS.NESTED) {
      ctx.edge('tlv.tag.nested');
      const nestedEnd = valueStart + length;
      ctx.node('nested-block', valueStart, nestedEnd, { length });
      parseRecordLoop(input, reader, ctx, nestedEnd, depth + 1);
      reader.offset = valueEnd;
    } else if (tag === TLV_TAGS.OFFSET_TABLE) {
      ctx.edge('tlv.tag.offset-table');
      if (length < 2) {
        reader.skip(length);
      } else {
        const tableStart = reader.offset;
        const relativeOffset = reader.u16le();
        ctx.span('offset-entry-0', tableStart, tableStart + 2, 'u16', { relativeOffset });
        reader.skip(Math.max(0, length - 2));
        // BUG #tlv-offset: relativeOffset is never validated against the input
        // buffer. Integer-boundary mutations set it to 0xffff and dereference
        // far past the end.
        const absolute = valueStart + relativeOffset;
        ctx.edge('tlv.offset-table.dereference');
        reader.unsafeU8At(
          absolute,
          ['dereferenceFirstOffset', 'parseOffsetTable', 'parseTlvRecord', 'parseTlv'],
          'tlv.offset-table.first-pointer',
        );
      }
    } else {
      ctx.edge('tlv.tag.unknown');
      reader.skip(length);
    }

    // Declared TLV length owns the stream position even if a special handler
    // consumed extra metadata such as CRC.
    if (tag !== TLV_TAGS.BLOB_CRC) reader.offset = valueEnd;
    records++;
  }
}

function parse(input, ctx) {
  ctx.edge('tlv.start');
  if (input.length < 6) throw new TruncatedInput('TLV header is shorter than 6 bytes');
  if (!magicEquals(input, MAGIC)) {
    ctx.edge('tlv.magic.reject');
    throw new TruncatedInput('bad TLV magic');
  }
  ctx.edge('tlv.magic.ok');
  const reader = new Reader(input, ctx, 'tlv');
  reader.skip(4);
  const version = reader.u8();
  const flags = reader.u8();
  ctx.span('version', 4, 5, 'u8', { value: version, enum: [1, 2] });
  ctx.span('flags', 5, 6, 'u8', { value: flags });
  parseRecordLoop(input, reader, ctx, input.length, 0);
  ctx.edge('tlv.done');
  return { format: 'TLV1', version, flags };
}

const seeds = [
  {
    name: 'valid-string.tlv',
    bytes: new Uint8Array([
      0x54, 0x4c, 0x56, 0x31, 0x01, 0x00,
      TLV_TAGS.STRING, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f,
    ]),
  },
  {
    name: 'blob-with-crc.tlv',
    bytes: new Uint8Array([
      0x54, 0x4c, 0x56, 0x31, 0x01, 0x00,
      TLV_TAGS.BLOB_CRC, 0x02, 0xaa, 0xbb, 0x12, 0x34, 0x56, 0x78,
    ]),
  },
  {
    name: 'offset-table-zero.tlv',
    bytes: new Uint8Array([
      0x54, 0x4c, 0x56, 0x31, 0x01, 0x00,
      TLV_TAGS.OFFSET_TABLE, 0x02, 0x00, 0x00,
    ]),
  },
  {
    name: 'nested-version.tlv',
    bytes: new Uint8Array([
      0x54, 0x4c, 0x56, 0x31, 0x02, 0x00,
      TLV_TAGS.NESTED, 0x03, TLV_TAGS.VERSION, 0x01, 0x01,
    ]),
  },
];

export const tlvTarget = {
  id: 'tlv',
  name: 'TLV-Roll 二进制协议',
  version: '0.9.3',
  kind: 'protocol',
  description: '带 4 字节魔数、u8 标签/长度和嵌套 Record 的 TLV 协议。手工 fuzz 曾在 CRC 与偏移表解引用处发现越界读。',
  file: 'targets/tlv.js',
  magic: MAGIC,
  grammar: {
    root: 'Message',
    byteOrder: 'little-endian (offset table)',
    rules: [
      {
        id: 'Message',
        kind: 'seq',
        fields: [
          { name: 'magic', type: 'const', size: 4, value: MAGIC },
          { name: 'version', type: 'u8', values: [1, 2] },
          { name: 'flags', type: 'u8' },
          { name: 'records', type: 'repeat', node: 'Record' },
        ],
      },
      {
        id: 'Record',
        kind: 'seq',
        fields: [
          { name: 'tag', type: 'u8', enum: TLV_TAGS },
          { name: 'length', type: 'u8' },
          { name: 'value', type: 'bytes', lengthFrom: 'length' },
        ],
      },
    ],
    structuralNodes: ['record', 'nested-block'],
  },
  instrumentation: [
    { id: 'tlv.magic.ok', label: '魔数校验通过', kind: 'branch' },
    { id: 'tlv.record', label: '进入 Record 循环', kind: 'edge' },
    { id: 'tlv.tag.blob-crc', label: 'BLOB_CRC 分支', kind: 'branch' },
    { id: 'tlv.blob.crc-read', label: '读取尾部 CRC（漏洞点）', kind: 'oob-site' },
    { id: 'tlv.tag.offset-table', label: 'OFFSET_TABLE 分支', kind: 'branch' },
    { id: 'tlv.offset-table.dereference', label: '解引用表内偏移（漏洞点）', kind: 'oob-site' },
  ],
  edges: [
    { id: 'tlv.start', from: 'entry', to: 'header', label: '开始解析' },
    { id: 'tlv.magic.ok', from: 'header', to: 'records', label: '魔数正确' },
    { id: 'tlv.magic.reject', from: 'header', to: 'reject', label: '魔数错误' },
    { id: 'tlv.record', from: 'loop', to: 'record-header', label: '下一条记录' },
    { id: 'tlv.tag.end', from: 'record-header', to: 'exit', label: 'END 标签' },
    { id: 'tlv.tag.version', from: 'tag', to: 'version', label: 'VERSION' },
    { id: 'tlv.tag.u32', from: 'tag', to: 'u32', label: 'U32' },
    { id: 'tlv.tag.string', from: 'tag', to: 'string', label: 'STRING' },
    { id: 'tlv.tag.blob-crc', from: 'tag', to: 'blob', label: 'BLOB_CRC' },
    { id: 'tlv.blob.crc-read', from: 'blob', to: 'crc', label: '未校验 CRC 边界' },
    { id: 'tlv.tag.nested', from: 'tag', to: 'nested', label: 'NESTED' },
    { id: 'tlv.tag.offset-table', from: 'tag', to: 'offset-table', label: 'OFFSET_TABLE' },
    { id: 'tlv.offset-table.dereference', from: 'offset-table', to: 'deref', label: '未校验指针偏移' },
    { id: 'tlv.tag.unknown', from: 'tag', to: 'skip', label: '未知标签' },
    { id: 'tlv.done', from: 'records', to: 'exit', label: '解析完成' },
  ],
  seeds,
  parse,
};
