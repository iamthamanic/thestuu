/**
 * Pattern editor dock wrapper around shared PatternClipBody.
 * Location: apps/dashboard/components/pattern-editor-panel.jsx
 */

import PatternClipBody from './pattern-clip-body.jsx';

/**
 * @param {{
 *   pattern: object | null,
 *   trackId: number | null,
 *   soundLabel: string,
 *   onOpenSoundChooser: () => void,
 *   onSoundDrop: (event: DragEvent) => void,
 *   onOpenPianoRoll: () => void,
 *   onDeletePattern?: () => void,
 * }} props
 */
export default function PatternEditorPanel({
  pattern,
  trackId,
  soundLabel,
  onOpenSoundChooser,
  onSoundDrop,
  onOpenPianoRoll,
  onDeletePattern,
}) {
  if (!pattern) {
    return (
      <div className="pattern-editor-panel pattern-editor-panel-empty">
        <p className="muted">Waehle einen Pattern-Clip auf der Timeline.</p>
      </div>
    );
  }

  return (
    <div className="pattern-editor-panel">
      <PatternClipBody
        pattern={pattern}
        trackId={trackId}
        soundLabel={soundLabel}
        variant="dock"
        onOpenSoundChooser={onOpenSoundChooser}
        onSoundDrop={onSoundDrop}
        onOpenPianoRoll={onOpenPianoRoll}
        onDeletePattern={onDeletePattern}
      />
    </div>
  );
}
