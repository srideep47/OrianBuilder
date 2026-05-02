#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

#if ORIAN_HAVE_TENSORRT
#include <NvInfer.h>
#endif

namespace {

#if ORIAN_HAVE_TENSORRT
class Logger final : public nvinfer1::ILogger {
 public:
  void log(Severity severity, const char* msg) noexcept override {
    if (severity <= Severity::kWARNING) {
      std::cerr << "[TensorRT] " << msg << std::endl;
    }
  }
};
#endif

std::string getJsonString(const std::string& json, const std::string& key) {
  const std::string marker = "\"" + key + "\":";
  const auto keyPos = json.find(marker);
  if (keyPos == std::string::npos) return {};
  auto pos = json.find('"', keyPos + marker.size());
  if (pos == std::string::npos) return {};
  ++pos;
  std::string out;
  bool escape = false;
  for (; pos < json.size(); ++pos) {
    const char c = json[pos];
    if (escape) {
      switch (c) {
        case 'n': out.push_back('\n'); break;
        case 'r': out.push_back('\r'); break;
        case 't': out.push_back('\t'); break;
        case '\\': out.push_back('\\'); break;
        case '"': out.push_back('"'); break;
        default: out.push_back(c); break;
      }
      escape = false;
      continue;
    }
    if (c == '\\') {
      escape = true;
      continue;
    }
    if (c == '"') break;
    out.push_back(c);
  }
  return out;
}

int getJsonInt(const std::string& json, const std::string& key, int fallback) {
  const std::string marker = "\"" + key + "\":";
  const auto keyPos = json.find(marker);
  if (keyPos == std::string::npos) return fallback;
  std::stringstream ss(json.substr(keyPos + marker.size()));
  int value = fallback;
  ss >> value;
  return value;
}

std::string escapeJson(const std::string& input) {
  std::string out;
  out.reserve(input.size() + 16);
  for (const char c : input) {
    switch (c) {
      case '\\': out += "\\\\"; break;
      case '"': out += "\\\""; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default: out.push_back(c); break;
    }
  }
  return out;
}

void respondOk(const std::string& id, const std::string& fields = "") {
  std::cout << "{\"id\":\"" << escapeJson(id) << "\",\"ok\":true";
  if (!fields.empty()) std::cout << "," << fields;
  std::cout << "}" << std::endl;
}

void respondError(const std::string& id, const std::string& error) {
  std::cout << "{\"id\":\"" << escapeJson(id)
            << "\",\"ok\":false,\"error\":\"" << escapeJson(error) << "\"}"
            << std::endl;
}

class TensorRtSession {
 public:
  void load(const std::string& engineDir) {
    unload();
    engineDir_ = engineDir;
#if ORIAN_HAVE_TENSORRT
    const auto enginePath = findEngineFile(engineDir);
    if (enginePath.empty()) {
      throw std::runtime_error("No .engine or .plan file found in engine directory");
    }
    std::ifstream file(enginePath, std::ios::binary);
    if (!file) {
      throw std::runtime_error("Failed to open engine file: " + enginePath);
    }
    std::vector<char> bytes(
      (std::istreambuf_iterator<char>(file)),
      std::istreambuf_iterator<char>());
    runtime_.reset(nvinfer1::createInferRuntime(logger_));
    if (!runtime_) {
      throw std::runtime_error("createInferRuntime failed");
    }
    engine_.reset(runtime_->deserializeCudaEngine(bytes.data(), bytes.size()));
    if (!engine_) {
      throw std::runtime_error("deserializeCudaEngine failed");
    }
    context_.reset(engine_->createExecutionContext());
    if (!context_) {
      throw std::runtime_error("createExecutionContext failed");
    }
#else
    const auto enginePath = findEngineFile(engineDir);
    if (enginePath.empty()) {
      throw std::runtime_error("No .engine or .plan file found in engine directory");
    }
#endif
    engineDir_ = engineDir;
    loaded_ = true;
  }

