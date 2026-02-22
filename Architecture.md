# 技术架构文档 (Architecture Design Document)
**项目名称**: Live2DPet (AI 桌面宠物)
**更新日期**: 2026-02-21

## 1. 系统整体架构设计 (System Overview)

本项目采用 **Electron** 框架构建，核心架构分为两层：
1. **Node.js 运行层 (Main Process - 主进程)**：负责系统级操作，如：全局快捷键拦截、屏幕截图 (Screen Capture)、本地文件系统读写、窗口管理 (Window Management) 以及调用本地的 VOICEVOX 服务。
2. **Chromium 渲染层 (Renderer Process - 渲染进程)**：负责 UI 显示与图形渲染。利用 HTML/CSS 构建设置界面，利用 PixiJS 和 Live2D SDK 渲染透明的桌宠模型。

两者之间通过 **Electron IPC (Inter-Process Communication，进程间通信)** 进行数据交换。

## 2. 项目目录结构规划 (Directory Structure)

为了让 AI 和后续开发维护更加清晰，规定以下项目基础目录结构。
*(注：所有的英文目录和文件都已标注详细中文解释，开发时严格按照此结构创建文件)*

```text
Live2DPet/
├── package.json             # Node.js 项目配置文件 (记录依赖包)
├── main.js                  # Electron 程序的总入口文件
├── src/                     # 源代码主目录
│   ├── main/                # 【主进程目录】：存放系统级底层代码
│   │   ├── window-manager.js   # 窗口管理器 (负责创建桌宠窗口、设置窗口)
│   │   ├── config-manager.js   # 配置管理器 (负责读写本地的 API Key、频率设置等)
│   │   ├── screen-capture.js   # 截屏模块 (调用系统底层截屏并返回图片数据)
│   │   └── ipc-handler.js      # 进程通信处理器 (处理渲染进程发来的请求)
│   │
│   ├── renderer/            # 【渲染进程目录】：存放前端 UI 和画面渲染代码
│   │   ├── pet/             # 桌宠窗口前端代码
│   │   │   ├── index.html         # 桌宠窗口的 HTML 骨架
│   │   │   ├── pet-app.js         # 桌宠逻辑主入口 (控制图片/Live2D切换)
│   │   │   ├── live2d-adapter.js  # Live2D 模型加载与适配器
│   │   │   └── chat-bubble.js     # 聊天气泡 UI 控制
│   │   │
│   │   └── settings/        # 设置窗口前端代码
│   │       ├── index.html         # 设置面板的 HTML 骨架
│   │       └── settings-ui.js     # 设置面板的交互逻辑 (保存 Token、频率等)
│   │
│   ├── core/                # 【核心业务逻辑目录】：存放具体的 AI 和 TTS 功能
│   │   ├── ai-client.js        # OpenAI 格式的 API 请求封装 (处理视觉大模型交互)
│   │   ├── tts-service.js      # VOICEVOX 语音合成服务调用模块
│   │   └── pet-state.js        # 桌宠状态机 (管理：待机、思考中、说话中)
│   │
├── assets/                  # 静态资源目录
│   ├── icons/               # 存放应用的图标文件
│   └── default_models/      # 存放默认的图片桌宠或 Live2D 示例模型
```

## 3. 核心进程划分与职责 (Core Processes)

### 3.1 主进程 (Main Process - Node.js)
主进程是应用的“大脑”，它在后台静默运行，拥有最高的系统权限。
- **职责 1：生命周期管理**。控制软件的启动、退出、最小化到系统托盘 (Tray)。
- **职责 2：窗口调度**。创建透明的桌宠窗口 (Pet Window) 和常规的设置窗口 (Settings Window)。
- **职责 3：硬件级操作**。由于前端网页无法直接截取 Windows 桌面，截屏动作必须由主进程完成（使用 Electron 的 `desktopCapturer` 或 Node 扩展），截取后通过 IPC 发送给渲染进程。

### 3.2 渲染进程 (Renderer Process - 前端页面)
渲染进程是应用的“脸面”，每个独立的窗口都是一个单独的渲染进程。
- **Pet Window (桌宠窗口)**：
  - 必须设置为 `transparent: true` (背景透明) 和 `frame: false` (无边框)。
  - 内部运行 PixiJS 引擎实时绘制模型。
  - 接收到鼠标拖拽事件时，计算相对坐标并动态更新窗口位置。
