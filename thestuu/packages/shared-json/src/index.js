const SUPPORTED_VERSION = '1.0.0-alpha';
const GRID_STEP = 1 / 16;
const DEFAULT_PATTERN_LENGTH = 16;
const DEFAULT_DRUM_LANES = ['Kick', 'Snare', 'CH', 'OH', 'Clap'];
const DEFAULT_PLAYLIST_VIEW_BARS = 32;
const MIN_PLAYLIST_VIEW_BARS = 8;
const MAX_PLAYLIST_VIEW_BARS = 4096;
const DEFAULT_PLAYLIST_BAR_WIDTH = 92;
const MIN_PLAYLIST_BAR_WIDTH = 36;
const MAX_PLAYLIST_BAR_WIDTH = 220;
const IMPORTABLE_AUDIO_EXTENSIONS = new Set(['wav', 'flac', 'mp3', 'ogg', 'aac', 'aiff', 'aif']);
const IMPORTABLE_MIDI_EXTENSIONS = new Set(['mid', 'midi']);
const IMPORTABLE_EXTENSIONS = new Set([...IMPORTABLE_AUDIO_EXTENSIONS, ...IMPORTABLE_MIDI_EXTENSIONS]);
const DEFAULT_PLAYLIST_SHOW_TRACK_NODES = true;
const MAX_WAVEFORM_PEAKS = 2048;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function asNumber(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function asInteger(value, fallback) {
  return Number.isInteger(Number(value)) ? Number(value) : fallback;
}

function asBoolean(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
      return true;
    }
    if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
      return false;
    }
  }
  return fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundToStep(value, step = GRID_STEP) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const snapped = Math.round(value / step) * step;
  return Number(snapped.toFixed(6));
}

function getClipPatternId(clip) {
  if (!isObject(clip)) {
    return null;
  }
  if (isNonEmptyString(clip.pattern_id)) {
    return clip.pattern_id.trim();
  }
  if (isNonEmptyString(clip.pattern)) {
    return clip.pattern.trim();
  }
  return null;
}

function getFileExtension(filename) {
  if (!isNonEmptyString(filename)) {
    return '';
  }
  const normalized = filename.trim().toLowerCase();
  const dotIndex = normalized.lastIndexOf('.');
  if (dotIndex < 0 || dotIndex === normalized.length - 1) {
    return '';
  }
  return normalized.slice(dotIndex + 1);
}

function normalizeClipType(type) {
  if (!isNonEmptyString(type)) {
    return null;
  }
  const normalized = type.trim().toLowerCase();
  if (normalized === 'audio' || normalized === 'midi') {
    return normalized;
  }
  return null;
}

