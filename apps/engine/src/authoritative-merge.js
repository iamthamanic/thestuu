/**
 * Merge JSON sidecar project (patterns/view/UI) with native export (arrangement/mixer).
 * DAW-authoritative: native export wins arrangement; JSON sidecar preserves ids + UI-only fields.
 * Location: apps/engine/src (used by project:load/save). See docs/daw-authority-guardrails.md.
 */

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {object} jsonProject - parsed .stu project (patterns, view, names)
 * @param {object} nativeExport - project.export response from native-engine
 * @returns {object} merged project for state.project
 */
export function mergeAuthoritativeProjectState(jsonProject, nativeExport) {
  const base = isObject(jsonProject) ? { ...jsonProject } : {};
  const native = isObject(nativeExport) ? nativeExport : {};
  const bpm = Number(base.bpm) || 120;

  const nativeTracks = Array.isArray(native.tracks) ? native.tracks : [];
  const jsonPlaylist = Array.isArray(base.playlist) ? base.playlist : [];
  const jsonById = new Map();
  for (const track of jsonPlaylist) {
    const trackId = Number(track?.track_id);
    if (Number.isInteger(trackId) && trackId > 0) {
      jsonById.set(trackId, track);
    }
  }

  const playlist = [];
  for (const row of nativeTracks) {
    const trackId = Number(row.track_id ?? row.trackId ?? row.id);
    if (!Number.isInteger(trackId) || trackId < 1) {
      continue;
    }
    const previous = jsonById.get(trackId);
    const name = typeof row.name === 'string' && row.name.trim()
      ? row.name.trim()
      : (previous?.name || `Track ${trackId}`);
    if (previous) {
      playlist.push({
        ...previous,
        track_id: trackId,
        name,
        clips: Array.isArray(previous.clips) ? previous.clips : [],
      });
    } else {
      playlist.push({
        track_id: trackId,
        name,
        clips: [],
        chain_collapsed: true,
        chain_enabled: true,
      });
    }
  }

  const BEATS_PER_BAR = 4;
  const nativeClips = Array.isArray(native.clips) ? native.clips : [];
  const clipsByTrack = new Map();
  const usedJsonAudioClipIds = new Set();
  for (const clip of nativeClips) {
    const trackId = Number(clip.track_id ?? clip.trackId);
    const sourcePath = typeof clip.source_path === 'string'
      ? clip.source_path
      : (typeof clip.sourcePath === 'string' ? clip.sourcePath : '');
    const startSeconds = Number(clip.start_seconds ?? clip.startSeconds);
    const lengthSeconds = Number(clip.length_seconds ?? clip.lengthSeconds);
    if (!Number.isInteger(trackId) || trackId < 1 || !sourcePath || !Number.isFinite(startSeconds) || !Number.isFinite(lengthSeconds) || lengthSeconds <= 0) {
      continue;
    }
    const startBars = Number(((startSeconds * bpm) / (60 * BEATS_PER_BAR)).toFixed(6));
    const lengthBars = Number(((lengthSeconds * bpm) / (60 * BEATS_PER_BAR)).toFixed(6));
    const previousTrack = jsonById.get(trackId);
    const jsonAudioClips = (Array.isArray(previousTrack?.clips) ? previousTrack.clips : [])
      .filter((entry) => String(entry?.type || '').toLowerCase() === 'audio');
    const jsonWithSamePath = jsonAudioClips.filter((entry) => {
      const jsonPath = entry.source_path || entry.sourcePath || '';
      return jsonPath && jsonPath === sourcePath && !usedJsonAudioClipIds.has(entry.id);
    });
    const matchedJsonClip = jsonWithSamePath.length === 1
      ? jsonWithSamePath[0]
      : jsonWithSamePath.find((entry) => Math.abs(Number(entry.start) - startBars) < 0.5);
    if (matchedJsonClip?.id) {
      usedJsonAudioClipIds.add(matchedJsonClip.id);
    }
    const audioClip = matchedJsonClip
      ? {
        ...matchedJsonClip,
        type: 'audio',
        start: Number.isFinite(Number(matchedJsonClip.start)) ? Number(matchedJsonClip.start) : startBars,
        length: Number.isFinite(Number(matchedJsonClip.length)) ? Number(matchedJsonClip.length) : lengthBars,
        source_path: sourcePath,
        source_name: clip.name || matchedJsonClip.source_name || sourcePath.split('/').pop(),
      }
      : {
        id: `clip-${trackId}-${startBars}-${sourcePath.split('/').pop()}`,
        type: 'audio',
        start: startBars,
        length: lengthBars,
        source_path: sourcePath,
        source_name: clip.name || sourcePath.split('/').pop(),
      };
    if (!clipsByTrack.has(trackId)) {
      clipsByTrack.set(trackId, []);
    }
    clipsByTrack.get(trackId).push(audioClip);
  }

  for (const track of playlist) {
    const audioClips = clipsByTrack.get(Number(track.track_id)) || [];
    const patternClips = (Array.isArray(track.clips) ? track.clips : []).filter((c) => String(c?.type || '').toLowerCase() !== 'audio');
    track.clips = [...patternClips, ...audioClips];
  }

  const jsonMixer = Array.isArray(base.mixer) ? base.mixer : [];
  const mixerById = new Map(jsonMixer.map((e) => [Number(e.track_id), e]));
  const mixer = [];
  const nativeMixer = Array.isArray(native.mixer) ? native.mixer : [];
  for (const row of nativeMixer) {
    const trackId = Number(row.track_id ?? row.trackId);
    if (!Number.isInteger(trackId) || trackId < 1) {
      continue;
    }
    const previous = mixerById.get(trackId);
    mixer.push({
      track_id: trackId,
      volume: Number.isFinite(Number(row.volume)) ? Number(row.volume) : (previous?.volume ?? 0.85),
      pan: Number.isFinite(Number(row.pan)) ? Number(row.pan) : (previous?.pan ?? 0),
      mute: Boolean(row.mute),
      solo: Boolean(row.solo),
      record_armed: Boolean(row.record_armed ?? row.recordArmed),
      record_input_device_id: previous?.record_input_device_id ?? null,
      record_input_device_name: previous?.record_input_device_name ?? null,
    });
  }

  const masterMix = isObject(base.master_mix) ? { ...base.master_mix } : { volume: 1, pan: 0, mute: false, chain_enabled: true };
  if (Number.isFinite(Number(native.master_volume ?? native.masterVolume))) {
    masterMix.volume = Number(native.master_volume ?? native.masterVolume);
  }
  if (Number.isFinite(Number(native.master_pan ?? native.masterPan))) {
    masterMix.pan = Number(native.master_pan ?? native.masterPan);
  }

  return {
    ...base,
    playlist,
    mixer,
    master_mix: masterMix,
    patterns: Array.isArray(base.patterns) ? base.patterns : [],
    nodes: Array.isArray(base.nodes) ? base.nodes : [],
  };
}

