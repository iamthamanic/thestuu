cmake_minimum_required(VERSION 3.16)
project(thestuu-native C CXX)

set(CMAKE_CXX_STANDARD 17)

# Release + LTO for distributable builds (see scripts/build-release.sh, CMakePresets.json).
include(CheckIPOSupported)
check_ipo_supported(RESULT STUU_IPO_SUPPORTED OUTPUT STUU_IPO_ERROR)
if(STUU_IPO_SUPPORTED)
  set(CMAKE_INTERPROCEDURAL_OPTIMIZATION_RELEASE ON)
else()
  message(STATUS "IPO/LTO not supported for this toolchain: ${STUU_IPO_ERROR}")
endif()

if(CMAKE_BUILD_TYPE STREQUAL "Release" OR CMAKE_BUILD_TYPE STREQUAL "RelWithDebInfo")
  if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
    add_compile_options(
      "$<$<CONFIG:Release>:-ffunction-sections>"
      "$<$<CONFIG:Release>:-fdata-sections>"
    )
    if(APPLE)
      add_link_options(
        "$<$<CONFIG:Release>:-Wl,-dead_strip>"
        "$<$<CONFIG:Release>:-Wl,-dead_strip_dylibs>"
      )
    else()
      add_link_options("$<$<CONFIG:Release>:-Wl,--gc-sections>")
    endif()
  elseif(MSVC)
    add_compile_options("$<$<CONFIG:Release>:/Gy>")
    add_link_options("$<$<CONFIG:Release>:/OPT:REF>")
  endif()
endif()

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
  target_compile_options(thestuu-native PRIVATE "$<$<CONFIG:Release>:-g>")
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
