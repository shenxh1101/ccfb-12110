import { Rng } from './rng.js';
import { fnv1aBytes } from './hash.js';
import { normalizeSettings, executorLimits } from './config.js';
import { executeTarget } from './executor.js';
import { mutate, chooseMutator } from './mutators.js';

export class FuzzEngine {
  constructor(target, options = {}) {
    if (!target) throw new TypeError('FuzzEngine requires a target');
    this.target = target;
    this.settings = normalizeSettings(options.settings || {});
    this.limits = executorLimits(this.settings);
    this.clock = typeof options.now === 'function' ? options.now : () => Date.now();

    this.rng = options.checkpoint?.rng
      ? Rng.fromState(options.checkpoint.rng, this.settings.seed)
      : new Rng(this.settings.seed);

    /** @type {Array<any>} */
    this.corpus = [];
    this.corpusById = new Map();
    this.inputHashes = new Set();
    this.crashes = new Map();
    this.edgeCounts = new Map(options.checkpoint?.edgeCounts || []);
    this.curve = Array.isArray(options.checkpoint?.curve) ? options.checkpoint.curve.slice() : [];

    this.mutationCount = options.checkpoint?.mutationCount || 0;
    this.nextCurveAt = options.checkpoint?.nextCurveAt || this.settings.curveInterval;
    this.nextCorpusSerial = options.checkpoint?.nextCorpusSerial || 1;

    this.stats = {
      executions: 0,
      baselineExecutions: 0,
      mutations: 0,
      rejected: 0,
      resourceLimits: 0,
      memoryLimitHits: 0,
      timeoutHits: 0,
      mutationErrors: 0,
      totalCrashes: 0,
      uniqueCrashes: 0,
      newEdges: 0,
      corpusAdded: 0,
      ...(options.checkpoint?.stats || {}),
      mutatorCounts: {
        bitflip: 0,
        'integer-boundary': 0,
        'block-splice': 0,
        'grammar-structure': 0,
        ...(options.checkpoint?.stats?.mutatorCounts || {}),
      },
      resourceCounts: {
        timeout: 0,
        'memory-limit': 0,
        'op-budget-exceeded': 0,
        'output-budget-exceeded': 0,
        ...(options.checkpoint?.stats?.resourceCounts || {}),
      },
    };

    if (Array.isArray(options.corpus)) {
      for (const entry of options.corpus) this.addCorpusEntry(entry);
    }
    if (Array.isArray(options.crashes)) {
      for (const crash of options.crashes) this.crashes.set(crash.fingerprint || crash.id, crash);
    }
  }

  loadDefaultSeeds() {
    for (const seed of this.target.seeds || []) {
      this.addCorpusEntry({
        id: seed.id || `seed-${this.target.id}-${fnv1aBytes(seed.bytes).slice(0, 8)}`,
        name: seed.name,
        bytes: seed.bytes,
        source: 'built-in-seed',
      });
    }
    return this;
  }

  addCorpusEntry(entry) {
    const bytes = entry.bytes || entry.data;
    if (!(bytes instanceof Uint8Array)) throw new TypeError('corpus entry requires Uint8Array bytes');
    const hash = entry.hash || fnv1aBytes(bytes);
    if (this.inputHashes.has(hash)) {
      const existing = this.corpus.find((item) => item.hash === hash);
      return { entry: existing, duplicate: true };
    }

    const record = {
      id: entry.id || `corpus-${this.target.id}-${hash.slice(0, 10)}-${this.nextCorpusSerial++}`,
      targetId: this.target.id,
      name: entry.name || entry.id || `case-${hash.slice(0, 8)}`,
      bytes,
      hash,
      size: bytes.length,
      source: entry.source || 'imported',
      parentId: entry.parentId || null,
      generation: Number.isInteger(entry.generation) ? entry.generation : 0,
      addedOrder: this.corpus.length,
      selectedCount: entry.selectedCount || 0,
      novelty: entry.novelty || 0,
      newEdgeCount: entry.newEdgeCount || 0,
      edgeCount: entry.edgeCount || 0,
      favored: Boolean(entry.favored),
      shape: entry.shape || null,
      createdAt: entry.createdAt || this.clock(),
    };
    this.corpus.push(record);
    this.corpusById.set(record.id, record);
    this.inputHashes.add(hash);
    return { entry: record, duplicate: false };
  }

