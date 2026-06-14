/**
 * spark_client.cpp — 讯飞星火 Lite 云端 API 客户端实现
 *
 * 编译: 作为 server 的一部分编译，链接 libcurl + OpenSSL
 * 运行: 通过 .env 读取 SPARK_API_PASSWORD
 *
 * 星火 OpenAPI 协议:
 *   POST https://spark-api-open.xf-yun.com/v1/chat/completions
 *   Header: Authorization: Bearer <apiPassword>
 *   Body: { model, messages, ... }
 *   响应: { choices: [{ message: { content } }] }
 */

#include "spark_client.h"
#include "nlohmann/json.hpp"

#include <curl/curl.h>
#include <iostream>
#include <cstring>

using json = nlohmann::json;

// ====================================================================
// 内置系统提示词：将口语化中文改写为标准、细节丰富的 AI 绘图提示词
// ====================================================================
const char* SparkClient::SYSTEM_PROMPT =
    "你是一个AI绘图指令转换助手。用户通过语音描述想要绘制的画面，"
    "语音转写文本可能包含同音字、错别字等识别错误。\n\n"
    "## 你的任务\n"
    "1. 纠正语音识别错误（同音字、错别字）\n"
    "2. 理解用户想表达的场景、风格、氛围\n"
    "3. 将纠正后的中文描述转换为优化的英文Stable Diffusion提示词\n"
    "4. 补充合理的画面细节（光影、构图、色彩等）\n\n"
    "## 提示词规则\n"
    "- 格式：主体, 场景, 细节, 风格, 光影, 画质\n"
    "- 必须追加：masterpiece, best quality\n"
    "- 默认风格：digital illustration, vibrant colors\n"
    "- 用户描述模糊时，合理推断补充细节\n"
    "- 禁止添加NSFW内容\n"
    "- 提示词用英文逗号分隔，不超过80个词\n"
    "- englishPrompt必须包含至少6个描述维度：主体、场景、细节、风格、光影、画质\n\n"
    "## 示例\n"
    "用户输入：画一棵樱花树\n"
    "输出：\n"
    "{\"correctedText\":\"画一棵樱花树\",\"englishPrompt\":\"cherry blossom tree in full bloom, pink petals falling gently, spring garden with soft green grass, digital illustration, warm sunlight filtering through branches, pastel pink and green color palette, masterpiece, best quality\",\"style\":\"digital illustration\",\"analysis\":\"樱花树春季场景\"}\n\n"
    "## 输出格式：严格JSON，不要markdown代码块，不要多余解释\n"
    "{\n"
    "  \"correctedText\": \"纠正后的中文\",\n"
    "  \"englishPrompt\": \"优化的英文SD提示词\",\n"
    "  \"style\": \"推断的风格\",\n"
    "  \"analysis\": \"一句话总结\"\n"
    "}";

// ====================================================================
// 构造
// ====================================================================
SparkClient::SparkClient(const std::string& apiPassword)
    : m_apiPassword(apiPassword)
{
}

// ====================================================================
// libcurl 写回调
// ====================================================================
size_t SparkClient::writeCallback(void* ptr, size_t size, size_t nmemb, void* userdata) {
    auto* response = static_cast<std::string*>(userdata);
    response->append(static_cast<char*>(ptr), size * nmemb);
    return size * nmemb;
}

// ====================================================================
// 调用星火 Lite，优化口语文本为绘图提示词
// ====================================================================
bool SparkClient::optimizePrompt(const std::string& rawText, std::string& outPrompt) {
    if (m_apiPassword.empty()) {
        std::cerr << "[SPARK] ERROR: API password not configured" << std::endl;
        return false;
    }

    if (rawText.empty()) {
        std::cerr << "[SPARK] ERROR: empty input text" << std::endl;
        return false;
    }

    // ---- 构造请求 JSON ----
    json body;
    body["model"] = "lite";
    body["messages"] = json::array({
        {{"role", "system"}, {"content", SYSTEM_PROMPT}},
        {{"role", "user"},   {"content", rawText}}
    });
    body["temperature"] = 0.3;

    std::string bodyStr = body.dump();

    // ---- 发送 HTTPS POST ----
    std::string responseStr;
    CURL* curl = curl_easy_init();
    if (!curl) {
        std::cerr << "[SPARK] ERROR: curl_easy_init failed" << std::endl;
        return false;
    }

    // 请求头
    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "Content-Type: application/json");
    std::string authHeader = "Authorization: Bearer " + m_apiPassword;
    headers = curl_slist_append(headers, authHeader.c_str());

    // 设置 curl 选项
    curl_easy_setopt(curl, CURLOPT_URL, "https://spark-api-open.xf-yun.com/v1/chat/completions");
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, bodyStr.c_str());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, static_cast<long>(bodyStr.size()));
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, writeCallback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &responseStr);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 30L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 1L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 2L);

    CURLcode res = curl_easy_perform(curl);

    // 获取 HTTP 状态码
    long httpCode = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &httpCode);

    // 清理
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);

    // ---- 检查网络错误 ----
    if (res != CURLE_OK) {
        std::cerr << "[SPARK] ERROR: curl request failed: " << curl_easy_strerror(res) << std::endl;
        return false;
    }

    if (httpCode != 200) {
        std::cerr << "[SPARK] ERROR: HTTP " << httpCode
                  << ", body: " << responseStr.substr(0, 300) << std::endl;
        return false;
    }

    // ---- 解析响应 JSON ----
    json apiResp;
    try {
        apiResp = json::parse(responseStr);
    } catch (...) {
        std::cerr << "[SPARK] ERROR: invalid JSON response" << std::endl;
        return false;
    }

    // 检查 API 错误码
    if (apiResp.contains("code") && !apiResp["code"].is_null()) {
        int code = apiResp["code"].get<int>();
        if (code != 0) {
            std::cerr << "[SPARK] ERROR: API code=" << code
                      << " msg=" << apiResp.value("message", "") << std::endl;
            return false;
        }
    }

    // 提取 content
    std::string content;
    try {
        content = apiResp["choices"][0]["message"]["content"].get<std::string>();
    } catch (...) {
        std::cerr << "[SPARK] ERROR: cannot extract content from response" << std::endl;
        return false;
    }

    // ---- 清理 markdown 包裹 ----
    {
        auto p = content.find("```json");
        if (p != std::string::npos) content = content.substr(p + 7);
        else {
            p = content.find("```");
            if (p != std::string::npos) content = content.substr(p + 3);
        }
        p = content.rfind("```");
        if (p != std::string::npos) content = content.substr(0, p);
        auto a = content.find_first_not_of(" \t\n\r");
        auto b = content.find_last_not_of(" \t\n\r");
        if (a != std::string::npos) content = content.substr(a, b - a + 1);
    }

    // ---- 解析内部 JSON ----
    json parsed;
    try {
        parsed = json::parse(content);
    } catch (...) {
        // LLM 输出不是合法 JSON，直接作为 prompt 使用
        std::cerr << "[SPARK] WARN: LLM output not valid JSON, using raw content" << std::endl;
        outPrompt = content;
        return true;
    }

    outPrompt = parsed.value("englishPrompt", content);

    std::cout << "[SPARK] \"" << rawText.substr(0, 40) << "\" -> "
              << outPrompt.substr(0, 60) << "..." << std::endl;
    return true;
}
