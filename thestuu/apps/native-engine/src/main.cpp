#include <algorithm>
#include <array>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <csignal>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <limits>
#include <map>
#include <stdexcept>
#include <string>
#include <thread>
#include <variant>
#include <vector>

#include <fcntl.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include "tracktion_backend.hpp"

namespace {

constexpr int kBeatsPerBar = 4;
constexpr int kStepsPerBeat = 4;
constexpr int kTickMs = 40;
constexpr size_t kFrameHeaderBytes = 4;
constexpr uint32_t kMaxFrameSize = 1024 * 1024;

std::atomic<bool> g_running{true};
static bool g_useTracktionTransport = false;

struct MsgValue {
  using Object = std::map<std::string, MsgValue>;
  using Array = std::vector<MsgValue>;
  using Storage = std::variant<std::monostate, bool, int64_t, double, std::string, Object, Array>;

  Storage value;

  MsgValue() : value(std::monostate{}) {}
  MsgValue(bool v) : value(v) {}
  MsgValue(int32_t v) : value(static_cast<int64_t>(v)) {}
  MsgValue(int64_t v) : value(v) {}
  MsgValue(double v) : value(v) {}
  MsgValue(std::string v) : value(std::move(v)) {}
  MsgValue(const char* v) : value(std::string(v)) {}
  MsgValue(Object v) : value(std::move(v)) {}
  MsgValue(Array v) : value(std::move(v)) {}
};

void writeUint16BE(std::vector<uint8_t>& out, uint16_t value) {
  out.push_back(static_cast<uint8_t>((value >> 8) & 0xFF));
  out.push_back(static_cast<uint8_t>(value & 0xFF));
}

void writeUint32BE(std::vector<uint8_t>& out, uint32_t value) {
  out.push_back(static_cast<uint8_t>((value >> 24) & 0xFF));
  out.push_back(static_cast<uint8_t>((value >> 16) & 0xFF));
  out.push_back(static_cast<uint8_t>((value >> 8) & 0xFF));
  out.push_back(static_cast<uint8_t>(value & 0xFF));
}

void writeUint64BE(std::vector<uint8_t>& out, uint64_t value) {
  out.push_back(static_cast<uint8_t>((value >> 56) & 0xFF));
  out.push_back(static_cast<uint8_t>((value >> 48) & 0xFF));
  out.push_back(static_cast<uint8_t>((value >> 40) & 0xFF));
  out.push_back(static_cast<uint8_t>((value >> 32) & 0xFF));
  out.push_back(static_cast<uint8_t>((value >> 24) & 0xFF));
  out.push_back(static_cast<uint8_t>((value >> 16) & 0xFF));
  out.push_back(static_cast<uint8_t>((value >> 8) & 0xFF));
  out.push_back(static_cast<uint8_t>(value & 0xFF));
}

void encodeValue(const MsgValue& value, std::vector<uint8_t>& out);

void encodeString(const std::string& text, std::vector<uint8_t>& out) {
  const size_t length = text.size();
  if (length <= 31) {
    out.push_back(static_cast<uint8_t>(0xA0 | length));
  } else if (length <= 0xFF) {
    out.push_back(0xD9);
    out.push_back(static_cast<uint8_t>(length));
  } else if (length <= 0xFFFF) {
    out.push_back(0xDA);
    writeUint16BE(out, static_cast<uint16_t>(length));
  } else {
    out.push_back(0xDB);
    writeUint32BE(out, static_cast<uint32_t>(length));
  }
  out.insert(out.end(), text.begin(), text.end());
}

void encodeInt(int64_t number, std::vector<uint8_t>& out) {
  if (number >= 0) {
    const uint64_t value = static_cast<uint64_t>(number);
    if (value <= 0x7F) {
      out.push_back(static_cast<uint8_t>(value));
      return;
    }
    if (value <= 0xFF) {
      out.push_back(0xCC);
      out.push_back(static_cast<uint8_t>(value));
      return;
    }
    if (value <= 0xFFFF) {
      out.push_back(0xCD);
      writeUint16BE(out, static_cast<uint16_t>(value));
      return;
    }
    if (value <= 0xFFFFFFFF) {
      out.push_back(0xCE);
      writeUint32BE(out, static_cast<uint32_t>(value));
      return;
    }
    out.push_back(0xCF);
    writeUint64BE(out, value);
    return;
  }

  if (number >= -32) {
    out.push_back(static_cast<uint8_t>(number));
    return;
  }
  if (number >= std::numeric_limits<int8_t>::min()) {
    out.push_back(0xD0);
    out.push_back(static_cast<uint8_t>(number));
    return;
  }
  if (number >= std::numeric_limits<int16_t>::min()) {
    out.push_back(0xD1);
    writeUint16BE(out, static_cast<uint16_t>(number));
    return;
  }
  if (number >= std::numeric_limits<int32_t>::min()) {
    out.push_back(0xD2);
    writeUint32BE(out, static_cast<uint32_t>(number));
    return;
  }
  out.push_back(0xD3);
  writeUint64BE(out, static_cast<uint64_t>(number));
}

void encodeValue(const MsgValue& value, std::vector<uint8_t>& out) {
  if (std::holds_alternative<std::monostate>(value.value)) {
    out.push_back(0xC0);
    return;
  }
  if (const auto* boolValue = std::get_if<bool>(&value.value)) {
    out.push_back(*boolValue ? 0xC3 : 0xC2);
    return;
  }
  if (const auto* intValue = std::get_if<int64_t>(&value.value)) {
    encodeInt(*intValue, out);
    return;
  }
  if (const auto* doubleValue = std::get_if<double>(&value.value)) {
    out.push_back(0xCB);
    uint64_t bits = 0;
    std::memcpy(&bits, doubleValue, sizeof(bits));
    writeUint64BE(out, bits);
    return;
  }
  if (const auto* stringValue = std::get_if<std::string>(&value.value)) {
    encodeString(*stringValue, out);
    return;
  }
  if (const auto* objectValue = std::get_if<MsgValue::Object>(&value.value)) {
    const size_t length = objectValue->size();
    if (length <= 15) {
      out.push_back(static_cast<uint8_t>(0x80 | length));
    } else if (length <= 0xFFFF) {
      out.push_back(0xDE);
      writeUint16BE(out, static_cast<uint16_t>(length));
    } else {
      out.push_back(0xDF);
      writeUint32BE(out, static_cast<uint32_t>(length));
    }

    for (const auto& [key, entry] : *objectValue) {
      encodeString(key, out);
      encodeValue(entry, out);
    }
    return;
  }
  if (const auto* arrayValue = std::get_if<MsgValue::Array>(&value.value)) {
    const size_t length = arrayValue->size();
    if (length <= 15) {
      out.push_back(static_cast<uint8_t>(0x90 | length));
    } else if (length <= 0xFFFF) {
      out.push_back(0xDC);
      writeUint16BE(out, static_cast<uint16_t>(length));
    } else {
      out.push_back(0xDD);
      writeUint32BE(out, static_cast<uint32_t>(length));
    }
    for (const auto& entry : *arrayValue) {
      encodeValue(entry, out);
    }
  }
}

class Decoder {
 public:
  explicit Decoder(const std::vector<uint8_t>& data) : data_(data) {}

