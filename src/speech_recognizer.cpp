/**
 * speech_recognizer.cpp — 讯飞实时语音转写 WebSocket 客户端实现
 *
 * 编译: 作为 server 的一部分编译，链接 ixwebsocket + OpenSSL
 * 运行: 通过 .env 读取凭证
 *
 * 讯飞 RTASR WebSocket 协议:
 *   wss://iat-api.xfyun.cn/v2/iat?authorization=...&date=...&host=...
 *   第一帧: JSON 参数
 *   中间帧: 音频数据 (status=1)
 *   最后一帧: status=2 (结束)
 *   服务端返回: 每句 JSON (含 w seg)
 */

#include "speech_recognizer.h"
#include "nlohmann/json.hpp"

using json = nlohmann::json;

// ---- ixwebsocket (本地源码 ixwebsocket_src/) ----
#include <IXWebSocket.h>
#include <IXNetSystem.h>

// ---- OpenSSL ----
#include <openssl/hmac.h>
#include <openssl/evp.h>

// ---- 标准库 ----
#include <iostream>
#include <sstream>
#include <iomanip>
#include <ctime>
#include <cstring>

using json = nlohmann::json;

// ====================================================================
// RFC 1123 时间 (GMT)
// ====================================================================
std::string SpeechRecognizer::rfc1123Time() {
    auto now = std::chrono::system_clock::now();
    auto t    = std::chrono::system_clock::to_time_t(now);
    struct tm gm;
#ifdef _WIN32
    gmtime_s(&gm, &t);
#else
    gmtime_r(&t, &gm);
#endif
    char buf[64];
    const char* days[]  = {"Sun","Mon","Tue","Wed","Thu","Fri","Sat"};
    const char* months[]= {"Jan","Feb","Mar","Apr","May","Jun",
                           "Jul","Aug","Sep","Oct","Nov","Dec"};
    snprintf(buf, sizeof(buf), "%s, %02d %s %04d %02d:%02d:%02d GMT",
             days[gm.tm_wday], gm.tm_mday, months[gm.tm_mon],
             gm.tm_year + 1900, gm.tm_hour, gm.tm_min, gm.tm_sec);
    return buf;
}

// ====================================================================
// HMAC-SHA256 → Base64
// ====================================================================
std::string SpeechRecognizer::hmacSha256Base64(const std::string& key,
                                                const std::string& msg) {
    unsigned char result[EVP_MAX_MD_SIZE];
    unsigned int len = 0;

    HMAC(EVP_sha256(),
         key.data(), static_cast<int>(key.size()),
         reinterpret_cast<const unsigned char*>(msg.data()), msg.size(),
         result, &len);

    return base64Encode(std::string(reinterpret_cast<char*>(result), len));
}

// ====================================================================
// Base64 编码 (OpenSSL)
// ====================================================================
std::string SpeechRecognizer::base64Encode(const std::string& in) {
    // OpenSSL BIO base64
    BIO* b64 = BIO_new(BIO_f_base64());
    BIO* mem = BIO_new(BIO_s_mem());
    BIO_set_flags(b64, BIO_FLAGS_BASE64_NO_NL);
    BIO_push(b64, mem);
    BIO_write(b64, in.data(), static_cast<int>(in.size()));
    BIO_flush(b64);

    char* data = nullptr;
    long  size = BIO_get_mem_data(mem, &data);
    std::string out(data, size);
    BIO_free_all(b64);
    return out;
}

// ====================================================================
// URL 编码
// ====================================================================
std::string SpeechRecognizer::urlEncode(const std::string& s) {
    std::ostringstream os;
    os << std::hex << std::uppercase;
    for (unsigned char c : s) {
        if (isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
            os << c;
        } else {
            os << '%' << std::setw(2) << std::setfill('0') << (int)c;
        }
    }
    return os.str();
}

// ====================================================================
// 构建 WebSocket 鉴权 URL
// ====================================================================
std::string SpeechRecognizer::buildAuthUrl() {
    std::string date = rfc1123Time();
    std::string sigOrigin =
        "host: " + m_cfg.host + "\n"
        "date: " + date + "\n"
        "GET " + m_cfg.uri + " HTTP/1.1";

    std::string signature = hmacSha256Base64(m_cfg.apiSecret, sigOrigin);

    // 讯飞要求的 authorization_origin 格式
    std::string authOrigin =
        "api_key=\"" + m_cfg.apiKey + "\", "
        "algorithm=\"hmac-sha256\", "
        "headers=\"host date request-line\", "
        "signature=\"" + signature + "\"";

    std::string authorization = base64Encode(authOrigin);

    return "wss://" + m_cfg.host + m_cfg.uri +
           "?authorization=" + urlEncode(authorization) +
           "&date=" + urlEncode(date) +
           "&host=" + urlEncode(m_cfg.host);
}

// ====================================================================
// 构造 & 析构
// ====================================================================
SpeechRecognizer::SpeechRecognizer(const XfyunConfig& cfg)
    : m_cfg(cfg)
{
    ix::initNetSystem();
}

SpeechRecognizer::~SpeechRecognizer() {
    disconnect();
}

