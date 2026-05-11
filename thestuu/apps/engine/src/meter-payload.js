/**
 * Build `engine:meter` payloads: merge native Tracktion peaks with playlist track ids,
 * or placeholder random levels when native transport is off.
 */

function clamp01(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

export function placeholderMetersForPlaylist(playlist, playing) {
  return playlist.map((track) => ({
    trackId: track.track_id,
    peak: playing ? Math.random() * 0.95 : Math.random() * 0.05,
    rms: playing ? Math.random() * 0.75 : Math.random() * 0.03,
  }));
}

export function mergeNativeMetersPayload(playlist, nativePayload) {
  const rows = Array.isArray(nativePayload?.meters) ? nativePayload.meters : [];
  // Native meters are ordered like `getAudioTracks(edit)`; payload `track_id` is only positional (1..n),
  // not the app's persistent playlist id — merge by index so holes / renumbering still match peaks.
  return playlist.map((track, index) => {
    const row = rows[index];
    if (!row) {
      return { trackId: track.track_id, peak: 0, rms: 0 };
    }
    return {
      trackId: track.track_id,
      peak: clamp01(Number(row.peak)),
      rms: clamp01(Number(row.rms)),
    };
  });
}

/** Largest peak in merged engine:meter rows (for diagnostics). */
export function maxPeakFromMeterRows(meters) {
  let max = 0;
  if (!Array.isArray(meters)) {
    return 0;
  }
  for (const row of meters) {
    const p = Number(row?.peak);
    if (Number.isFinite(p) && p > max) {
      max = p;
    }
  }
  return max;
}