- **Settings Window (设置窗口)**：
  - 标准的网页应用界面。
  - 提供表单供用户输入 API Key、选择模型路径、配置 Token 长度 (1024/2048/3072/4096/自定义) 和视觉分析频率 (1分钟/5分钟/10分钟/手动)。
## 4. 核心模块设计 (Core Module Design)

### 4.1 截屏与频率控制模块 (Screen Capture & Frequency Control)
- **触发机制**：由主进程的 `setInterval` 定时器控制，或者通过全局快捷键 (Global Shortcut) 手动触发。
- **配置读取**：每次触发前，读取 `config-manager` 中的频率设置（手动、1、5、10或自定义分钟数）。如果设为手动，则停止定时器。
- **图像处理**：使用 Electron 提供的 `desktopCapturer` 获取屏幕内容，将其转换为 Base64 编码的 JPEG/PNG 字符串，以便发送给大模型 API。
- **内存管理**：截屏数据极易导致内存泄漏。必须确保在发送给 API 后，立即将图像变量置为 `null`，并手动调用垃圾回收（如果开启了 Node 的 `--expose-gc` 参数）。

### 4.2 AI 视觉对话模块 (AI Vision & Chat Module)
- **API 兼容层**：封装一个通用的 HTTP 请求客户端（使用 `fetch` 或 `axios`），使其兼容所有标准的 OpenAI Chat Completions 接口格式。
- **请求体构造 (Request Payload)**：
  - `model`: 读取用户配置的模型名称（例如 `gpt-4o` 或 `grok-vision`）。
  - `max_tokens`: 读取用户配置的最大回复长度（1024 / 2048 / 3072 / 4096 / 自定义）。
  - `messages`: 包含 System Prompt（系统设定角色词）以及包含 Base64 图像的 User Message。
- **异常处理**：必须包含超时处理 (Timeout) 和网络错误捕获 (Catch)。如果 API 报错（如余额不足、网络不通），在桌宠的气泡中显示中文错误提示，而不是直接让程序崩溃。

### 4.3 语音合成模块 (VOICEVOX TTS Module)
- **服务对接**：VOICEVOX 在本地默认运行在 `http://127.0.0.1:50021`。
- **两步合成法**：
  1. 第一步：发送文字到 `/audio_query` 接口，生成音高、语速等参数。
  2. 第二步：将第一步生成的参数发送到 `/synthesis` 接口，获取 `.wav` 音频流数据。
- **音频降级策略 (Audio Fallback)**：
  - 在应用启动时尝试 `ping` VOICEVOX 端口。
  - 如果未连接成功，全局标记 `isTTSAvailable = false`。
  - 在 AI 返回文本后，如果 `isTTSAvailable` 为假，则跳过语音合成步骤，直接触发 UI 气泡显示文字，确保不影响核心视觉陪伴功能。

## 5. 核心数据流转图 (Data Flow)

以下展示了“从截取屏幕到桌宠说话”的一个完整生命周期 (Lifecycle)：

1. **[主进程 Main]** 定时器触发 / 用户点击快捷键。
2. **[主进程 Main]** 调用 `desktopCapturer` 抓取当前屏幕截图 (Base64)。
3. **[主进程 Main]** 通过 IPC 通信，将截图数据发送给 **[渲染进程 Renderer (Core)]**。
4. **[渲染进程 Renderer]** 组合 System Prompt + 截图数据，通过 HTTP POST 发送给云端 Vision 大模型。
5. **[云端 API]** 分析图片并返回 JSON 格式的回复文本。
6. **[渲染进程 Renderer]** 解析出回复文本，判断是否启用 TTS (语音合成)：
   - **[如果不启用]** -> 直接跳转到步骤 8。
   - **[如果启用]** -> 发送文本至本地的 VOICEVOX 引擎 (`127.0.0.1:50021`)。
7. **[本地 VOICEVOX]** 返回生成好的 WAV 音频文件缓冲区 (Buffer)。
8. **[渲染进程 Renderer (UI)]** 同步执行 UI 动作：
   - 气泡 UI 浮现并打字机式显示回复文本。
   - 触发 Live2D/图片 的“说话”动作或表情。
   - 播放 WAV 音频。
9. **[渲染进程 Renderer]** 音频播放完毕 / 气泡驻留时间结束，桌宠恢复“待机 (Idle)”状态，清理内存。