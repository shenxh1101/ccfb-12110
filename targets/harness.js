// Shared, dependency-free instrumentation harness for browser and Node.
// Targets never index attacker-controlled memory directly; they go through
// Reader / MeteredAllocator so OOB reads and resource limits are observable.

export class TruncatedInput extends Error {
  constructor(message = 'unexpected end of input', details = {}) {
    super(message);
    this.name = 'TruncatedInput';
    this.code = 'truncated-input';
    this.details = details;
  }
}

export class TargetFault extends Error {
  constructor(kind, message, details = {}) {
    super(message);
    this.name = 'TargetFault';
    this.kind = kind;
    this.site = details.site || null;
    this.frames = Array.isArray(details.frames) ? details.frames : [];
    this.access = details.access || null;
    this.faultDetails = { ...details };
    delete this.faultDetails.frames;
    delete this.faultDetails.site;
    delete this.faultDetails.access;
  }

  toJSON() {
    return {
      kind: this.kind,
      name: this.name,
      message: this.message,
      site: this.site,
      frames: this.frames,
      access: this.access,
      details: this.faultDetails,
    };
  }
}

export class ResourceLimitError extends Error {
  constructor(kind, message, details = {}) {
    super(message);
    this.name = 'ResourceLimitError';
    this.code = kind;
    this.details = details;
  }
}

function nowDefault() {
  if (typeof globalThis.performance?.now === 'function') return globalThis.performance.now();
  return Date.now();
}

export class TargetContext {
  constructor(target = {}, options = {}) {
    this.targetId = target.id || 'unknown';
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 1000;
    this.maxMemoryBytes = Number.isFinite(options.maxMemoryBytes)
      ? options.maxMemoryBytes
      : 64 * 1024 * 1024;
    // Deterministic guard for parsers that do not hit the wall-clock check often.
    this.maxOps = Number.isFinite(options.maxOps) ? options.maxOps : 2_000_000;
    this.now = typeof options.now === 'function' ? options.now : nowDefault;
    this.startedAt = this.now();
    this.deadline = this.timeoutMs > 0 ? this.startedAt + this.timeoutMs : Infinity;

    const declaredEdges = Array.isArray(target.edges) ? target.edges : [];
    this.edgeIds = declaredEdges.map((edge) => edge.id);
    this.edgeIndex = new Map(this.edgeIds.map((id, index) => [id, index]));
    this.edgeCounts = new Uint32Array(this.edgeIds.length);
    this.dynamicEdges = [];

    this.spans = [];
    this.nodes = [];
    this.frameStack = [];
    this.logs = [];

    this.operations = 0;
    this.usedMemory = 0;
    this.peakMemory = 0;
    this.timedOut = false;
  }

  tick(weight = 1) {
    this.operations += weight;
    // The deterministic op budget is always enforced; wall-clock sampling is
    // relatively expensive and only runs every 1024 unweighted operations.
    if (this.operations > this.maxOps) {
      throw new ResourceLimitError('op-budget-exceeded', 'deterministic execution budget exceeded', {
        operations: this.operations,
        maxOps: this.maxOps,
      });
    }
    if ((this.operations & 1023) !== 0) return;
    if (this.timeoutMs > 0 && this.now() > this.deadline) {
      this.timedOut = true;
      throw new ResourceLimitError('timeout', `execution exceeded ${this.timeoutMs}ms`, {
        timeoutMs: this.timeoutMs,
      });
    }
  }

  edge(id) {
    let index = this.edgeIndex.get(id);
    if (index === undefined) {
      index = this.edgeIds.length;
      this.edgeIds.push(id);
      this.edgeIndex.set(id, index);
      this.edgeCounts = Uint32Array.from(this.edgeCounts);
      this.dynamicEdges.push(id);
    }
    if (this.edgeCounts[index] < 0xffffffff) this.edgeCounts[index] += 1;
    this.tick();
  }

  enter(frame) {
    this.frameStack.push(frame);
    this.tick();
  }

  exit(frame) {
    const last = this.frameStack[this.frameStack.length - 1];
    if (last === frame) this.frameStack.pop();
    else {
      const index = this.frameStack.lastIndexOf(frame);
      if (index >= 0) this.frameStack.length = index;
    }
  }

  withFrame(frame, fn) {
    this.enter(frame);
    try {
      return fn();
    } finally {
      this.exit(frame);
    }
  }

  span(name, start, end, type = 'bytes', meta = {}) {
    this.spans.push({ name, start, end, type, ...meta });
  }

  node(kind, start, end, meta = {}) {
    const node = { kind, start, end, ...meta };
    this.nodes.push(node);
    return node;
  }

  alloc(size, label = 'allocation') {
    const n = Number(size);
    if (!Number.isFinite(n) || n < 0) {
      throw new ResourceLimitError('invalid-allocation', 'negative or invalid allocation', { size });
    }
    if (n > this.maxMemoryBytes || this.usedMemory + n > this.maxMemoryBytes) {
      throw new ResourceLimitError('memory-limit', `allocation of ${n} bytes exceeds memory limit`, {
        label,
        size: n,
        usedMemory: this.usedMemory,
        maxMemoryBytes: this.maxMemoryBytes,
      });
    }
    this.usedMemory += n;
    this.peakMemory = Math.max(this.peakMemory, this.usedMemory);
    this.tick(Math.max(1, Math.ceil(n / 4096)));
  }

