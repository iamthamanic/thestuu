/**
 * Vertical peak meter (0–1): Mix strip (tall) or Arrangement row (compact).
 * Optional FL-style green / yellow / red gradient via CSS modifiers.
 * Location: apps/dashboard/components — consumed by stuu-shell Mix + Arrangement meters.
 */

export default function LevelMeter({ value, variant = 'mix', graded = true, ariaLabel = undefined }) {
  const v = Number(value);
  const pct = Math.round(Math.min(100, Math.max(0, Number.isFinite(v) ? v * 100 : 0)));
  const wrapClass = variant === 'arrangement' ? 'arrangement-track-meter' : 'mix-strip-meter';
  const fillClass =
    variant === 'arrangement'
      ? `arrangement-track-meter-fill${graded ? ' arrangement-track-meter-fill--graded' : ''}`
      : `mix-strip-meter-fill${graded ? ' mix-strip-meter-fill--graded' : ''}`;

  const a11y =
    variant === 'arrangement' && typeof ariaLabel === 'string' && ariaLabel.trim()
      ? { role: 'img', 'aria-label': ariaLabel.trim() }
      : {};

  return (
    <div className={wrapClass} {...a11y}>
      <div className={fillClass} style={{ height: `${pct}%` }} />
    </div>
  );
}
