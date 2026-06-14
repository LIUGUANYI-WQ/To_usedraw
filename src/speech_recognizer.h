/**
 * speech_recognizer.h — 讯飞实时语音转写模块
 * PR 5.2: WebSocket 客户端 + HMAC-SHA256 鉴权
 *
 * 依赖: ixwebsocket + OpenSSL
 * 配置: 通过 .env 读取 XFYUN_APP_ID / XFYUN_API_KEY / XFYUN_API_SECRET
 */
#pragma once

#include <atomic>
#include <chrono>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

// ---- 前向声明 (避免头文件暴露 ixwebsocket) ----
namespace ix { class WebSocket; }

// ---- 配置结构 ----
struct XfyunConfig {
    std::string appId;
    std::string apiKey;
    std::string apiSecret;
    std::string host = "iat-api.xfyun.cn";
    std::string uri  = "/v2/iat";

    bool isValid() const {
        return !appId.empty() && !apiKey.empty() && !apiSecret.empty();
    }
};

// ---- 转写结果回调 ----
using OnTextCallback = std::function<void(const std::string& text,
                                           bool isFinal,
                                           double confidence)>;

/**
 * SpeechRecognizer — 讯飞实时语音转写 WebSocket 客户端
 *
 * 用法:
 *   XfyunConfig cfg{"appid","apikey","apisecret"};
 *   SpeechRecognizer sr(cfg);
 *   sr.setOnText([](auto& t, bool f, double c) { ... });
 *   sr.connect();
 *   sr.sendAudio(pcmData);
 *   sr.sendAudio(moreData);
 *   sr.sendEnd();
 *   // ... 等回调收到 text ...
 *   sr.disconnect();
 */
class SpeechRecognizer {
public:
    explicit SpeechRecognizer(const XfyunConfig& cfg);
    ~SpeechRecognizer();

    // 禁止拷贝
    SpeechRecognizer(const SpeechRecognizer&) = delete;
    SpeechRecognizer& operator=(const SpeechRecognizer&) = delete;

    /** 设置转写结果回调（逐句触发） */
    void setOnText(OnTextCallback cb) { m_onText = std::move(cb); }

    /** 连接讯飞 WebSocket + 发送握手参数 */
    bool connect();

    /** 发送音频数据 (16kHz/16bit/单声道 PCM) */
    bool sendAudio(const std::vector<uint8_t>& pcm);

    /** 发送结束帧，等待最终结果 */
    void sendEnd();

    /** 断开连接 */
    void disconnect();

    /** 是否已连接 */
    bool isConnected() const { return m_connected; }

    /** 获取累计识别文字 */
    std::string getText() const { return m_text; }

private:
    // ---- 鉴权 ----
    static std::string rfc1123Time();
    static std::string hmacSha256Base64(const std::string& key, const std::string& msg);
    static std::string base64Encode(const std::string& in);
    static std::string urlEncode(const std::string& s);
    std::string buildAuthUrl();

    // ---- ixwebsocket 回调 ----
    void onWsMessage(const std::string& msg);
    void onWsOpen();
    void onWsClose();
    void onWsError(const std::string& err);

    // ---- 发送初始参数帧 ----
    void sendParams();

    // ---- 配置 ----
    XfyunConfig m_cfg;
    OnTextCallback m_onText;

    // ---- WebSocket ----
    std::unique_ptr<ix::WebSocket> m_ws;

    // ---- 状态 ----
    std::atomic<bool> m_connected{false};
    std::atomic<bool> m_ended{false};
    std::string m_text;
    mutable std::mutex m_textMutex;
};
