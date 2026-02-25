cmake_minimum_required(VERSION 3.16)
project(thestuu-native C CXX)

set(CMAKE_CXX_STANDARD 17)

set(STUU_THIRD_PARTY_DIR "" CACHE PATH "Path to tracktion_engine repo (clone with --recurse-submodules)")

# TheStuu erfordert Tracktion; Stub-Backend wurde entfernt.
if(NOT STUU_THIRD_PARTY_DIR OR NOT EXISTS "${STUU_THIRD_PARTY_DIR}/CMakeLists.txt")
  message(FATAL_ERROR
    "Tracktion ist für TheStuu erforderlich. STUU_THIRD_PARTY_DIR muss auf einen tracktion_engine-Klon zeigen (mit JUCE-Submodule). Siehe apps/native-engine/README.md oder führe scripts/setup-tracktion.sh aus."
  )
endif()

set(TE_ADD_EXAMPLES OFF CACHE BOOL "Do not build Tracktion examples" FORCE)
add_subdirectory(${STUU_THIRD_PARTY_DIR} ${CMAKE_BINARY_DIR}/tracktion_build)
message(STATUS "Building with Tracktion backend: ${STUU_THIRD_PARTY_DIR}")

set(SOURCES src/main.cpp src/tracktion_backend_tracktion.cpp)

add_executable(thestuu-native ${SOURCES})

target_include_directories(thestuu-native PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)

target_compile_features(thestuu-native PRIVATE cxx_std_20)
target_link_libraries(thestuu-native PRIVATE
  tracktion::tracktion_core
  tracktion::tracktion_engine
  tracktion::tracktion_graph
  juce::juce_audio_devices
  juce::juce_audio_utils
  juce::juce_recommended_warning_flags
)
target_compile_definitions(thestuu-native PRIVATE
  JUCE_USE_CURL=0
  JUCE_WEB_BROWSER=0
  JUCE_MODAL_LOOPS_PERMITTED=1
  # Enable external plugin hosting (AU/VST3) for the native scan/load flow.
  JUCE_PLUGINHOST_AU=1
  JUCE_PLUGINHOST_VST3=1
  JUCE_VST3_CAN_REPLACE_VST2=0
)
if(APPLE)
  target_compile_options(thestuu-native PRIVATE "-fno-aligned-allocation")
  set_target_properties(thestuu-native PROPERTIES
    MACOSX_BUNDLE FALSE
    OSX_DEPLOYMENT_TARGET "10.13"
  )
endif()
if(UNIX AND NOT APPLE)
  target_link_libraries(thestuu-native PRIVATE "-latomic")
endif()

if(APPLE)
  target_link_libraries(thestuu-native PRIVATE pthread)
endif()
if(UNIX AND NOT APPLE)
  target_link_libraries(thestuu-native PRIVATE pthread)
endif()
