# AI 语音绘图助手 — 设计文档

## 一、项目概述

本项目旨在构建一个语音驱动的 AI 绘图系统，用户通过语音或文字描述画面，系统自动完成语音识别、语义理解、提示词优化、图片生成全流程。设计目标为降低 AI 绘图使用门槛，实现"说出画面，即刻呈现"。

---

## 二、指令能力设计

### 2.1 计划支持的指令能力

项目初期规划了以下三大类指令能力：

#### A. 语音指令类

| 编号 | 指令能力 | 说明 | 优先级 |
|------|---------|------|--------|
| A1 | 实时语音识别 | 浏览器采集音频，讯飞 API 实时转文字 | P0 |
| A2 | 静音自动结束 | 讯飞服务端检测静音 2-3 秒后自动返回最终结果 | P0 |
| A3 | 语音中间结果展示 | 识别过程中实时显示中间文字 | P1 |
| A4 | 语音自动发送 | 语音结束后自动触发 AI 处理，无需手动操作 | P0 |
| A5 | 多轮连续语音 | 支持连续多次语音输入，累积上下文 | P2 |

#### B. 绘图指令类

| 编号 | 指令能力 | 说明 | 优先级 |
|------|---------|------|--------|
| B1 | AI 图片生成 | 中文描述 → AI 提示词优化 → 生成图片 | P0 |
| B2 | 多模型切换 | FLUX.1-schnell（快速）/ Kolors（免费中文） | P1 |
| B3 | Canvas 基础绘图 | 语音指令画圆、矩形、三角形、线段、弧线 | P1 |
| B4 | 位置绘图 | "在左上角画一个红色的圆" | P1 |
| B5 | 颜色识别 | 中文颜色词 → 十六进制色值 | P1 |
| B6 | 画布操作 | "清空画布"、"清除所有" | P1 |
| B7 | 图片编辑 | 局部重绘、风格迁移、图生图 | P3 |
| B8 | 尺寸/比例控制 | "画一个大的圆"、"宽屏的风景" | P2 |

#### C. 交互指令类

| 编号 | 指令能力 | 说明 | 优先级 |
|------|---------|------|--------|
| C1 | 文字输入 | 键盘输入 + 回车/按钮发送 | P0 |
| C2 | 多会话管理 | 创建/切换/删除对话 | P1 |
| C3 | 用户认证 | 注册/登录/退出 | P1 |
| C4 | 流式响应 | AI 回复流式显示，实时反馈 | P1 |
| C5 | 历史记录 | 按会话保存和加载历史消息 | P1 |
| C6 | 图片查看 | 气泡中展示图片，hover 放大 | P1 |
| C7 | 用户中心 | 头像、昵称、生成历史统计 | P2 |
| C8 | 分享/导出 | 图片下载、分享链接 | P2 |

---

### 2.2 最终实现状态

| 编号 | 指令能力 | 状态 | 实现说明 |
|------|---------|------|---------|
| A1 | 实时语音识别 | ✅ 已完成 | AudioCapture + 讯飞 WebSocket，16kHz/16bit/单声道 PCM 采集，400ms 分片上传 |
| A2 | 静音自动结束 | ✅ 已完成 | 讯飞服务端静音检测，2-3 秒无语音自动返回 isFinal |
| A3 | 语音中间结果展示 | ✅ 已完成 | 中间结果实时显示在输入框，最终结果自动发送 |
| A4 | 语音自动发送 | ✅ 已完成 | 收到 isFinal 后自动调用 processUserInput() |
| A5 | 多轮连续语音 | ✅ 已完成 | 通过多会话管理实现，每次语音自动关联当前会话 |
| B1 | AI 图片生成 | ✅ 已完成 | DeepSeek 提示词优化 + SiliconFlow 图片生成，支持自动回退 |
| B2 | 多模型切换 | ✅ 已完成 | 前端下拉选择 FLUX.1-schnell / Kolors，后端按模型参数调用 |
| B3 | Canvas 基础绘图 | ✅ 已完成 | DrawingEngine 支持 6 种形状：圆、矩形、正方形、三角形、线段、弧线 |
| B4 | 位置绘图 | ✅ 已完成 | PositionDrawStrategy 支持 9 个位置关键词（左上角、中间等） |
| B5 | 颜色识别 | ✅ 已完成 | SimpleDrawStrategy 支持 18 种中文颜色词映射 |
| B6 | 画布操作 | ✅ 已完成 | CanvasOpStrategy 支持"清空画布"、"清除所有"等指令 |
| B7 | 图片编辑 | ❌ 未完成 | 见下方说明 |
| B8 | 尺寸/比例控制 | ❌ 未完成 | 见下方说明 |
| C1 | 文字输入 | ✅ 已完成 | 输入框 + 回车发送 + 发送按钮 |
| C2 | 多会话管理 | ✅ 已完成 | SessionService + 后端 CRUD API + sessions.json 持久化 |
| C3 | 用户认证 | ✅ 已完成 | 注册/登录/退出，SHA-256 哈希，HttpOnly Cookie Token |
| C4 | 流式响应 | ✅ 已完成 | 后端 SSE 流式推送，前端 ChatEngine 流式文字 + 光标动画 |
| C5 | 历史记录 | ✅ 已完成 | 按会话保存消息，切换会话加载历史 |
| C6 | 图片查看 | ✅ 已完成 | 聊天气泡内展示图片，hover 放大效果 |
| C7 | 用户中心 | ❌ 未完成 | 见下方说明 |
| C8 | 分享/导出 | ❌ 未完成 | 见下方说明 |

