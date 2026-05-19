#pragma once

#include <cstdint>

#ifdef __cplusplus
extern "C" {
#endif

/** POD mirror of thestuu::clipfade::ClipFadeEnvelope for the playback graph. */
struct TheStuuFadeEnvPOD {
  double fadeInSec;
  double fadeOutSec;
  double inU;
  double inV;
  double outU;
  double outV;
};

/** Apply (u,v) bezier fade gain to an interleaved-free multi-channel buffer view. */
void thestuu_apply_envelope_to_audio(
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
  int32_t clearOutside);

/** Returns 1 if an envelope exists for this clip instance pointer. */
int32_t thestuu_lookup_clip_fade_envelope(const void* clipInstance, struct TheStuuFadeEnvPOD* out);

#ifdef __cplusplus
}
#endif
