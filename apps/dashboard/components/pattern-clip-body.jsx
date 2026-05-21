/**
 * Shared pattern clip UI: header (add Sound), piano roll preview (timeline clip + dock).
 * Location: apps/dashboard/components/pattern-clip-body.jsx
 */

import { useMemo } from 'react';
import { ChevronDown, Piano, Trash2 } from 'lucide-react';
import { patternLoopBars } from '@thestuu/shared-json';
import PianoRollView from './piano-roll-view.jsx';
import { DEFAULT_STEPS_PER_BAR } from '../lib/piano-roll-layout.js';
import {
  expandPatternNotesForClipLength,
  playlistGridPhaseOffsetPx,
} from '../lib/playlist-grid-sync.js';

/**
 * @param {{
 *   pattern: object,
 *   notes?: Array<object> | null,
 *   trackId?: number | null,
 *   soundLabel?: string,
 *   variant?: 'dock' | 'clip',
 *   clipLengthBars?: number,
 *   clipStartBars?: number,
 *   timelineBarWidthPx?: number,
 *   clipToolsMenuActive?: boolean,
 *   onOpenSoundChooser: () => void,
 *   onSoundDrop: (event: DragEvent) => void,
 *   onOpenPianoRoll: () => void,
 *   onDeletePattern?: () => void,
 *   onDeleteClip?: () => void,
 *   onOpenClipTools?: (event: React.MouseEvent) => void,
 * }} props
 */
export default function PatternClipBody({
  pattern,
  notes: notesOverride = null,
  trackId = null,
  soundLabel = '',
  variant = 'dock',
  clipLengthBars = 1,
  clipStartBars = 0,
  timelineBarWidthPx = 0,
  clipToolsMenuActive = false,
  onOpenSoundChooser,
  onSoundDrop,
  onOpenPianoRoll,
  onDeletePattern,
  onDeleteClip,
  onOpenClipTools,
}) {
  const patternName = typeof pattern?.name === 'string' && pattern.name.trim()
    ? pattern.name.trim()
    : 'Pattern';
  const loopBars = patternLoopBars(pattern);
  const barCount = variant === 'clip'
    ? Math.max(1, Math.min(64, Math.round(Number(clipLengthBars) || loopBars)))
    : Math.max(1, Math.min(64, Math.round(loopBars)));
  const rawNotes = Array.isArray(notesOverride)
    ? notesOverride
    : (Array.isArray(pattern?.notes) ? pattern.notes : []);
  const isClip = variant === 'clip';
  const syncPlaylistGrid = isClip && Number(timelineBarWidthPx) > 0;
  const notes = useMemo(() => {
    if (!syncPlaylistGrid) {
      return rawNotes;
    }
    return expandPatternNotesForClipLength(rawNotes, loopBars, barCount);
  }, [syncPlaylistGrid, rawNotes, loopBars, barCount]);
  const gridPhaseOffsetPx = syncPlaylistGrid
    ? playlistGridPhaseOffsetPx(clipStartBars, timelineBarWidthPx)
    : 0;
  const rootClass = `pattern-clip-body${isClip ? ' pattern-clip-body--timeline' : ' pattern-clip-body--dock'}`;

  const handleTrash = onDeleteClip || onDeletePattern;

  return (
    <div className={rootClass}>
      <header className="pattern-clip-body-head">
        <div className="pattern-clip-body-head-left">
          {handleTrash ? (
            <button
              type="button"
              className="pattern-clip-body-icon-btn danger"
              onPointerDown={(event) => {
                event.stopPropagation();
                event.preventDefault();
              }}
              onClick={(event) => {
                event.stopPropagation();
                handleTrash();
              }}
              aria-label={onDeleteClip ? 'Clip entfernen' : 'Pattern loeschen'}
              title={onDeleteClip ? 'Clip entfernen' : 'Pattern loeschen'}
            >
              <Trash2 size={isClip ? 10 : 14} strokeWidth={2} aria-hidden="true" />
            </button>
          ) : null}
          {isClip && onOpenClipTools ? (
            <button
              type="button"
              className={`pattern-clip-body-icon-btn${clipToolsMenuActive ? ' active' : ''}`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onOpenClipTools(event);
              }}
              aria-label="Clip Tools"
              title="Clip Tools"
              aria-haspopup="menu"
              aria-expanded={clipToolsMenuActive}
            >
              <ChevronDown size={10} strokeWidth={2} aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              className="pattern-clip-body-icon-btn"
              aria-label="Pattern Menue"
              disabled
              onPointerDown={(event) => event.stopPropagation()}
            >
              <ChevronDown size={isClip ? 10 : 14} strokeWidth={2} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className="pattern-clip-body-add-sound"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onOpenSoundChooser();
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'copy';
            }}
            onDrop={(event) => {
              event.stopPropagation();
              onSoundDrop(event);
            }}
          >
            {soundLabel ? (
              <span className="pattern-clip-body-sound-label" title={soundLabel}>{soundLabel}</span>
            ) : (
              <span className="pattern-clip-body-add-sound-placeholder">add Sound</span>
            )}
          </button>
          <span className="pattern-clip-body-title" title={patternName}>{patternName}</span>
        </div>
        <button
          type="button"
          className="pattern-clip-body-icon-btn"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onOpenPianoRoll();
          }}
          aria-label="Piano Roll oeffnen"
          title="Piano Roll"
        >
          <Piano size={isClip ? 12 : 16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </header>
      <div className="pattern-clip-body-main">
        <PianoRollView
          notes={notes}
          totalBars={barCount}
          stepsPerBar={DEFAULT_STEPS_PER_BAR}
          variant="mini"
          syncPlaylistGrid={syncPlaylistGrid}
          timelineBarWidthPx={timelineBarWidthPx}
          gridPhaseOffsetPx={gridPhaseOffsetPx}
          clipStartBars={clipStartBars}
          clipLengthBars={barCount}
          patternLoopBars={loopBars}
          onRequestOpen={isClip ? undefined : onOpenPianoRoll}
        />
        {!isClip && trackId != null ? (
          <span className="pattern-clip-body-preview-meta muted">Track {trackId} · {notes.length} notes</span>
        ) : null}
      </div>
    </div>
  );
}
