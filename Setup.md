# 基础环境与依赖安装文档 (Environment Setup Guide)
**项目名称**: Live2DPet (AI 桌面宠物)
**更新日期**: 2026-02-21
**目标操作系统**: Windows 11 (64位)

## 1. 安装核心运行环境 (Node.js)

Node.js 是运行本项目的主力环境，它让我们可以使用 JavaScript 来控制电脑系统（如创建窗口、读取文件）。

**步骤：**
1. 前往 Node.js 官方网站下载 LTS（长期支持版）安装包：`https://nodejs.org/`
2. 像安装普通软件一样，一直点击“下一步”完成安装。
3. 打开 Windows 的“命令提示符”(CMD) 或 PowerShell，输入以下命令检查是否安装成功：

```bash
# 检查 Node.js 版本，正常会输出类似 v18.17.0 的数字
node -v

# 检查 npm (Node Package Manager，Node 的包管理器) 版本
# npm 相当于手机上的“应用商店”，用来下载别人写好的代码包
npm -v
```

## 2. 初始化项目与安装依赖包 (Dependencies)

在你的电脑上创建一个空文件夹（例如命名为 `Live2DPet`），然后在该文件夹内打开终端，依次执行以下命令：

### 2.1 初始化项目
```bash
# 初始化一个 Node 项目。
# -y 的意思是 "yes"，自动全选默认配置，这会生成一个 package.json 文件，记录项目信息。
npm init -y
```

### 2.2 安装主框架 (Electron)
```bash
# 安装 Electron 框架。
# --save-dev 的意思是将其保存为“开发依赖”，因为只有我们在写代码和打包时才需要它。
# 这一步可能会比较慢，请耐心等待。
npm install electron --save-dev
```

### 2.3 安装核心功能库
```bash
# 安装项目中需要用到的功能性代码包（不用加 --save-dev，因为程序运行时也需要它们）
# axios: 用于向大模型 API 发送网络请求。
# pixi.js: 一个非常快的前端 2D 渲染引擎，用来画图。
# @pixi/live2d-display: 让 PixiJS 能够读取并显示 Live2D 模型的专用插件。
npm install axios pixi.js @pixi/live2d-display
```

## 3. 安装语音合成引擎 (VOICEVOX)

VOICEVOX 不是一个代码包，而是一个独立的桌面软件，它在后台提供免费的日语语音合成接口。

**步骤：**
1. 前往 VOICEVOX 官网下载安装包：`https://voicevox.hiroshiba.jp/`
2. 安装并启动该软件。它启动后，会在你的电脑后台开启一个服务端口 `50021`。
3. 验证是否成功：在浏览器地址栏输入 `http://127.0.0.1:50021/docs`，如果能看到一个 API 接口说明页面，说明本地语音引擎已准备就绪。

## 4. 配置运行命令 (Scripts)

打开项目文件夹下的 `package.json` 文件，找到 `"scripts"` 这一块，将其修改为如下内容，以便我们快速启动项目：

```json
"scripts": {
  "start": "electron .",
  "test": "echo \"Error: no test specified\" && exit 1"
}
```
*解释：`"start": "electron ."` 的意思是，当我们在终端输入 `npm start` 时，就使用 electron 运行当前目录（`.`代表当前目录）下的 `main.js` 文件。*

## 5. 开发第一步测试

创建基础的 `main.js` 和 `index.html` 后，在终端输入以下命令启动你的桌宠应用：

```bash
# 启动程序
npm start
```