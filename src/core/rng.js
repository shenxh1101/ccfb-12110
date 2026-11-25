// Deterministic seeded PRNG. Every mutation/scheduling random decision goes
// through this class; checkpointing state makes pause/resume/reload exact.

export function hashSeed(input) {
  if (typeof input === 'number' && Number.isFinite(input)) return input >>> 0;
  const text = String(input ?? 'roll5-fuzz');
  // xmur3-style 32-bit seed derivation.
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

export class Rng {
  constructor(seed = 'roll5-fuzz') {
    this.initialSeed = hashSeed(seed);
    this.state = this.initialSeed;
    this.calls = 0;
  }

  static fromState(state, initialSeed) {
    const rng = new Rng(initialSeed ?? state.seed ?? 'restored');
    if (state && typeof state.state === 'number') rng.state = state.state >>> 0;
    if (state && Number.isInteger(state.calls)) rng.calls = state.calls;
    return rng;
  }

  nextU32() {
    // mulberry32
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    this.calls++;
    return (t ^ (t >>> 14)) >>> 0;
  }

  float() {
    return this.nextU32() / 4294967296;
  }

  bool(probability = 0.5) {
    return this.float() < probability;
  }

  int(minInclusive, maxInclusive) {
    const min = Math.ceil(minInclusive);
    const max = Math.floor(maxInclusive);
    if (max < min) throw new RangeError(`invalid int range [${min}, ${max}]`);
    return min + Math.floor(this.float() * (max - min + 1));
  }

  pick(items) {
    if (!items || items.length === 0) throw new RangeError('cannot pick from empty array');
    return items[this.int(0, items.length - 1)];
  }

  weightedIndex(weights) {
    if (!weights || weights.length === 0) throw new RangeError('no weights');
    let total = 0;
    for (const w of weights) total += Math.max(0, Number(w) || 0);
    if (total <= 0) return this.int(0, weights.length - 1);
    let roll = this.float() * total;
    for (let i = 0; i < weights.length; i++) {
      roll -= Math.max(0, Number(weights[i]) || 0);
      if (roll < 0) return i;
    }
    return weights.length - 1;
  }

  shuffle(items) {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  checkpoint() {
    return { seed: this.initialSeed, state: this.state >>> 0, calls: this.calls };
  }

  restore(checkpoint) {
    if (!checkpoint) return;
    if (Number.isInteger(checkpoint.state)) this.state = checkpoint.state >>> 0;
    if (Number.isInteger(checkpoint.calls)) this.calls = checkpoint.calls;
  }
}
