/**
 * Builds a single peak envelope for the Mix-tab playlist overview (all tracks/clips, bar-aligned).
 * Location: apps/dashboard/lib — used by MixPlaylistOverview.jsx.
 */

const OVERVIEW_PEAK_COUNT = 512;
const MIN_WAVEFORM_SAMPLES = 24;
const MAX_WAVEFORM_SAMPLES = 2048;
const MIDI_PLACEHOLDER_PEAK = 0.22;
const MIDI_PLACEHOLDER_SAMPLES = 48;
/** Visual level for muted tracks/clips (still visible in overview). */
const MUTED_GHOST_SCALE = 0.08;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeWaveformPeaks(peaks, maxSamples = MAX_WAVEFORM_SAMPLES) {
  if (!Array.isArray(peaks)) {
    return [];
  }
  const sanitized = peaks
    .map((peak) => Number(peak))
    .filter((peak) => Number.isFinite(peak))
    .map((peak) => Number(clamp(Math.abs(peak), 0, 1).toFixed(4)));
  if (sanitized.length <= maxSamples) {
    return sanitized;
  }
  const downsampled = [];
  const span = sanitized.length / maxSamples;
  for (let index = 0; index < maxSamples; index += 1) {
    const start = Math.floor(index * span);
    const end = Math.min(sanitized.length, Math.floor((index + 1) * span) || (start + 1));
    let peak = 0;
    for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
      if (sanitized[sampleIndex] > peak) {
        peak = sanitized[sampleIndex];
      }
    }
    downsampled.push(Number(peak.toFixed(4)));
  }
  return downsampled;
}

function barsToSeconds(bars, bpm, timeSignature = { numerator: 4, denominator: 4 }) {
  if (!Number.isFinite(bars) || !Number.isFinite(bpm) || bpm <= 0) return 0;
  const num = Number(timeSignature?.numerator) || 4;
  const denom = Number(timeSignature?.denominator) || 4;
  const quarterNotesPerBar = (num * 4) / denom;
  return (bars * quarterNotesPerBar * 60) / bpm;
}

function getClipWaveformPeaks(clip) {
  if (!clip || typeof clip !== 'object') {
    return [];
  }
  return normalizeWaveformPeaks(clip.waveform_peaks ?? clip.waveformPeaks ?? clip.waveform ?? []);
}

function getLeadingSilenceOffsetSecondsFromPeaks(peaks, sourceDurationSeconds, threshold = 0.02) {
  const n = peaks.length;
  if (n === 0 || !Number.isFinite(sourceDurationSeconds) || sourceDurationSeconds <= 0) {
    return 0;
  }
  for (let i = 0; i < n; i += 1) {
    const p = Number(peaks[i]);
    if (Number.isFinite(p) && Math.abs(p) > threshold) {
      return (i / n) * sourceDurationSeconds;
    }
  }
  return 0;
}

function sliceWaveformPeaksByFileTime(peaks, t0, t1) {
  const n = peaks.length;
  if (n === 0) {
    return [];
  }
  if (n === 1) {
    return [...peaks];
  }
  const lo = clamp(t0, 0, 1);
  const hi = clamp(t1, lo, 1);
  const last = n - 1;
  const startFrac = lo * last;
  const endFrac = hi * last;
  let i0 = Math.floor(startFrac);
  let i1 = Math.ceil(endFrac);
  i0 = clamp(i0, 0, last);
  i1 = clamp(i1, i0, last);
  return peaks.slice(i0, i1 + 1);
}

function getEffectiveAudioTrimStartForWaveform(clip) {
  if (!clip || typeof clip !== 'object') {
    return 0;
  }
  const peaks = getClipWaveformPeaks(clip);
  const sourceDur = Number(clip.source_duration_seconds ?? clip.sourceDurationSeconds);
  let peakLead = 0;
  if (peaks.length > 0 && Number.isFinite(sourceDur) && sourceDur > 0) {
    peakLead = getLeadingSilenceOffsetSecondsFromPeaks(peaks, sourceDur);
  }
  if (Object.prototype.hasOwnProperty.call(clip, 'trim_start_seconds') && Number.isFinite(Number(clip.trim_start_seconds))) {
    return Math.max(0, Number(clip.trim_start_seconds) || 0, peakLead);
  }
  return peakLead;
}