  MsgValue readValue() {
    const uint8_t marker = readByte();

    if (marker <= 0x7F) {
      return MsgValue(static_cast<int64_t>(marker));
    }
    if (marker >= 0xE0) {
      return MsgValue(static_cast<int64_t>(static_cast<int8_t>(marker)));
    }
    if ((marker & 0xF0) == 0x80) {
      return readMap(marker & 0x0F);
    }
    if ((marker & 0xF0) == 0x90) {
      return readArray(marker & 0x0F);
    }
    if ((marker & 0xE0) == 0xA0) {
      return readString(marker & 0x1F);
    }

    switch (marker) {
      case 0xC0:
        return MsgValue();
      case 0xC2:
        return MsgValue(false);
      case 0xC3:
        return MsgValue(true);
      case 0xCC:
        return MsgValue(static_cast<int64_t>(readUint8()));
      case 0xCD:
        return MsgValue(static_cast<int64_t>(readUint16()));
      case 0xCE:
        return MsgValue(static_cast<int64_t>(readUint32()));
      case 0xCF: {
        const uint64_t raw = readUint64();
        if (raw <= static_cast<uint64_t>(std::numeric_limits<int64_t>::max())) {
          return MsgValue(static_cast<int64_t>(raw));
        }
        return MsgValue(static_cast<double>(raw));
      }
      case 0xD0:
        return MsgValue(static_cast<int64_t>(static_cast<int8_t>(readUint8())));
      case 0xD1:
        return MsgValue(static_cast<int64_t>(static_cast<int16_t>(readUint16())));
      case 0xD2:
        return MsgValue(static_cast<int64_t>(static_cast<int32_t>(readUint32())));
      case 0xD3:
        return MsgValue(static_cast<int64_t>(readUint64()));
      case 0xCA: {
        const uint32_t raw = readUint32();
        float number = 0.0F;
        std::memcpy(&number, &raw, sizeof(number));
        return MsgValue(static_cast<double>(number));
      }
      case 0xCB: {
        const uint64_t raw = readUint64();
        double number = 0.0;
        std::memcpy(&number, &raw, sizeof(number));
        return MsgValue(number);
      }
      case 0xD9:
        return readString(readUint8());
      case 0xDA:
        return readString(readUint16());
      case 0xDB:
        return readString(readUint32());
      case 0xDC:
        return readArray(readUint16());
      case 0xDD:
        return readArray(readUint32());
      case 0xDE:
        return readMap(readUint16());
      case 0xDF:
        return readMap(readUint32());
      default:
        throw std::runtime_error("unsupported MessagePack marker");
    }
  }

  bool eof() const {
    return offset_ >= data_.size();
  }

 private:
  const std::vector<uint8_t>& data_;
  size_t offset_ = 0;

  void ensure(size_t bytes) {
    if (offset_ + bytes > data_.size()) {
      throw std::runtime_error("unexpected end of MessagePack buffer");
    }
  }

  uint8_t readByte() {
    ensure(1);
    return data_[offset_++];
  }

  uint8_t readUint8() {
    return readByte();
  }

  uint16_t readUint16() {
    ensure(2);
    uint16_t value = static_cast<uint16_t>((static_cast<uint16_t>(data_[offset_]) << 8) | data_[offset_ + 1]);
    offset_ += 2;
    return value;
  }

  uint32_t readUint32() {
    ensure(4);
    uint32_t value = 0;
    value |= static_cast<uint32_t>(data_[offset_]) << 24;
    value |= static_cast<uint32_t>(data_[offset_ + 1]) << 16;
    value |= static_cast<uint32_t>(data_[offset_ + 2]) << 8;
    value |= static_cast<uint32_t>(data_[offset_ + 3]);
    offset_ += 4;
    return value;
  }

  uint64_t readUint64() {
    ensure(8);
    uint64_t value = 0;
    value |= static_cast<uint64_t>(data_[offset_]) << 56;
    value |= static_cast<uint64_t>(data_[offset_ + 1]) << 48;
    value |= static_cast<uint64_t>(data_[offset_ + 2]) << 40;
    value |= static_cast<uint64_t>(data_[offset_ + 3]) << 32;
    value |= static_cast<uint64_t>(data_[offset_ + 4]) << 24;
    value |= static_cast<uint64_t>(data_[offset_ + 5]) << 16;
    value |= static_cast<uint64_t>(data_[offset_ + 6]) << 8;
    value |= static_cast<uint64_t>(data_[offset_ + 7]);
    offset_ += 8;
    return value;
  }

  MsgValue readString(uint32_t length) {
    ensure(length);
    const std::string text(reinterpret_cast<const char*>(data_.data() + offset_), length);
    offset_ += length;
    return MsgValue(text);
  }

  MsgValue readArray(uint32_t length) {
    MsgValue::Array values;
    values.reserve(length);
    for (uint32_t i = 0; i < length; ++i) {
      values.push_back(readValue());
    }
    return MsgValue(values);
  }