### 实现统计

| 状态 | 数量 | 占比 |
|------|------|------|
| ✅ 已完成 | 16 | 80% |
| ❌ 未完成 | 4 | 20% |

---

## 三、未完成部分原因说明

### B7 — 图片编辑（局部重绘、风格迁移、图生图）

**未完成原因**：

1. **API 限制**：当前使用的 SiliconFlow API 仅支持文生图（text-to-image），不支持图生图（image-to-image）和局部重绘（inpainting）接口
2. **交互复杂度**：图片编辑需要用户在图片上标记编辑区域（如涂抹遮罩），当前微信风格聊天界面不适合承载此类交互，需要专门的图片编辑器组件
3. **优先级调整**：核心语音生图流程优先级更高，图片编辑属于增强功能，计划后续版本实现

**后续计划**：
- 接入支持图生图的 API（如 Stable Diffusion img2img）
- 设计图片编辑交互组件（画笔涂抹 + 指令描述）
- 支持风格迁移（上传参考图 + 目标风格描述）

### B8 — 尺寸/比例控制

**未完成原因**：

1. **自然语言解析难度**："大的"、"宽屏的"等模糊描述需要 LLM 理解并映射为具体像素尺寸，当前 CommandParser 基于正则匹配，无法处理此类语义
2. **模型参数限制**：FLUX.1-schnell 和 Kolors 模型对输出尺寸有固定要求，自定义尺寸需要额外处理
3. **优先级较低**：默认尺寸已满足大多数场景，自定义尺寸属于锦上添花

**后续计划**：
- 在 DeepSeek 提示词优化阶段同时解析尺寸意图
- 预设常用比例模板（1:1、16:9、9:16、4:3）
- 前端增加尺寸选择器

### C7 — 用户中心

**未完成原因**：

1. **功能优先级**：登录认证已实现基础用户隔离，用户中心属于体验优化而非核心功能
2. **存储限制**：当前 JSON 文件存储方案不适合存储头像等二进制数据，需要先接入对象存储（七牛云）
3. **时间约束**：实训营周期内优先保证核心功能完整性

**后续计划**：
- 接入七牛云存储头像
- 用户信息编辑页面
- 生成历史统计（总生成数、最常用模型等）

### C8 — 分享/导出

**未完成原因**：

1. **存储架构**：当前图片存储在服务器本地，无法生成公网可访问的分享链接，需要先接入七牛云对象存储
2. **下载功能**：前端可通过 Canvas API 实现图片下载，但未作为优先项实现
3. **时间约束**：核心交互流程优先

**后续计划**：
- 接入七牛云，图片上传后返回公网 URL
- 前端添加"下载"和"分享"按钮
- 生成分享卡片（图片 + 提示词 + 二维码）

---

## 四、系统架构设计

### 4.1 整体架构

