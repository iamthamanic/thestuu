#include <cmath>
#include <mutex>
#include <unordered_map>

#include <tracktion_engine/tracktion_engine.h>
#include <tracktion_graph/utilities/tracktion_GlueCode.h>

#include "clip_fade_envelope.hpp"
#include "thestuu_clip_fade_apply.h"

namespace thestuu::clipfade {

namespace {

std::mutex gEnvelopeMutex;
std::unordered_map<const void*, ClipFadeEnvelope> gEnvelopes;

const void* clipKey(const tracktion::AudioClipBase& clip) {
  return static_cast<const void*>(&clip);
}

namespace detail {

struct QuadPoint {
  double x = 0.0;
  double y = 0.0;
};

QuadPoint quadBezierPoint(double t, double x0, double y0, double x1, double y1, double x2, double y2) {
  const double u = 1.0 - t;
  const double tt = t * t;
  const double uu = u * u;
  return {
    uu * x0 + 2.0 * u * t * x1 + tt * x2,
    uu * y0 + 2.0 * u * t * y1 + tt * y2,
  };
}

double solveBezierTForX(double targetX, double x0, double y0, double x1, double y1, double x2, double y2) {
  const auto xAt = [&](double t) { return quadBezierPoint(t, x0, y0, x1, y1, x2, y2).x; };
  const double xStart = xAt(0.0);
  const double xEnd = xAt(1.0);
  const bool increasing = xEnd >= xStart;
  const double tx = std::min(std::max(targetX, std::min(xStart, xEnd)), std::max(xStart, xEnd));
  double lo = 0.0;
  double hi = 1.0;
  for (int i = 0; i < 24; ++i) {
    const double mid = (lo + hi) * 0.5;
    const double x = xAt(mid);
    if (increasing) {
      if (x < tx) {
        lo = mid;
      } else {
        hi = mid;
      }
    } else if (x > tx) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) * 0.5;
}

void applyEnvelopeToSection(
  choc::buffer::ChannelArrayView<float> audio,
  tracktion::core::TimeRange editTime,
  tracktion::core::TimeRange clipPos,
  tracktion::core::TimeRange fadeIn,
  tracktion::core::TimeRange fadeOut,
  const ClipFadeEnvelope& env,
  bool clearExtraSamples) {
  const int numSamples = static_cast<int>(audio.getNumFrames());
  if (numSamples <= 0) {
    return;
  }

  const double clipStart = clipPos.getStart().inSeconds();
  const double clipEnd = clipPos.getEnd().inSeconds();
  const double clipLen = clipEnd - clipStart;
  double fadeInFrac = (clipLen > 0.0) ? (env.fadeInSec / clipLen) : 0.0;
  double fadeOutFrac = (clipLen > 0.0) ? (env.fadeOutSec / clipLen) : 0.0;
  fadeInFrac = clamp01(fadeInFrac);
  fadeOutFrac = clamp01(fadeOutFrac);
  if (fadeInFrac + fadeOutFrac > 1.0) {
    const double scale = 1.0 / (fadeInFrac + fadeOutFrac);
    fadeInFrac *= scale;
    fadeOutFrac *= scale;
  }
  const double editStart = editTime.getStart().inSeconds();
  const double editLen = editTime.getLength().inSeconds();
  auto buffer = tracktion::graph::toAudioBuffer(audio);

  for (int i = 0; i < numSamples; ++i) {
    const double frac = (static_cast<double>(i) + 0.5) / static_cast<double>(numSamples);
    const double tSec = editStart + editLen * frac;

    double gain = 1.0;
    if (clipLen > 0.0) {
      const double p = (tSec - clipStart) / clipLen;
      if (p >= 0.0 && p <= 1.0) {
        if (fadeInFrac > 0.0 && p < fadeInFrac) {
          gain = thestuu::clipfade::gainAtFadeInLocal(p / fadeInFrac, env.fadeIn.u, env.fadeIn.v);
        }
        if (fadeOutFrac > 0.0 && p > 1.0 - fadeOutFrac) {
          gain *= thestuu::clipfade::gainAtFadeOutLocal((1.0 - p) / fadeOutFrac, env.fadeOut.u, env.fadeOut.v);
        }
      } else if (clearExtraSamples) {
        gain = 0.0;
      }
    }

    const float g = static_cast<float>(gain);
    for (int ch = 0; ch < buffer.getNumChannels(); ++ch) {
      buffer.getWritePointer(ch)[i] *= g;
    }
  }
}

}  // namespace detail

}  // namespace

double clamp01(double value) {
  return std::min(1.0, std::max(0.0, value));
}

FadeControl controlFromCurveIndex(int curveIndex) {
  switch (curveIndex) {
    case 2:
      return {0.68, 0.94};
    case 3:
      return {0.35, 0.48};
    case 4:
      return {0.52, 0.62};
    default:
      return {0.52, 0.74};
  }
}

FadeControl controlFromPresetName(const std::string& name) {
  if (name == "convex") {
    return controlFromCurveIndex(2);
  }
  if (name == "concave") {
    return controlFromCurveIndex(3);
  }
  if (name == "sCurve" || name == "scurve") {
    return controlFromCurveIndex(4);
  }
  return controlFromCurveIndex(1);
}

double gainAtFadeInLocal(double localX, double u, double v) {
  const double cx = clamp01(u);
  const double cy = clamp01(v);
  const double t = detail::solveBezierTForX(clamp01(localX), 0.0, 1.0, cx, cy, 1.0, 0.0);
  const detail::QuadPoint pt = detail::quadBezierPoint(t, 0.0, 1.0, cx, cy, 1.0, 0.0);
  return clamp01(1.0 - pt.y);
}

double gainAtFadeOutLocal(double localX, double u, double v) {
  const double cx = 1.0 - clamp01(u);
  const double cy = clamp01(v);
  const double targetX = 1.0 - clamp01(localX);
  const double t = detail::solveBezierTForX(targetX, 1.0, 1.0, cx, cy, 0.0, 0.0);
  const detail::QuadPoint pt = detail::quadBezierPoint(t, 1.0, 1.0, cx, cy, 0.0, 0.0);
  return clamp01(1.0 - pt.y);
}

void setEnvelopeForClip(const tracktion::AudioClipBase& clip, ClipFadeEnvelope envelope) {
  std::lock_guard<std::mutex> lock(gEnvelopeMutex);
  gEnvelopes[clipKey(clip)] = std::move(envelope);
}

void clearEnvelopeForClip(const tracktion::AudioClipBase& clip) {
  std::lock_guard<std::mutex> lock(gEnvelopeMutex);
  gEnvelopes.erase(clipKey(clip));
}

bool getEnvelopeForClip(const tracktion::AudioClipBase& clip, ClipFadeEnvelope& out) {
  std::lock_guard<std::mutex> lock(gEnvelopeMutex);
  const auto it = gEnvelopes.find(clipKey(clip));
  if (it == gEnvelopes.end()) {
    return false;
  }
  out = it->second;
  return true;
}

namespace {

tracktion::engine::AudioFadeCurve::Type fadeCurveTypeFromIndex(int curveIndex) {
  switch (curveIndex) {
    case 2:
      return tracktion::engine::AudioFadeCurve::convex;
    case 3:
      return tracktion::engine::AudioFadeCurve::concave;
    case 4:
      return tracktion::engine::AudioFadeCurve::sCurve;
    default:
      return tracktion::engine::AudioFadeCurve::linear;
  }
}

}  // namespace

void syncTracktionClipFades(
  tracktion::AudioClipBase& clip,
  const ClipFadeEnvelope& env,
  int fadeInCurve,
  int fadeOutCurve) {
  clip.setAutoCrossfade(false);
  clip.setFadeInBehaviour(tracktion::engine::AudioClipBase::gainFade);
  clip.setFadeOutBehaviour(tracktion::engine::AudioClipBase::gainFade);
  clip.setFadeIn(tracktion::core::TimeDuration::fromSeconds(env.fadeInSec));
  clip.setFadeOut(tracktion::core::TimeDuration::fromSeconds(env.fadeOutSec));
  clip.setFadeInType(fadeCurveTypeFromIndex(fadeInCurve));
  clip.setFadeOutType(fadeCurveTypeFromIndex(fadeOutCurve));
}

TheStuuFadeEnvPOD toFadeEnvPOD(const ClipFadeEnvelope& env) {
  return TheStuuFadeEnvPOD{
    env.fadeInSec,
    env.fadeOutSec,
    env.fadeIn.u,
    env.fadeIn.v,
    env.fadeOut.u,
    env.fadeOut.v,
  };
}

}  // namespace thestuu::clipfade