  prime({ restoreCoverage = Boolean(this.edgeCounts.size || this.curve.length) } = {}) {
    if (this.corpus.length === 0) this.loadDefaultSeeds();

    if (restoreCoverage) {
      // Checkpoint owns global coverage counts. Still rebuild syntax shapes for
      // grammar mutation without mutating RNG or execution statistics.
      for (const entry of this.corpus) {
        if (!entry.shape) {
          const result = executeTarget(this.target, entry.bytes, this.limits);
          entry.shape = { nodes: result.nodes, spans: result.spans };
          entry.edgeCount = result.edges.length;
        }
      }
      return this;
    }

    this.edgeCounts.clear();
    for (const entry of this.corpus) {
      const result = executeTarget(this.target, entry.bytes, this.limits);
      this.stats.executions++;
      this.stats.baselineExecutions++;
      entry.shape = { nodes: result.nodes, spans: result.spans };
      entry.edgeCount = result.edges.length;
      const before = this.edgeCounts.size;
      const merged = this.mergeCoverage(result.edges);
      if (merged.newEdgeCount > 0) {
        entry.novelty += merged.newEdgeCount;
        entry.newEdgeCount += merged.newEdgeCount;
        this.stats.newEdges += merged.newEdgeCount;
      }
      void before;
    }
    this.curve = [];
    this.pushCurvePoint('baseline');
    this.nextCurveAt = this.stats.executions + this.settings.curveInterval;
    return this;
  }

  mergeCoverage(edges) {
    const newEdgeIds = [];
    for (const edge of edges || []) {
      const id = typeof edge === 'string' ? edge : edge.id;
      const count = typeof edge === 'string' ? 1 : edge.count || 1;
      const before = this.edgeCounts.get(id) || 0;
      if (before === 0) newEdgeIds.push(id);
      this.edgeCounts.set(id, before + count);
    }
    return { newEdgeIds, newEdgeCount: newEdgeIds.length };
  }

  weightFor(entry) {
    const s = this.settings.scheduler;
    const noveltyPart = 1 + entry.novelty * s.noveltyWeight + entry.newEdgeCount * 0.5;
    const coveragePart = 1 + Math.sqrt(Math.max(0, entry.edgeCount || 0)) * s.edgeWeight;
    const usePart = 1 / Math.sqrt(1 + entry.selectedCount * s.useCountPenalty);
    const sourceBoost = entry.source === 'built-in-seed' ? 1.25 : 1;
    return Math.max(0.05, noveltyPart * coveragePart * usePart * sourceBoost);
  }

  selectParent() {
    if (this.corpus.length === 0) this.loadDefaultSeeds();
    const weights = this.corpus.map((entry) => this.weightFor(entry));
    const index = this.rng.weightedIndex(weights);
    const parent = this.corpus[index];
    parent.selectedCount++;
    return parent;
  }

  chooseMutator() {
    return chooseMutator(this.rng, this.settings.mutatorWeights);
  }

  runBatch(requestedSize) {
    const batchSize = Math.max(1, Math.floor(requestedSize || this.settings.batchSize));
    const events = {
      newCorpus: [],
      newCrashes: [],
      updatedCrashes: [],
      resourceEvents: [],
      completedIterations: 0,
    };

    for (let i = 0; i < batchSize; i++) {
      if (this.settings.maxIterations > 0 && this.mutationCount >= this.settings.maxIterations) break;

      const parent = this.selectParent();
      const mutatorId = this.chooseMutator();
      this.stats.mutations++;
      this.stats.mutatorCounts[mutatorId] = (this.stats.mutatorCounts[mutatorId] || 0) + 1;

      let input;
      try {
        input = mutate(mutatorId, this.rng, parent.bytes, {
          corpus: this.corpus,
          target: this.target,
          shape: parent.shape,
        });
      } catch (error) {
        this.stats.mutationErrors++;
        input = parent.bytes.slice();
      }

      if (input.length > this.settings.maxInputBytes) {
        input = input.subarray(0, this.settings.maxInputBytes);
      }

      const result = executeTarget(this.target, input, this.limits);
      this.mutationCount++;
      this.stats.executions++;
      events.completedIterations++;

      const coverage = this.mergeCoverage(result.edges);

      if (result.rejected) this.stats.rejected++;
      if (result.resource) {
        this.stats.resourceLimits++;
        if (result.resource === 'timeout') {
          this.stats.timeoutHits++;
          this.stats.resourceCounts.timeout++;
        } else if (result.resource === 'memory-limit') {
          this.stats.memoryLimitHits++;
          this.stats.resourceCounts['memory-limit']++;
        } else if (this.stats.resourceCounts[result.resource] !== undefined) {
          this.stats.resourceCounts[result.resource]++;
        }
        if (events.resourceEvents.length < 20) {
          events.resourceEvents.push({ resource: result.resource, error: result.error?.message });
        }
      }

      if (coverage.newEdgeCount > 0) {
        this.stats.newEdges += coverage.newEdgeCount;
        parent.novelty += coverage.newEdgeCount;
        const generatedCount = this.corpus.filter((e) => String(e.source).startsWith('mutation:')).length;
        if (generatedCount < this.settings.maxCorpus) {
          const added = this.addCorpusEntry({
            targetId: this.target.id,
            name: `edge-${this.edgeCounts.size}-${this.mutationCount}.bin`,
            bytes: input,
            source: `mutation:${mutatorId}`,
            parentId: parent.id,
            generation: (parent.generation || 0) + 1,
            newEdgeCount: coverage.newEdgeCount,
            edgeCount: result.edges.length,
            shape: { nodes: result.nodes, spans: result.spans },
          });
          if (!added.duplicate) {
            this.stats.corpusAdded++;
            events.newCorpus.push(added.entry);
          }
        }
      }

      if (result.crash) this.recordCrash(result, input, mutatorId, parent, events);

      if (this.stats.executions >= this.nextCurveAt) {
        this.pushCurvePoint('interval');
        this.nextCurveAt += this.settings.curveInterval;
      }
    }

    if (this.settings.maxIterations > 0 && this.mutationCount >= this.settings.maxIterations) {
      this.pushCurvePoint('completed');
    }

    return { checkpoint: this.checkpoint(), events };
  }

