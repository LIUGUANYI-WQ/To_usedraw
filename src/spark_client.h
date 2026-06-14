/**
 * spark_client.h — 讯飞星火 Lite 云端 API 客户端
 * 将口语文本优化为 AI 绘图提示词
 *
 * 依赖: libcurl + OpenSSL
 * API:  https://spark-api-open.xf-yun.com/v1/chat/completions
 * 模型: generalv3.5-lite
 *
 * 用法:
 *   SparkClient client(apiPassword);
 *   std::string prompt, negPrompt;
 *   if (client.optimizePrompt("画一棵樱花树", prompt, negPrompt)) {
 *       // prompt = "cherry blossom tree, pink petals falling, ..."
 *   }
 *   // 流式版本：
 *   client.optimizePromptStreaming("画一棵樱花树", onChunk, prompt, negPrompt);
 */
#pragma once

#include <string>
#include <functional>

class SparkClient {
public:
    /**
     * @param apiPassword  星火 API 鉴权密码（从 .env 读取，禁止硬编码）
     */
    explicit SparkClient(const std::string& apiPassword);

    /**
     * 调用星火 Lite，将口语文本优化为绘图提示词（非流式）
     */
    bool optimizePrompt(const std::string& rawText,
                        std::string& outPrompt,
                        std::string& outNegativePrompt);

    /**
     * 调用星火 Lite 流式接口，将口语文本优化为绘图提示词
     *
     * @param rawText           讯飞语音转写得到的原始文本
     * @param onChunk           每收到一个 SSE chunk 的回调，参数为增量文本
     * @param outPrompt         [out] 优化后的英文提示词
     * @param outNegativePrompt [out] 负面提示词
     * @return true=成功, false=失败
     */
    using ChunkCallback = std::function<void(const std::string&)>;
    bool optimizePromptStreaming(const std::string& rawText,
                                 ChunkCallback onChunk,
                                 std::string& outPrompt,
                                 std::string& outNegativePrompt);

private:
    /** libcurl 写回调（非流式） */
    static size_t writeCallback(void* ptr, size_t size, size_t nmemb, void* userdata);

    /** libcurl 写回调（流式 SSE） */
    static size_t streamCallback(void* ptr, size_t size, size_t nmemb, void* userdata);

    /** 清理 LLM 输出中的 markdown 包裹 */
    static std::string stripMarkdown(const std::string& content);

    /** 解析内部 JSON，提取 prompt 和 negativePrompt */
    bool parseContent(const std::string& content,
                      std::string& outPrompt,
                      std::string& outNegativePrompt);

    /** 鉴权密码 */
    std::string m_apiPassword;

    /** 内置系统提示词（固定，将口语中文改写为英文绘图提示词） */
    static const char* SYSTEM_PROMPT;
};