function getVisibleWaveformPeaks(clip, { bpm, timeSignature } = {}) {
  const peaks = getClipWaveformPeaks(clip);
  if (peaks.length === 0) {
    return [];
  }
  const lengthBars = Number(clip?.length) || 0;
  const safeBpm = Number.isFinite(Number(bpm)) && Number(bpm) > 0 ? Number(bpm) : 128;
  const lengthSeconds = barsToSeconds(lengthBars, safeBpm, timeSignature);
  const sourceDurRaw = Number(clip?.source_duration_seconds ?? clip?.sourceDurationSeconds);
  const hasSourceDur = Number.isFinite(sourceDurRaw) && sourceDurRaw > 0;
  const effectiveSourceDur = hasSourceDur ? sourceDurRaw : Math.max(lengthSeconds, 1e-9);
  const windowStartSec = getEffectiveAudioTrimStartForWaveform(clip);
  const windowEndSec = windowStartSec + lengthSeconds;
  const t0 = clamp(windowStartSec / effectiveSourceDur, 0, 1);
  const t1 = clamp(windowEndSec / effectiveSourceDur, t0, 1);
  if (t1 <= t0) {
    const idx = Math.min(peaks.length - 1, Math.max(0, Math.round(t0 * Math.max(1, peaks.length - 1))));
    return [peaks[idx]];
  }
  const sliced = sliceWaveformPeaksByFileTime(peaks, t0, t1);
  return sliced.length > 0 ? sliced : peaks;
}

function resampleWaveformPeaks(peaks, targetCount) {
  const normalized = normalizeWaveformPeaks(peaks);
  if (normalized.length === 0) {
    return [];
  }
  const safeTargetCount = Math.round(clamp(targetCount, MIN_WAVEFORM_SAMPLES, MAX_WAVEFORM_SAMPLES));
  if (safeTargetCount === normalized.length) {
    return normalized;
  }
  if (safeTargetCount < normalized.length) {
    const downsampled = [];
    const span = normalized.length / safeTargetCount;
    for (let index = 0; index < safeTargetCount; index += 1) {
      const start = Math.floor(index * span);
      const end = Math.min(normalized.length, Math.floor((index + 1) * span) || (start + 1));
      let peak = 0;
      for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
        if (normalized[sampleIndex] > peak) {
          peak = normalized[sampleIndex];
        }
      }
      downsampled.push(Number(peak.toFixed(4)));
    }
    return downsampled;
  }
  const upsampled = [];
  const lastIndex = normalized.length - 1;
  const divisor = safeTargetCount - 1;
  for (let index = 0; index < safeTargetCount; index += 1) {
    const progress = divisor > 0 ? index / divisor : 0;
    const sourcePosition = progress * lastIndex;
    const sourceIndex = Math.floor(sourcePosition);
    const nextIndex = Math.min(lastIndex, sourceIndex + 1);
    const blend = sourcePosition - sourceIndex;
    const value = (normalized[sourceIndex] * (1 - blend)) + (normalized[nextIndex] * blend);
    upsampled.push(Number(clamp(value, 0, 1).toFixed(4)));
  }
  return upsampled;
}

function normalizeClipType(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'audio' || normalized === 'midi') {
    return normalized;
  }
  return null;
}

function getPatternId(clip) {
  if (!clip || typeof clip !== 'object') {
    return null;
  }
  if (typeof clip.pattern_id === 'string' && clip.pattern_id.trim()) {
    return clip.pattern_id.trim();
  }
  if (typeof clip.patternId === 'string' && clip.patternId.trim()) {
    return clip.patternId.trim();
  }
  return null;
}

function getMidiPlaceholderPeaks() {
  return Array.from({ length: MIDI_PLACEHOLDER_SAMPLES }, () => MIDI_PLACEHOLDER_PEAK);
}

function getClipPeaksForOverview(clip, { bpm, timeSignature }) {
  const clipType = normalizeClipType(clip?.type);
  const patternId = getPatternId(clip);
  const rawPeaks = clipType === 'audio' ? getClipWaveformPeaks(clip) : [];
  if (clipType === 'audio' && rawPeaks.length > 0) {
    const visible = getVisibleWaveformPeaks(clip, { bpm, timeSignature });
    return visible.length > 0 ? visible : rawPeaks;
  }
  if (clipType === 'midi' || patternId) {
    return getMidiPlaceholderPeaks();
  }
  if (rawPeaks.length > 0) {
    return getVisibleWaveformPeaks(clip, { bpm, timeSignature });
  }
  return [];
}

