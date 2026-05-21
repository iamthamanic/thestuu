/**
 * Timeline pattern clip content (re-exports PatternClipBody for playlist clips).
 * Location: apps/dashboard/components/pattern-clip-preview.jsx
 */

import PatternClipBody from './pattern-clip-body.jsx';

export default function PatternClipPreview({
  pattern = null,
  trackId = null,
  soundLabel = '',
  clipLengthBars = 1,
  clipStartBars = 0,
  timelineBarWidthPx = 0,
  clipToolsMenuActive = false,
  onOpenSoundChooser,
  onSoundDrop,
  onOpenPianoRoll,
  onDeleteClip,
  onOpenClipTools,
}) {
  if (!pattern) {
    return <div className="pattern-clip-body pattern-clip-body--timeline pattern-clip-body-empty" aria-hidden="true" />;
  }

  return (
    <PatternClipBody
      pattern={pattern}
      trackId={trackId}
      soundLabel={soundLabel}
      variant="clip"
      clipLengthBars={clipLengthBars}
      clipStartBars={clipStartBars}
      timelineBarWidthPx={timelineBarWidthPx}
      clipToolsMenuActive={clipToolsMenuActive}
      onOpenSoundChooser={onOpenSoundChooser}
      onSoundDrop={onSoundDrop}
      onOpenPianoRoll={onOpenPianoRoll}
      onDeleteClip={onDeleteClip}
      onOpenClipTools={onOpenClipTools}
    />
  );
}