// ====================================================================
// 连接 + 发送参数帧
// ====================================================================
bool SpeechRecognizer::connect() {
    if (m_connected) return true;

    std::string url = buildAuthUrl();
    std::cout << "[XFYUN] connecting to iat-api.xfyun.cn ..." << std::endl;

    m_ws = std::make_unique<ix::WebSocket>();
    m_ws->setUrl(url);

    // 设置回调
    m_ws->setOnMessageCallback([this](const ix::WebSocketMessagePtr& msg) {
        switch (msg->type) {
            case ix::WebSocketMessageType::Message:
                onWsMessage(msg->str);
                break;
            case ix::WebSocketMessageType::Open:
                onWsOpen();
                break;
            case ix::WebSocketMessageType::Close:
                onWsClose();
                break;
            case ix::WebSocketMessageType::Error:
                onWsError(msg->errorInfo.reason);
                break;
            default: break;
        }
    });

    // 心跳 15s
    m_ws->setPingInterval(15);
    m_ws->start();

    // 等待连接建立 (最多 5 秒)
    int wait = 0;
    while (!m_connected && wait < 50) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        wait++;
    }
    return m_connected;
}

// ====================================================================
// WebSocket 事件
// ====================================================================
void SpeechRecognizer::onWsOpen() {
    m_connected = true;
    std::cout << "[XFYUN] WS connected, sending params..." << std::endl;
    sendParams();
}

void SpeechRecognizer::onWsClose() {
    m_connected = false;
    std::cout << "[XFYUN] WS closed" << std::endl;
}

void SpeechRecognizer::onWsError(const std::string& err) {
    m_connected = false;
    std::cerr << "[XFYUN] WS error: " << err << std::endl;
}

// ====================================================================
// 发送初始参数帧
// ====================================================================
void SpeechRecognizer::sendParams() {
    json params;
    params["common"]["app_id"] = m_cfg.appId;
    params["business"]["language"] = "zh_cn";
    params["business"]["domain"]   = "iat";
    params["business"]["accent"]   = "mandarin";
    params["business"]["vad_eos"]  = 3000;  // 3s 静音结束
    params["data"]["status"]   = 0;
    params["data"]["format"]   = "audio/L16;rate=16000";
    params["data"]["encoding"] = "raw";
    params["data"]["audio"]    = "";

    m_ws->send(params.dump());
}

// ====================================================================
// 发送音频数据
// ====================================================================
bool SpeechRecognizer::sendAudio(const std::vector<uint8_t>& pcm) {
    if (!m_connected || m_ended) return false;
    if (pcm.empty()) return true;

    // 音频帧: status=1, audio=base64(pcm)
    json frame;
    frame["data"]["status"] = 1;
    frame["data"]["format"]   = "audio/L16;rate=16000";
    frame["data"]["encoding"] = "raw";
    frame["data"]["audio"]    = base64Encode(std::string(
        reinterpret_cast<const char*>(pcm.data()), pcm.size()));

    auto info = m_ws->send(frame.dump());
    return info.success;
}

// ====================================================================
// 发送结束帧
// ====================================================================
void SpeechRecognizer::sendEnd() {
    if (!m_connected || m_ended) return;

    m_ended = true;
    json frame;
    frame["data"]["status"]   = 2;
    frame["data"]["format"]   = "audio/L16;rate=16000";
    frame["data"]["encoding"] = "raw";
    frame["data"]["audio"]    = "";
    m_ws->send(frame.dump());

    // 等待最终结果 (最多 5s)
    int wait = 0;
    while (m_connected && wait < 50) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        wait++;
    }
}

// ====================================================================
// 断开
// ====================================================================
void SpeechRecognizer::disconnect() {
    if (m_ws) {
        m_ws->stop();
        m_ws.reset();
    }
    m_connected = false;
    m_ended = false;
}

// ====================================================================
// 解析 WebSocket 返回的 JSON
// ====================================================================
void SpeechRecognizer::onWsMessage(const std::string& msg) {
    json j;
    try { j = json::parse(msg); } catch (...) { return; }

    int code = j.value("code", 0);
    if (code != 0) {
        std::cerr << "[XFYUN] error code=" << code
                  << " msg=" << j.value("message", "") << std::endl;
        return;
    }

    // 提取识别文本
    auto data = j["data"];
    if (data.is_null() || data["result"].is_null()) return;

    std::string text;
    for (auto& ws : data["result"]["ws"]) {
        for (auto& cw : ws["cw"]) {
            text += cw["w"].get<std::string>();
        }
    }
    if (text.empty()) return;

    {
        std::lock_guard<std::mutex> lk(m_textMutex);
        m_text += text;
    }

    // 判断是否最后一句 (ls=true)
    bool isFinal = false;
    if (data["status"].is_number() && data["status"].get<int>() == 2)
        isFinal = true;

    double confidence = 0.0;
    if (data.contains("confidence"))
        confidence = data["confidence"].get<double>();

    std::cout << "[XFYUN] " << (isFinal ? "[FINAL] " : "[INTERIM] ")
              << text << std::endl;

    if (m_onText) m_onText(text, isFinal, confidence);
}
