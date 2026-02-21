cmake_minimum_required(VERSION 3.24)

project(thestuu_native_engine VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(STUU_ENABLE_TRACKTION "Build native engine with JUCE + Tracktion backend" OFF)
set(STUU_THIRD_PARTY_DIR "${CMAKE_CURRENT_SOURCE_DIR}/vendor" CACHE PATH "Vendor root containing JUCE and tracktion_engine")
set(STUU_JUCE_DIR "${STUU_THIRD_PARTY_DIR}/JUCE" CACHE PATH "Path to JUCE source")
set(STUU_TRACKTION_DIR "${STUU_THIRD_PARTY_DIR}/tracktion_engine" CACHE PATH "Path to Tracktion Engine source")

add_executable(
  thestuu-native
  src/main.cpp
  src/tracktion_backend.hpp
)

target_compile_options(
  thestuu-native
  PRIVATE
    -Wall
    -Wextra
    -Wpedantic
)

target_compile_definitions(
  thestuu-native
  PRIVATE
    STUU_ENABLE_TRACKTION=$<BOOL:${STUU_ENABLE_TRACKTION}>
)

if (STUU_ENABLE_TRACKTION)
  if (NOT EXISTS "${STUU_JUCE_DIR}/CMakeLists.txt")
    message(FATAL_ERROR "STUU_ENABLE_TRACKTION=ON but JUCE was not found at ${STUU_JUCE_DIR}")
  endif()

  if (NOT EXISTS "${STUU_TRACKTION_DIR}/CMakeLists.txt")
    message(FATAL_ERROR "STUU_ENABLE_TRACKTION=ON but tracktion_engine was not found at ${STUU_TRACKTION_DIR}")
  endif()

  add_subdirectory("${STUU_JUCE_DIR}" juce EXCLUDE_FROM_ALL)
  add_subdirectory("${STUU_TRACKTION_DIR}" tracktion_engine EXCLUDE_FROM_ALL)

  target_sources(thestuu-native PRIVATE src/tracktion_backend_tracktion.cpp)
  target_link_libraries(
    thestuu-native
    PRIVATE
      tracktion_engine
      juce::juce_audio_basics
      juce::juce_audio_devices
      juce::juce_audio_processors
      juce::juce_core
      juce::juce_events
  )

  target_compile_definitions(
    thestuu-native
    PRIVATE
      JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
      JUCE_WEB_BROWSER=0
      JUCE_USE_CURL=0
  )
else()
  target_sources(thestuu-native PRIVATE src/tracktion_backend_stub.cpp)
endif()