extern "C" void thestuu_apply_envelope_to_audio(
  float* const* channelData,
  int32_t numChannels,
  int32_t numSamples,
  double editStartSec,
  double editLenSec,
  double clipStartSec,
  double clipEndSec,
  double fadeInStartSec,
  double fadeInEndSec,
  double fadeOutStartSec,
  double fadeOutEndSec,
  const struct TheStuuFadeEnvPOD* env,
  int32_t clearOutside) {
  if (channelData == nullptr || numChannels <= 0 || numSamples <= 0 || env == nullptr) {
    return;
  }

  const double clipLen = clipEndSec - clipStartSec;
  double fadeInFrac = (clipLen > 0.0) ? (env->fadeInSec / clipLen) : 0.0;
  double fadeOutFrac = (clipLen > 0.0) ? (env->fadeOutSec / clipLen) : 0.0;
  fadeInFrac = thestuu::clipfade::clamp01(fadeInFrac);
  fadeOutFrac = thestuu::clipfade::clamp01(fadeOutFrac);
  if (fadeInFrac + fadeOutFrac > 1.0) {
    const double scale = 1.0 / (fadeInFrac + fadeOutFrac);
    fadeInFrac *= scale;
    fadeOutFrac *= scale;
  }

  for (int32_t i = 0; i < numSamples; ++i) {
    const double frac = (static_cast<double>(i) + 0.5) / static_cast<double>(numSamples);
    const double tSec = editStartSec + editLenSec * frac;

    double gain = 1.0;
    if (clipLen > 0.0) {
      const double p = (tSec - clipStartSec) / clipLen;
      if (p >= 0.0 && p <= 1.0) {
        if (fadeInFrac > 0.0 && p < fadeInFrac) {
          gain = thestuu::clipfade::gainAtFadeInLocal(p / fadeInFrac, env->inU, env->inV);
        }
        if (fadeOutFrac > 0.0 && p > 1.0 - fadeOutFrac) {
          gain *= thestuu::clipfade::gainAtFadeOutLocal((1.0 - p) / fadeOutFrac, env->outU, env->outV);
        }
      } else if (clearOutside != 0) {
        gain = 0.0;
      }
    }

    const float g = static_cast<float>(gain);
    for (int32_t ch = 0; ch < numChannels; ++ch) {
      channelData[ch][i] *= g;
    }
  }
}

extern "C" int32_t thestuu_lookup_clip_fade_envelope(const void* clipInstance, TheStuuFadeEnvPOD* out) {
  if (clipInstance == nullptr || out == nullptr) {
    return 0;
  }
  thestuu::clipfade::ClipFadeEnvelope env;
  if (!thestuu::clipfade::getEnvelopeForClip(*static_cast<const tracktion::AudioClipBase*>(clipInstance), env)) {
    return 0;
  }
  if (env.fadeInSec <= 0.0 && env.fadeOutSec <= 0.0) {
    return 0;
  }
  *out = thestuu::clipfade::toFadeEnvPOD(env);
  return 1;
}
