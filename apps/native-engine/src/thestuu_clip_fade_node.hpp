#pragma once

#include <memory>

#include <tracktion_engine/tracktion_engine.h>

#include "thestuu_clip_fade_apply.h"

namespace tracktion {
inline namespace engine {

std::unique_ptr<tracktion::graph::Node> makeTheStuuFadeInOutNode(
  std::unique_ptr<tracktion::graph::Node> input,
  ProcessState& processState,
  tracktion::core::TimeRange clipPos,
  tracktion::core::TimeRange fadeIn,
  tracktion::core::TimeRange fadeOut,
  TheStuuFadeEnvPOD envelope,
  bool clearSamplesOutsideFade);

}  // inline namespace engine
}  // namespace tracktion
