/**
 * External meter store with per-track subscriptions so meter ticks do not re-render the full shell.
 * Location: apps/dashboard/lib — used by meters-context.jsx and meter UI components.
 */

import { useSyncExternalStore } from 'react';

/** @type {Record<string, { peak?: number, rms?: number }>} */
let metersMap = {};
/** @type {Set<() => void>} */
const globalListeners = new Set();
/** @type {Map<string, Set<() => void>>} */
const trackListeners = new Map();

const PEAK_EPSILON = 0.0015;

function notifyTrack(trackId) {
  const set = trackListeners.get(String(trackId));
  if (!set) {
    return;
  }
  set.forEach((listener) => listener());
}

/**
 * @param {Record<string, { peak?: number, rms?: number }>} nextMap
 */
export function setMetersMap(nextMap) {
  const next = nextMap && typeof nextMap === 'object' ? nextMap : {};
  const changedTracks = new Set();

  const allKeys = new Set([...Object.keys(metersMap), ...Object.keys(next)]);
  for (const key of allKeys) {
    const prevPeak = Number(metersMap[key]?.peak) || 0;
    const nextPeak = Number(next[key]?.peak) || 0;
    if (Math.abs(prevPeak - nextPeak) > PEAK_EPSILON) {
      changedTracks.add(key);
    }
  }

  metersMap = next;
  if (changedTracks.size > 0) {
    changedTracks.forEach((trackId) => notifyTrack(trackId));
    globalListeners.forEach((listener) => listener());
  }
}

export function getMetersMap() {
  return metersMap;
}

function subscribe(listener) {
  globalListeners.add(listener);
  return () => globalListeners.delete(listener);
}

function subscribeTrack(trackId, listener) {
  const key = String(trackId);
  let set = trackListeners.get(key);
  if (!set) {
    set = new Set();
    trackListeners.set(key, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) {
      trackListeners.delete(key);
    }
  };
}

/** Full meter map (prefer useMeterPeak per track in hot paths). */
export function useMetersMap() {
  return useSyncExternalStore(subscribe, getMetersMap, () => ({}));
}

/**
 * @param {number | string | null | undefined} trackId
 */
export function useMeterPeak(trackId) {
  const key = trackId == null ? '' : String(trackId);
  return useSyncExternalStore(
    (listener) => (key ? subscribeTrack(key, listener) : () => {}),
    () => (key ? Number(metersMap[key]?.peak) || 0 : 0),
    () => 0,
  );
}

/**
 * Max peak across track ids (for master bus meter).
 * @param {Array<{ track_id?: number }>} tracks
 */
export function useMixMasterPeak(tracks) {
  const ids = tracks.map((t) => String(t.track_id));
  return useSyncExternalStore(
    (listener) => {
      const unsubs = ids.map((id) => subscribeTrack(id, listener));
      const globalUnsub = subscribe(listener);
      return () => {
        globalUnsub();
        unsubs.forEach((u) => u());
      };
    },
    () => {
      let max = 0;
      for (const id of ids) {
        max = Math.max(max, Number(metersMap[id]?.peak) || 0);
      }
      return max;
    },
    () => 0,
  );
}
