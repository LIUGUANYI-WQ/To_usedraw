# AI 语音绘图助手（Voice Drawing）

## 一、项目概述

**AI 语音绘图助手**是一款基于语音交互的 AI 绘图工具，用户只需说出想要的画面描述，系统即可自动完成语音识别、语义理解、提示词优化、图片生成全流程，真正实现"说出画面，即刻呈现"。

### 项目背景

传统 AI 绘图工具需要用户手动输入提示词（Prompt），对非英语用户存在语言门槛，且提示词编写需要一定经验。本项目通过语音输入 + AI 提示词优化，降低 AI 绘图的使用门槛，让任何人都能通过自然语言轻松创作。

### 核心业务功能

- **语音输入**：点击麦克风说出画面描述，讯飞语音识别实时转文字，静音自动结束并发送
- **文字输入**：支持键盘输入，回车或点击发送
- **AI 提示词优化**：DeepSeek 大模型自动将中文描述优化为高质量英文 Prompt
- **AI 图片生成**：支持 FLUX.1-schnell（快速）和 Kolors（免费/中文）两种模型切换
- **微信风格聊天界面**：左右气泡、流式文字、图片展示、加载动画
- **多会话管理**：创建/切换/删除对话，历史消息持久化
- **用户认证**：注册/登录，数据按用户隔离

### 使用场景

| 场景 | 说明 |
|------|------|
| 语音快速创作 | 说话即可生图，无需打字 |
| 中文描述生图 | 不懂英文 Prompt 也能生成高质量图片 |
| 多轮对话优化 | 通过对话逐步调整画面细节 |
| 创意灵感探索 | 快速尝试不同描述，即时看到效果 |

---

## 二、🎬 项目演示视频

