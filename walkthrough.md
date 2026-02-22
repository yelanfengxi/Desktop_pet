# Live2DPet 核心踩坑与解决方案复盘

在这款基于 Electron + PixiJS v7 + Live2D 的桌面宠物项目开发中，我们将跨端框架和图形渲染引擎糅合在了一个追求“无边框透明交互”的极端应用场景里。这种多维度的架构带来了大量的底层冲突。本文档将复盘开发过程中遭遇的四大“灾难级”深坑及最终的硬核解法。

---

## 坑一：模块隔离机制下的上下文断裂（PixiJS 与插件的恩怨）

**💣 灾难现象：**
在 Renderer 进程中，主视图画布毫无动静。控制台报错：`undefined is not an object` 或者找不到 `window.PIXI`。无论怎么修改 import 顺序，`pixi-live2d-display` 插件就是无法挂载到 PixiJS 对象上。

**🔍 根本原因：**
Electron 开启了 Node Integration，引入 CommonJS/Require 体系后，打包或加载机制导致 PixiJS 实例被局限在当前的模块级作用域中。而老牌的 `pixi-live2d-display` 核心代码被设计为强制去全局的 `window.PIXI` 对象上寻址挂载扩展。这导致插件根本“看不见”我们在脚本里 `require` 进来的 PIXI 实例。

**🛡️ 硬核解法：严格控制依赖注入顺序与强行暴露**
必须在引入 Live2D 插件**之前**，人为打破模块隔离，强行将 PIXI 对象“钉牢”在全局的 window 上。顺序错一行都会导致挂载失败。
```javascript
// 1. 严格控制依赖注入顺序
const PIXI = require('pixi.js');
// 【关键】强行挂载到 window，打破 CommonJS 模块隔离，供 Live2D 插件寻址
window.PIXI = PIXI; 
// 2. 然后再引入插件
const { Live2DModel } = require('pixi-live2d-display');
```

---

## 坑二：高分屏环境下的“膨胀拖拽”Bug

**💣 灾难现象：**
在 Windows 等开启了系统缩放比例（DPI 缩放，比如 125% 或 150%）的高分屏显示器上，每次用户点住模型拖拽时，原本设定为 500x500 的宠物窗口会**不可逆转地越变越大**（甚至飞出屏幕边缘），同时模型本身迅速缩小。

**🔍 根本原因：**
这是 Electron 在高分屏系统下与 `getBounds()` / `setBounds()` API 计算逻辑脱节导致的经典 Bug。`getBounds()` 取到的坐标和宽高，再经过鼠标的屏幕坐标（受到系统 DPI 污染）进行差值计算（`deltaX`, `deltaY`）重设 Bounds 时，Electron 内部的矩形计算丢失了原始的宽高信息，发生反复的像素截断增殖。

**🛡️ 硬核解法：暴力锁死窗口物理尺寸**
放弃仅修改 x/y，每次处理主进程的拖拽 IPC 通信重新定位窗口时，必须**同时强制重写物理宽高**（锁死在我们在创建窗口时设定的原始值）。并且通过防抖或限制最大移动步长来过滤异常跳变坐标。
```javascript
// main.js - ipcMain.on('window-move')
const newX = bounds.x + deltaX;
const newY = bounds.y + deltaY;

// 修复 Windows 缩放比例下拖拽会导致窗口越来越大的 Bug
// 强制将宽和高锁死在目前的固定尺寸(500x500)
petWindow.setBounds({
    x: newX,
    y: newY,
    width: 500,  // 绝对不信任 bounds.width
    height: 500  // 绝对不信任 bounds.height
});
```

---

## 坑三：透明窗口的“穿透悖论”与脱手断触

**💣 灾难现象：**
为了让桌面宠物看起来“悬浮”在桌面上，我们启用了 Electron 的 `transparent: true`，并在主进程中使用了 `petWindow.setIgnoreMouseEvents(true, { forward: true })` 来让背景透明区域完全放行鼠标点击（点到桌面背后的图标）。
**结果：**PixiJS 引擎内基于 `eventMode` 绑定的 Interaction 事件彻底哑火！由于顶层窗口告诉 OS 忽略鼠标，底层的 Canvas 根本收不到 Web 鼠标事件。
就算我们勉强通过坐标测算解决了点击，**拖拽脱手**也是噩梦：一旦拖动鼠标速度过快离开模型区域（发生断触），或者点击别的地方，宠物就会陷入“黏在鼠标上扯不掉”或“再也点不中”的死锁状态。

**🔍 根本原因：**
Electron 的 `forward: true`（把事件转给底下程序）对 Chromium 内核渲染的 Canvas 和内部 WebGL 对象的派发机制极度脆弱，尤其是结合了 PixiJS 的内部渲染树。PixiJS 的虚拟事件根本无法反向去通知 Electron “嗨，我被点到了，把截获权还给我”。

