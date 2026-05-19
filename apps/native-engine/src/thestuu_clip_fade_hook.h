#pragma once

#include <memory>

namespace tracktion {
inline namespace engine {
class AudioClipBase;
struct EditTimeRange;
struct CreateNodeParams;
}  // inline namespace engine

inline namespace graph {
class Node;
}  // inline namespace graph
}  // namespace tracktion

namespace tracktion {
inline namespace engine {

/** Returns nullptr if no TheStuu envelope applies (caller uses Tracktion fades). */
std::unique_ptr<tracktion::graph::Node> tryWrapTheStuuClipFadeNode(
  AudioClipBase& clip,
  EditTimeRange clipTimeRangeToUse,
  std::unique_ptr<tracktion::graph::Node> node,
  const CreateNodeParams& params);

}  // inline namespace engine
}  // namespace tracktion