  MsgValue readMap(uint32_t length) {
    MsgValue::Object object;
    for (uint32_t i = 0; i < length; ++i) {
      const MsgValue key = readValue();
      const auto* keyText = std::get_if<std::string>(&key.value);
      if (keyText == nullptr) {
        throw std::runtime_error("MessagePack map key must be string");
      }
      object[*keyText] = readValue();
    }
    return MsgValue(object);
  }
};

const MsgValue* getField(const MsgValue::Object& object, const std::string& key) {
  const auto it = object.find(key);
  if (it == object.end()) {
    return nullptr;
  }
  return &it->second;
}

const MsgValue::Object* asObject(const MsgValue* value) {
  if (value == nullptr) {
    return nullptr;
  }
  return std::get_if<MsgValue::Object>(&value->value);
}

std::string asString(const MsgValue* value, const std::string& fallback = "") {
  if (value == nullptr) {
    return fallback;
  }
  if (const auto* text = std::get_if<std::string>(&value->value)) {
    return *text;
  }
  return fallback;
}

int64_t asInt(const MsgValue* value, int64_t fallback = 0) {
  if (value == nullptr) {
    return fallback;
  }
  if (const auto* integer = std::get_if<int64_t>(&value->value)) {
    return *integer;
  }
  if (const auto* decimal = std::get_if<double>(&value->value)) {
    if (!std::isfinite(*decimal)) {
      return fallback;
    }
    return static_cast<int64_t>(*decimal);
  }
  return fallback;
}

double asDouble(const MsgValue* value, double fallback = 0.0) {
  if (value == nullptr) {
    return fallback;
  }
  if (const auto* decimal = std::get_if<double>(&value->value)) {
    return *decimal;
  }
  if (const auto* integer = std::get_if<int64_t>(&value->value)) {
    return static_cast<double>(*integer);
  }
  return fallback;
}

bool asBool(const MsgValue* value, bool fallback = false) {
  if (value == nullptr) {
    return fallback;
  }
  if (const auto* b = std::get_if<bool>(&value->value)) {
    return *b;
  }
  if (const auto* integer = std::get_if<int64_t>(&value->value)) {
    return *integer != 0;
  }
  if (const auto* decimal = std::get_if<double>(&value->value)) {
    return *decimal != 0.0;
  }
  return fallback;
}

bool sendAll(int fd, const uint8_t* data, size_t size) {
  size_t sent = 0;
  while (sent < size) {
    int flags = 0;
#ifdef MSG_NOSIGNAL
    flags |= MSG_NOSIGNAL;
#endif
    const ssize_t written = send(fd, data + sent, size - sent, flags);
    if (written > 0) {
      sent += static_cast<size_t>(written);
      continue;
    }
    if (written == 0) {
      return false;
    }
    if (errno == EINTR) {
      continue;
    }
    if (errno == EAGAIN || errno == EWOULDBLOCK) {
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
      continue;
    }
    return false;
  }
  return true;
}

bool sendFrame(int fd, const MsgValue& message) {
  std::vector<uint8_t> body;
  encodeValue(message, body);
  if (body.size() > kMaxFrameSize) {
    return false;
  }

  std::array<uint8_t, kFrameHeaderBytes> header{};
  const uint32_t size = static_cast<uint32_t>(body.size());
  header[0] = static_cast<uint8_t>((size >> 24) & 0xFF);
  header[1] = static_cast<uint8_t>((size >> 16) & 0xFF);
  header[2] = static_cast<uint8_t>((size >> 8) & 0xFF);
  header[3] = static_cast<uint8_t>(size & 0xFF);

  return sendAll(fd, header.data(), header.size()) && sendAll(fd, body.data(), body.size());
}

double clampBpm(double bpm) {
  if (!std::isfinite(bpm)) {
    return 128.0;
  }
  return std::clamp(bpm, 20.0, 300.0);
}

struct TransportCore {
  bool playing = false;
  double bpm = 128.0;
  double offsetBeats = 0.0;
  std::chrono::steady_clock::time_point startedAt = std::chrono::steady_clock::now();

  double positionBeatsAt(std::chrono::steady_clock::time_point now) const {
    if (!playing) {
      return std::max(0.0, offsetBeats);
    }
    const auto elapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(now - startedAt).count();
    const double elapsedBeats = static_cast<double>(elapsedMs) * (bpm / 60000.0);
    return std::max(0.0, offsetBeats + elapsedBeats);
  }

  void play() {
    if (playing) {
      return;
    }
    startedAt = std::chrono::steady_clock::now();
    playing = true;
  }

  void pause() {
    if (!playing) {
      return;
    }
    offsetBeats = positionBeatsAt(std::chrono::steady_clock::now());
    startedAt = std::chrono::steady_clock::now();
    playing = false;
  }

  void stop() {
    playing = false;
    offsetBeats = 0.0;
    startedAt = std::chrono::steady_clock::now();
  }

  void seekToBeats(double nextPositionBeats) {
    offsetBeats = std::max(0.0, std::isfinite(nextPositionBeats) ? nextPositionBeats : 0.0);
    startedAt = std::chrono::steady_clock::now();
  }

  void setBpm(double nextBpm) {
    const double clamped = clampBpm(nextBpm);
    if (playing) {
      offsetBeats = positionBeatsAt(std::chrono::steady_clock::now());
      startedAt = std::chrono::steady_clock::now();
    }
    bpm = clamped;
  }