```
┌──────────────────────────────────────────────────────────┐
│                      浏览器（前端）                        │
│                                                          │
│  ┌────────────┐  ┌────────────┐  ┌───────────────────┐  │
│  │AudioCapture│  │ChatEngine  │  │  SessionService   │  │
│  │语音采集     │  │聊天渲染     │  │  会话管理          │  │
│  └─────┬──────┘  └─────┬──────┘  └────────┬──────────┘  │
│        │               │                   │             │
│  ┌─────▼──────┐  ┌─────▼──────┐  ┌────────▼──────────┐  │
│  │CommandParser│  │LLMService  │  │  AuthService      │  │
│  │指令解析     │  │AI服务封装   │  │  认证服务          │  │
│  └────────────┘  └────────────┘  └───────────────────┘  │
│        │               │                   │             │
│  ┌─────▼──────┐        │                   │             │
│  │DrawingEngine│       │                   │             │
│  │Canvas绘图   │       │                   │             │
│  └────────────┘        │                   │             │
└────────────────────────┼───────────────────┼─────────────┘
                         │ HTTP               │ Cookie
┌────────────────────────▼───────────────────▼─────────────┐
│                  C++ 后端（cpp-httplib）                    │
│                                                          │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────┐  │
│  │ /api/     │ │ /api/    │ │ /api/    │ │ /api/      │  │
│  │ speech    │ │ generate │ │ sessions │ │ auth       │  │
│  │ 语音识别   │ │ 图片生成  │ │ 会话管理  │ │ 用户认证    │  │
│  └─────┬────┘ └─────┬────┘ └─────┬────┘ └──────┬─────┘  │
│        │            │            │              │         │
│  ┌─────▼────┐ ┌─────▼────┐ ┌────▼────┐ ┌──────▼─────┐  │
│  │讯飞WS    │ │DeepSeek  │ │sessions │ │users.json  │  │
│  │转发      │ │+生图API  │ │.json    │ │+内存Token  │  │
│  └──────────┘ └──────────┘ └─────────┘ └────────────┘  │
└──────────────────────────────────────────────────────────┘
```

### 4.2 核心数据流

#### 语音生图流程

```
用户点击麦克风
    │
    ▼
AudioCapture.start()
    │ getUserMedia → AudioContext → AudioWorklet
    │ 每 400ms 发送 PCM 分片
    ▼
POST /api/speech (binary PCM)
    │
    ▼
后端转发至讯飞 WebSocket
    │ 返回 { text, isFinal, confidence }
    ▼
前端 onCaptureText()
    │ isFinal=true → processUserInput(text)
    ▼
POST /api/generate { text, model }
    │
    ├─→ DeepSeek 优化提示词（中文→英文Prompt）
    │
    ├─→ SiliconFlow 生成图片（FLUX/Kolors）
    │
    └─→ 下载图片到 generated/ 目录
    │
    ▼
返回 { imageUrl, localPath, prompt, provider }
    │
    ▼
ChatEngine 显示图片气泡
    │
    ▼
SessionService 保存消息到会话
```

### 4.3 指令解析策略

采用策略模式，按优先级依次尝试解析：

```
输入文本
    │
    ▼
CanvasOpStrategy（画布操作）
    │ 匹配 "清空画布"、"清除所有" 等
    │ → { action: "clear_canvas" }
    │
    ▼ 不匹配
PositionDrawStrategy（位置绘图）
    │ 匹配 "在左上角画一个红色的圆"
    │ → { action: "draw_shape", params: { shape, position, fillColor } }
    │
    ▼ 不匹配
SimpleDrawStrategy（简单绘图）
    │ 匹配 "画一个红色的圆"
    │ → { action: "draw_shape", params: { shape, fillColor } }
    │
    ▼ 不匹配
返回 null → 走 AI 图片生成流程
```

### 4.4 认证与数据隔离

```
注册：username + password → SHA-256(password) → users.json
登录：验证密码 → generateToken() → g_authSessions[token] = { username, expires }
      → Set-Cookie: token=xxx; HttpOnly; Max-Age=86400
鉴权：Cookie 或 Authorization Header → 查 g_authSessions → 获取 username
隔离：所有数据查询加 WHERE username = currentUser
```

---

## 五、API 接口设计

### 5.1 认证接口

| 方法 | 路径 | 说明 | 请求体 | 响应 |
|------|------|------|--------|------|
| POST | `/api/register` | 注册 | `{ username, password }` | `{ username, nickname }` |
| POST | `/api/login` | 登录 | `{ username, password }` | `{ username, nickname }` + Set-Cookie |
| POST | `/api/logout` | 退出 | - | `{ success: true }` |
| GET | `/api/me` | 当前用户 | - | `{ username, nickname }` |