  allocBytes(size, label = 'buffer') {
    this.alloc(size, label);
    return new Uint8Array(size);
  }

  fault(kind, message, details = {}) {
    if (!details.frames || details.frames.length === 0) {
      details.frames = [...this.frameStack];
    }
    throw new TargetFault(kind, message, details);
  }

  coverageEntries() {
    return this.edgeIds.map((id, index) => ({ id, count: this.edgeCounts[index] || 0 }));
  }
}

export class Reader {
  constructor(input, ctx, label = 'input') {
    if (!(input instanceof Uint8Array)) {
      throw new TypeError('Reader expects a Uint8Array');
    }
    this.input = input;
    this.length = input.length;
    this.offset = 0;
    this.ctx = ctx;
    this.label = label;
  }

  get remaining() {
    return this.length - this.offset;
  }

  eof() {
    return this.offset >= this.length;
  }

  tick() {
    this.ctx?.tick();
  }

  need(count) {
    if (this.offset + count > this.length) {
      throw new TruncatedInput(`need ${count} byte(s) at offset ${this.offset}, only ${this.remaining} remain`, {
        offset: this.offset,
        count,
        length: this.length,
      });
    }
  }

  u8() {
    this.need(1);
    this.tick();
    return this.input[this.offset++];
  }

  peekU8() {
    this.need(1);
    return this.input[this.offset];
  }

  u16le() {
    this.need(2);
    const value = this.input[this.offset] | (this.input[this.offset + 1] << 8);
    this.offset += 2;
    this.tick();
    return value >>> 0;
  }

  u16be() {
    this.need(2);
    const value = (this.input[this.offset] << 8) | this.input[this.offset + 1];
    this.offset += 2;
    this.tick();
    return value >>> 0;
  }

  u32le() {
    this.need(4);
    const value =
      (this.input[this.offset] |
        (this.input[this.offset + 1] << 8) |
        (this.input[this.offset + 2] << 16) |
        (this.input[this.offset + 3] << 24)) >>>
      0;
    this.offset += 4;
    this.tick();
    return value;
  }

  u32be() {
    this.need(4);
    const value =
      (this.input[this.offset] << 24) |
      (this.input[this.offset + 1] << 16) |
      (this.input[this.offset + 2] << 8) |
      this.input[this.offset + 3];
    this.offset += 4;
    this.tick();
    return value >>> 0;
  }

  take(count) {
    const n = Number(count);
    if (!Number.isInteger(n) || n < 0) {
      throw new TruncatedInput(`invalid read length ${count}`, { count });
    }
    this.need(n);
    const start = this.offset;
    this.offset += n;
    this.tick(Math.max(1, Math.ceil(n / 256)));
    return this.input.subarray(start, start + n);
  }

  skip(count) {
    const n = Number(count);
    if (!Number.isInteger(n) || n < 0) {
      throw new TruncatedInput(`invalid skip length ${count}`, { count });
    }
    this.need(n);
    this.offset += n;
    this.tick(Math.max(1, Math.ceil(n / 256)));
  }

  // Deliberately vulnerable read primitive. A hardened parser would call
  // checkRange() first; the bugs below forget that check on some paths.
  unsafeRead(size, absoluteOffset, frames, site) {
    const start = Number(absoluteOffset);
    const end = start + size;
    if (!Number.isInteger(start) || start < 0 || end > this.length) {
      this.ctx.fault('oob-read', `detected out-of-bounds read of ${size} byte(s)`, {
        site,
        frames,
        access: { offset: start, size, end, bufferLength: this.length },
        offset: start,
        requestedSize: size,
      });
    }
    const bytes = [];
    for (let i = 0; i < size; i++) bytes.push(this.input[start + i]);
    this.offset = Math.max(this.offset, end);
    this.tick();
    if (size === 1) return bytes[0];
    let value = 0;
    for (let i = 0; i < size; i++) value |= bytes[i] << (8 * i);
    return value >>> 0;
  }

  unsafeU8At(offset, frames = ['Reader.unsafeU8At'], site = 'unknown-oob-read') {
    return this.unsafeRead(1, offset, frames, site);
  }

  unsafeU16LeAt(offset, frames = ['Reader.unsafeU16LeAt'], site = 'unknown-oob-read') {
    return this.unsafeRead(2, offset, frames, site);
  }

  unsafeU32LeAt(offset, frames = ['Reader.unsafeU32LeAt'], site = 'unknown-oob-read') {
    return this.unsafeRead(4, offset, frames, site);
  }
}

export function magicEquals(input, magic) {
  if (!(input instanceof Uint8Array) || input.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (input[i] !== magic.charCodeAt(i)) return false;
  }
  return true;
}

export function textToBytes(text) {
  return new TextEncoder().encode(text);
}