  MsgValue::Object snapshot() const {
    const auto nowSteady = std::chrono::steady_clock::now();
    const auto nowSystem = std::chrono::system_clock::now();
    const double positionBeats = positionBeatsAt(nowSteady);
    const double positionBars = positionBeats / static_cast<double>(kBeatsPerBar);
    const int64_t bar = static_cast<int64_t>(std::floor(positionBars)) + 1;
    const int64_t beat = static_cast<int64_t>(std::floor(std::fmod(positionBeats, static_cast<double>(kBeatsPerBar)))) + 1;
    const int64_t stepIndex = static_cast<int64_t>(std::floor(positionBeats * static_cast<double>(kStepsPerBeat))) %
      static_cast<int64_t>(kBeatsPerBar * kStepsPerBeat);
    const int64_t step = stepIndex + 1;
    const auto timestamp = std::chrono::duration_cast<std::chrono::milliseconds>(nowSystem.time_since_epoch()).count();

    return MsgValue::Object{
      {"playing", MsgValue(playing)},
      {"recording", MsgValue(false)},
      {"bpm", MsgValue(bpm)},
      {"bar", MsgValue(bar)},
      {"beat", MsgValue(beat)},
      {"step", MsgValue(step)},
      {"stepIndex", MsgValue(stepIndex)},
      {"positionBars", MsgValue(positionBars)},
      {"positionBeats", MsgValue(positionBeats)},
      {"timestamp", MsgValue(static_cast<int64_t>(timestamp))},
    };
  }
};

std::string escapeJson(const std::string& text) {
  static constexpr char kHex[] = "0123456789abcdef";
  std::string escaped;
  escaped.reserve(text.size() + 8);

  for (const unsigned char c : text) {
    switch (c) {
      case '\"':
        escaped += "\\\"";
        break;
      case '\\':
        escaped += "\\\\";
        break;
      case '\b':
        escaped += "\\b";
        break;
      case '\f':
        escaped += "\\f";
        break;
      case '\n':
        escaped += "\\n";
        break;
      case '\r':
        escaped += "\\r";
        break;
      case '\t':
        escaped += "\\t";
        break;
      default:
        if (c < 0x20) {
          escaped += "\\u00";
          escaped.push_back(kHex[(c >> 4) & 0x0F]);
          escaped.push_back(kHex[c & 0x0F]);
        } else {
          escaped.push_back(static_cast<char>(c));
        }
        break;
    }
  }

  return escaped;
}

void logJson(const std::string& type, const std::string& message) {
  std::cerr << "{\"type\":\"" << escapeJson(type) << "\",\"message\":\"" << escapeJson(message) << "\"}\n";
}

MsgValue toMsgValue(const thestuu::native::PluginParameterInfo& parameter) {
  return MsgValue(MsgValue::Object{
    {"id", MsgValue(parameter.id)},
    {"name", MsgValue(parameter.name)},
    {"min", MsgValue(parameter.min)},
    {"max", MsgValue(parameter.max)},
    {"value", MsgValue(parameter.value)},
  });
}

MsgValue toMsgValue(const thestuu::native::PluginInfo& plugin) {
  MsgValue::Array parameters;
  parameters.reserve(plugin.parameters.size());
  for (const auto& parameter : plugin.parameters) {
    parameters.emplace_back(toMsgValue(parameter));
  }

  return MsgValue(MsgValue::Object{
    {"name", MsgValue(plugin.name)},
    {"uid", MsgValue(plugin.uid)},
    {"type", MsgValue(plugin.type)},
    {"kind", MsgValue(plugin.kind)},
    {"isInstrument", MsgValue(plugin.isInstrument)},
    {"isNative", MsgValue(plugin.isNative)},
    {"parameters", MsgValue(std::move(parameters))},
  });
}

MsgValue toMsgValue(const thestuu::native::LoadPluginResult& plugin) {
  MsgValue::Array parameters;
  parameters.reserve(plugin.parameters.size());
  for (const auto& parameter : plugin.parameters) {
    parameters.emplace_back(toMsgValue(parameter));
  }

  return MsgValue(MsgValue::Object{
    {"name", MsgValue(plugin.name)},
    {"uid", MsgValue(plugin.uid)},
    {"type", MsgValue(plugin.type)},
    {"kind", MsgValue(plugin.kind)},
    {"isInstrument", MsgValue(plugin.isInstrument)},
    {"isNative", MsgValue(plugin.isNative)},
    {"trackId", MsgValue(plugin.trackId)},
    {"pluginIndex", MsgValue(plugin.pluginIndex)},
    {"parameters", MsgValue(std::move(parameters))},
  });
}

MsgValue makeResponse(int64_t id, const MsgValue::Object& payload) {
  return MsgValue(MsgValue::Object{
    {"type", MsgValue("response")},
    {"id", MsgValue(id)},
    {"ok", MsgValue(true)},
    {"payload", MsgValue(payload)},
  });
}

MsgValue makeErrorResponse(int64_t id, const std::string& error) {
  logJson("error", error);
  return MsgValue(MsgValue::Object{
    {"type", MsgValue("response")},
    {"id", MsgValue(id)},
    {"ok", MsgValue(false)},
    {"error", MsgValue(error)},
  });
}

MsgValue::Object snapshotToMsgObject(const thestuu::native::TransportSnapshot& s) {
  return MsgValue::Object{
    {"playing", MsgValue(s.playing)},
    {"recording", MsgValue(s.isRecording)},
    {"bpm", MsgValue(s.bpm)},
    {"bar", MsgValue(s.bar)},
    {"beat", MsgValue(s.beat)},
    {"step", MsgValue(s.step)},
    {"stepIndex", MsgValue(s.stepIndex)},
    {"positionBars", MsgValue(s.positionBars)},
    {"positionBeats", MsgValue(s.positionBeats)},
    {"timestamp", MsgValue(s.timestamp)},
  };
}

MsgValue::Object spectrumAnalyzerSnapshotToMsgObject(const thestuu::native::SpectrumAnalyzerSnapshot& s) {
  auto toNumberArray = [](const std::vector<float>& values) {
    MsgValue::Array arr;
    arr.reserve(values.size());
    for (float value : values) {
      arr.push_back(MsgValue(static_cast<double>(value)));
    }
    return arr;
  };

  return MsgValue::Object{
    {"available", MsgValue(s.available)},
    {"preMirrorsPost", MsgValue(s.preMirrorsPost)},
    {"scope", MsgValue(s.scope)},
    {"channels", MsgValue(s.channels)},
    {"sampleRate", MsgValue(s.sampleRate)},
    {"fftSize", MsgValue(static_cast<int64_t>(s.fftSize))},
    {"minDb", MsgValue(s.minDb)},
    {"maxDb", MsgValue(s.maxDb)},
    {"timestamp", MsgValue(s.timestamp)},
    {"freqsHz", MsgValue(toNumberArray(s.freqsHz))},
    {"preDb", MsgValue(toNumberArray(s.preDb))},
    {"postDb", MsgValue(toNumberArray(s.postDb))},
  };
}

namespace {
int g_tickLogCounter = 0;
}

MsgValue makeTickEvent(const TransportCore& transport) {
  thestuu::native::TransportSnapshot backendSnap;
  if (g_useTracktionTransport && thestuu::native::getTransportSnapshot(backendSnap)) {
    if (++g_tickLogCounter <= 12 || (g_tickLogCounter % 50 == 0)) {
      std::fprintf(
        stderr,
        "[thestuu-native] tick playing=%d positionBeats=%.4f bpm=%.3f\n",
        backendSnap.playing ? 1 : 0,
        backendSnap.positionBeats,
        backendSnap.bpm
      );
    }
    auto payload = snapshotToMsgObject(backendSnap);
    thestuu::native::SpectrumAnalyzerSnapshot analyzerSnapshot;
    if (thestuu::native::getSpectrumAnalyzerSnapshot(analyzerSnapshot) && analyzerSnapshot.available) {
      payload["analyzer"] = MsgValue(spectrumAnalyzerSnapshotToMsgObject(analyzerSnapshot));
    }
    return MsgValue(MsgValue::Object{
      {"type", MsgValue("event")},
      {"event", MsgValue("transport.tick")},
      {"payload", MsgValue(std::move(payload))},
    });
  }
  return MsgValue(MsgValue::Object{
    {"type", MsgValue("event")},
    {"event", MsgValue("transport.tick")},
    {"payload", MsgValue(transport.snapshot())},
  });
}

MsgValue handleRequest(const MsgValue::Object& request, TransportCore& transport) {
  const int64_t id = asInt(getField(request, "id"), 0);
  const std::string type = asString(getField(request, "type"));
  if (type != "request") {
    return makeErrorResponse(id, "message type must be \"request\"");
  }

  const std::string cmd = asString(getField(request, "cmd"));
  const MsgValue::Object* payload = asObject(getField(request, "payload"));

  if (cmd == "transport.get_state") {
    thestuu::native::TransportSnapshot backendSnap;
    if (g_useTracktionTransport && thestuu::native::getTransportSnapshot(backendSnap)) {
      return makeResponse(id, MsgValue::Object{{"transport", MsgValue(snapshotToMsgObject(backendSnap))}});
    }
    return makeResponse(id, MsgValue::Object{{"transport", MsgValue(transport.snapshot())}});
  }
  if (cmd == "transport.ensure-context" || cmd == "transport:ensure-context") {
    if (g_useTracktionTransport) {
      thestuu::native::transportEnsureContext();
    }
    return makeResponse(id, MsgValue::Object{});
  }
  if (cmd == "transport.play") {
    if (g_useTracktionTransport) {
      thestuu::native::transportPlay();
      thestuu::native::TransportSnapshot backendSnap;
      if (thestuu::native::getTransportSnapshot(backendSnap)) {
        std::fprintf(stderr, "[thestuu-native] after transportPlay: isPlaying=%d positionBeats=%.4f\n",
                     backendSnap.playing ? 1 : 0, backendSnap.positionBeats);
        backendSnap.playing = true;  // Tracktion may set isPlaying() async; ensure response reflects play request
        return makeResponse(id, MsgValue::Object{{"transport", MsgValue(snapshotToMsgObject(backendSnap))}});
      }
    } else {
      transport.play();
    }
    return makeResponse(id, MsgValue::Object{{"transport", MsgValue(transport.snapshot())}});
  }
  if (cmd == "transport.record") {
    if (g_useTracktionTransport) {
      thestuu::native::transportRecord();
      thestuu::native::TransportSnapshot backendSnap;
      if (thestuu::native::getTransportSnapshot(backendSnap)) {
        backendSnap.playing = true;
        return makeResponse(id, MsgValue::Object{{"transport", MsgValue(snapshotToMsgObject(backendSnap))}});
      }
    } else {
      transport.play();
    }
    return makeResponse(id, MsgValue::Object{{"transport", MsgValue(transport.snapshot())}});
  }
  if (cmd == "transport.pause") {
    if (g_useTracktionTransport) {
      thestuu::native::transportPause();
      thestuu::native::TransportSnapshot backendSnap;
      if (thestuu::native::getTransportSnapshot(backendSnap)) {
        return makeResponse(id, MsgValue::Object{{"transport", MsgValue(snapshotToMsgObject(backendSnap))}});
      }
    } else {
      transport.pause();
    }
    return makeResponse(id, MsgValue::Object{{"transport", MsgValue(transport.snapshot())}});
  }
  if (cmd == "transport.stop") {
    if (g_useTracktionTransport) {
      thestuu::native::transportStop();
      thestuu::native::TransportSnapshot backendSnap;
      if (thestuu::native::getTransportSnapshot(backendSnap)) {
        return makeResponse(id, MsgValue::Object{{"transport", MsgValue(snapshotToMsgObject(backendSnap))}});
      }
    } else {
      transport.stop();
    }
    return makeResponse(id, MsgValue::Object{{"transport", MsgValue(transport.snapshot())}});
  }
  if (cmd == "transport.set_bpm") {
    const double bpm = payload ? asDouble(getField(*payload, "bpm"), transport.bpm) : transport.bpm;
    if (g_useTracktionTransport) {
      thestuu::native::transportSetBpm(bpm);
      thestuu::native::TransportSnapshot backendSnap;
      if (thestuu::native::getTransportSnapshot(backendSnap)) {
        return makeResponse(id, MsgValue::Object{{"transport", MsgValue(snapshotToMsgObject(backendSnap))}});
      }
    } else {
      transport.setBpm(bpm);
    }
    return makeResponse(id, MsgValue::Object{{"transport", MsgValue(transport.snapshot())}});
  }
  if (cmd == "transport.seek") {
    const double positionBeats = payload
      ? asDouble(
        getField(*payload, "position_beats"),
        asDouble(
          getField(*payload, "positionBeats"),
          asDouble(
            getField(*payload, "position_bars"),
            asDouble(getField(*payload, "positionBars"), 0.0) * static_cast<double>(kBeatsPerBar)
          ) * static_cast<double>(kBeatsPerBar)
        )
      )
      : 0.0;
    if (g_useTracktionTransport) {
      thestuu::native::transportSeek(positionBeats);
      thestuu::native::TransportSnapshot backendSnap;
      if (thestuu::native::getTransportSnapshot(backendSnap)) {
        return makeResponse(id, MsgValue::Object{{"transport", MsgValue(snapshotToMsgObject(backendSnap))}});
      }
    } else {
      transport.seekToBeats(positionBeats);
    }
    return makeResponse(id, MsgValue::Object{{"transport", MsgValue(transport.snapshot())}});
  }
  if (cmd == "edit:reset") {
    const int32_t requestedTrackCount = static_cast<int32_t>(
      payload ? asInt(getField(*payload, "track_count"), asInt(getField(*payload, "trackCount"), 16)) : 16
    );
    const int32_t trackCount = requestedTrackCount > 0 ? requestedTrackCount : 16;

    std::string error;
    if (!thestuu::native::resetDefaultEdit(trackCount, error)) {
      return makeErrorResponse(id, error);
    }

    return makeResponse(
      id,
      MsgValue::Object{
        {"trackCount", MsgValue(trackCount)},
      }
    );
  }
  if (cmd == "edit:clear-audio-clips") {
    if (!g_useTracktionTransport) {
      return makeResponse(id, MsgValue::Object{});
    }
    std::string error;
    if (!thestuu::native::clearAllAudioClipsOnMessageThread(error)) {
      return makeErrorResponse(id, error);
    }
    return makeResponse(id, MsgValue::Object{});
  }
  if (cmd == "edit:get-audio-clips") {
    if (!g_useTracktionTransport) {
      return makeResponse(id, MsgValue::Object{{"clips", MsgValue(MsgValue::Array{})}});
    }
    std::vector<thestuu::native::EditClipInfo> clips;
    std::string error;
    if (!thestuu::native::getEditAudioClipsOnMessageThread(clips, error)) {
      return makeErrorResponse(id, error);
    }
    MsgValue::Array arr;
    arr.reserve(clips.size());
    for (const auto& c : clips) {
      arr.push_back(MsgValue(MsgValue::Object{
        {"track_id", MsgValue(static_cast<int64_t>(c.trackId))},
        {"source_path", MsgValue(c.sourcePath)},
        {"start_seconds", MsgValue(c.startSeconds)},
        {"length_seconds", MsgValue(c.lengthSeconds)},
        {"name", MsgValue(c.name)},
      }));
    }
    return makeResponse(id, MsgValue::Object{{"clips", MsgValue(std::move(arr))}});
  }
  if (cmd == "backend.info") {
    return makeResponse(id, MsgValue::Object{{"tracktion", MsgValue(g_useTracktionTransport)}});
  }
  if (cmd == "health.ping") {
    return makeResponse(id, MsgValue::Object{{"pong", MsgValue(true)}});
  }
  if (cmd == "audio.get_outputs") {
    std::vector<thestuu::native::AudioDeviceInfo> devices;
    std::string error;
    if (!thestuu::native::getAudioOutputDevices(devices, error)) {
      return makeErrorResponse(id, error);
    }
    MsgValue::Array arr;
    arr.reserve(devices.size());
    for (const auto& d : devices) {
      arr.push_back(MsgValue(MsgValue::Object{
        {"id", MsgValue(d.id)},
        {"name", MsgValue(d.name)},
      }));
    }
    std::string currentId;
    thestuu::native::getCurrentAudioOutputDeviceId(currentId, error);
    MsgValue::Object payloadObj{
      {"devices", MsgValue(std::move(arr))},
      {"currentId", MsgValue(currentId)},
    };
    thestuu::native::AudioStatus status;
    if (thestuu::native::getAudioStatus(status, error)) {
      payloadObj["sampleRate"] = MsgValue(status.sampleRate);
      payloadObj["blockSize"] = MsgValue(static_cast<int64_t>(status.blockSize));
      payloadObj["outputLatencySeconds"] = MsgValue(status.outputLatencySeconds);
      payloadObj["outputChannels"] = MsgValue(static_cast<int64_t>(status.outputChannels));
    }
    return makeResponse(id, MsgValue::Object(std::move(payloadObj)));
  }
  if (cmd == "audio.set_output") {
    std::string deviceId;
    if (payload) {
      deviceId = asString(getField(*payload, "device_id"));
      if (deviceId.empty()) deviceId = asString(getField(*payload, "deviceId"));
    }
    if (deviceId.empty()) {
      return makeErrorResponse(id, "audio.set_output requires device_id");
    }
    std::string error;
    if (!thestuu::native::setAudioOutputDevice(deviceId, error)) {
      return makeErrorResponse(id, error);
    }
    return makeResponse(id, MsgValue::Object{{"ok", MsgValue(true)}});
  }
  if (cmd == "vst:scan") {
    std::vector<thestuu::native::PluginInfo> plugins;
    std::string error;
    if (!thestuu::native::scanPlugins(plugins, error)) {
      return makeErrorResponse(id, error);
    }

    MsgValue::Array pluginList;
    pluginList.reserve(plugins.size());
    for (const auto& plugin : plugins) {
      pluginList.emplace_back(toMsgValue(plugin));
    }

    return makeResponse(id, MsgValue::Object{{"plugins", MsgValue(std::move(pluginList))}});
  }
  if (cmd == "vst:load") {
    if (payload == nullptr) {
      return makeErrorResponse(id, "vst:load requires payload");
    }

    std::string pluginUid = asString(getField(*payload, "plugin_uid"));
    if (pluginUid.empty()) {
      pluginUid = asString(getField(*payload, "pluginUid"));
    }
    if (pluginUid.empty()) {
      pluginUid = asString(getField(*payload, "name"));
    }
    if (pluginUid.empty()) {
      return makeErrorResponse(id, "vst:load requires plugin_uid");
    }

    const int32_t trackId = static_cast<int32_t>(
      asInt(
        getField(*payload, "track_id"),
        asInt(getField(*payload, "trackId"), 1)
      )
    );

    thestuu::native::LoadPluginResult result;
    std::string error;
    if (!thestuu::native::loadPlugin(pluginUid, trackId, result, error)) {
      return makeErrorResponse(id, error);
    }

    return makeResponse(id, MsgValue::Object{{"plugin", toMsgValue(result)}});
  }
  if (cmd == "vst:editor:open") {
    if (payload == nullptr) {
      return makeErrorResponse(id, "vst:editor:open requires payload");
    }

    const int32_t trackId = static_cast<int32_t>(
      asInt(
        getField(*payload, "track_id"),
        asInt(getField(*payload, "trackId"), 1)
      )
    );
    const int32_t pluginIndex = static_cast<int32_t>(
      asInt(
        getField(*payload, "plugin_index"),
        asInt(getField(*payload, "pluginIndex"), -1)
      )
    );

    if (trackId <= 0 || pluginIndex < 0) {
      return makeErrorResponse(id, "vst:editor:open requires track_id and plugin_index");
    }

    std::string error;
    if (!thestuu::native::openPluginEditor(trackId, pluginIndex, error)) {
      return makeErrorResponse(id, error);
    }

    return makeResponse(
      id,
      MsgValue::Object{
        {"trackId", MsgValue(trackId)},
        {"pluginIndex", MsgValue(pluginIndex)},
        {"opened", MsgValue(true)},
      }
    );
  }
  if (cmd == "vst:param:set") {
    if (payload == nullptr) {
      return makeErrorResponse(id, "vst:param:set requires payload");
    }

    const int32_t trackId = static_cast<int32_t>(
      asInt(
        getField(*payload, "track_id"),
        asInt(getField(*payload, "trackId"), 1)
      )
    );
    const int32_t pluginIndex = static_cast<int32_t>(
      asInt(
        getField(*payload, "plugin_index"),
        asInt(getField(*payload, "pluginIndex"), 0)
      )
    );

    std::string paramId = asString(getField(*payload, "param_id"));
    if (paramId.empty()) {
      paramId = asString(getField(*payload, "paramId"));
    }
    if (paramId.empty()) {
      return makeErrorResponse(id, "vst:param:set requires param_id");
    }

    const double value = asDouble(getField(*payload, "value"), 0.0);
    thestuu::native::PluginParameterInfo parameter;
    std::string error;
    if (!thestuu::native::setPluginParameter(trackId, pluginIndex, paramId, value, parameter, error)) {
      return makeErrorResponse(id, error);
    }

    return makeResponse(
      id,
      MsgValue::Object{
        {"trackId", MsgValue(trackId)},
        {"pluginIndex", MsgValue(pluginIndex)},
        {"parameter", toMsgValue(parameter)},
      }
    );
  }

  if (cmd == "clip:import-file") {
    if (payload == nullptr) {
      return makeErrorResponse(id, "clip:import-file requires payload");
    }

    thestuu::native::ClipImportRequest request;
    request.trackId = static_cast<int32_t>(
      asInt(getField(*payload, "track_id"),
        asInt(getField(*payload, "trackId"), 1)
      )
    );
    request.sourcePath = asString(getField(*payload, "source_path"));
    if (request.sourcePath.empty()) {
      request.sourcePath = asString(getField(*payload, "sourcePath"));
    }
    request.startBars = asDouble(getField(*payload, "start"), 0.0);
    request.lengthBars = asDouble(getField(*payload, "length"), 0.0);
    request.startSeconds = asDouble(getField(*payload, "start_seconds"), asDouble(getField(*payload, "startSeconds"), -1.0));
    request.lengthSeconds = asDouble(getField(*payload, "length_seconds"), asDouble(getField(*payload, "lengthSeconds"), -1.0));
    request.fadeInSeconds = asDouble(getField(*payload, "fade_in"), asDouble(getField(*payload, "fadeIn"), 0.0));
    request.fadeOutSeconds = asDouble(getField(*payload, "fade_out"), asDouble(getField(*payload, "fadeOut"), 0.0));
    auto fadeCurveFromString = [](const MsgValue* v) -> int {
      if (!v) return 1;
      std::string s = asString(v);
      if (s == "convex") return 2;
      if (s == "concave") return 3;
      if (s == "sCurve" || s == "scurve") return 4;
      return 1;
    };
    const MsgValue* fic = getField(*payload, "fade_in_curve");
    if (!fic) fic = getField(*payload, "fadeInCurve");
    request.fadeInCurve = fadeCurveFromString(fic);
    const MsgValue* foc = getField(*payload, "fade_out_curve");
    if (!foc) foc = getField(*payload, "fadeOutCurve");
    request.fadeOutCurve = fadeCurveFromString(foc);
    request.type = asString(getField(*payload, "type"));
    request.sourceOffsetSeconds = asDouble(getField(*payload, "source_offset_seconds"), asDouble(getField(*payload, "sourceOffsetSeconds"), -1.0));

    thestuu::native::ClipImportResult importResult;
    std::string error;
    const bool ok = g_useTracktionTransport
      ? thestuu::native::importClipFileOnMessageThread(request, importResult, error)
      : thestuu::native::importClipFile(request, importResult, error);
    if (!ok) {
      return makeErrorResponse(id, error);
    }

    return makeResponse(
      id,
      MsgValue::Object{
        {"trackId", MsgValue(importResult.trackId)},
        {"startBars", MsgValue(importResult.startBars)},
        {"lengthBars", MsgValue(importResult.lengthBars)},
        {"sourcePath", MsgValue(importResult.sourcePath)},
      }
    );
  }

  if (cmd == "track:set-mute") {
    if (payload == nullptr) {
      return makeErrorResponse(id, "track:set-mute requires payload");
    }
    const int32_t trackId = static_cast<int32_t>(
      asInt(
        getField(*payload, "track_id"),
        asInt(getField(*payload, "trackId"), 1)
      )
    );
    const bool mute = asBool(getField(*payload, "mute"), false);
    std::string error;
    if (!thestuu::native::setTrackMute(trackId, mute, error)) {
      return makeErrorResponse(id, error);
    }
    return makeResponse(id, MsgValue::Object{
      {"trackId", MsgValue(trackId)},
      {"mute", MsgValue(mute)},
    });
  }

  if (cmd == "track:set-solo") {
    if (payload == nullptr) {
      return makeErrorResponse(id, "track:set-solo requires payload");
    }
    const int32_t trackId = static_cast<int32_t>(
      asInt(
        getField(*payload, "track_id"),
        asInt(getField(*payload, "trackId"), 1)
      )
    );
    const bool solo = asBool(getField(*payload, "solo"), false);
    std::string error;
    if (!thestuu::native::setTrackSolo(trackId, solo, error)) {
      return makeErrorResponse(id, error);
    }
    return makeResponse(id, MsgValue::Object{
      {"trackId", MsgValue(trackId)},
      {"solo", MsgValue(solo)},
    });
  }

  if (cmd == "track:set-volume") {
    if (payload == nullptr) {
      return makeErrorResponse(id, "track:set-volume requires payload");
    }
    const int32_t trackId = static_cast<int32_t>(
      asInt(
        getField(*payload, "track_id"),
        asInt(getField(*payload, "trackId"), 1)
      )
    );
    const double volume = asDouble(getField(*payload, "volume"), 0.85);
    std::string error;
    if (!thestuu::native::setTrackVolume(trackId, volume, error)) {
      return makeErrorResponse(id, error);
    }
    return makeResponse(id, MsgValue::Object{
      {"trackId", MsgValue(trackId)},
      {"volume", MsgValue(volume)},
    });
  }

  if (cmd == "track:set-pan") {
    if (payload == nullptr) {
      return makeErrorResponse(id, "track:set-pan requires payload");
    }
    const int32_t trackId = static_cast<int32_t>(
      asInt(
        getField(*payload, "track_id"),
        asInt(getField(*payload, "trackId"), 1)
      )
    );
    const double pan = asDouble(getField(*payload, "pan"), 0.0);
    std::string error;
    if (!thestuu::native::setTrackPan(trackId, pan, error)) {
      return makeErrorResponse(id, error);
    }
    return makeResponse(id, MsgValue::Object{
      {"trackId", MsgValue(trackId)},
      {"pan", MsgValue(pan)},
    });
  }

  if (cmd == "track:set-record-arm") {
    if (payload == nullptr) {
      return makeErrorResponse(id, "track:set-record-arm requires payload");
    }
    const int32_t trackId = static_cast<int32_t>(
      asInt(
        getField(*payload, "track_id"),
        asInt(getField(*payload, "trackId"), 1)
      )
    );
    const bool armed = asBool(getField(*payload, "record_armed"), asBool(getField(*payload, "recordArmed"), false));
    std::string error;
    if (!thestuu::native::setTrackRecordArm(trackId, armed, error)) {
      return makeErrorResponse(id, error);
    }
    return makeResponse(id, MsgValue::Object{
      {"trackId", MsgValue(trackId)},
      {"record_armed", MsgValue(armed)},
    });
  }

  if (cmd == "audio.get_inputs") {
    std::vector<thestuu::native::AudioDeviceInfo> devices;
    std::string error;
    if (!thestuu::native::getAudioInputDevices(devices, error)) {
      return makeErrorResponse(id, error);
    }
    MsgValue::Array arr;
    arr.reserve(devices.size());
    for (const auto& d : devices) {
      arr.push_back(MsgValue(MsgValue::Object{
        {"id", MsgValue(d.id)},
        {"name", MsgValue(d.name)},
      }));
    }
    std::string currentId;
    thestuu::native::getCurrentAudioInputDeviceId(currentId, error);
    return makeResponse(id, MsgValue::Object{
      {"devices", MsgValue(std::move(arr))},
      {"currentId", MsgValue(currentId)},
    });
  }

  if (cmd == "audio.set_input") {
    std::string deviceId;
    if (payload) {
      deviceId = asString(getField(*payload, "device_id"));
      if (deviceId.empty()) deviceId = asString(getField(*payload, "deviceId"));
    }
    if (deviceId.empty()) {
      return makeErrorResponse(id, "audio.set_input requires device_id");
    }
    std::string error;
    if (!thestuu::native::setAudioInputDevice(deviceId, error)) {
      return makeErrorResponse(id, error);
    }
    return makeResponse(id, MsgValue::Object{{"ok", MsgValue(true)}});
  }

  return makeErrorResponse(id, "unknown cmd: " + cmd);
}

bool processIncomingBuffer(std::vector<uint8_t>& buffer, int clientFd, TransportCore& transport) {
  while (buffer.size() >= kFrameHeaderBytes) {
    const uint32_t frameSize =
      (static_cast<uint32_t>(buffer[0]) << 24) |
      (static_cast<uint32_t>(buffer[1]) << 16) |
      (static_cast<uint32_t>(buffer[2]) << 8) |
      static_cast<uint32_t>(buffer[3]);

    if (frameSize > kMaxFrameSize) {
      const MsgValue error = makeErrorResponse(0, "frame too large");
      sendFrame(clientFd, error);
      return false;
    }

    if (buffer.size() < kFrameHeaderBytes + frameSize) {
      return true;
    }

    std::vector<uint8_t> frame(buffer.begin() + static_cast<std::ptrdiff_t>(kFrameHeaderBytes),
      buffer.begin() + static_cast<std::ptrdiff_t>(kFrameHeaderBytes + frameSize));
    buffer.erase(buffer.begin(), buffer.begin() + static_cast<std::ptrdiff_t>(kFrameHeaderBytes + frameSize));

    try {
      Decoder decoder(frame);
      const MsgValue decoded = decoder.readValue();
      if (!decoder.eof()) {
        const MsgValue error = makeErrorResponse(0, "unexpected trailing bytes");
        if (!sendFrame(clientFd, error)) {
          return false;
        }
        continue;
      }

      const MsgValue::Object* request = asObject(&decoded);
      if (request == nullptr) {
        const MsgValue error = makeErrorResponse(0, "frame root must be map");
        if (!sendFrame(clientFd, error)) {
          return false;
        }
        continue;
      }

      const MsgValue response = handleRequest(*request, transport);
      if (!sendFrame(clientFd, response)) {
        return false;
      }
    } catch (const std::exception& error) {
      const MsgValue response = makeErrorResponse(0, std::string("decode error: ") + error.what());
      if (!sendFrame(clientFd, response)) {
        return false;
      }
    }
  }

  return true;
}

int makeServerSocket(const std::string& socketPath) {
  if (socketPath.size() >= sizeof(sockaddr_un::sun_path)) {
    throw std::runtime_error("socket path too long");
  }

  const int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) {
    throw std::runtime_error("failed to create unix socket");
  }

