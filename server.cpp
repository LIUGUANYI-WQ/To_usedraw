/**
 * server.cpp — 语音绘图工具 C++ 后端
 * PR 3.1: HTTP 服务骨架 + 静态文件 + /api/health
 *
 * 依赖（header-only）:
 *   - cpp-httplib:  https://github.com/yhirose/cpp-httplib
 *   - nlohmann/json: https://github.com/nlohmann/json
 *
 * 编译 & 运行:
 *   cmake -B build -G "Visual Studio 17 2022"
 *   cmake --build build --config Debug
 *   build\Debug\server.exe
 *
 * API Key 配置:
 *   复制 .env.example 为 .env，填入 Key 即可，无需手动设环境变量
 */

#include <cstdlib>
#include <fstream>
#include <iostream>
#include <string>
#include <filesystem>

// header-only 库
#include "httplib.h"
#include "nlohmann/json.hpp"

using json = nlohmann::json;

namespace fs = std::filesystem;

// ============================================================
// 从 .env 文件加载环境变量
// ============================================================
static void loadEnvFile(const std::string& path) {
    std::ifstream file(path);
    if (!file.is_open()) return;

    std::string line;
    while (std::getline(file, line)) {
        // 跳过空行和注释
        if (line.empty() || line[0] == '#') continue;

        // 去掉首尾空格
        auto start = line.find_first_not_of(" \t\r");
        auto end   = line.find_last_not_of(" \t\r");
        if (start == std::string::npos) continue;
        line = line.substr(start, end - start + 1);

        // 分离 KEY=VALUE
        auto eq = line.find('=');
        if (eq == std::string::npos) continue;

        std::string key   = line.substr(0, eq);
        std::string value = line.substr(eq + 1);

        // 去掉 value 两端的引号
        if (value.size() >= 2 &&
            ((value.front() == '"'  && value.back() == '"') ||
             (value.front() == '\'' && value.back() == '\'')))
        {
            value = value.substr(1, value.size() - 2);
        }

        // 只在环境变量未设置时才覆盖（方便命令行临时覆盖）
#ifdef _WIN32
        _putenv_s(key.c_str(), value.c_str());
#else
        setenv(key.c_str(), value.c_str(), 0);
#endif
    }
}

// ============================================================
// 获取 API Key
// ============================================================
static std::string getApiKey() {
    const char* key = std::getenv("DEEPSEEK_API_KEY");
    if (!key) {
        std::cerr << "[WARN] DEEPSEEK_API_KEY 未设置" << std::endl;
        std::cerr << "       请复制 .env.example 为 .env 并填入 Key" << std::endl;
        return "";
    }
    return std::string(key);
}

// ================================================================
// main
// ================================================================
int main() {
    // 自动加载 .env 文件（从可执行文件所在目录或当前工作目录）
    if (fs::exists(".env")) {
        loadEnvFile(".env");
        std::cout << "[INFO] 已加载 .env 配置" << std::endl;
    }

    httplib::Server svr;

    const int port = 8080;

    // --------------------------------------------------
    // 1. 静态文件服务（前端页面）
    // --------------------------------------------------
    svr.set_mount_point("/", ".");

    // --------------------------------------------------
    // 2. 健康检查
    // --------------------------------------------------
    svr.Get("/api/health", [](const httplib::Request&, httplib::Response& res) {
        json body;
        body["status"] = "ok";
        body["service"] = "voice-drawing-backend";
        body["version"] = "0.1.0";
        res.set_content(body.dump(2), "application/json");
    });

    // --------------------------------------------------
    // 3. LLM 代理（占位，PR 3.2 实现）
    // --------------------------------------------------
    svr.Post("/api/parse", [](const httplib::Request& req, httplib::Response& res) {
        (void)req;
        json body;
        body["error"] = "not implemented yet";
        body["message"] = "/api/parse will be implemented in PR 3.2";
        res.status = 501;
        res.set_content(body.dump(2), "application/json");
    });

    // --------------------------------------------------
    // 启动
    // --------------------------------------------------
    std::cout << "========================================" << std::endl;
    std::cout << "   " << std::endl;
    std::cout << "  port: " << port << std::endl;
    std::cout << "  addr: http://localhost:" << port << std::endl;
    std::cout << "========================================" << std::endl;

    svr.listen("0.0.0.0", port);

    return 0;
}
