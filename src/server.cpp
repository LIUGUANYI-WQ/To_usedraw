/**
 * server.cpp — AI 语音绘图 C++ 后端
 * PR 3.2: /api/parse → DeepSeek 理解中文 → 优化英文 Prompt
 *
 * WSL 编译:  cmake -B build -DCMAKE_BUILD_TYPE=Debug && cmake --build build -j$(nproc)
 * 运行:      ./build/server
 *
 * 依赖: cpp-httplib + nlohmann/json + OpenSSL（libssl-dev）
 */

#ifndef CPPHTTPLIB_OPENSSL_SUPPORT
#define CPPHTTPLIB_OPENSSL_SUPPORT
#endif
#include "httplib.h"
#include "nlohmann/json.hpp"
#include "speech_recognizer.h"
#include "spark_client.h"

#include <curl/curl.h>
#include <map>
#include <mutex>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <string>
#include <thread>
#include <filesystem>

using json = nlohmann::json;
namespace fs = std::filesystem;

// ===== API Keys =====
static std::string g_deepseekKey;
static std::string g_zhipuKey;
static std::string g_dashscopeKey;
static std::string g_sparkApiPassword;
static XfyunConfig g_xfyunCfg;

// 讯飞会话
struct XfyunSess {
    std::unique_ptr<SpeechRecognizer> reco;
    std::string text;
    bool connected = false;
    bool ended = false;
};
static std::map<std::string, XfyunSess> g_sessions;
static std::mutex g_sessMutex;

static void initApiKeys() {
    std::ifstream f(".env");
    if (!f) return;
    std::string line;
    while (std::getline(f, line)) {
        if (line.empty() || line[0] == '#') continue;
        auto s = line.find_first_not_of(" \t\r");
        auto e = line.find_last_not_of(" \t\r");
        if (s == std::string::npos) continue;
        line = line.substr(s, e - s + 1);
        auto eq = line.find('=');
        if (eq == std::string::npos) continue;
        std::string k = line.substr(0, eq);
        std::string v = line.substr(eq + 1);
        if (!v.empty() && v.front() == '"' && v.back() == '"')
            v = v.substr(1, v.size() - 2);
        if (k == "DEEPSEEK_API_KEY")   g_deepseekKey = v;
        if (k == "ZHIPU_API_KEY")      g_zhipuKey = v;
        if (k == "DASHSCOPE_API_KEY")  g_dashscopeKey = v;
        if (k == "SPARK_API_PASSWORD") g_sparkApiPassword = v;
        if (k == "XFYUN_APP_ID")        g_xfyunCfg.appId = v;
        if (k == "XFYUN_API_KEY")       g_xfyunCfg.apiKey = v;
        if (k == "XFYUN_API_SECRET")    g_xfyunCfg.apiSecret = v;
    }
}

// ===== DeepSeek HTTPS (httplib + OpenSSL) =====
static bool callDeepSeek(const std::string& systemPrompt,
                         const std::string& userText,
                         std::string& outResponse) {
    json body;
    body["model"] = "deepseek-chat";
    body["temperature"] = 0.3;
    body["messages"] = json::array({
        {{"role","system"}, {"content",systemPrompt}},
        {{"role","user"},   {"content",userText}}
    });

    httplib::Client cli("https://api.deepseek.com");
    cli.set_read_timeout(30);
    cli.set_write_timeout(30);
    cli.enable_server_certificate_verification(true);

    auto res = cli.Post("/v1/chat/completions",
        {{"Content-Type", "application/json"},
         {"Authorization", "Bearer " + g_deepseekKey}},
        body.dump(), "application/json");

    if (!res || res->status != 200) {
        std::cerr << "[ERROR] DeepSeek: " << (res ? std::to_string(res->status) : "no response") << std::endl;
        if (res) std::cerr << "  body: " << res->body.substr(0, 300) << std::endl;
        return false;
    }

    outResponse = res->body;
    return true;
}

// ===== System Prompt =====
static const char* PARSE_SYSTEM_PROMPT =
    "You are an AI drawing assistant. The user describes a scene in Chinese via voice, "
    "which may contain speech recognition errors (homophones, typos).\n\n"
    "Your tasks:\n"
    "1. Correct any Chinese speech recognition errors\n"
    "2. Understand what scene, style, and mood the user wants\n"
    "3. Convert the corrected description into an optimized English "
    "Stable Diffusion prompt (comma-separated keywords)\n\n"
    "## Prompt rules\n"
    "- Format: subject, scene, details, style, lighting, quality\n"
    "- Always append: masterpiece, best quality\n"
    "- Default style: digital illustration, vibrant colors\n"
    "- Infer reasonable details if vague\n"
    "- Never add NSFW content\n\n"
    "## Return strict JSON only, no markdown\n"
    "{\n"
    "  \"correctedText\": \"corrected Chinese\",\n"
    "  \"englishPrompt\": \"optimized SD prompt\",\n"
    "  \"style\": \"inferred style\",\n"
    "  \"analysis\": \"one-sentence summary\"\n"
    "}";

