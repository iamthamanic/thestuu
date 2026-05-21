/**
 * Pattern clip preview playback synced to engine transport (FL-style scheduling).
 * Location: apps/dashboard/hooks/use-pattern-playback.js
 */

import { useEffect, useRef } from 'react';
import { schedulePatternNoteOns } from '@thestuu/shared-json';
import { PatternPlaybackAudio } from '../lib/pattern-playback-audio.js';

/**
 * @param {{
 *   enabled?: boolean,
 *   getTransportSnapshot: () => { playing?: boolean, positionBars?: number, bpm?: number } | null,
 *   playlist: Array<object>,
 *   patternsById: Map<string, object>,
 *   patternNotesDraft?: { patternId: string, notes: Array<object> } | null,
 * }} options
 */
export function usePatternPlayback({
  enabled = false,
  getTransportSnapshot,
  playlist,
  patternsById,
  patternNotesDraft = null,
}) {
  const audioRef = useRef(null);
  const prevPosRef = useRef(0);
  const rafRef = useRef(0);

  useEffect(() => {
    if (!enabled) {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
      audioRef.current?.suspend();
      return undefined;
    }

    if (!audioRef.current) {
      audioRef.current = new PatternPlaybackAudio();
    }

    const patternsWithDraft = new Map(patternsById);
    if (patternNotesDraft?.patternId && patternsWithDraft.has(patternNotesDraft.patternId)) {
      const base = patternsWithDraft.get(patternNotesDraft.patternId);
      patternsWithDraft.set(patternNotesDraft.patternId, {
        ...base,
        notes: patternNotesDraft.notes,
      });
    }

    const tick = () => {
      const snap = typeof getTransportSnapshot === 'function' ? getTransportSnapshot() : null;
      const playing = Boolean(snap?.playing);
      const pos = Math.max(0, Number(snap?.positionBars) || 0);
      const bpm = Math.max(20, Number(snap?.bpm) || 120);

      if (!playing) {
        prevPosRef.current = pos;
        audioRef.current?.suspend();
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      audioRef.current?.ensureContext();

      const prev = prevPosRef.current;
      const noteOns = schedulePatternNoteOns({
        playlist,
        patternsById: patternsWithDraft,
        positionBars: pos,
        prevPositionBars: prev,
      });

      for (const hit of noteOns) {
        audioRef.current?.playNote(hit.note, bpm);
      }

      prevPosRef.current = pos;
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
    };
  }, [enabled, getTransportSnapshot, playlist, patternsById, patternNotesDraft]);
}