### 5.2 语音接口

| 方法 | 路径 | 说明 | 请求体 | 响应 |
|------|------|------|--------|------|
| POST | `/api/speech` | 上传 PCM 分片 | binary PCM | `{ text, isFinal, confidence }` |
| POST | `/api/speech?end=1` | 结束识别 | - | `{ text, isFinal: true }` |

### 5.3 图片生成接口

| 方法 | 路径 | 说明 | 请求体 | 响应 |
|------|------|------|--------|------|
| POST | `/api/generate` | 生成图片 | `{ text, model }` | `{ imageUrl, localPath, prompt, provider }` |

### 5.4 提示词优化接口

| 方法 | 路径 | 说明 | 请求体 | 响应 |
|------|------|------|--------|------|
| POST | `/api/parse` | 星火优化 | `{ text }` | `{ englishPrompt, negativePrompt }` |
| POST | `/api/parse-stream` | 星火流式优化 | `{ text }` | SSE: `{ type, text/prompt }` |

### 5.5 会话接口

| 方法 | 路径 | 说明 | 请求体 | 响应 |
|------|------|------|--------|------|
| GET | `/api/sessions` | 会话列表 | - | `[{ id, title, preview, ... }]` |
| POST | `/api/sessions` | 创建会话 | `{ title }` | `{ id, title, createdAt }` |
| GET | `/api/sessions/:id` | 会话详情 | - | `{ id, title, messages: [...] }` |
| POST | `/api/sessions/:id/messages` | 添加消息 | `{ role, type, text, imageUrl }` | `{ success, timestamp }` |
| DELETE | `/api/sessions/:id` | 删除会话 | - | `{ success: true }` |

---

## 六、数据模型设计

### 6.1 用户模型（users.json）

```json
{
  "username": "string, 唯一标识",
  "passwordHash": "string, SHA-256 哈希",
  "nickname": "string, 显示名称",
  "createdAt": "string, 创建时间 YYYY-MM-DD HH:MM:SS"
}
```

### 6.2 会话模型（sessions.json）

```json
{
  "id": "string, 16位随机Token",
  "username": "string, 所属用户",
  "title": "string, 会话标题（首条消息前20字符）",
  "preview": "string, 最近消息预览（前30字符）",
  "createdAt": "string, 创建时间",
  "updatedAt": "string, 更新时间",
  "messages": [
    {
      "role": "user | assistant",
      "type": "text | image",
      "text": "string, 消息文本",
      "imageUrl": "string, 图片云端URL",
      "localPath": "string, 图片本地路径",
      "timestamp": "string, 消息时间"
    }
  ]
}
```

### 6.3 认证会话（内存）

```json
{
  "token": "string, 随机Token",
  "username": "string, 用户名",
  "expires": "time_point, 24小时后过期"
}
```

---

## 七、关键技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 后端语言 | C++17 | 高性能，低延迟，适合音频转发 |
| HTTP 框架 | cpp-httplib | Header-only，轻量，支持 HTTPS/SSE |
| 前端框架 | Vanilla JS | 无构建依赖，部署简单 |
| 语音识别 | 讯飞 WebSocket | 实时流式识别，中文识别准确率高 |
| 提示词优化 | DeepSeek Chat | 中文理解能力强，价格低 |
| 图片生成 | SiliconFlow | 支持 FLUX/Kolors 多模型，API 兼容 OpenAI 格式 |
| 数据存储 | JSON 文件 | 简单可靠，小规模够用，后续可迁移 SQLite |
| 密码安全 | SHA-256 | OpenSSL 内置，无需额外依赖 |

---

## 八、已知限制与风险

| 限制 | 影响 | 缓解措施 |
|------|------|---------|
| JSON 文件存储 | 并发写入可能丢数据 | 互斥锁保护，后续迁移 SQLite |
| Session 内存存储 | 重启后需重新登录 | 可接受，后续持久化到文件 |
| 讯飞 22 端口 | 部分网络环境无法连接 | 后端代理转发，前端不直连 |
| Kolors 免费并发 1 | 多用户同时使用排队 | 提示用户切换 FLUX 模型 |
| UTF-8 截断 | 中文截断导致 JSON 崩溃 | 已实现 utf8Substr 安全截断 |
| 图片本地存储 | 无法公网分享 | 后续接入七牛云对象存储 |