/**
 * Build native import payload from JSON project (audio clips + mixer + tracks).
 * @param {object} project
 */
export function buildNativeImportFromProject(project) {
  const bpm = Number(project?.bpm) || 120;
  const BEATS_PER_BAR = 4;
  const tracks = (Array.isArray(project?.playlist) ? project.playlist : [])
    .map((track) => ({
      track_id: Number(track.track_id),
      name: track.name || `Track ${track.track_id}`,
    }))
    .filter((row) => Number.isInteger(row.track_id) && row.track_id > 0);

  const clips = [];
  for (const track of Array.isArray(project?.playlist) ? project.playlist : []) {
    const trackId = Number(track.track_id);
    if (!Number.isInteger(trackId) || trackId < 1 || !Array.isArray(track.clips)) {
      continue;
    }
    for (const clip of track.clips) {
      if (String(clip?.type || '').toLowerCase() !== 'audio') {
        continue;
      }
      const sourcePath = clip.source_path || clip.sourcePath || clip.path;
      if (!sourcePath || typeof sourcePath !== 'string') {
        continue;
      }
      const startBars = Number(clip.start) || 0;
      const lengthBars = Number(clip.length) || 0;
      if (lengthBars <= 0) {
        continue;
      }
      const startSeconds = (startBars * BEATS_PER_BAR * 60) / bpm;
      const lengthSeconds = (lengthBars * BEATS_PER_BAR * 60) / bpm;
      clips.push({
        track_id: trackId,
        source_path: sourcePath,
        start_seconds: startSeconds,
        length_seconds: lengthSeconds,
        name: clip.source_name || clip.name || '',
      });
    }
  }

  const mixer = (Array.isArray(project?.mixer) ? project.mixer : []).map((entry) => ({
    track_id: Number(entry.track_id),
    volume: Number(entry.volume),
    pan: Number(entry.pan),
    mute: Boolean(entry.mute),
    solo: Boolean(entry.solo),
    record_armed: Boolean(entry.record_armed),
  })).filter((row) => Number.isInteger(row.track_id) && row.track_id > 0);

  return {
    tracks,
    clips,
    mixer,
    master_volume: Number(project?.master_mix?.volume ?? 1),
    master_pan: Number(project?.master_mix?.pan ?? 0),
  };
}