> **演示视频链接**：[点击观看项目演示视频](https://example.com/demo-video)
>
> - 视频时长：约 3 分钟
> - 内容说明：注册登录 → 语音输入生图 → 文字输入生图 → 模型切换 → 多会话管理

---

## 三、技术架构与技术栈

### 整体架构

```
┌─────────────────────────────────────────────────────┐
│                    浏览器（前端）                      │
│  index.html / login.html + JS + CSS                  │
│  AudioCapture → ChatEngine → LLM Service             │
└──────────────────────┬──────────────────────────────┘
                       │ HTTP / WebSocket
┌──────────────────────▼──────────────────────────────┐
│               C++ 后端（cpp-httplib）                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────────┐ │
│  │ 用户认证  │ │ 会话管理  │ │ 语音/绘图 API        │ │
│  │ SHA-256  │ │ JSON存储  │ │ 讯飞/DeepSeek/生图   │ │
│  └──────────┘ └──────────┘ └──────────────────────┘ │
└────┬──────────────┬──────────────┬──────────────────┘
     │              │              │
     ▼              ▼              ▼
┌─────────┐  ┌──────────┐  ┌────────────────┐
│ 讯飞语音 │  │ DeepSeek │  │ SiliconFlow    │
│ 识别 API │  │ 提示词优化│  │ FLUX/Kolors生图│
└─────────┘  └──────────┘  └────────────────┘
```

### 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 前端 | HTML5 + CSS3 + Vanilla JS | 无框架依赖，轻量高效 |
| 前端音频 | Web Audio API + AudioWorklet | 浏览器原生 PCM 采集 |
| 后端 | C++17 + cpp-httplib | 高性能 HTTP 服务 |
| 语音识别 | 讯飞 WebSocket API | 实时流式语音转文字 |
| 提示词优化 | DeepSeek Chat API | 中文描述 → 英文 Prompt |
| 图片生成 | SiliconFlow API | FLUX.1-schnell / Kolors |
| 数据存储 | JSON 文件 | 用户数据 + 会话数据持久化 |
| 密码安全 | OpenSSL SHA-256 | 密码哈希存储 |
| 构建工具 | CMake 3.14+ | 跨平台编译 |

### 云存储服务接入说明

本项目生成的图片通过以下流程处理：

1. 用户语音/文字输入 → AI 生成提示词 → 调用 SiliconFlow API 生成图片
2. SiliconFlow 返回图片 URL（云端临时链接）
3. 后端下载图片到本地 `generated/` 目录，同时保留原始云端 URL
4. 前端通过本地路径 `/generated/img_xxx.png` 展示图片

> **注**：当前版本图片存储在服务器本地。如需接入七牛云存储，只需在后端图片下载后增加七牛云上传逻辑，将 `localPath` 替换为七牛云外链即可。七牛云接入配置项预留于 `.env` 文件中。

---

## 四、功能列表

### 用户认证
- [x] 用户注册（用户名 ≥ 2 字符，密码 ≥ 4 字符）
- [x] 用户登录（SHA-256 密码验证，HttpOnly Cookie Token）
- [x] 退出登录（清除 Cookie 和服务端 Session）
- [x] 登录状态检查（未登录自动跳转登录页）
- [x] Token 24 小时过期机制

### 语音输入
- [x] 浏览器麦克风权限请求
- [x] 实时 PCM 音频采集（16kHz/16bit/单声道）
- [x] 音频分片上传（400ms 间隔）
- [x] 讯飞实时语音识别（中间结果 + 最终结果）
- [x] 静音自动检测结束（讯飞服务端 2-3 秒静音判定）
- [x] 语音结束后自动发送

### 文字输入
- [x] 键盘输入 + 回车发送
- [x] 发送按钮点击发送

### AI 绘图
- [x] DeepSeek 提示词优化（中文 → 英文 Prompt）
- [x] FLUX.1-schnell 模型（4 步推理，2-5 秒出图）
- [x] Kolors 模型（20 步推理，免费，原生中文支持）
- [x] 前端模型切换下拉选择
- [x] 图片下载到本地并展示

### 聊天界面
- [x] 微信风格左右气泡布局
- [x] 用户消息蓝色右对齐，AI 回复灰色左对齐
- [x] 图片气泡展示（hover 放大）
- [x] 流式文字显示 + 光标动画
- [x] 加载中三点动画
- [x] 消息入场动画
- [x] 侧边栏折叠/展开

### 多会话管理
- [x] 创建新对话
- [x] 切换历史对话（加载消息记录）
- [x] 删除对话（带确认弹窗）
- [x] 会话标题自动提取（首条用户消息前 20 字符）
- [x] 会话预览（最近消息摘要）
- [x] 会话数据按用户隔离

---

## 五、部署 & 运行指南

### 环境准备

| 依赖 | 版本要求 | 说明 |
|------|---------|------|
| CMake | ≥ 3.14 | 构建工具 |
| C++ 编译器 | 支持 C++17 | GCC 8+ / MSVC 2019+ / Clang 7+ |
| OpenSSL | ≥ 1.1 | HTTPS + SHA-256 |
| libcurl | ≥ 7.0 | 星火 API HTTPS 请求 |
| WSL（Windows） | Ubuntu 20.04+ | Windows 下推荐使用 WSL 编译 |

#### Ubuntu/WSL 依赖安装

```bash
sudo apt update
sudo apt install -y cmake g++ libssl-dev libcurl4-openssl-dev
```

#### macOS 依赖安装

```bash
brew install cmake openssl curl
```

### 依赖安装

项目使用 CMake 构建，第三方库（cpp-httplib、nlohmann/json、ixwebsocket）已包含在源码中，无需额外安装。

### 配置文件说明

复制示例配置文件并填入 API Key：

```bash
cp .env.example .env
```

编辑 `.env` 文件，填入以下配置：

```ini
# DeepSeek API Key（提示词优化）
# 注册：https://platform.deepseek.com
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# 阿里云 DashScope API Key（备用图片生成）
# 注册：https://dashscope.console.aliyun.com
DASHSCOPE_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# 讯飞语音识别
# 注册：https://www.xfyun.cn
XFYUN_APP_ID=xxxxxxxx
XFYUN_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
XFYUN_API_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# 星火 Lite API
SPARK_API_PASSWORD=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# SiliconFlow（FLUX.1-schnell / Kolors 图片生成）
# 注册：https://cloud.siliconflow.cn（注册送 14 元额度）
SILICONFLOW_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

> **重点标注**：`SILICONFLOW_API_KEY` 为图片生成必需配置，Kolors 模型免费使用；`XFYUN_API_KEY` / `XFYUN_API_SECRET` 为语音识别必需配置。

### 编译

```bash
# 克隆项目
git clone https://github.com/your-username/AI_tousedraw.git
cd AI_tousedraw

# 创建构建目录并编译
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j$(nproc)
```

### 启动命令

```bash
./build/server
```

启动成功后终端输出：

```
=== AI Voice Drawing Backend :8080 ===
```

### 访问地址

| 地址 | 说明 |
|------|------|
| http://localhost:8080 | 主页面（未登录自动跳转登录页） |
| http://localhost:8080/login.html | 登录/注册页面 |

### 测试方法

1. **注册登录**：打开浏览器访问 `http://localhost:8080`，注册账号并登录
2. **语音生图**：点击麦克风按钮，说出"一只猫在月光下"，等待图片生成
3. **文字生图**：在输入框输入描述文字，回车发送
4. **模型切换**：在控制栏下拉框切换 FLUX.1-schnell / Kolors
5. **会话管理**：点击侧边栏 `+` 新建对话，点击历史会话切换

#### API 手动测试

```bash
# 注册
curl -X POST http://localhost:8080/api/register \
  -H "Content-Type: application/json" \
  -d '{"username":"test","password":"1234"}'

# 登录
curl -X POST http://localhost:8080/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"test","password":"1234"}' -c cookies.txt

# 创建会话
curl -X POST http://localhost:8080/api/sessions \
  -H "Content-Type: application/json" \
  -d '{"title":"测试对话"}' -b cookies.txt

# 生成图片
curl -X POST http://localhost:8080/api/generate \
  -H "Content-Type: application/json" \
  -d '{"text":"一只猫在月光下","model":"kolors"}' -b cookies.txt
```

---

## 六、项目目录结构

```
AI_tousedraw/
├── CMakeLists.txt              # CMake 构建配置
├── .env.example                # 环境变量示例（需复制为 .env）
├── .gitignore                  # Git 忽略规则
├── index.html                  # 主页面（聊天界面）
├── login.html                  # 登录/注册页面
│
├── css/
│   └── styles.css              # 全局样式（微信风格主题）
│
├── js/
│   ├── audio-capture.js        # 音频采集模块（Web Audio API）
│   ├── auth-service.js         # 用户认证服务
│   ├── chat-engine.js          # 聊天引擎（气泡渲染/流式文字）
│   ├── command-parser.js       # 指令解析器
│   ├── drawing-engine.js       # 绘图引擎
│   ├── llm-service.js          # LLM API 封装（DeepSeek/生图）
│   ├── main.js                 # 主入口（事件绑定/流程控制）
│   ├── pcm-processor.js        # AudioWorklet PCM 处理器
│   └── session-service.js      # 会话管理服务
│
├── include/
│   ├── httplib.h               # cpp-httplib（HTTP 库）
│   └── nlohmann/
│       └── json.hpp            # nlohmann/json（JSON 库）
│
├── src/
│   ├── server.cpp              # 后端主文件（API 路由/业务逻辑）
│   ├── speech_recognizer.cpp   # 讯飞语音识别客户端
│   ├── speech_recognizer.h
│   ├── spark_client.cpp        # 星火 Lite API 客户端
│   └── spark_client.h
│
└── ixwebsocket_src/            # ixwebsocket 库源码（WebSocket）
```

---

## 七、核心功能实现思路

### 1. 语音识别流程

```
用户点击麦克风
    ↓
浏览器 getUserMedia 获取麦克风权限
    ↓
AudioContext + AudioWorklet 采集 Float32 音频
    ↓
重采样到 16kHz，转 Int16 PCM
    ↓
每 400ms 发送 PCM 分片到后端 /api/speech
    ↓
后端通过 WebSocket 转发至讯飞语音识别 API
    ↓
讯飞返回中间结果（isFinal=false）和最终结果（isFinal=true）
    ↓
后端通过 HTTP 响应返回识别文本
    ↓
前端收到 isFinal=true 后自动发送给 AI 处理
```

### 2. AI 提示词优化 + 图片生成

```
用户输入（中文描述）
    ↓
后端调用 DeepSeek Chat API
    ↓
System Prompt 指导模型输出结构化 JSON：
  { "prompt": "英文提示词", "negative": "负面提示词", ... }
    ↓
提取 prompt 调用 SiliconFlow 图片生成 API
    ↓
优先使用 FLUX.1-schnell（快速），失败回退 DashScope wanx-v1
    ↓
获取图片 URL → 下载到本地 generated/ 目录
    ↓
返回 { imageUrl, localPath, prompt, provider } 给前端
```

### 3. 图片存储与展示

```
SiliconFlow 返回图片云端 URL
    ↓
后端 HTTPS 下载图片二进制数据
    ↓
保存到 generated/img_N.png
    ↓
前端通过 /generated/img_N.png 本地路径展示
    ↓
同时保留原始 imageUrl 用于外部访问
```

### 4. 用户认证流程

```
注册：用户名 + 密码 → SHA-256 哈希 → 存入 users.json
登录：验证密码 → 生成随机 Token → 存入内存 g_authSessions
      → 设置 HttpOnly Cookie（24h 过期）
鉴权：每次请求从 Cookie 或 Authorization Header 提取 Token
      → 查询 g_authSessions 验证有效性 + 过期时间
```

### 5. 多会话管理

```
用户发送消息 → ensureSession() 确保有活跃会话
    ↓
消息保存到 sessions.json（按用户名隔离）
    ↓
侧边栏渲染会话列表（标题 + 预览 + 时间）
    ↓
切换会话 → 从后端加载完整消息列表 → 渲染到聊天区
    ↓
删除会话 → 从 sessions.json 移除 → 刷新列表
```

---

## 八、测试效果

### 功能测试结果

| 测试项 | 操作 | 预期结果 | 实际结果 |
|--------|------|---------|---------|
| 用户注册 | 输入用户名密码注册 | 注册成功跳转登录 | 通过 |
| 用户登录 | 输入正确密码登录 | 登录成功进入主页 | 通过 |
| 语音输入 | 点击麦克风说话 | 识别文字自动发送 | 通过 |
| 文字输入 | 输入框输入回车 | 消息发送并生图 | 通过 |
| FLUX 模型 | 选择 FLUX.1-schnell | 2-5 秒生成图片 | 通过 |
| Kolors 模型 | 选择 Kolors | 约 10 秒生成图片 | 通过 |
| 新建对话 | 点击 + 按钮 | 创建新会话 | 通过 |
| 切换对话 | 点击侧边栏会话 | 加载历史消息 | 通过 |
| 删除对话 | 点击 × 确认删除 | 会话被删除 | 通过 |
| 未登录访问 | 未登录访问主页 | 跳转登录页 | 通过 |

### 测试方式

- 浏览器 Chrome 120+ 手动测试全部功能
- curl 命令行测试全部 API 接口
- 代码可正常运行，功能可复现

---

## 九、团队分工与总结

### 团队分工

#### 牛小林 — 后端架构 & AI 模型对接

| 模块 | 具体工作 |
|------|---------|
| 后端架构 | C++ 服务端整体架构设计，cpp-httplib 路由规划，CMake 构建配置 |
| 语音识别 | 讯飞 WebSocket 实时语音识别对接，PCM 音频转发，中间/最终结果解析 |
| AI 提示词优化 | DeepSeek Chat API 对接，System Prompt 设计，结构化 JSON 输出解析 |
| 图片生成 | SiliconFlow FLUX.1-schnell / Kolors 模型对接，模型切换逻辑，图片下载存储 |
| 用户认证 | 注册/登录 API，SHA-256 密码哈希，Token 生成与验证，HttpOnly Cookie |
| 会话管理 | 会话 CRUD API，sessions.json 持久化，UTF-8 安全截断修复 |
| 星火备用 | 星火 Lite API 客户端开发，ixwebsocket 集成 |

#### 马雪峰 — 前端开发 & 测试

| 模块 | 具体工作 |
|------|---------|
| 聊天界面 | 微信风格 UI 设计，左右气泡布局，流式文字光标动画，加载动画 |
| 语音采集 | AudioCapture 模块开发，Web Audio API + AudioWorklet PCM 采集，分片上传 |
| 聊天引擎 | ChatEngine 气泡渲染，图片展示，流式消息，加载→结果替换 |
| 会话前端 | SessionService API 封装，侧边栏会话列表渲染，切换/删除/新建交互 |
| 认证前端 | AuthService 登录/注册/鉴权，login.html 页面，登录状态检查跳转 |
| 模型切换 | 前端模型选择器，参数传递，模型信息展示 |
| 整体测试 | 全功能手动测试，API 接口测试，Bug 反馈与验证 |



### 总结

本项目实现了一个完整的语音驱动 AI 绘图系统，核心亮点：

1. **零门槛创作**：语音输入 + AI 提示词优化，无需编写英文 Prompt
2. **实时交互**：讯飞流式语音识别，说完即发，体验流畅
3. **模型灵活**：支持 FLUX.1-schnell（快速付费）和 Kolors（免费中文）切换
4. **微信风格 UI**：聊天式交互，多会话管理，符合用户习惯
5. **安全认证**：SHA-256 密码哈希 + HttpOnly Cookie Token

### 展望

- [ ] 接入七牛云存储，图片持久化到云端
- [ ] 接入更多图片生成模型（SDXL、MidJourney 等）
- [ ] 支持图片编辑（局部重绘、风格迁移）
- [ ] 移动端适配（PWA / 小程序）
- [ ] 用户中心（头像、昵称、生成历史统计）
- [ ] SQLite 替换 JSON 存储，提升并发性能
