#pragma once

#include <tracktion_engine/tracktion_engine.h>

#include "clip_fade_envelope.hpp"
#include "thestuu_clip_fade_apply.h"

namespace thestuu::clipfade {

void setEnvelopeForClip(const tracktion::AudioClipBase& clip, ClipFadeEnvelope envelope);
void clearEnvelopeForClip(const tracktion::AudioClipBase& clip);
bool getEnvelopeForClip(const tracktion::AudioClipBase& clip, ClipFadeEnvelope& out);
/** Push sidecar fade lengths/curve presets to the clip for Tracktion FadeInOutNode playback. */
void syncTracktionClipFades(
  tracktion::AudioClipBase& clip,
  const ClipFadeEnvelope& env,
  int fadeInCurve,
  int fadeOutCurve);

TheStuuFadeEnvPOD toFadeEnvPOD(const ClipFadeEnvelope& env);

}  // namespace thestuu::clipfade
