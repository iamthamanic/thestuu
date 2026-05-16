/**
 * Normalize engine `engine:meter` socket payloads into a map keyed by track id.
 * Shared by dashboard UI (Mix / Arrangement meters).
 */

function clamp01(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

export function normalizeMeterRow(row) {
  const rawId = row.trackId ?? row.track_id;
  const trackId = rawId == null || rawId === '' ? null : Number(rawId);
  return {
    trackId: Number.isFinite(trackId) ? trackId : null,
    peak: clamp01(Number(row.peak)),
    rms: clamp01(Number(row.rms)),
  };
}

export function getMeterMap(payload) {
  const map = {};
  if (!payload || !Array.isArray(payload.meters)) {
    return map;
  }

  for (const meter of payload.meters) {
    const normalized = normalizeMeterRow(meter);
    if (normalized.trackId == null) {
      continue;
    }
    map[normalized.trackId] = normalized;
  }

  return map;
}