  void unload() {
#if ORIAN_HAVE_TENSORRT
    context_.reset();
    engine_.reset();
    runtime_.reset();
#endif
    engineDir_.clear();
    loaded_ = false;
  }

  std::string chat(const std::string& prompt, int maxTokens, int& tokenCount, double& decodeTps, int& durationMs) {
    if (!loaded_) {
      throw std::runtime_error("TensorRT engine is not loaded");
    }

    const auto start = std::chrono::steady_clock::now();

    // Placeholder response keeps the protocol testable before the TensorRT
    // runtime is linked. Replace this with decode loop output.
    const std::string text =
      "[TensorRT native runner linked, but generation runtime is not implemented yet.] "
      "Engine directory: " + engineDir_ + ". Prompt chars: " +
      std::to_string(prompt.size()) + ". Max tokens: " +
      std::to_string(maxTokens) + ".";

    const auto end = std::chrono::steady_clock::now();
    durationMs = static_cast<int>(
      std::chrono::duration_cast<std::chrono::milliseconds>(end - start).count());
    if (durationMs < 1) durationMs = 1;
    tokenCount = static_cast<int>(text.size() / 4);
    decodeTps = tokenCount / (durationMs / 1000.0);
    return text;
  }

 private:
  static std::string findEngineFile(const std::string& engineDir) {
    namespace fs = std::filesystem;
    const fs::path root(engineDir);
    if (!fs::exists(root)) return {};
    for (const auto& entry : fs::recursive_directory_iterator(root)) {
      if (!entry.is_regular_file()) continue;
      const auto ext = entry.path().extension().string();
      if (ext == ".engine" || ext == ".plan") {
        return entry.path().string();
      }
    }
    return {};
  }

  bool loaded_ = false;
  std::string engineDir_;
#if ORIAN_HAVE_TENSORRT
  struct RuntimeDeleter {
    void operator()(nvinfer1::IRuntime* ptr) const { delete ptr; }
  };
  struct EngineDeleter {
    void operator()(nvinfer1::ICudaEngine* ptr) const { delete ptr; }
  };
  struct ContextDeleter {
    void operator()(nvinfer1::IExecutionContext* ptr) const { delete ptr; }
  };
  Logger logger_;
  std::unique_ptr<nvinfer1::IRuntime, RuntimeDeleter> runtime_;
  std::unique_ptr<nvinfer1::ICudaEngine, EngineDeleter> engine_;
  std::unique_ptr<nvinfer1::IExecutionContext, ContextDeleter> context_;
#endif
};

}  // namespace

int main() {
  TensorRtSession session;
  std::string line;
  while (std::getline(std::cin, line)) {
    const std::string id = getJsonString(line, "id");
    const std::string type = getJsonString(line, "type");
    if (id.empty()) continue;

    try {
      if (type == "load") {
        const std::string engineDir = getJsonString(line, "engineDir");
        if (engineDir.empty()) {
          respondError(id, "engineDir is required");
          continue;
        }
        session.load(engineDir);
        respondOk(id);
      } else if (type == "unload") {
        session.unload();
        respondOk(id);
      } else if (type == "chat") {
        const std::string prompt = getJsonString(line, "prompt");
        const int maxTokens = getJsonInt(line, "maxTokens", 512);
        int tokenCount = 0;
        double decodeTps = 0;
        int durationMs = 0;
        const std::string text = session.chat(prompt, maxTokens, tokenCount, decodeTps, durationMs);
        respondOk(
          id,
          "\"text\":\"" + escapeJson(text) + "\",\"tokenCount\":" +
            std::to_string(tokenCount) + ",\"decodeTps\":" +
            std::to_string(decodeTps) + ",\"durationMs\":" +
            std::to_string(durationMs));
      } else {
        respondError(id, "unknown request type: " + type);
      }
    } catch (const std::exception& ex) {
      respondError(id, ex.what());
    }
  }
  return 0;
}