function normalizeWaveformPeaks(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const sanitized = value
    .map((peak) => Number(peak))
    .filter((peak) => Number.isFinite(peak))
    .map((peak) => Number(clamp(Math.abs(peak), 0, 1).toFixed(4)));
  if (sanitized.length <= MAX_WAVEFORM_PEAKS) {
    return sanitized;
  }

  const downsampled = [];
  const span = sanitized.length / MAX_WAVEFORM_PEAKS;
  for (let index = 0; index < MAX_WAVEFORM_PEAKS; index += 1) {
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

function normalizeImportedFormat(format) {
  if (!isNonEmptyString(format)) {
    return '';
  }
  const normalized = format.trim().toLowerCase();
  if (normalized === 'mid') {
    return 'midi';
  }
  if (normalized === 'aif') {
    return 'aiff';
  }
  return normalized;
}

function inferClipTypeFromFormat(format) {
  if (!isNonEmptyString(format)) {
    return null;
  }
  if (IMPORTABLE_MIDI_EXTENSIONS.has(format)) {
    return 'midi';
  }
  if (IMPORTABLE_AUDIO_EXTENSIONS.has(format)) {
    return 'audio';
  }
  return null;
}

function normalizeDrumSteps(steps, patternLength) {
  if (!Array.isArray(steps)) {
    return [];
  }

  const map = new Map();
  for (const [index, rawStep] of steps.entries()) {
    if (!isObject(rawStep)) {
      continue;
    }

    const lane = isNonEmptyString(rawStep.lane) ? rawStep.lane.trim() : DEFAULT_DRUM_LANES[index % DEFAULT_DRUM_LANES.length];
    const stepIndex = clamp(asInteger(rawStep.index, index), 0, Math.max(0, patternLength - 1));
    const velocity = clamp(asNumber(rawStep.velocity, 1), 0, 1);
    if (velocity <= 0) {
      continue;
    }

    const normalized = {
      lane,
      index: stepIndex,
      velocity: Number(velocity.toFixed(2)),
    };
    map.set(`${lane}:${stepIndex}`, normalized);
  }

  return Array.from(map.values()).sort((left, right) => {
    if (left.index === right.index) {
      return left.lane.localeCompare(right.lane);
    }
    return left.index - right.index;
  });
}

function normalizeMidiNotes(notes) {
  if (!Array.isArray(notes)) {
    return [];
  }

  const normalized = [];
  for (const [index, rawNote] of notes.entries()) {
    if (!isObject(rawNote)) {
      continue;
    }

    const noteId = isNonEmptyString(rawNote.id) ? rawNote.id.trim() : `note_${index + 1}`;
    const start = Math.max(0, roundToStep(asNumber(rawNote.start, 0)));
    const length = Math.max(GRID_STEP, roundToStep(asNumber(rawNote.length, 1 / 4)));
    const pitch = clamp(asInteger(rawNote.pitch, 36), 0, 127);
    const velocity = clamp(asNumber(rawNote.velocity, 0.8), 0, 1);

    normalized.push({
      id: noteId,
      start,
      length,
      pitch,
      velocity: Number(velocity.toFixed(2)),
    });
  }

  return normalized;
}

function normalizePattern(pattern, index = 0) {
  const safePattern = isObject(pattern) ? pattern : {};
  const id = isNonEmptyString(safePattern.id) ? safePattern.id.trim() : `pattern_${index + 1}`;
  const normalizedType = safePattern.type === 'drum' || safePattern.type === 'midi'
    ? safePattern.type
    : Array.isArray(safePattern.steps)
      ? 'drum'
      : 'midi';
  const length = Math.max(1, asInteger(safePattern.length, DEFAULT_PATTERN_LENGTH));
  const swing = clamp(asNumber(safePattern.swing, 0), 0, 0.95);

  if (normalizedType === 'drum') {
    return {
      id,
      type: 'drum',
      length,
      swing: Number(swing.toFixed(3)),
      steps: normalizeDrumSteps(safePattern.steps, length),
    };
  }

  return {
    id,
    type: 'midi',
    length,
    swing: Number(swing.toFixed(3)),
    notes: normalizeMidiNotes(safePattern.notes),
  };
}

function normalizeClip(clip, trackId, clipIndex) {
  const safeClip = isObject(clip) ? clip : {};
  const id = isNonEmptyString(safeClip.id) ? safeClip.id.trim() : `clip_${trackId}_${clipIndex + 1}`;
  const start = Math.max(0, roundToStep(asNumber(safeClip.start, 0)));
  const length = Math.max(GRID_STEP, roundToStep(asNumber(safeClip.length, 1)));
  const patternId = getClipPatternId(safeClip);
  const sourceNameRaw = safeClip.source_name ?? safeClip.sourceName ?? safeClip.file_name ?? safeClip.fileName ?? safeClip.filename ?? safeClip.name;
  const sourceName = isNonEmptyString(sourceNameRaw) ? sourceNameRaw.trim().slice(0, 255) : '';
  const sourceMimeRaw = safeClip.source_mime ?? safeClip.sourceMime ?? safeClip.mime;
  const sourceMime = isNonEmptyString(sourceMimeRaw) ? sourceMimeRaw.trim().toLowerCase().slice(0, 96) : '';
  const sourceFormatRaw = safeClip.source_format ?? safeClip.sourceFormat ?? safeClip.format;
  const sourceFormat = normalizeImportedFormat(
    sourceFormatRaw || getFileExtension(sourceName),
  );
  const rawClipType = normalizeClipType(safeClip.type ?? safeClip.clip_type ?? safeClip.clipType);
  const clipType = rawClipType || inferClipTypeFromFormat(sourceFormat);
  const sourceSizeBytesRaw = asNumber(safeClip.source_size_bytes ?? safeClip.sourceSizeBytes ?? safeClip.size_bytes ?? safeClip.sizeBytes, NaN);
  const sourceSizeBytes = Number.isFinite(sourceSizeBytesRaw) && sourceSizeBytesRaw >= 0
    ? Math.round(sourceSizeBytesRaw)
    : null;
  const sourceDurationSecondsRaw = asNumber(
    safeClip.source_duration_seconds ?? safeClip.sourceDurationSeconds ?? safeClip.duration_seconds ?? safeClip.durationSeconds,
    NaN,
  );
  const sourceDurationSeconds = Number.isFinite(sourceDurationSecondsRaw) && sourceDurationSecondsRaw > 0
    ? Number(sourceDurationSecondsRaw.toFixed(6))
    : null;
  const waveformPeaks = normalizeWaveformPeaks(safeClip.waveform_peaks ?? safeClip.waveformPeaks ?? safeClip.waveform ?? []);
  const sourcePathRaw = safeClip.source_path ?? safeClip.sourcePath ?? safeClip.file_path ?? safeClip.filePath;
  const sourcePath = isNonEmptyString(sourcePathRaw) ? sourcePathRaw.trim() : '';

  return {
    id,
    start,
    length,
    ...(patternId ? { pattern_id: patternId } : {}),
    ...(!patternId && clipType ? { type: clipType } : {}),
    ...(sourceName ? { source_name: sourceName } : {}),
    ...(sourceFormat && IMPORTABLE_EXTENSIONS.has(sourceFormat) ? { source_format: sourceFormat } : {}),
    ...(sourceMime ? { source_mime: sourceMime } : {}),
    ...(sourceSizeBytes !== null ? { source_size_bytes: sourceSizeBytes } : {}),
    ...(sourceDurationSeconds !== null ? { source_duration_seconds: sourceDurationSeconds } : {}),
    ...(waveformPeaks.length > 0 ? { waveform_peaks: waveformPeaks } : {}),
    ...(sourcePath ? { source_path: sourcePath } : {}),
  };
}

function normalizeTrack(track, trackIndex) {
  const safeTrack = isObject(track) ? track : {};
  const trackId = Math.max(1, asInteger(safeTrack.track_id, trackIndex + 1));
  const clips = Array.isArray(safeTrack.clips)
    ? safeTrack.clips.map((clip, clipIndex) => normalizeClip(clip, trackId, clipIndex))
    : [];

  return {
    track_id: trackId,
    name: isNonEmptyString(safeTrack.name) ? safeTrack.name.trim() : `Track ${trackId}`,
    chain_collapsed: asBoolean(safeTrack.chain_collapsed ?? safeTrack.chainCollapsed, true),
    chain_enabled: asBoolean(safeTrack.chain_enabled ?? safeTrack.chainEnabled, true),
    clips,
  };
}

function normalizeMixerEntry(entry, index = 0) {
  const safeEntry = isObject(entry) ? entry : {};
  const trackId = Math.max(1, asInteger(safeEntry.track_id, index + 1));
  return {
    track_id: trackId,
    volume: clamp(asNumber(safeEntry.volume, 0.85), 0, 1.2),
    pan: clamp(asNumber(safeEntry.pan, 0), -1, 1),
    mute: asBoolean(safeEntry.mute, false),
    solo: asBoolean(safeEntry.solo, false),
    record_armed: asBoolean(safeEntry.record_armed ?? safeEntry.recordArmed, false),
  };
}

function normalizeNodeParameterSchema(schema) {
  if (!Array.isArray(schema)) {
    return [];
  }

  const normalized = [];
  const seen = new Set();
  for (const [index, rawParameter] of schema.entries()) {
    if (!isObject(rawParameter)) {
      continue;
    }

    const id = isNonEmptyString(rawParameter.id) ? rawParameter.id.trim() : `param_${index + 1}`;
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);

    const min = asNumber(rawParameter.min, 0);
    const max = asNumber(rawParameter.max, 1);
    const value = asNumber(rawParameter.value, 0);
    normalized.push({
      id,
      name: isNonEmptyString(rawParameter.name) ? rawParameter.name.trim() : id,
      min: Number(min.toFixed(6)),
      max: Number(max.toFixed(6)),
      value: Number(clamp(value, 0, 1).toFixed(6)),
    });
  }

  return normalized;
}

function normalizeNode(node, index = 0) {
  const safeNode = isObject(node) ? node : {};
  const id = isNonEmptyString(safeNode.id) ? safeNode.id.trim() : `node_${index + 1}`;
  const type = isNonEmptyString(safeNode.type) ? safeNode.type.trim() : 'node';
  const trackId = asInteger(safeNode.track_id ?? safeNode.trackId, NaN);
  const pluginIndex = asInteger(safeNode.plugin_index ?? safeNode.pluginIndex, NaN);
  const params = isObject(safeNode.params)
    ? Object.fromEntries(
      Object.entries(safeNode.params)
        .filter(([key]) => isNonEmptyString(key))
        .map(([key, value]) => {
          const nextValue = asNumber(value, NaN);
          return [key, Number.isFinite(nextValue) ? Number(clamp(nextValue, 0, 1).toFixed(6)) : value];
        }),
    )
    : {};

  return {
    ...safeNode,
    id,
    type,
    ...(isNonEmptyString(safeNode.plugin) ? { plugin: safeNode.plugin.trim() } : {}),
    ...(isNonEmptyString(safeNode.plugin_uid) ? { plugin_uid: safeNode.plugin_uid.trim() } : {}),
    ...(Number.isInteger(trackId) && trackId > 0 ? { track_id: trackId } : {}),
    ...(Number.isInteger(pluginIndex) && pluginIndex >= 0 ? { plugin_index: pluginIndex } : {}),
    ...(safeNode.bypassed !== undefined ? { bypassed: asBoolean(safeNode.bypassed, false) } : {}),
    params,
    ...(Array.isArray(safeNode.parameter_schema)
      ? { parameter_schema: normalizeNodeParameterSchema(safeNode.parameter_schema) }
      : {}),
  };
}

function collectPatternRefs(playlist) {
  const refs = new Set();
  for (const track of playlist) {
    for (const clip of track.clips || []) {
      if (isNonEmptyString(clip.pattern_id)) {
        refs.add(clip.pattern_id.trim());
      }
    }
  }
  return refs;
}

function createLegacyPatternStub(id) {
  return {
    id,
    type: 'midi',
    length: DEFAULT_PATTERN_LENGTH,
    swing: 0,
    notes: [],
  };
}

function dedupePatterns(patterns) {
  const deduped = new Map();
  for (const pattern of patterns) {
    if (!isNonEmptyString(pattern.id) || deduped.has(pattern.id)) {
      continue;
    }
    deduped.set(pattern.id, pattern);
  }
  return Array.from(deduped.values());
}

function normalizeTimeSignature(value) {
  const src = isObject(value) ? value : {};
  const numerator = clamp(asInteger(src.numerator, 4), 1, 16);
  const denominator = clamp(asInteger(src.denominator, 4), 1, 32);
  return { numerator, denominator };
}

export function normalizeProject(project) {
  const source = isObject(project) ? project : {};
  const playlist = Array.isArray(source.playlist) ? source.playlist.map((track, index) => normalizeTrack(track, index)) : [];

  const patternCandidates = Array.isArray(source.patterns)
    ? source.patterns.map((pattern, index) => normalizePattern(pattern, index))
    : [];
  const patterns = dedupePatterns(patternCandidates);
  const knownPatternIds = new Set(patterns.map((pattern) => pattern.id));

  for (const ref of collectPatternRefs(playlist)) {
    if (!knownPatternIds.has(ref)) {
      patterns.push(createLegacyPatternStub(ref));
      knownPatternIds.add(ref);
    }
  }

  return {
    version: isNonEmptyString(source.version) ? source.version.trim() : SUPPORTED_VERSION,
    project_name: isNonEmptyString(source.project_name) ? source.project_name.trim() : 'Untitled Project',
    bpm: clamp(asNumber(source.bpm, 128), 20, 300),
    playlist_view_bars: Math.round(clamp(asInteger(source.playlist_view_bars, DEFAULT_PLAYLIST_VIEW_BARS), MIN_PLAYLIST_VIEW_BARS, MAX_PLAYLIST_VIEW_BARS)),
    playlist_bar_width: Number(clamp(asNumber(source.playlist_bar_width, DEFAULT_PLAYLIST_BAR_WIDTH), MIN_PLAYLIST_BAR_WIDTH, MAX_PLAYLIST_BAR_WIDTH).toFixed(3)),
    playlist_show_track_nodes: asBoolean(source.playlist_show_track_nodes ?? source.playlistShowTrackNodes, DEFAULT_PLAYLIST_SHOW_TRACK_NODES),
    nodes: Array.isArray(source.nodes) ? source.nodes.map((node, index) => normalizeNode(node, index)) : [],
    patterns,
    playlist,
    mixer: Array.isArray(source.mixer) ? source.mixer.map((entry, index) => normalizeMixerEntry(entry, index)) : [],
  };
}

function validatePattern(pattern, patternIndex, errors) {
  if (!isObject(pattern)) {
    errors.push(`patterns[${patternIndex}] must be an object`);
    return;
  }

  if (!isNonEmptyString(pattern.id)) {
    errors.push(`patterns[${patternIndex}].id must be a non-empty string`);
  }

  if (pattern.type !== 'drum' && pattern.type !== 'midi') {
    errors.push(`patterns[${patternIndex}].type must be "drum" or "midi"`);
  }

  if (!Number.isInteger(pattern.length) || pattern.length <= 0) {
    errors.push(`patterns[${patternIndex}].length must be a positive integer`);
  }

  if (!Number.isFinite(asNumber(pattern.swing, NaN)) || pattern.swing < 0 || pattern.swing > 0.95) {
    errors.push(`patterns[${patternIndex}].swing must be a number between 0 and 0.95`);
  }

  if (pattern.type === 'drum') {
    if (!Array.isArray(pattern.steps)) {
      errors.push(`patterns[${patternIndex}].steps must be an array`);
      return;
    }

    for (const [stepIndex, step] of pattern.steps.entries()) {
      if (!isObject(step)) {
        errors.push(`patterns[${patternIndex}].steps[${stepIndex}] must be an object`);
        continue;
      }
      if (!isNonEmptyString(step.lane)) {
        errors.push(`patterns[${patternIndex}].steps[${stepIndex}].lane must be a non-empty string`);
      }
      if (!Number.isInteger(step.index) || step.index < 0 || step.index >= pattern.length) {
        errors.push(`patterns[${patternIndex}].steps[${stepIndex}].index must be within pattern length`);
      }
      if (!Number.isFinite(step.velocity) || step.velocity < 0 || step.velocity > 1) {
        errors.push(`patterns[${patternIndex}].steps[${stepIndex}].velocity must be between 0 and 1`);
      }
    }
    return;
  }

  if (!Array.isArray(pattern.notes)) {
    errors.push(`patterns[${patternIndex}].notes must be an array`);
    return;
  }

  for (const [noteIndex, note] of pattern.notes.entries()) {
    if (!isObject(note)) {
      errors.push(`patterns[${patternIndex}].notes[${noteIndex}] must be an object`);
      continue;
    }
    if (!isNonEmptyString(note.id)) {
      errors.push(`patterns[${patternIndex}].notes[${noteIndex}].id must be a non-empty string`);
    }
    if (!Number.isFinite(note.start) || note.start < 0) {
      errors.push(`patterns[${patternIndex}].notes[${noteIndex}].start must be >= 0`);
    }
    if (!Number.isFinite(note.length) || note.length <= 0) {
      errors.push(`patterns[${patternIndex}].notes[${noteIndex}].length must be > 0`);
    }
    if (!Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127) {
      errors.push(`patterns[${patternIndex}].notes[${noteIndex}].pitch must be 0-127`);
    }
    if (!Number.isFinite(note.velocity) || note.velocity < 0 || note.velocity > 1) {
      errors.push(`patterns[${patternIndex}].notes[${noteIndex}].velocity must be between 0 and 1`);
    }
  }
}

function validatePlaylist(playlist, patternIds, errors) {
  if (!Array.isArray(playlist)) {
    errors.push('playlist must be an array');
    return;
  }

  for (const [trackIndex, track] of playlist.entries()) {
    if (!isObject(track)) {
      errors.push(`playlist[${trackIndex}] must be an object`);
      continue;
    }

    if (!Number.isFinite(asNumber(track.track_id, NaN))) {
      errors.push(`playlist[${trackIndex}].track_id must be a number`);
    }
    if (track.chain_collapsed !== undefined && typeof track.chain_collapsed !== 'boolean') {
      errors.push(`playlist[${trackIndex}].chain_collapsed must be a boolean`);
    }
    if (track.chain_enabled !== undefined && typeof track.chain_enabled !== 'boolean') {
      errors.push(`playlist[${trackIndex}].chain_enabled must be a boolean`);
    }

    if (!Array.isArray(track.clips)) {
      errors.push(`playlist[${trackIndex}].clips must be an array`);
      continue;
    }

    for (const [clipIndex, clip] of track.clips.entries()) {
      if (!isObject(clip)) {
        errors.push(`playlist[${trackIndex}].clips[${clipIndex}] must be an object`);
        continue;
      }
      if (!isNonEmptyString(clip.id)) {
        errors.push(`playlist[${trackIndex}].clips[${clipIndex}].id must be a non-empty string`);
      }
      if (!Number.isFinite(clip.start) || clip.start < 0) {
        errors.push(`playlist[${trackIndex}].clips[${clipIndex}].start must be >= 0`);
      }
      if (!Number.isFinite(clip.length) || clip.length <= 0) {
        errors.push(`playlist[${trackIndex}].clips[${clipIndex}].length must be > 0`);
      }

      const patternId = getClipPatternId(clip);
      if (patternId && patternIds.size > 0 && !patternIds.has(patternId)) {
        errors.push(`playlist[${trackIndex}].clips[${clipIndex}] references unknown pattern "${patternId}"`);
      }

      if (!patternId && clip.type !== undefined && clip.type !== 'audio' && clip.type !== 'midi') {
        errors.push(`playlist[${trackIndex}].clips[${clipIndex}].type must be "audio" or "midi"`);
      }

      if (clip.source_name !== undefined && !isNonEmptyString(clip.source_name)) {
        errors.push(`playlist[${trackIndex}].clips[${clipIndex}].source_name must be a non-empty string`);
      }

      if (clip.source_format !== undefined) {
        if (!isNonEmptyString(clip.source_format)) {
          errors.push(`playlist[${trackIndex}].clips[${clipIndex}].source_format must be a non-empty string`);
        } else {
          const normalizedFormat = normalizeImportedFormat(clip.source_format);
          if (!IMPORTABLE_EXTENSIONS.has(normalizedFormat)) {
            errors.push(`playlist[${trackIndex}].clips[${clipIndex}].source_format "${clip.source_format}" is not supported`);
          }
        }
      }

      if (clip.source_mime !== undefined && !isNonEmptyString(clip.source_mime)) {
        errors.push(`playlist[${trackIndex}].clips[${clipIndex}].source_mime must be a non-empty string`);
      }

      if (clip.source_size_bytes !== undefined && (!Number.isInteger(clip.source_size_bytes) || clip.source_size_bytes < 0)) {
        errors.push(`playlist[${trackIndex}].clips[${clipIndex}].source_size_bytes must be a non-negative integer`);
      }

      if (clip.source_duration_seconds !== undefined && (!Number.isFinite(clip.source_duration_seconds) || clip.source_duration_seconds <= 0)) {
        errors.push(`playlist[${trackIndex}].clips[${clipIndex}].source_duration_seconds must be > 0`);
      }

      if (clip.waveform_peaks !== undefined) {
        if (!Array.isArray(clip.waveform_peaks)) {
          errors.push(`playlist[${trackIndex}].clips[${clipIndex}].waveform_peaks must be an array`);
        } else if (clip.waveform_peaks.length > MAX_WAVEFORM_PEAKS) {
          errors.push(`playlist[${trackIndex}].clips[${clipIndex}].waveform_peaks must have <= ${MAX_WAVEFORM_PEAKS} items`);
        } else {
          for (const [peakIndex, peak] of clip.waveform_peaks.entries()) {
            if (!Number.isFinite(peak) || peak < 0 || peak > 1) {
              errors.push(`playlist[${trackIndex}].clips[${clipIndex}].waveform_peaks[${peakIndex}] must be between 0 and 1`);
              break;
            }
          }
        }
      }

      if (clip.source_path !== undefined && !isNonEmptyString(clip.source_path)) {
        errors.push(`playlist[${trackIndex}].clips[${clipIndex}].source_path must be a non-empty string`);
      }
    }
  }
}

function validateNode(node, nodeIndex, errors) {
  if (!isObject(node)) {
    errors.push(`nodes[${nodeIndex}] must be an object`);
    return;
  }

  if (!isNonEmptyString(node.id)) {
    errors.push(`nodes[${nodeIndex}].id must be a non-empty string`);
  }

  if (!isNonEmptyString(node.type)) {
    errors.push(`nodes[${nodeIndex}].type must be a non-empty string`);
  }

  if (node.track_id !== undefined && (!Number.isInteger(node.track_id) || node.track_id <= 0)) {
    errors.push(`nodes[${nodeIndex}].track_id must be a positive integer`);
  }

  if (node.plugin_index !== undefined && (!Number.isInteger(node.plugin_index) || node.plugin_index < 0)) {
    errors.push(`nodes[${nodeIndex}].plugin_index must be a non-negative integer`);
  }

  if (node.params !== undefined && !isObject(node.params)) {
    errors.push(`nodes[${nodeIndex}].params must be an object`);
  }
  if (node.bypassed !== undefined && typeof node.bypassed !== 'boolean') {
    errors.push(`nodes[${nodeIndex}].bypassed must be a boolean`);
  }

  if (node.parameter_schema !== undefined) {
    if (!Array.isArray(node.parameter_schema)) {
      errors.push(`nodes[${nodeIndex}].parameter_schema must be an array`);
      return;
    }

    const parameterIds = new Set();
    for (const [parameterIndex, parameter] of node.parameter_schema.entries()) {
      if (!isObject(parameter)) {
        errors.push(`nodes[${nodeIndex}].parameter_schema[${parameterIndex}] must be an object`);
        continue;
      }
      if (!isNonEmptyString(parameter.id)) {
        errors.push(`nodes[${nodeIndex}].parameter_schema[${parameterIndex}].id must be a non-empty string`);
      } else if (parameterIds.has(parameter.id)) {
        errors.push(`nodes[${nodeIndex}].parameter_schema[${parameterIndex}].id must be unique`);
      } else {
        parameterIds.add(parameter.id);
      }
    }
  }
}

function validateMixerEntry(entry, entryIndex, errors) {
  if (!isObject(entry)) {
    errors.push(`mixer[${entryIndex}] must be an object`);
    return;
  }

  if (!Number.isInteger(asInteger(entry.track_id, NaN)) || asInteger(entry.track_id, 0) <= 0) {
    errors.push(`mixer[${entryIndex}].track_id must be a positive integer`);
  }

  const volume = asNumber(entry.volume, NaN);
  if (!Number.isFinite(volume) || volume < 0 || volume > 1.2) {
    errors.push(`mixer[${entryIndex}].volume must be between 0 and 1.2`);
  }

  const pan = asNumber(entry.pan, NaN);
  if (!Number.isFinite(pan) || pan < -1 || pan > 1) {
    errors.push(`mixer[${entryIndex}].pan must be between -1 and 1`);
  }

  if (entry.mute !== undefined && typeof entry.mute !== 'boolean') {
    errors.push(`mixer[${entryIndex}].mute must be a boolean`);
  }
  if (entry.solo !== undefined && typeof entry.solo !== 'boolean') {
    errors.push(`mixer[${entryIndex}].solo must be a boolean`);
  }
  if (entry.record_armed !== undefined && typeof entry.record_armed !== 'boolean') {
    errors.push(`mixer[${entryIndex}].record_armed must be a boolean`);
  }
}

export function createDefaultProject(name = 'Autumn Vibes') {
  return normalizeProject({
    version: SUPPORTED_VERSION,
    project_name: name,
    bpm: 128,
    time_signature: { numerator: 4, denominator: 4 },
    playlist_view_bars: DEFAULT_PLAYLIST_VIEW_BARS,
    playlist_bar_width: DEFAULT_PLAYLIST_BAR_WIDTH,
    playlist_show_track_nodes: DEFAULT_PLAYLIST_SHOW_TRACK_NODES,
    nodes: [
      {
        id: 'vst_1',
        type: 'vst_instrument',
        plugin: 'Serum',
        params: { cutoff: 0.8 },
      },
      {
        id: 'logic_1',
        type: 'lfo_automation',
        target: 'vst_1.cutoff',
        speed: '1/4',
      },
    ],
    patterns: [
      {
        id: 'drum_p1',
        type: 'drum',
        length: 16,
        swing: 0,
        steps: [
          { lane: 'Kick', index: 0, velocity: 1 },
          { lane: 'Kick', index: 8, velocity: 1 },
          { lane: 'Snare', index: 4, velocity: 0.95 },
          { lane: 'Snare', index: 12, velocity: 0.95 },
          { lane: 'CH', index: 2, velocity: 0.65 },
          { lane: 'CH', index: 6, velocity: 0.65 },
          { lane: 'CH', index: 10, velocity: 0.65 },
          { lane: 'CH', index: 14, velocity: 0.65 },
        ],
      },
      {
        id: 'midi_p1',
        type: 'midi',
        length: 16,
        swing: 0,
        notes: [
          { id: 'note_bass_1', start: 0, length: 1, pitch: 36, velocity: 0.88 },
          { id: 'note_bass_2', start: 1.5, length: 0.5, pitch: 38, velocity: 0.8 },
        ],
      },
    ],
    playlist: [
      {
        track_id: 1,
        name: 'Drums',
        chain_collapsed: true,
        clips: [{ id: 'clip_1_1', start: 0, length: 4, pattern_id: 'drum_p1' }],
      },
      {
        track_id: 2,
        name: 'Bass',
        chain_collapsed: true,
        clips: [{ id: 'clip_2_1', start: 0, length: 4, pattern_id: 'midi_p1' }],
      },
      {
        track_id: 3,
        name: 'Track 3',
        chain_collapsed: true,
        clips: [],
      },
    ],
    mixer: [
      { track_id: 1, volume: 0.9, pan: 0, mute: false, solo: false, record_armed: false },
      { track_id: 2, volume: 0.85, pan: 0, mute: false, solo: false, record_armed: false },
      { track_id: 3, volume: 0.85, pan: 0, mute: false, solo: false, record_armed: false },
    ],
  });
}

export function validateProject(project) {
  const errors = [];

  if (!isObject(project)) {
    return { ok: false, errors: ['Project must be an object'] };
  }

  if (!isNonEmptyString(project.project_name)) {
    errors.push('project_name must be a non-empty string');
  }

  const bpm = asNumber(project.bpm, NaN);
  if (!Number.isFinite(bpm) || bpm < 20 || bpm > 300) {
    errors.push('bpm must be a number between 20 and 300');
  }

  if (project.playlist_view_bars !== undefined) {
    const playlistViewBars = asInteger(project.playlist_view_bars, NaN);
    if (!Number.isInteger(playlistViewBars) || playlistViewBars < MIN_PLAYLIST_VIEW_BARS || playlistViewBars > MAX_PLAYLIST_VIEW_BARS) {
      errors.push(`playlist_view_bars must be an integer between ${MIN_PLAYLIST_VIEW_BARS} and ${MAX_PLAYLIST_VIEW_BARS}`);
    }
  }

  if (project.playlist_bar_width !== undefined) {
    const playlistBarWidth = asNumber(project.playlist_bar_width, NaN);
    if (!Number.isFinite(playlistBarWidth) || playlistBarWidth < MIN_PLAYLIST_BAR_WIDTH || playlistBarWidth > MAX_PLAYLIST_BAR_WIDTH) {
      errors.push(`playlist_bar_width must be a number between ${MIN_PLAYLIST_BAR_WIDTH} and ${MAX_PLAYLIST_BAR_WIDTH}`);
    }
  }

  if (project.playlist_show_track_nodes !== undefined && typeof project.playlist_show_track_nodes !== 'boolean') {
    errors.push('playlist_show_track_nodes must be a boolean');
  }

  if (!Array.isArray(project.nodes)) {
    errors.push('nodes must be an array');
  } else {
    const nodeIds = new Set();
    for (const [nodeIndex, node] of project.nodes.entries()) {
      validateNode(node, nodeIndex, errors);
      if (isObject(node) && isNonEmptyString(node.id)) {
        if (nodeIds.has(node.id)) {
          errors.push(`nodes[${nodeIndex}].id must be unique`);
        } else {
          nodeIds.add(node.id);
        }
      }
    }
  }

  const rawPatterns = project.patterns;
  if (rawPatterns !== undefined && !Array.isArray(rawPatterns)) {
    errors.push('patterns must be an array if provided');
  }

  const patterns = Array.isArray(rawPatterns) ? rawPatterns : [];
  const patternIds = new Set();
  for (const [patternIndex, pattern] of patterns.entries()) {
    validatePattern(pattern, patternIndex, errors);
    if (isObject(pattern) && isNonEmptyString(pattern.id)) {
      if (patternIds.has(pattern.id)) {
        errors.push(`patterns[${patternIndex}].id must be unique`);
      } else {
        patternIds.add(pattern.id);
      }
    }
  }

  validatePlaylist(project.playlist, patternIds, errors);

  if (project.mixer !== undefined && !Array.isArray(project.mixer)) {
    errors.push('mixer must be an array if provided');
  } else if (Array.isArray(project.mixer)) {
    for (const [mixerIndex, entry] of project.mixer.entries()) {
      validateMixerEntry(entry, mixerIndex, errors);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function serializeProject(project, spacing = 2) {
  return JSON.stringify(normalizeProject(project), null, spacing);
}

export function parseProject(raw) {
  const parsed = JSON.parse(raw);
  const normalized = normalizeProject(parsed);
  const result = validateProject(normalized);

  if (!result.ok) {
    const summary = result.errors.join('; ');
    throw new Error(`Invalid .stu project: ${summary}`);
  }

  return normalized;
}

export function getSupportedVersion() {
  return SUPPORTED_VERSION;
}