// ===== main =====
int main() {
    initApiKeys();

    // 全局初始化 libcurl（必须在多线程使用前调用一次）
    curl_global_init(CURL_GLOBAL_DEFAULT);

    std::cout << "[INFO] DeepSeek: " << (g_deepseekKey.empty() ? "NOT FOUND" : "loaded")
              << "  DashScope: " << (g_dashscopeKey.empty() ? "NOT FOUND" : "loaded")
              << "  Spark: " << (g_sparkApiPassword.empty() ? "NOT FOUND" : "loaded")
              << "  Xfyun: " << (g_xfyunCfg.isValid() ? "loaded" : "NOT FOUND") << std::endl;

    // 创建 generated 目录（图片输出）
    fs::create_directory("generated");

    httplib::Server svr;
    const int port = 8080;

    svr.set_mount_point("/", ".");

    svr.Get("/api/health", [](const httplib::Request&, httplib::Response& res) {
        json b;
        b["status"] = "ok"; b["version"] = "0.3.0";
        res.set_content(b.dump(), "application/json");
    });

    // ---- POST /api/parse (星火 Lite → 优化 Prompt) ---------------------
    svr.Post("/api/parse", [](const httplib::Request& req, httplib::Response& res) {
        json reqBody;
        try { reqBody = json::parse(req.body); } catch (...) {
            res.status = 400;
            res.set_content("{\"error\":\"invalid JSON\"}", "application/json");
            return;
        }

        std::string text = reqBody.value("text", "");
        if (text.empty()) {
            res.status = 400;
            res.set_content("{\"error\":\"missing text\"}", "application/json");
            return;
        }

        if (g_sparkApiPassword.empty()) {
            res.status = 500;
            res.set_content("{\"error\":\"SPARK_API_PASSWORD not set\"}", "application/json");
            return;
        }

        SparkClient spark(g_sparkApiPassword);
        std::string prompt, negativePrompt;
        if (!spark.optimizePrompt(text, prompt, negativePrompt)) {
            res.status = 502;
            res.set_content("{\"error\":\"Spark API failed\"}", "application/json");
            return;
        }

        json out;
        out["correctedText"] = text;
        out["englishPrompt"] = prompt;
        out["negativePrompt"] = negativePrompt;
        out["style"] = "auto";
        out["analysis"] = "";
        res.set_content(out.dump(), "application/json");
        std::cout << "[PARSE] \"" << text.substr(0, 40) << "\" -> "
                  << prompt.substr(0, 60) << "..." << std::endl;
    });

    // ---- POST /api/spark-parse (讯飞星火 Lite → 优化 Prompt) -----------
    svr.Post("/api/spark-parse", [](const httplib::Request& req, httplib::Response& res) {
        json reqBody;
        try { reqBody = json::parse(req.body); } catch (...) {
            res.status = 400;
            res.set_content("{\"error\":\"invalid JSON\"}", "application/json");
            return;
        }

        std::string text = reqBody.value("text", "");
        if (text.empty()) {
            res.status = 400;
            res.set_content("{\"error\":\"missing text\"}", "application/json");
            return;
        }

        if (g_sparkApiPassword.empty()) {
            res.status = 500;
            res.set_content("{\"error\":\"SPARK_API_PASSWORD not set\"}", "application/json");
            return;
        }

        SparkClient spark(g_sparkApiPassword);
        std::string prompt, negativePrompt;
        if (!spark.optimizePrompt(text, prompt, negativePrompt)) {
            res.status = 502;
            res.set_content("{\"error\":\"Spark API failed\"}", "application/json");
            return;
        }

        json out;
        out["englishPrompt"] = prompt;
        out["negativePrompt"] = negativePrompt;
        out["rawText"] = text;
        res.set_content(out.dump(), "application/json");
    });

    // ---- POST /api/parse-stream (星火 Lite 流式 SSE → 优化 Prompt) ------
    svr.Post("/api/parse-stream", [](const httplib::Request& req, httplib::Response& res) {
        json reqBody;
        try { reqBody = json::parse(req.body); } catch (...) {
            res.status = 400;
            res.set_content("{\"error\":\"invalid JSON\"}", "application/json");
            return;
        }

        std::string text = reqBody.value("text", "");
        if (text.empty()) {
            res.status = 400;
            res.set_content("{\"error\":\"missing text\"}", "application/json");
            return;
        }

        if (g_sparkApiPassword.empty()) {
            res.status = 500;
            res.set_content("{\"error\":\"SPARK_API_PASSWORD not set\"}", "application/json");
            return;
        }

        // 设置 SSE 响应头
        res.set_header("Content-Type", "text/event-stream");
        res.set_header("Cache-Control", "no-cache");
        res.set_header("Connection", "keep-alive");

        // 流式调用星火，每个 chunk 通过 SSE 推送给前端
        SparkClient spark(g_sparkApiPassword);
        std::string prompt, negativePrompt;

        bool ok = spark.optimizePromptStreaming(text,
            [&res](const std::string& delta) {
                // SSE 格式: data: {...}\n\n
                json chunk;
                chunk["type"] = "delta";
                chunk["text"] = delta;
                res.body += "data: " + chunk.dump() + "\n\n";
            },
            prompt, negativePrompt);

        if (!ok) {
            json errChunk;
            errChunk["type"] = "error";
            errChunk["error"] = "Spark API failed";
            res.body += "data: " + errChunk.dump() + "\n\n";
            return;
        }

        // 最终结果
        json doneChunk;
        doneChunk["type"] = "done";
        doneChunk["englishPrompt"] = prompt;
        doneChunk["negativePrompt"] = negativePrompt;
        doneChunk["correctedText"] = text;
        doneChunk["style"] = "auto";
        res.body += "data: " + doneChunk.dump() + "\n\n";

        std::cout << "[PARSE-STREAM] \"" << text.substr(0, 40) << "\" -> "
                  << prompt.substr(0, 60) << "..." << std::endl;
    });

    // ---- POST /api/generate (DashScope Z-Image-Turbo) --------------------
    svr.Post("/api/generate", [](const httplib::Request& req, httplib::Response& res) {
        json reqBody;
        try { reqBody = json::parse(req.body); } catch (...) {
            res.status = 400;
            res.set_content("{\"error\":\"invalid JSON\"}", "application/json");
            return;
        }
        std::string prompt = reqBody.value("prompt", "");
        std::string negativePrompt = reqBody.value("negativePrompt", "");
        if (prompt.empty()) {
            res.status = 400;
            res.set_content("{\"error\":\"missing prompt\"}", "application/json");
            return;
        }
        if (g_dashscopeKey.empty()) {
            res.status = 500;
            res.set_content("{\"error\":\"DASHSCOPE_API_KEY not set\"}", "application/json");
            return;
        }

        // wanx-v1 同步 API（去掉 X-DashScope-Async，一次请求直接返回结果）
        json dashBody;
        dashBody["model"] = "wanx-v1";
        dashBody["input"]["prompt"] = prompt;
        if (!negativePrompt.empty()) {
            dashBody["input"]["negative_prompt"] = negativePrompt;
        }
        dashBody["parameters"]["size"] = "1024*1024";
        dashBody["parameters"]["n"] = 1;

        httplib::Client dashCli("https://dashscope.aliyuncs.com");
        dashCli.set_read_timeout(120);

        httplib::Request syncReq;
        syncReq.method = "POST";
        syncReq.path = "/api/v1/services/aigc/text2image/image-synthesis";
        syncReq.set_header("Content-Type", "application/json");
        syncReq.set_header("Authorization", "Bearer " + g_dashscopeKey);
        syncReq.body = dashBody.dump();

        auto syncRes = dashCli.send(syncReq);

        if (!syncRes) {
            res.status = 502;
            res.set_content("{\"error\":\"dashscope request failed\"}", "application/json");
            std::cerr << "[GENERATE] sync: no response" << std::endl;
            return;
        }
        json syncResp;
        try { syncResp = json::parse(syncRes->body); } catch (...) {
            res.status = 502;
            res.set_content("{\"error\":\"invalid response\"}", "application/json");
            std::cerr << "[GENERATE] sync parse: " << syncRes->body.substr(0, 300) << std::endl;
            return;
        }

        // 检查错误
        if (syncResp.contains("code") && !syncResp["code"].is_null()) {
            res.status = 502;
            json err;
            err["error"] = syncResp.value("message", "");
            err["raw"] = syncRes->body.substr(0, 300);
            res.set_content(err.dump(), "application/json");
            std::cerr << "[GENERATE] sync error: " << syncRes->body << std::endl;
            return;
        }

        // 同步返回：直接从 output.results 取 URL
        std::string imageUrl;
        if (syncResp.contains("output") && syncResp["output"].contains("results")) {
            imageUrl = syncResp["output"]["results"][0].value("url", "");
        }

        if (imageUrl.empty()) {
            res.status = 502;
            res.set_content("{\"error\":\"no image url in response\"}", "application/json");
            std::cerr << "[GENERATE] no url: " << syncRes->body.substr(0, 300) << std::endl;
            return;
        }

        // 下载图片到本地
        std::string host, dlPath;
        auto slashSlash = imageUrl.find("//");
        if (slashSlash != std::string::npos) {
            auto hostStart = slashSlash + 2;
            auto pathStart = imageUrl.find('/', hostStart);
            host = imageUrl.substr(hostStart, pathStart - hostStart);
            dlPath = imageUrl.substr(pathStart);
        }
        httplib::Client dlCli("https://" + host);
        dlCli.set_read_timeout(30);
        auto dlRes = dlCli.Get(dlPath.c_str());
        if (!dlRes || dlRes->status != 200) {
            res.status = 502;
            res.set_content("{\"error\":\"image download failed\"}", "application/json");
            return;
        }

        static int imgIdx = 0; imgIdx++;
        std::string localPath = "generated/img_" + std::to_string(imgIdx) + ".png";
        std::ofstream(localPath, std::ios::binary) << dlRes->body;

        json out;
        out["imageUrl"]  = imageUrl;
        out["localPath"] = "/" + localPath;
        out["prompt"]    = prompt;
        res.set_content(out.dump(), "application/json");
        std::cout << "[GENERATE] " << localPath << std::endl;
    });

    // ---- POST /api/speech (音频分片 → 讯飞转写) ---------------------
    svr.Post("/api/speech", [](const httplib::Request& req, httplib::Response& res) {
        std::string sid = req.has_param("session") ? req.get_param_value("session") : "default";

        // 检查是否结束标志
        bool endFlag = req.has_param("end") && req.get_param_value("end") == "1";

        std::lock_guard<std::mutex> lk(g_sessMutex);
        auto& sess = g_sessions[sid];

        if (endFlag) {
            // 结束请求: 发送讯飞 end frame，返回最终文字
            std::string finalText = sess.text;
            if (sess.reco && sess.connected && !sess.ended) {
                sess.reco->sendEnd();
                sess.ended = true;
            }
            json out;
            out["text"] = finalText;
            out["isFinal"] = true;
            out["confidence"] = 0.9;
            res.set_content(out.dump(), "application/json");
            // 清理
            if (sess.reco) sess.reco->disconnect();
            g_sessions.erase(sid);
            std::cout << "[SPEECH] session " << sid << " ended. final: " << finalText << std::endl;
            return;
        }

        // 新会话: 建立讯飞连接
        if (!sess.connected && g_xfyunCfg.isValid()) {
            sess.reco = std::make_unique<SpeechRecognizer>(g_xfyunCfg);
            sess.reco->setOnText([&sess](const std::string& t, bool final, double conf) {
                sess.text += t;
            });
            sess.connected = sess.reco->connect();
        }

        // 发送音频（raw PCM binary body）
        if (sess.reco && sess.connected && !sess.ended) {
            std::vector<uint8_t> pcm(req.body.begin(), req.body.end());
            if (!pcm.empty()) {
                sess.reco->sendAudio(pcm);
            }
        }

        json out;
        out["text"] = sess.text;
        out["isFinal"] = false;
        out["confidence"] = 0.0;
        res.set_content(out.dump(), "application/json");
    });

    // ---- POST /api/speech/stop (终止会话) ---------------------------
    svr.Post("/api/speech/stop", [](const httplib::Request& req, httplib::Response& res) {
        std::string sid = req.has_param("session") ? req.get_param_value("session") : "default";
        std::lock_guard<std::mutex> lk(g_sessMutex);
        auto it = g_sessions.find(sid);
        json out;
        if (it != g_sessions.end()) {
            auto& sess = it->second;
            if (sess.reco && sess.connected && !sess.ended) {
                sess.reco->sendEnd();
                sess.ended = true;
            }
            out["text"] = sess.text;
            out["isFinal"] = true;
            if (sess.reco) sess.reco->disconnect();
            g_sessions.erase(it);
        } else {
            out["text"] = "";
            out["isFinal"] = true;
        }
        res.set_content(out.dump(), "application/json");
    });

    std::cout << "=== AI Voice Drawing Backend :" << port << " ===" << std::endl;
    svr.listen("0.0.0.0", port);
    return 0;
}
