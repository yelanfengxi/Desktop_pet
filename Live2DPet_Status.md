# Live2DPet 项目状态与修改总结文档

**当前开发阶段**: 阶段二 (集成 Live2D 模型并实现渲染与交互)
**文档更新时间**: 2026-02-22

## 1. 项目概述
本项目是一个基于 Electron 的桌面宠物应用。
- **视觉表现**：透明、无边框、始终置顶的 Electron 窗口。
- **核心功能**：支持 Cubism 3/4 格式的 Live2D 模型渲染、鼠标视线跟随（跨窗口）、拖拽移动窗口，以及智能的鼠标穿透（点击透明区域穿透，停留在宠物本身时拦截点击）。

## 2. 核心技术栈与版本要求
为了保障底层兼容性，本项目在渲染层严格锁定了以下特殊版本搭配：
- **Electron + Node.js**: 开启 `nodeIntegration: true` 和 `contextIsolation: false`。
- **PixiJS**: 锁定 `v7.x` 版本（项目当前建议并使用的是 v7 同步语法 `new PIXI.Application()`）。
- **Live2D 插件**: `pixi-live2d-display`（由于其官方只对 PixiJS v7 提供最为稳定的全兼容，且依赖旧版的交互规范）。
- **Live2D SDK 核心**: 通过 HTML 引入了官方的 `live2dcubismcore.min.js` 和 `live2d.min.js`。

---

## 3. 阶段二期间进行的核心修改与 Bug 修复

在此阶段，我们解决了诸多由模块化隔离和 PixiJS 版本迭代引发的致命报错与渲染问题，所有重要修改均集中于 `src/renderer/pet/pet-app.js` 中：

### ① 修复 Electron 下的模块依赖注入 (ReferenceError 崩溃)
- **原因**：在 CommonJS `require` 模式下，`pixi-live2d-display` 插件找不到全局变数 `PIXI`，导致插件内部瘫痪。
- **修改**：强制指定了严格的加载顺序：
  ```javascript
  const PIXI = require('pixi.js');
  window.PIXI = PIXI; // 必须先挂载到全局
  const { Live2DModel } = require('pixi-live2d-display');
  ```

### ② 修复 Ticker 报错 (`reading 'add' of undefined`)
- **原因**：`Live2DModel.registerTicker` 期望接收的是 Ticker 类本身，而不是单一实例。
- **修改**：将绑定参数从旧版的 `PIXI.Ticker.shared` 修正为类对象：
  ```javascript
  Live2DModel.registerTicker(PIXI.Ticker);
  ```

### ③ 修复 `isInteractive is not a function` 报错风暴 (EventBoundary 崩溃)
- **原因**：PixiJS v7 升级了全新的 `@pixi/events` 事件分发系统，它要求画布下的所有渲染节点必须提供 `isInteractive` 方法。但旧版 `pixi-live2d-display` 内部构造的 WebGL 骨骼零件缺少此方法，导致当鼠标经过模型时，控制台疯狂报错。
- **修改**：
  1. 在实例化模型时禁用插件不兼容的自带互动：`Live2DModel.from(modelPath, { autoInteract: false })`。
  2. 实现了**深度遍历拦截猴子补丁** (`patchIsInteractive`)，在模型加载后扫描模型的整棵渲染树，强制为每一个缺少该方法的子组件挂载 `isInteractive = () => false`。

### ④ 修复高分屏下的渲染模糊 (Blurry Texture)
- **原因**：Electron 默认采用 1:1 的逻辑像素渲染，而在 Windows 的 125%、150% 等高 DPI 系统缩放率下，Canvas 被拉伸导致画面糊化。
- **修改**：在 `PIXI.Application` 初始化时，引入硬件设备像素比和自动 CSS 密度锁定：
  ```javascript
  resolution: window.devicePixelRatio || 1, // 适配高分屏
  autoDensity: true // 锁定 CSS 尺寸同化
  ```

### ⑤ 修复拖拽窗口时模型变形放大 (Rubber-band Scaling)
- **原因**：之前的 `<canvas>` CSS宽高被设置成了相对值 `100%`。在通过 IPC 通知主进程拖动无边框窗口时，微小的 DOM 抖动和重绘使得 WebGL 上下文被动态挤压和二次缩放。
- **修改**：在容器初始化之后，将其 CSS 尺寸强制写死为初始化时的固定绝对物理像素（例如直接转换为 `300px`），阻止由于容器边框变化引起的重绘失真：
  ```javascript
  app.view.style.width = app.screen.width + 'px';
  app.view.style.height = app.screen.height + 'px';
  ```

---

## 4. 当前核心机制运行现状

目前 `pet-app.js` 和 `main.js` 现有的协同逻辑已稳定达成以下特性：

1. **自动回退策略**：如果真实的 `.model3.json` 地址不对或发生读取异常，应用会自动 catch 生成一个带眼睛的“粉色圆形”代替，绝不白屏死机。
2. **全局视线跟随**：无论鼠标是在窗口内还是穿透到窗口后方（桌面其他地方），通过归一化运算 (`-0.5~0.5`) + `model.focus(mouseX, mouseY)`，角色视线都能精准指向鼠标。
3. **鼠标穿透拦截**：配合 HTML 容器的 `mouseenter` 和 `mouseleave` 事件，按需向主进程发送 `enable-mouse-events` 或 `disable-mouse-events`，实现在没有点中宠物时，鼠标点击直接穿透给下方的桌面应用。
4. **平滑的无边框拖拽**：在宠物身上按下左键拖动时，监听 `document` 级别的 `mousemove` 并通过 IPC (`window-move`) 实时向外透传相对屏幕的位移增量，主进程调用 `setPosition` 使透明窗体完成随动。

## 5. 建议的下一步计划
- **模型文件管理**：目前使用的是相对路径（退三层），建议未来引入 Node.js 的 `path.join(__dirname, ...)` 或设置一个全局资源根目录，方便 Electron 打包后模型不丢失。
- **交互扩展**：可以在 `pet-app.js` 里为 Live2D 模型绑定点击事件（Tap / Click），调用 `model.motion("TapBody")` 或播放特定交互动作与声音。
- **持久化配置**：为拖拽结束后的位置增加本地记录（存入 localStorage 或 electron-store），下次启动时在主进程里直达该坐标。
