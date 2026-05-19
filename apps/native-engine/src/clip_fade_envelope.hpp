#pragma once

#include <cstdint>
#include <string>

namespace thestuu::clipfade {

/** (u,v) fade control — same semantics as packages/shared-json/src/fade-curve.js */
struct FadeControl {
  double u = 0.52;
  double v = 0.74;
};

/** Per-clip fade envelope applied in playback (not Tracktion AudioFadeCurve types). */
struct ClipFadeEnvelope {
  double fadeInSec = 0.0;
  double fadeOutSec = 0.0;
  FadeControl fadeIn;
  FadeControl fadeOut;
};

FadeControl controlFromCurveIndex(int curveIndex);
FadeControl controlFromPresetName(const std::string& name);

double clamp01(double value);
/** localX = 0..1 horizontal position across fade region (timeline-linear, matches UI SVG). */
double gainAtFadeInLocal(double localX, double u, double v);
double gainAtFadeOutLocal(double localX, double u, double v);

}  // namespace thestuu::clipfade
