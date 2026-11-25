import { tlvTarget } from './tlv.js';
import { imageHeaderTarget } from './image-header.js';
import { lzTarget } from './puff.js';

const registry = new Map();

export function registerTarget(target) {
  if (!target || typeof target.id !== 'string') {
    throw new TypeError('target.id must be a non-empty string');
  }
  if (typeof target.parse !== 'function') {
    throw new TypeError(`target ${target.id} must implement parse(input, context)`);
  }
  if (!Array.isArray(target.grammar?.rules)) {
    throw new TypeError(`target ${target.id} must declare grammar.rules`);
  }
  if (!Array.isArray(target.instrumentation)) {
    throw new TypeError(`target ${target.id} must declare instrumentation points`);
  }
  if (!Array.isArray(target.edges) || target.edges.length === 0) {
    throw new TypeError(`target ${target.id} must declare coverage edges`);
  }
  registry.set(target.id, target);
  return target;
}

export function unregisterTarget(id) {
  return registry.delete(id);
}

export function getTarget(id) {
  return registry.get(id);
}

export function listTargets() {
  return Array.from(registry.values());
}

[tlvTarget, imageHeaderTarget, lzTarget].forEach(registerTarget);

// Runtime registration hook for experiments from DevTools or future UI:
// window.FuzzWorkbench.registerTarget(myTarget)
if (typeof globalThis !== 'undefined') {
  globalThis.FuzzWorkbench = globalThis.FuzzWorkbench || {};
  globalThis.FuzzWorkbench.registerTarget = registerTarget;
  globalThis.FuzzWorkbench.listTargets = listTargets;
}