  recordCrash(result, input, mutatorId, parent, events) {
    this.stats.totalCrashes++;
    const fingerprint = result.fingerprint;
    let crash = this.crashes.get(fingerprint);
    if (crash) {
      crash.count++;
      crash.lastExecution = this.stats.executions;
      crash.lastSeen = this.clock();
      events.updatedCrashes.push(crash);
    } else {
      crash = {
        id: fingerprint,
        fingerprint,
        targetId: this.target.id,
        title: result.title,
        kind: result.error?.kind || result.error?.name || 'crash',
        severity: result.error?.kind === 'oob-read' ? 'high' : 'medium',
        message: result.error?.message,
        site: result.error?.site,
        stack: result.error?.stack,
        frames: result.fingerprintFrames || [],
        access: result.error?.access || null,
        mutator: mutatorId,
        parentId: parent?.id || null,
        sample: input,
        size: input.length,
        count: 1,
        firstExecution: this.stats.executions,
        lastExecution: this.stats.executions,
        firstSeen: this.clock(),
        lastSeen: this.clock(),
        minimized: null,
        reproduction: null,
      };
      this.crashes.set(fingerprint, crash);
      this.stats.uniqueCrashes = this.crashes.size;
      events.newCrashes.push(crash);
    }
  }

  pushCurvePoint(reason) {
    const point = {
      x: this.stats.executions,
      mutation: this.mutationCount,
      edges: this.edgeCounts.size,
      crashes: this.crashes.size,
      reason,
    };
    const last = this.curve[this.curve.length - 1];
    if (last && last.x === point.x) this.curve[this.curve.length - 1] = point;
    else this.curve.push(point);
    if (this.curve.length > 5000) this.curve = this.decimateCurve(this.curve, 2500);
  }

  decimateCurve(points, targetSize) {
    if (points.length <= targetSize) return points;
    const step = points.length / targetSize;
    const out = [];
    for (let i = 0; i < targetSize; i++) out.push(points[Math.floor(i * step)]);
    out.push(points[points.length - 1]);
    return out;
  }

  checkpoint() {
    return {
      version: 1,
      targetId: this.target.id,
      seed: this.settings.seed,
      rng: this.rng.checkpoint(),
      mutationCount: this.mutationCount,
      nextCurveAt: this.nextCurveAt,
      nextCorpusSerial: this.nextCorpusSerial,
      stats: JSON.parse(JSON.stringify(this.stats)),
      edgeCounts: Array.from(this.edgeCounts.entries()),
      curve: this.curve,
      corpusMeta: this.corpus.map((entry) => ({
        id: entry.id,
        hash: entry.hash,
        name: entry.name,
        size: entry.size,
        source: entry.source,
        parentId: entry.parentId,
        generation: entry.generation,
        addedOrder: entry.addedOrder,
        selectedCount: entry.selectedCount,
        novelty: entry.novelty,
        newEdgeCount: entry.newEdgeCount,
        edgeCount: entry.edgeCount,
        favored: entry.favored,
        createdAt: entry.createdAt,
      })),
    };
  }
}