  sockaddr_un address{};
  address.sun_family = AF_UNIX;
  std::strncpy(address.sun_path, socketPath.c_str(), sizeof(address.sun_path) - 1);

  unlink(socketPath.c_str());

  if (bind(fd, reinterpret_cast<sockaddr*>(&address), sizeof(address)) < 0) {
    close(fd);
    throw std::runtime_error("failed to bind unix socket");
  }

  if (listen(fd, 4) < 0) {
    close(fd);
    throw std::runtime_error("failed to listen on unix socket");
  }

  return fd;
}

bool setNonBlocking(int fd) {
  const int flags = fcntl(fd, F_GETFL, 0);
  if (flags < 0) {
    return false;
  }
  return fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0;
}

void signalHandler(int) {
  g_running = false;
}

std::string resolveSocketPath(int argc, char** argv) {
  std::string path = "/tmp/thestuu-native.sock";

  if (const char* envSocket = std::getenv("STUU_NATIVE_SOCKET")) {
    path = envSocket;
  }

  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    if (arg == "--socket" && i + 1 < argc) {
      path = argv[++i];
    }
  }

  return path;
}

double resolveSampleRate() {
  constexpr double defaultSampleRate = 48000.0;
  if (const char* envValue = std::getenv("STUU_SAMPLE_RATE")) {
    char* end = nullptr;
    const double value = std::strtod(envValue, &end);
    if (end != envValue && std::isfinite(value) && value > 0.0) {
      return value;
    }
  }
  return defaultSampleRate;
}

