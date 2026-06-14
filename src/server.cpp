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
static std::string g_siliconflowKey;
static std::string g_sparkApiPassword;
static XfyunConfig g_xfyunCfg;

// 讯飞会话
struct XfyunSess {
    std::unique_ptr<SpeechRecognizer> reco;
    std::string text;
    bool initialized = false;  // 是否已尝试过建立连接
    bool ended = false;
};
static std::map<std::string, XfyunSess> g_sessions;
static std::mutex g_sessMutex;

// 历史记录
struct HistoryItem {
    std::string id;
    std::string localPath;
    std::string prompt;
    std::string negativePrompt;
    std::string correctedText;
    std::string provider;
    std::string timestamp;
};
static std::vector<HistoryItem> g_history;
static std::mutex g_histMutex;

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
        if (k == "SILICONFLOW_API_KEY") g_siliconflowKey = v;
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
              << "  SiliconFlow: " << (g_siliconflowKey.empty() ? "NOT FOUND" : "loaded")
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

    // ---- POST /api/generate (SiliconFlow 优先 → DashScope 回退) --------------------
    svr.Post("/api/generate", [](const httplib::Request& req, httplib::Response& res) {
        json reqBody;
        try { reqBody = json::parse(req.body); } catch (...) {
            res.status = 400;
            res.set_content("{\"error\":\"invalid JSON\"}", "application/json");
            return;
        }
        std::string prompt = reqBody.value("prompt", "");
        std::string negativePrompt = reqBody.value("negativePrompt", "");
        std::string correctedText = reqBody.value("correctedText", "");
        std::string requestedModel = reqBody.value("model", "flux-schnell");  // 默认 FLUX
        if (prompt.empty()) {
            res.status = 400;
            res.set_content("{\"error\":\"missing prompt\"}", "application/json");
            return;
        }

        std::string imageUrl;
        std::string provider;

        // ---- SiliconFlow: 根据 model 参数选择模型 ----
        if (!g_siliconflowKey.empty()) {
            std::string sfModel;
            int sfSteps = 4;           // FLUX 默认 4 步
            std::string sfSize = "1024x1024";

            if (requestedModel == "kolors") {
                sfModel = "Kwai-Kolors/Kolors";
                sfSteps = 20;           // Kolors 推荐 20 步
            } else {
                // 默认 flux-schnell
                sfModel = "black-forest-labs/FLUX.1-schnell";
                sfSteps = 4;
            }

            std::cout << "[GENERATE] trying SiliconFlow (" << sfModel << ")..." << std::endl;
            json sfBody;
            sfBody["model"] = sfModel;
            sfBody["prompt"] = prompt;
            if (!negativePrompt.empty()) sfBody["negative_prompt"] = negativePrompt;
            sfBody["image_size"] = sfSize;
            sfBody["num_inference_steps"] = sfSteps;

            httplib::Client sfCli("https://api.siliconflow.cn");
            sfCli.set_read_timeout(120);

            httplib::Request sfReq;
            sfReq.method = "POST";
            sfReq.path = "/v1/images/generations";
            sfReq.set_header("Content-Type", "application/json");
            sfReq.set_header("Authorization", "Bearer " + g_siliconflowKey);
            sfReq.body = sfBody.dump();

            auto sfRes = sfCli.send(sfReq);
            if (sfRes && sfRes->status == 200) {
                json sfResp;
                try {
                    sfResp = json::parse(sfRes->body);
                    if (sfResp.contains("images") && sfResp["images"].is_array() && !sfResp["images"].empty()) {
                        imageUrl = sfResp["images"][0].value("url", "");
                    }
                } catch (...) {}
            }
            if (!imageUrl.empty()) {
                provider = "siliconflow-" + requestedModel;
                std::cout << "[GENERATE] SiliconFlow OK (" << sfModel << ")" << std::endl;
            } else {
                std::cerr << "[GENERATE] SiliconFlow failed, falling back to DashScope" << std::endl;
            }
        }

        // ---- 回退: DashScope wanx-v1 异步模式 ----
        if (imageUrl.empty() && !g_dashscopeKey.empty()) {
            std::cout << "[GENERATE] trying DashScope..." << std::endl;
            provider = "dashscope";

            json dashBody;
            dashBody["model"] = "wanx-v1";
            dashBody["input"]["prompt"] = prompt;
            if (!negativePrompt.empty()) {
                dashBody["input"]["negative_prompt"] = negativePrompt;
            }
            dashBody["parameters"]["size"] = "1024*1024";
            dashBody["parameters"]["n"] = 1;

            httplib::Client dashCli("https://dashscope.aliyuncs.com");
            dashCli.set_read_timeout(30);

            httplib::Request asyncReq;
            asyncReq.method = "POST";
            asyncReq.path = "/api/v1/services/aigc/text2image/image-synthesis";
            asyncReq.set_header("Content-Type", "application/json");
            asyncReq.set_header("Authorization", "Bearer " + g_dashscopeKey);
            asyncReq.set_header("X-DashScope-Async", "enable");
            asyncReq.body = dashBody.dump();

            auto submitRes = dashCli.send(asyncReq);
            if (!submitRes) {
                res.status = 502;
                res.set_content("{\"error\":\"dashscope submit failed\"}", "application/json");
                std::cerr << "[GENERATE] DashScope submit: no response" << std::endl;
                return;
            }

            json submitResp;
            try { submitResp = json::parse(submitRes->body); } catch (...) {
                res.status = 502;
                res.set_content("{\"error\":\"invalid dashscope response\"}", "application/json");
                std::cerr << "[GENERATE] DashScope parse: " << submitRes->body.substr(0, 300) << std::endl;
                return;
            }

            if (submitResp.contains("code") && !submitResp["code"].is_null()) {
                std::string code = submitResp.value("code", "");
                if (code != "200") {
                    res.status = 502;
                    json err;
                    err["error"] = submitResp.value("message", "");
                    err["raw"] = submitRes->body.substr(0, 300);
                    res.set_content(err.dump(), "application/json");
                    std::cerr << "[GENERATE] DashScope error: " << submitRes->body << std::endl;
                    return;
                }
            }

            std::string taskId;
            if (submitResp.contains("output") && submitResp["output"].contains("task_id")) {
                taskId = submitResp["output"]["task_id"].get<std::string>();
            }
            if (taskId.empty()) {
                res.status = 502;
                res.set_content("{\"error\":\"no task_id\"}", "application/json");
                return;
            }
            std::cout << "[GENERATE] DashScope task: " << taskId << std::endl;

            // 轮询
            int maxPoll = 120;
            for (int i = 0; i < maxPoll; i++) {
                std::this_thread::sleep_for(std::chrono::seconds(1));
                httplib::Request pollReq;
                pollReq.method = "GET";
                pollReq.path = "/api/v1/tasks/" + taskId;
                pollReq.set_header("Authorization", "Bearer " + g_dashscopeKey);

                auto pollRes = dashCli.send(pollReq);
                if (!pollRes || pollRes->status != 200) continue;

                json pollResp;
                try { pollResp = json::parse(pollRes->body); } catch (...) { continue; }

                std::string taskStatus = pollResp.value("output", json::object()).value("task_status", "");
                if (taskStatus == "SUCCEEDED") {
                    if (pollResp["output"].contains("results")) {
                        imageUrl = pollResp["output"]["results"][0].value("url", "");
                    }
                    break;
                } else if (taskStatus == "FAILED") {
                    res.status = 502;
                    json err;
                    err["error"] = pollResp.value("output", json::object()).value("message", "task failed");
                    res.set_content(err.dump(), "application/json");
                    std::cerr << "[GENERATE] DashScope task failed" << std::endl;
                    return;
                }
            }

            if (imageUrl.empty()) {
                res.status = 502;
                res.set_content("{\"error\":\"dashscope timeout\"}", "application/json");
                return;
            }
        }

        if (imageUrl.empty()) {
            res.status = 500;
            res.set_content("{\"error\":\"no image provider available (need SILICONFLOW_API_KEY or DASHSCOPE_API_KEY)\"}", "application/json");
            return;
        }

        // ---- 下载图片到本地 ----
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
        out["provider"]  = provider;

        // 保存历史记录
        {
            auto now = std::chrono::system_clock::now();
            auto t = std::chrono::system_clock::to_time_t(now);
            char ts[32];
#ifdef _WIN32
            struct tm ltm;
            localtime_s(&ltm, &t);
            std::strftime(ts, sizeof(ts), "%Y-%m-%d %H:%M:%S", &ltm);
#else
            std::strftime(ts, sizeof(ts), "%Y-%m-%d %H:%M:%S", std::localtime(&t));
#endif
            std::lock_guard<std::mutex> lk(g_histMutex);
            HistoryItem item;
            item.id = std::to_string(imgIdx);
            item.localPath = "/" + localPath;
            item.prompt = prompt;
            item.negativePrompt = negativePrompt;
            item.correctedText = correctedText;
            item.provider = provider;
            item.timestamp = ts;
            g_history.insert(g_history.begin(), item);
            out["id"] = item.id;
        }

        res.set_content(out.dump(), "application/json");
        std::cout << "[GENERATE] " << localPath << " via " << provider << std::endl;
    });

    // ---- GET /api/history (历史记录) ------------------------------------
    svr.Get("/api/history", [](const httplib::Request&, httplib::Response& res) {
        std::lock_guard<std::mutex> lk(g_histMutex);
        json arr = json::array();
        for (auto& item : g_history) {
            json j;
            j["id"]             = item.id;
            j["localPath"]      = item.localPath;
            j["prompt"]         = item.prompt;
            j["negativePrompt"] = item.negativePrompt;
            j["correctedText"]  = item.correctedText;
            j["provider"]       = item.provider;
            j["timestamp"]      = item.timestamp;
            arr.push_back(j);
        }
        res.set_content(arr.dump(), "application/json");
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
            if (sess.reco && sess.reco->isConnected() && !sess.ended) {
                sess.reco->sendEnd();
                sess.ended = true;
                // sendEnd 会等待最终结果，更新 sess.text
                finalText = sess.text;
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
        if (!sess.initialized && g_xfyunCfg.isValid()) {
            sess.reco = std::make_unique<SpeechRecognizer>(g_xfyunCfg);
            sess.reco->setOnText([&sess](const std::string& t, bool final, double conf) {
                sess.text += t;
            });
            sess.initialized = true;
            if (!sess.reco->connect()) {
                std::cerr << "[SPEECH] 讯飞连接失败, session=" << sid << std::endl;
                sess.reco.reset();
                sess.initialized = false;
            }
        }

        // 发送音频（raw PCM binary body）
        if (sess.reco && sess.reco->isConnected() && !sess.ended) {
            std::vector<uint8_t> pcm(req.body.begin(), req.body.end());
            if (!pcm.empty()) {
                sess.reco->sendAudio(pcm);
            }
        }

        // 检测讯飞连接是否已断开（VAD 静音自动关闭 / 错误断连）
        // 使用 reco->isConnected() 而非缓存的 connected 标志
        if (sess.reco && !sess.reco->isConnected() && !sess.text.empty()) {
            std::string finalText = sess.text;
            if (sess.reco) sess.reco->disconnect();
            g_sessions.erase(sid);

            json out;
            out["text"] = finalText;
            out["isFinal"] = true;
            out["confidence"] = 0.9;
            res.set_content(out.dump(), "application/json");
            std::cout << "[SPEECH] VAD auto-end session " << sid << ". final: " << finalText << std::endl;
            return;
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
            if (sess.reco && sess.reco->isConnected() && !sess.ended) {
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
