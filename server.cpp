/**
 * server.cpp — AI 语音绘图 C++ 后端
 * PR 3.2: /api/parse → DeepSeek 理解中文 → 优化英文 Prompt
 *
 * WSL 编译:  cmake -B build -DCMAKE_BUILD_TYPE=Debug && cmake --build build -j$(nproc)
 * 运行:      ./build/server
 *
 * 依赖: cpp-httplib + nlohmann/json + OpenSSL（libssl-dev）
 */

#define CPPHTTPLIB_OPENSSL_SUPPORT
#include "httplib.h"
#include "nlohmann/json.hpp"

#include <cctype>
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
    std::cout << "[INFO] DeepSeek: " << (g_deepseekKey.empty() ? "NOT FOUND" : "loaded")
              << "  DashScope: " << (g_dashscopeKey.empty() ? "NOT FOUND" : "loaded") << std::endl;
    if (g_deepseekKey.empty())  std::cerr << "Set DEEPSEEK_API_KEY in .env" << std::endl;
    if (g_dashscopeKey.empty()) std::cerr << "Set DASHSCOPE_API_KEY in .env" << std::endl;

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

    // ---- POST /api/parse -------------------------------------------------
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

        if (g_deepseekKey.empty()) {
            res.status = 500;
            res.set_content("{\"error\":\"API key not set\"}", "application/json");
            return;
        }

        std::string raw;
        if (!callDeepSeek(PARSE_SYSTEM_PROMPT, text, raw) || raw.empty()) {
            res.status = 502;
            res.set_content("{\"error\":\"DeepSeek API failed\"}", "application/json");
            return;
        }

        // Parse response
        json apiResp;
        try { apiResp = json::parse(raw); } catch (...) {
            res.status = 502;
            res.set_content("{\"error\":\"invalid API response\"}", "application/json");
            return;
        }

        std::string content = apiResp["choices"][0]["message"]["content"];

        // Strip markdown
        {
            auto p = content.find("```json");
            if (p != std::string::npos) content = content.substr(p + 7);
            else { p = content.find("```"); if (p != std::string::npos) content = content.substr(p + 3); }
            p = content.rfind("```");
            if (p != std::string::npos) content = content.substr(0, p);
            auto a = content.find_first_not_of(" \t\n\r");
            auto b = content.find_last_not_of(" \t\n\r");
            if (a != std::string::npos) content = content.substr(a, b - a + 1);
        }

        json parsed;
        try { parsed = json::parse(content); } catch (...) {
            res.status = 502;
            json err;
            err["error"] = "LLM output not valid JSON";
            err["raw"] = content;
            res.set_content(err.dump(), "application/json");
            return;
        }

        res.set_content(parsed.dump(), "application/json");
        std::cout << "[PARSE] \"" << text.substr(0, 40) << "\" -> "
                  << parsed.value("englishPrompt", "?").substr(0, 60) << "..." << std::endl;
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

        // wanx-v1 异步 API（httplib + OpenSSL 直连，零 system()）
        json dashBody;
        dashBody["model"] = "wanx-v1";
        dashBody["input"]["prompt"] = prompt;
        dashBody["parameters"]["size"] = "1024*1024";
        dashBody["parameters"]["n"] = 1;

        // 1. 提交任务
        httplib::Client dashCli("https://dashscope.aliyuncs.com");
        dashCli.set_read_timeout(30);

        // 手动构造 Request，完全控制所有 header（DashScope 对 Accept 敏感）
        httplib::Request subReq;
        subReq.method = "POST";
        subReq.path = "/api/v1/services/aigc/text2image/image-synthesis";
        subReq.set_header("Content-Type", "application/json");
        subReq.set_header("X-DashScope-Async", "enable");
        subReq.set_header("Authorization", "Bearer " + g_dashscopeKey);
        subReq.body = dashBody.dump();

        auto submitRes = dashCli.send(subReq);

        if (!submitRes) {
            res.status = 502;
            res.set_content("{\"error\":\"dashscope submit failed\"}", "application/json");
            std::cerr << "[GENERATE] submit: no response" << std::endl;
            return;
        }
        json submitResp;
        try { submitResp = json::parse(submitRes->body); } catch (...) {
            res.status = 502;
            res.set_content("{\"error\":\"invalid submit response\"}", "application/json");
            std::cerr << "[GENERATE] submit parse: " << submitRes->body.substr(0, 300) << std::endl;
            return;
        }
        if (submitResp.contains("code") && !submitResp["code"].is_null()) {
            res.status = 502;
            json err;
            err["error"] = submitResp.value("message", "");
            err["raw"] = submitRes->body.substr(0, 300);
            res.set_content(err.dump(), "application/json");
            std::cerr << "[GENERATE] submit error: " << submitRes->body << std::endl;
            return;
        }

        std::string taskId = submitResp["output"]["task_id"];
        std::cout << "[GENERATE] task: " << taskId << std::endl;

        // 2. 轮询
        std::string imageUrl;
        for (int i = 0; i < 20; i++) {
            std::this_thread::sleep_for(std::chrono::seconds(1));
            auto pollRes = dashCli.Get(
                ("/api/v1/tasks/" + taskId).c_str(),
                {{"Authorization", "Bearer " + g_dashscopeKey}});

            if (!pollRes) continue;
            json pResp;
            try { pResp = json::parse(pollRes->body); } catch (...) { continue; }
            std::string status = pResp["output"].value("task_status", "");
            if (status == "SUCCEEDED") {
                imageUrl = pResp["output"]["results"][0].value("url", "");
                break;
            } else if (status == "FAILED") {
                res.status = 502;
                res.set_content("{\"error\":\"generation failed\"}", "application/json");
                return;
            }
        }

        if (imageUrl.empty()) {
            res.status = 502;
            res.set_content("{\"error\":\"timeout\"}", "application/json");
            return;
        }

        // 3. 下载图片
        std::string host, path;
        auto slashSlash = imageUrl.find("//");
        if (slashSlash != std::string::npos) {
            auto hostStart = slashSlash + 2;
            auto pathStart = imageUrl.find('/', hostStart);
            host = imageUrl.substr(hostStart, pathStart - hostStart);
            path = imageUrl.substr(pathStart);
        }
        httplib::Client dlCli("https://" + host);
        dlCli.set_read_timeout(30);
        auto dlRes = dlCli.Get(path.c_str());
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

    std::cout << "=== AI Voice Drawing Backend :" << port << " ===" << std::endl;
    svr.listen("0.0.0.0", port);
    return 0;
}