int resolveBufferSize() {
  constexpr int defaultBufferSize = 256;
  if (const char* envValue = std::getenv("STUU_BUFFER_SIZE")) {
    char* end = nullptr;
    const long value = std::strtol(envValue, &end, 10);
    if (end != envValue && value > 0 && value <= 8192) {
      return static_cast<int>(value);
    }
  }
  return defaultBufferSize;
}

}  // namespace

int main(int argc, char** argv) {
  std::signal(SIGINT, signalHandler);
  std::signal(SIGTERM, signalHandler);
  std::signal(SIGPIPE, SIG_IGN);

  const std::string socketPath = resolveSocketPath(argc, argv);
  const thestuu::native::BackendConfig backendConfig{
    resolveSampleRate(),
    resolveBufferSize(),
  };
  thestuu::native::BackendRuntimeInfo backendInfo{};
  std::string backendError;

  if (!thestuu::native::initialiseBackend(backendConfig, backendInfo, backendError)) {
    std::cerr << "[thestuu-native] backend init failed: " << backendError << "\n";
    return 1;
  }

  g_useTracktionTransport = backendInfo.tracktion;
  std::cout << "[thestuu-native] backend: " << backendInfo.description << "\n";

  TransportCore transport;

  int serverFd = -1;
  try {
    serverFd = makeServerSocket(socketPath);
  } catch (const std::exception& error) {
    std::cerr << "[thestuu-native] boot failed: " << error.what() << "\n";
    return 1;
  }

  std::cout << "[thestuu-native] listening on " << socketPath << "\n";

  // Socket I/O on a background thread so the main thread can run the JUCE message loop (required on macOS).
  std::thread socketThread([&transport, serverFd]() {
    while (g_running) {
      const int clientFd = accept(serverFd, nullptr, nullptr);
      if (clientFd < 0) {
        if (errno == EINTR) {
          continue;
        }
        if (g_running) {
          std::cerr << "[thestuu-native] accept failed: " << std::strerror(errno) << "\n";
        }
        break;
      }

      setNonBlocking(clientFd);
      std::cout << "[thestuu-native] client connected\n";

      std::vector<uint8_t> readBuffer;
      readBuffer.reserve(8192);
      auto nextTick = std::chrono::steady_clock::now();

      while (g_running) {
        fd_set readSet;
        FD_ZERO(&readSet);
        FD_SET(clientFd, &readSet);

        timeval timeout{};
        timeout.tv_sec = 0;
        timeout.tv_usec = 20000;

        const int ready = select(clientFd + 1, &readSet, nullptr, nullptr, &timeout);
        if (ready < 0) {
          if (errno == EINTR) {
            continue;
          }
          break;
        }

        if (ready > 0 && FD_ISSET(clientFd, &readSet)) {
          std::array<uint8_t, 4096> chunk{};
          const ssize_t bytes = recv(clientFd, chunk.data(), chunk.size(), 0);
          if (bytes <= 0) {
            break;
          }
          readBuffer.insert(readBuffer.end(), chunk.begin(), chunk.begin() + bytes);
          if (!processIncomingBuffer(readBuffer, clientFd, transport)) {
            break;
          }
        }

        const auto now = std::chrono::steady_clock::now();
        if (now >= nextTick) {
          if (!sendFrame(clientFd, makeTickEvent(transport))) {
            break;
          }
          nextTick = now + std::chrono::milliseconds(kTickMs);
        }
      }

      close(clientFd);
      std::cout << "[thestuu-native] client disconnected\n";
    }
  });

  // Main thread runs the JUCE message loop so transport.play (callAsync) is processed on the message thread.
  while (g_running) {
    if (g_useTracktionTransport) {
      thestuu::native::runMessageLoopFor(100);
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }

  socketThread.join();
  if (serverFd >= 0) {
    close(serverFd);
  }
  thestuu::native::shutdownBackend();
  unlink(socketPath.c_str());
  std::cout << "[thestuu-native] stopped\n";
  return 0;
}
