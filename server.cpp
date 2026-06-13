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

#include <cstdlib>
#include <fstream>
#include <iostream>
#include <string>
#include <filesystem>

using json = nlohmann::json;
namespace fs = std::filesystem;

// ===== API Key =====
static std::string g_apiKey;

static void initApiKey() {
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
        if (line.substr(0, eq) == "DEEPSEEK_API_KEY") {
            g_apiKey = line.substr(eq + 1);
            if (!g_apiKey.empty() && g_apiKey.front() == '"' && g_apiKey.back() == '"')
                g_apiKey = g_apiKey.substr(1, g_apiKey.size() - 2);
            return;
        }
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
         {"Authorization", "Bearer " + g_apiKey}},
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
    initApiKey();
    std::cout << "[INFO] API Key: " << (g_apiKey.empty() ? "NOT FOUND" : "loaded") << std::endl;
    if (g_apiKey.empty()) {
        std::cerr << "Please create .env with DEEPSEEK_API_KEY=sk-xxx" << std::endl;
    }

    httplib::Server svr;
    const int port = 8080;

    svr.set_mount_point("/", ".");

    svr.Get("/api/health", [](const httplib::Request&, httplib::Response& res) {
        json b;
        b["status"] = "ok"; b["version"] = "0.2.0";
        res.set_content(b.dump(), "application/json");
    });

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

        if (g_apiKey.empty()) {
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
        std::cout << "[API] \"" << text.substr(0, 40) << "\" -> "
                  << parsed.value("englishPrompt", "?").substr(0, 60) << "..." << std::endl;
    });

    std::cout << "=== AI Voice Drawing Backend :" << port << " ===" << std::endl;
    svr.listen("0.0.0.0", port);
    return 0;
}
