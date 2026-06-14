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
#include <sstream>

using json = nlohmann::json;

// ====================================================================
// 内置系统提示词：将口语化中文改写为标准、细节丰富的 AI 绘图提示词
// ====================================================================
const char* SparkClient::SYSTEM_PROMPT =
    "你是一个专业的AI绘图提示词工程师。用户通过语音描述想要绘制的画面，"
    "语音转写文本可能包含同音字、错别字等识别错误，且用户描述往往模糊、笼统。\n\n"
    "## 核心能力：将模糊想法精确化\n"
    "用户说「画个好看的风景」时，你需要推断出具体的风景类型、季节、时间、氛围；"
    "用户说「画个动物」时，你需要选择最具视觉表现力的动物并构建完整场景。\n"
    "始终站在画师角度思考：什么样的画面最打动人？哪些细节让画面生动？\n\n"
    "## 你的任务\n"
    "1. 纠正语音识别错误（同音字、错别字、口语化表达）\n"
    "2. 将模糊描述精确化：推断用户真正想表达的具体场景\n"
    "3. 补充画面细节：光影方向、色彩氛围、构图视角、环境元素\n"
    "4. 将精确化的中文描述转换为英文Stable Diffusion提示词\n\n"
    "## 提示词构造规则\n"
    "- 结构：主体描述, 场景环境, 细节装饰, 艺术风格, 光影氛围, 色彩基调, 画质标签\n"
    "- 主体：必须具体（不是tree而是ancient cherry blossom tree in full bloom）\n"
    "- 场景：补充环境（不是sky而是pastel blue sky with soft white clouds）\n"
    "- 细节：添加让画面生动的元素（花瓣飘落、光线穿透、水波粼粼等）\n"
    "- 风格：根据内容推断最合适的风格（oil painting / watercolor / digital art / anime等）\n"
    "- 光影：明确光源和氛围（golden hour sunlight / soft moonlight / dramatic rim lighting等）\n"
    "- 色彩：指定色调（warm amber tones / cool blue palette / vibrant rainbow等）\n"
    "- 必须追加：masterpiece, best quality, highly detailed\n"
    "- 禁止添加NSFW内容\n"
    "- 提示词用英文逗号分隔，60-80个词\n\n"
    "## 模糊→精确 推断示例\n"
    "- 「好看的风景」→ 日落时分的湖畔，远山剪影，金色余晖\n"
    "- 「画个猫」→ 一只橘猫趴在窗台上晒太阳，阳光洒在毛发上\n"
    "- 「科幻的感觉」→ 未来城市天际线，霓虹灯光，飞行器穿梭\n"
    "- 「温馨的画面」→ 壁炉旁的旧沙发，猫咪蜷缩，暖黄灯光\n\n"
    "## 输出示例\n"
    "用户：画一棵樱花树\n"
    "{\"correctedText\":\"画一棵樱花树\",\"englishPrompt\":\"ancient cherry blossom tree in full bloom, branches heavy with pink flowers, petals drifting in gentle breeze, serene Japanese garden with stone path, digital painting, warm spring sunlight filtering through canopy, soft pink and green color palette, masterpiece, best quality, highly detailed\",\"negativePrompt\":\"blurry, low quality, deformed, ugly, text, watermark\",\"style\":\"digital painting\",\"analysis\":\"樱花盛开的日式庭院\"}\n\n"
    "## 输出格式：严格JSON，不要markdown代码块，不要多余解释\n"
    "{\n"
    "  \"correctedText\": \"纠正并精确化后的中文\",\n"
    "  \"englishPrompt\": \"优化的英文SD提示词\",\n"
    "  \"negativePrompt\": \"英文负面提示词，避免画面中出现的元素\",\n"
    "  \"style\": \"推断的风格\",\n"
    "  \"analysis\": \"一句话总结画面\"\n"
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
bool SparkClient::optimizePrompt(const std::string& rawText,
                                 std::string& outPrompt,
                                 std::string& outNegativePrompt) {
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
    return parseContent(content, outPrompt, outNegativePrompt);
}

// ====================================================================
// 流式 SSE 回调上下文
// ====================================================================
struct StreamCtx {
    std::string accumulated;       // 累积的完整 content
    std::function<void(const std::string&)> onChunk;  // 每次 delta 回调
    bool hasError = false;
    std::string errorMsg;
};