**🛡️ 硬核解法：摒弃 WebGL 交互，回归纯净 DOM 物理遮罩 (Hitbox)**
不再执着于在复杂的 PixiJS 节点里玩事件！在 [index.html](file:///d:/WORKS/LAN/src/renderer/pet/index.html) 的顶层，绝对定位一个看不见的 [div](file:///d:/WORKS/LAN/node_modules/pixi-live2d-display/dist/index.js#2151-2157) 元素（Hitbox 碰撞箱）精准覆盖模型肉体。所有的“鼠标穿透（`ignore`）”全靠这个最外层纯 DOM 元素的 `mouseenter`（恢复截获）和 `mouseleave`（放给桌面）来通知主进程！
配合 200ms 防抖计时器，完美解决焦点快速滑出的断触问题。
```html
<!-- index.html -->
<!-- 真正的绝对物理碰撞遮罩层，完全透明隐身！ -->
<div id="hitbox"></div>
<div id="canvas-wrapper"></div> <!-- 画布躲在后面画图就行，不参与主线交互 -->
```
```javascript
// pet-app.js
const hitbox = document.getElementById('hitbox');
// 进入神圣结界：向主进程索要鼠标控制权
hitbox.addEventListener('mouseenter', () => {
    if (hideChatBoxTimer) { clearTimeout(hideChatBoxTimer); hideChatBoxTimer = null; }
    ipcRenderer.send('enable-mouse-events');
});
// 离开结界：延迟 200ms 归还鼠标控制权给桌面操作系统
hitbox.addEventListener('mouseleave', () => {
    // ...逻辑代码
    hideChatBoxTimer = setTimeout(() => {
        ipcRenderer.send('disable-mouse-events');
    }, 200);
});
```

---

## 坑四：多模态 AI 喂图导致的 400 Bad Request 崩溃

**💣 灾难现象：**
桌宠添加了自动截屏呼叫视觉 AI 接口的功能。当大模型试图分析桌面时，极大概率抛出 `HTTP 400 Bad Request` 甚至让请求直接挂起崩溃，导致应用进程内存暴涨。

**🔍 根本原因：**
Electron 的 `desktopCapturer` 会根据当前主屏幕分辨率抓取无损画质。返回的 `NativeImage` 如果直接转换成 DataURL（`toDataURL()` 会默认为 PNG），在 2K、4K、甚至多屏拼接环境下，一张纯无损 PNG Base64 字符串的体积高达 **数十 MB**（有时字符串长度超过数千万字符！）。
不管是大模型的云端 Gateway 层（如 Nginx）、还是 OpenAI 接口限制、还是 Fetch API 本身，面对这么恐怖的 Body 体积直接拒收或超时断开。

**🛡️ 硬核解法：在主进程 C++ 引擎侧直接极限降维打包 JPEG**
绝对不能传纯 PNG，甚至不能试图在渲染进程用 JS 瞎转！必须在 Node 控制的主进程中，利用 Electron 底层暴露在 `NativeImage` 对象上的 C++ 图像处理 API，在内存里就完成**尺寸降维** + **高损重编码 JPEG**：
```javascript
// main.js - 截屏 IPC 侦听
const sources = await desktopCapturer.getSources({ types: ['screen'] });
const mainScreen = sources[0];

// 【拯救网络层的核心两招】
// 第一招：破坏无损，强制将其物理宽高缩骨到极限宽度（通常 1024 已经足够 AI 辨认）
const img = mainScreen.thumbnail.resize({ width: 1024 }); 
// 第二招：杜绝 PNG，强转成仅有 80% 质量的有损 JPEG，并将 Buffer 取出！
const base64Image = `data:image/jpeg;base64,${img.toJPEG(80).toString('base64')}`;

// 体积从原来的 30MB 骤降到 150KB - 200KB 之间。光速发包！
return base64Image;
```

---
**总结：** 开发桌面宠物是在挑战现代操作系统视窗管理器的底线。只要遵循“能用 DOM 解决碰撞就绝对不用引擎”、“永远不要相信 DPI 缩放下的坐标系”、“涉及底层文件必须在 C++ 层就地压缩” 这三大原则，就能构建出一个极度稳定犹如原生级体验的丝滑跨端应用。

---

## 坑五：复杂多组件悬停与脱嵌悖论 (Hover Glitch)

**💣 灾难现象：**
当把聊天输入框、历史面板、设置面板等相互独立的 DOM 组件并列分离后，因这几个盒子互不为父子或嵌套，原生 `mouseenter` 和 `mouseleave` 的闭包延时器开始“各自为战”。鼠标在它们之间的缝隙仅仅越过 1 个像素，就会触发疯狂的隐藏与重现闪烁。同时因为分离重构不小心清除了 `hitbox` 的源事件，使得由模型触发的拖拽 IPC 彻底哑火。

**🔍 根本原因：**
1. 并列 DOM 元素的移出判定十分苛刻，系统毫不管你是不是想去它隔壁的另一个属于同一家族的控件，只要鼠标离开盒子 0.1mm，`mouseleave` 发射。并且 `userChatInput` 虽然从视觉上被隐藏（`opacity: 0`），但如果物理上焦点并未主动退离，按键仍会响应或引发视觉卡死。
2. 拖拽强行解绑了 hitbox mousedown 等物理 DOM 事件，完全依靠 window mousemove 成了“无本之木”。

**🛡️ 硬核解法：全局聚合家族 + Native relatedTarget 溯源防抖 + UI 全局脱敏拖动**

抛弃了原本通过 `activeElement !== userChatInput` 判断失焦的“治标不治本”写法。引入完整的家族生命周期判定：
1. **统一家族树**：将 `hitbox`，聊天框、历史框、设置面板划定为一个在 JS 逻辑里的虚拟 DOM 组（UI Family）。
2. **`relatedTarget` 追踪溯源**：原生 `mouseleave` 事件如果触发，不是立刻断开底层的透明穿透权（这会导致后续追踪失效），而是打开事件头查看鼠标正要前往的下一个落脚点 `e.relatedTarget`。只要依然在家族范围内，就直接 `return` 无视这次表面“移出”。
3. **强制没收发话权**：只有全员离开且无鼠标残影，倒计时 1s 结束时。除了触发隐藏样式外，必须加一句霸道的 `userChatInput.blur()` 强行剥除其内部 HTML 焦点！防止透明输入框继续拦截按键。
4. **底层事件链下放**：原来固定 `hitbox` 的绑定被扩大到了 `window` 级别。拖拽窗口事件变更为只要判断排除 `e.target === textarea / button` 这类交互组件，点任何背景区（甚至对话框留白）都会下发 IPC `"enable-mouse-events"` + `isDragging = true`，真正实现了全桌面的丝滑随手拖。

---

## 坑六：右键被吞与拖拽伪失焦的“系统级死锁”

**💣 灾难现象：**
解决了悬停与脱嵌后，马上迎来了终极死锁：当用户按住模型飞速拖拽时，鼠标很容易瞬间甩出无边框窗口的物理范围，假性触发了 `hitbox` 的 `mouseleave`。程序一旦发射 `disable-mouse-events`（开启主进程透传），窗口立马变成一块无法选中的隐形玻璃，用户正在拖拽的手当场“脱臼”。不仅如此，只要点个右键召唤设置面板，这个拖拽锁就会被永久激活，从此无论是谁触发 `mouseleave` 都会让整个桌宠万劫不复，再也无法被鼠标唤醒。

**🔍 根本原因：**
1. **伪失焦过分自信**：系统事件 `mouseleave` 是冷酷无情的，它不知道用户此时**是否正按着左键在拖拽**。
2. **事件黏连与冒泡越级**：全局绑定的 `window.mousedown` 除了会抓取左键，也会默默抓取右键（`button === 2`）。当用户本意是点右键呼出设置时，虽然底层菜单弹出了，但全局记录了 `isDraggingModel = true`。更致命的是，浏览器对于系统右键行为会吃掉其对应的 `mouseup` 回调，导致这个锁一辈子都关不上。

**🛡️ 硬核解法：三重防御锁与绝对强隐机制**

这是在原生客户端开发中最经典的一类防卫战，必须用“六亲不认”的代码风格应对各种刁钻的鼠标抽搐：

1. **拖拽互斥锁** `isDraggingModel`：
   在全局 `mousedown` 里（且明确 `e.button === 0` 即左键时），不仅激活拖动框架，还同步启动 `isDraggingModel = true`。有了这把锁，在 `hitbox` 的 `mouseleave` 第一行里大喊一句：**“老子在拖拽呢！想穿透？门都没有！`return;`”**。这彻底杜绝了拖拽甩出窗口时的死锁。

2. **右键强行净化**：
   在 `hitbox.addEventListener('contextmenu')` 唤起设置的一瞬间。不用去猜测当前系统里积累了多少错乱的未释放点击，第一句直接就是：
   ```javascript
   isDraggingModel = false; // 【绝对净化】不管你前面怎么乱点，只要我设置开着，前面的锁统统解除！
   isSettingsOpen = true;   // 【开启霸体】
   ```

3. **松手回血容错**：
   在全局解决“是否要恢复穿透权”的终极 `mouseup` 判定里。如果用户此时在设置面板里瞎点导致在界面外松开鼠标，系统以前会盲测“光标不在身上，立刻透明！”。现在加入了一句护心符：
   ```javascript
   if (isSettingsOpen) return; // 只要设置在开着，不论发生什么，绝不允许进入隐身/穿透状态！
   ```

正是这种用“纯血 JS 逻辑锁”生生掐断底层原生事件链的做法，才换回了无论怎么左击右击狂甩鼠标，绝不崩溃宕机的原生级 UI 流畅性体验。


