import { DEFAULT_SETTINGS, normalizeSettings } from '../core/config.js';
import { kvGet, kvSet, keys } from '../data/storage.js';

export async function loadSettings() {
  const stored = await kvGet(keys.settings, {});
  return normalizeSettings({ ...DEFAULT_SETTINGS, ...(stored || {}) });
}

export async function saveSettings(settings) {
  const normalized = normalizeSettings(settings);
  await kvSet(keys.settings, normalized);
  return normalized;
}

export async function loadActiveTarget() {
  return kvGet(keys.activeTarget, 'tlv');
}

export async function saveActiveTarget(targetId) {
  return kvSet(keys.activeTarget, targetId);
}