// ====================================================================
// libcurl 流式写回调
// ====================================================================
size_t SparkClient::streamCallback(void* ptr, size_t size, size_t nmemb, void* userdata) {
    auto* ctx = static_cast<StreamCtx*>(userdata);
    std::string chunk(static_cast<char*>(ptr), size * nmemb);

    // 解析 SSE 行：data: {...}\n\n
    std::istringstream ss(chunk);
    std::string line;
    while (std::getline(ss, line)) {
        // 去掉 \r
        if (!line.empty() && line.back() == '\r') line.pop_back();

        if (line.find("data:") != 0) continue;
        std::string data = line.substr(5);
        // 去前导空格
        auto p = data.find_first_not_of(' ');
        if (p != std::string::npos) data = data.substr(p);

        if (data == "[DONE]") continue;

        json j;
        try { j = json::parse(data); } catch (...) { continue; }

        // 检查错误
        if (j.contains("code") && !j["code"].is_null()) {
            int code = j["code"].get<int>();
            if (code != 0) {
                ctx->hasError = true;
                ctx->errorMsg = j.value("message", "unknown error");
                return size * nmemb;
            }
        }

        // 提取 delta content
        try {
            std::string delta = j["choices"][0]["delta"]["content"].get<std::string>();
            ctx->accumulated += delta;
            if (ctx->onChunk) ctx->onChunk(delta);
        } catch (...) {
            // 有些 chunk 没有 delta.content，忽略
        }
    }
    return size * nmemb;
}

// ====================================================================
// 流式调用星火 Lite
// ====================================================================
bool SparkClient::optimizePromptStreaming(const std::string& rawText,
                                          ChunkCallback onChunk,
                                          std::string& outPrompt,
                                          std::string& outNegativePrompt) {
    if (m_apiPassword.empty()) {
        std::cerr << "[SPARK] ERROR: API password not configured" << std::endl;
        return false;
    }
    if (rawText.empty()) {
        std::cerr << "[SPARK] ERROR: empty input text" << std::endl;
        return false;
    }

    json body;
    body["model"] = "lite";
    body["messages"] = json::array({
        {{"role", "system"}, {"content", SYSTEM_PROMPT}},
        {{"role", "user"},   {"content", rawText}}
    });
    body["temperature"] = 0.3;
    body["stream"] = true;

    std::string bodyStr = body.dump();

    StreamCtx ctx;
    ctx.onChunk = onChunk;

    CURL* curl = curl_easy_init();
    if (!curl) {
        std::cerr << "[SPARK] ERROR: curl_easy_init failed" << std::endl;
        return false;
    }

    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "Content-Type: application/json");
    std::string authHeader = "Authorization: Bearer " + m_apiPassword;
    headers = curl_slist_append(headers, authHeader.c_str());

    curl_easy_setopt(curl, CURLOPT_URL, "https://spark-api-open.xf-yun.com/v1/chat/completions");
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, bodyStr.c_str());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, static_cast<long>(bodyStr.size()));
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, streamCallback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &ctx);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 30L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 1L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 2L);

    CURLcode res = curl_easy_perform(curl);

    long httpCode = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &httpCode);

    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);

    if (res != CURLE_OK) {
        std::cerr << "[SPARK] ERROR: curl request failed: " << curl_easy_strerror(res) << std::endl;
        return false;
    }
    if (httpCode != 200) {
        std::cerr << "[SPARK] ERROR: HTTP " << httpCode << std::endl;
        return false;
    }
    if (ctx.hasError) {
        std::cerr << "[SPARK] ERROR: " << ctx.errorMsg << std::endl;
        return false;
    }

    // 清理 markdown 并解析
    std::string content = stripMarkdown(ctx.accumulated);
    bool ok = parseContent(content, outPrompt, outNegativePrompt);

    std::cout << "[SPARK-STREAM] \"" << rawText.substr(0, 40) << "\" -> "
              << outPrompt.substr(0, 60) << "..." << std::endl;
    return ok;
}

// ====================================================================
// 工具：清理 markdown 包裹
// ====================================================================
std::string SparkClient::stripMarkdown(const std::string& raw) {
    std::string content = raw;
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
    return content;
}

// ====================================================================
// 工具：解析内部 JSON
// ====================================================================
bool SparkClient::parseContent(const std::string& content,
                                std::string& outPrompt,
                                std::string& outNegativePrompt) {
    json parsed;
    try {
        parsed = json::parse(content);
    } catch (...) {
        std::cerr << "[SPARK] WARN: LLM output not valid JSON, using raw content" << std::endl;
        outPrompt = content;
        outNegativePrompt = "blurry, low quality, deformed, ugly, text, watermark";
        return true;
    }

    outPrompt = parsed.value("englishPrompt", content);
    outNegativePrompt = parsed.value("negativePrompt", "blurry, low quality, deformed, ugly, text, watermark");
    return true;
}