function peakAtClipPosition(clipPeaks, rel) {
  if (!clipPeaks.length) {
    return 0;
  }
  const t = clamp(rel, 0, 1);
  if (clipPeaks.length === 1) {
    return clipPeaks[0];
  }
  const pos = t * (clipPeaks.length - 1);
  const i0 = Math.floor(pos);
  const i1 = Math.min(clipPeaks.length - 1, i0 + 1);
  const blend = pos - i0;
  return (clipPeaks[i0] * (1 - blend)) + (clipPeaks[i1] * blend);
}

/**
 * @param {object} options
 * @param {Array} options.tracks — arrangement tracks with clips + mix
 * @param {number} options.maxClipEnd — timeline end in bars
 * @param {number} options.bpm
 * @param {{ numerator: number, denominator: number }} options.timeSignature
 * @param {Record<string, boolean>} [options.clipMuteOverrides]
 * @param {boolean} [options.anyTrackSolo]
 */
export function buildPlaylistOverviewPeaks({
  tracks = [],
  maxClipEnd = 0,
  bpm = 128,
  timeSignature = { numerator: 4, denominator: 4 },
  clipMuteOverrides = {},
  anyTrackSolo = false,
}) {
  const safeEnd = Math.max(0.001, Number(maxClipEnd) || 0);
  const count = OVERVIEW_PEAK_COUNT;
  const overview = new Array(count).fill(0);
  const lastIndex = Math.max(1, count - 1);

  for (const track of tracks) {
    if (!track?.exists) {
      continue;
    }
    const mix = track.mix || {};
    const trackId = Number(track.track_id);
    if (anyTrackSolo && !mix.solo) {
      continue;
    }
    const trackMuted = Boolean(mix.mute);
    const volumeRaw = Number(mix.volume);
    const volume = Number.isFinite(volumeRaw) ? clamp(volumeRaw, 0, 1.2) : 1;
    const volumeScale = volume / 1.2;
    const trackScale = trackMuted ? volumeScale * MUTED_GHOST_SCALE : volumeScale;

    const clips = Array.isArray(track.clips) ? track.clips : [];
    for (const clip of clips) {
      if (!clip || typeof clip !== 'object') {
        continue;
      }
      const clipId = clip.id != null ? String(clip.id) : '';
      const clipKey = `${trackId}:${clipId}`;
      const clipMuted = clipMuteOverrides[clipKey] === true || clip.muted === true;
      const clipScale = clipMuted ? trackScale * MUTED_GHOST_SCALE : trackScale;
      if (clipScale <= 0) {
        continue;
      }

      const clipPeaks = getClipPeaksForOverview(clip, { bpm, timeSignature });
      if (clipPeaks.length === 0) {
        continue;
      }

      const clipStart = Number(clip.start) || 0;
      const clipLength = Math.max(0.001, Number(clip.length) || 0.001);
      const clipEnd = clipStart + clipLength;

      for (let i = 0; i < count; i += 1) {
        const bar = (i / lastIndex) * safeEnd;
        if (bar < clipStart || bar >= clipEnd) {
          continue;
        }
        const rel = (bar - clipStart) / clipLength;
        const contribution = peakAtClipPosition(clipPeaks, rel) * clipScale;
        if (contribution > overview[i]) {
          overview[i] = contribution;
        }
      }
    }
  }

  return overview.map((peak) => Number(clamp(peak, 0, 1).toFixed(4)));
}

export function getWaveformPolygonPoints(peaks) {
  const normalized = normalizeWaveformPeaks(peaks, OVERVIEW_PEAK_COUNT);
  if (normalized.length === 0) {
    return '';
  }
  const topPoints = [];
  const bottomPoints = [];
  const lastIdx = Math.max(1, normalized.length - 1);
  for (let index = 0; index < normalized.length; index += 1) {
    const x = (index / lastIdx) * 100;
    const amplitude = normalized[index] * 44;
    const topY = 50 - amplitude;
    const bottomY = 50 + amplitude;
    topPoints.push(`${x.toFixed(3)},${topY.toFixed(3)}`);
    bottomPoints.push(`${x.toFixed(3)},${bottomY.toFixed(3)}`);
  }
  return [...topPoints, ...bottomPoints.reverse()].join(' ');
}

export { OVERVIEW_PEAK_COUNT };
