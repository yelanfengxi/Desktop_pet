const { ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs');

// 1. 严格控制依赖注入顺序
const PIXI = require('pixi.js');
window.PIXI = PIXI;

const { Live2DModel } = require('pixi-live2d-display');

// 声明全局状态
let app;
let model;
let isDragging = false;
let mouseOffset = { x: 0, y: 0 };
let chatHistory = []; // 滑动窗口记忆
let hideChatBoxTimer = null; // 输入框防抖定时器
let isChatPinned = false;    // 任务2：聊天面板图钉状态锁
let isSettingsOpen = false;  // 设置面板状态锁 (拦截 UI 冲突)
let isDraggingModel = false; // 防穿透死锁：拖拽状态锁

// ==========================================
// 任务1：统一鼠标穿透防抖控制器
// 所有交互区域共用一个 150ms 缓冲，在面板间滑动时不会丢失鼠标接管
// ==========================================
let mouseLeaveTimer = null;
function enableMouse() {
    clearTimeout(mouseLeaveTimer);
    mouseLeaveTimer = null;
    ipcRenderer.send('enable-mouse-events');
}
function disableMouse() {
    clearTimeout(mouseLeaveTimer);
    mouseLeaveTimer = setTimeout(() => {
        ipcRenderer.send('disable-mouse-events');
    }, 150);
}

async function init() {
    // 初始化 Application
    const canvasWrapper = document.getElementById('canvas-wrapper');
    const petContainer = document.getElementById('pet-container');

    app = new PIXI.Application({
        width: petContainer ? petContainer.clientWidth : 300,
        height: petContainer ? petContainer.clientHeight : 300,
        backgroundAlpha: 0, // 确保透明
        antialias: true,
        // 修复模糊: 告诉 Pixi 适配高分屏 / 系统缩放 (DPI)
        resolution: window.devicePixelRatio || 1,
        // 修复 CSS 与内部绘图尺寸剥离，防止拖拽/缩放时窗口变形导致模型失真
        autoDensity: true
    });

    if (canvasWrapper) {
        // 由于我们在 HTML 里加了同级的气泡，现在将 Canvas 挂载在专用的 wrapper 里
        canvasWrapper.appendChild(app.view);
    } else if (petContainer) {
        petContainer.appendChild(app.view);
    } else {
        document.body.appendChild(app.view);
    }

    // 核心修复：锁死物理像素与外框的同步率，避免跟随悬浮窗伸缩
    app.view.style.width = app.screen.width + 'px';
    app.view.style.height = app.screen.height + 'px';
    app.view.style.display = 'block';

    // 2. 【核心修复】注册 Ticker！
    // 插件的 registerTicker 期望接收的是 `Ticker` 类本身（即 PIXI.Ticker），而不是 Ticker 的实例。
    // 如果你传了 PIXI.Ticker.shared（实例）或者 app.ticker（实例），它内部会在实例上找 .shared.add()，这就是之前报 `undefined (reading 'add')` 的原因！
    Live2DModel.registerTicker(PIXI.Ticker);

    // 之前那个没用，Live2D 埋在内部的子类（如网格、部件）很多都是自定义的，必须递归去贴。
    // （将在下方 await from 加载后执行）

    // 3. 读取并加载模型：优先使用用户在设置面板保存的绝对路径，否则使用默认路径
    // 注意：Windows 绝对路径传给 Live2DModel.from() 时需转换为 file:/// URL（正斜杠）
    let modelPath;
    const savedFolder = localStorage.getItem('model-path');
    if (savedFolder) {
        try {
            // 在用户指定的文件夹中查找第一个 .model3.json 文件
            const files = fs.readdirSync(savedFolder);
            const jsonFile = files.find(f => f.endsWith('.model3.json'));
            if (jsonFile) {
                const absPath = path.join(savedFolder, jsonFile);
                // 转为 file:// URL，路径分隔符改为正斜杠
                modelPath = 'file:///' + absPath.replace(/\\/g, '/');
            } else {
                console.warn('指定文件夹中未找到 .model3.json 文件，回退到默认模型');
                modelPath = path.join(__dirname, '..', '..', '..', 'assets', 'default_models', 'Live2d', '春日部つむぎ公式live2Dモデル.model3.json');
            }
        } catch (fsErr) {
            console.warn('读取模型文件夹失败，回退到默认模型:', fsErr);
            modelPath = path.join(__dirname, '..', '..', '..', 'assets', 'default_models', 'Live2d', '春日部つむぎ公式live2Dモデル.model3.json');
        }
    } else {
        // 默认路径：使用 Node 绝对路径，防止 Electron 打包后相对路径丢失
        modelPath = path.join(__dirname, '..', '..', '..', 'assets', 'default_models', 'Live2d', '春日部つむぎ公式live2Dモデル.model3.json');
    }
    try {
        model = await Live2DModel.from(modelPath, { autoInteract: false });

        const containerWidth = app.view.width;
        const containerHeight = app.view.height;

        // 缩放确保模型完全在可见区域内 
        // 你可通过修改 *= 0.8 的数值来进一步调节它在窗口里的默认大小
        const scaleX = containerWidth / model.width;
        const scaleY = containerHeight / model.height;
        const modelScale = Math.min(scaleX, scaleY) * 0.8;

        // 挂载
        app.stage.addChild(model);

        // 把 Y 轴适当下移一点，好给头顶上的气泡留出绝对的空间
        model.scale.set(modelScale);
        model.x = containerWidth / 2;
        model.y = containerHeight / 2 + 80;
        model.anchor.set(0.5, 0.5);

        // 【终极防爆补丁】：深度遍历扫描这整棵庞大的模型渲染树，强行给每一片没有交互声明的树叶打上免疫标签
        function patchIsInteractive(node) {
            if (node && typeof node.isInteractive !== 'function') {
                node.isInteractive = function () { return false; };
            }
            if (node && node.children) {
                node.children.forEach(patchIsInteractive);
            }
        }
        patchIsInteractive(model);

    } catch (err) {
        console.error("加载 Live2D 模型失败，启用粉色测试模型：", err);
        createPlaceholderModel(); // 失败则启用原来的粉红色测试占位模型
    }

    // 不管是否加载成 Live2D，都初始化交互逻辑（比如穿透和拖拽）
    setupInteraction();
}

function createPlaceholderModel() {
    // 构建粉色圆形
    model = new PIXI.Graphics();
    model.beginFill(0xff9999);
    model.drawCircle(150, 150, 100);
    model.endFill();

    // 眼睛
    const leftEye = new PIXI.Graphics();
    leftEye.beginFill(0x000000);
    leftEye.drawCircle(120, 130, 15);
    leftEye.endFill();
    model.addChild(leftEye);

    const rightEye = new PIXI.Graphics();
    rightEye.beginFill(0x000000);
    rightEye.drawCircle(180, 130, 15);
    rightEye.endFill();
    model.addChild(rightEye);

    app.stage.addChild(model);
}

function setupInteraction() {
    // 视线跟随
    app.view.addEventListener('pointermove', (e) => {
        if (model && model.focus) {
            const rect = app.view.getBoundingClientRect();
            const mouseX = (e.clientX - rect.left) / rect.width - 0.5;
            const mouseY = (e.clientY - rect.top) / rect.height - 0.5;

            try {
                model.focus(mouseX, mouseY);
            } catch (err) {
            }
        }
    });

    // ==========================================
    // 阶段4.7：绝对的物理 DOM 层交互 (Hitbox)
    // 依靠原生的 DOM mouseenter 和 mouseleave 检测，最稳妥的防穿透方案
    // ==========================================
    const hitbox = document.getElementById('hitbox');

    const chatWrapper = document.getElementById('chat-wrapper');
    const chatInputContainer = document.getElementById('chat-input-container');
    const userChatInput = document.getElementById('user-chat-input');

    // ==========================================
    // 任务1统一防抖穿透绑定
    // ==========================================
    const settingsPanelEl = document.getElementById('settings-panel');
    const chatHistoryPanelEl = document.getElementById('chat-history-panel');
    // ============================================================
    // 悬停显隐（0.5s 显示 / 1s 隐藏）+ 全局拖拽 + 绝杀隐藏逻辑
    // ============================================================
    let showChatBoxTimer = null;
    let hideChatBoxTimer = null;

    // 受保护的 UI 面板集合，鼠标在此家族内跳转不视为"离开"
    const uiFamily = [hitbox, settingsPanelEl, chatWrapper].filter(Boolean);

    // 判断一个元素是否属于 UI "家族"
    function isInUIFamily(el) {
        if (!el) return false;
        return uiFamily.some(panel => panel === el || panel.contains(el));
    }

    // 强制隐藏所有浮动 UI
    function forceHideAllUI() {
        if (userChatInput) userChatInput.blur();
        if (chatInputContainer) chatInputContainer.classList.remove('visible');
        if (chatHistoryPanelEl) chatHistoryPanelEl.style.display = 'none';
    }

    // 启动隐藏倒计时（0.5 秒后强制隐藏）
    function scheduleHide() {
        if (isChatPinned || isDragging) return;
        if (hideChatBoxTimer) clearTimeout(hideChatBoxTimer);
        hideChatBoxTimer = setTimeout(() => {
            forceHideAllUI();
            hideChatBoxTimer = null;
        }, 500);
    }

    // 全局拖拽：点击非 UI 区域即拖动窗口
    window.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        // 如果点击的目标属于任何 UI 面板，不拖拽
        if (e.target.closest('#chat-input-container, #chat-history-panel, #settings-panel, #chat-bubble')) return;
        isDragging = true;
        isDraggingModel = true; // 新增：标记开始拖拽模型
        mouseOffset.x = e.screenX;
        mouseOffset.y = e.screenY;
        ipcRenderer.send('enable-mouse-events');
    });

    let isGlobalPassthrough = false;
    ipcRenderer.on('mouse-passthrough-changed', (e, isPassthrough) => {
        isGlobalPassthrough = isPassthrough;
        console.log('[Debug] 收到主进程鼠标穿透状态更改:', isGlobalPassthrough);
        if (isGlobalPassthrough) {
            forceHideAllUI();
        }
    });

    uiFamily.forEach(el => {
        el.addEventListener('mouseenter', () => {
            // 全局穿透期间，禁止一切 UI 唤醒，彻底变成桌布
            if (isGlobalPassthrough) return;

            // 无论如何，只要摸到交互家族（尤其是 Hitbox），第一时间开启鼠标穿透拦截，让模型可交互
            enableMouse();

            // 如果设置面板处于打开状态，强行阻断其它 UI（如聊天气泡、历史记录）弹出的行为
            if (isSettingsOpen) return;

            // 取消正在进行的隐藏倒计时
            if (hideChatBoxTimer) { clearTimeout(hideChatBoxTimer); hideChatBoxTimer = null; }
            if (showChatBoxTimer) return; // 已经在等待显示了

            if (!isChatPinned && (!chatInputContainer || !chatInputContainer.classList.contains('visible'))) {
                showChatBoxTimer = setTimeout(() => {
                    if (chatInputContainer) chatInputContainer.classList.add('visible');
                    if (chatHistoryPanelEl && localStorage.getItem('pet_isHistoryVisible') === 'true') {
                        chatHistoryPanelEl.style.display = 'flex';
                    }
                    if (window.syncHistoryPanelPos) window.syncHistoryPanelPos();
                    showChatBoxTimer = null;
                }, 500);
            }
        });

        el.addEventListener('mouseleave', (e) => {
            // 注意：因为上面是 uiFamily.forEach，这里的 el 可能是 hitbox 也可能是别的面板
            // 我们需要对 hitbox 的 mouseleave 做严格的死锁拦截（遵循用户的新指令结构）
            if (el.id === 'hitbox') {
                console.log('[Debug] hitbox 触发 mouseleave');

                // 终极拦截锁 1：正在拖拽中，绝对禁止穿透！
                if (typeof isDraggingModel !== 'undefined' && isDraggingModel === true) {
                    console.log('[Debug] 拦截：正在拖拽中，禁止穿透');
                    return;
                }

                // 终极拦截锁 2：设置面板处于打开状态，绝对禁止穿透！(否则面板点不到)
                if (typeof isSettingsOpen !== 'undefined' && isSettingsOpen === true) {
                    console.log('[Debug] 拦截：设置面板已开启，禁止穿透');
                    return;
                }

                console.log('[Debug] 验证通过，准备执行面板隐藏与穿透操作...');
            }

            // 核心修复1：提前判断是否是内部跳跃
            const goingTo = e.relatedTarget;
            if (isInUIFamily(goingTo)) {
                // 如果是家族间跳转，绝对不能 disableMouse 断开鼠标！
                return;
            }

            disableMouse();
            if (showChatBoxTimer) { clearTimeout(showChatBoxTimer); showChatBoxTimer = null; }

            // 真正离开了所有 UI，启动隐藏倒计时
            scheduleHide();
        });
    });

    // 终极防漏罩：鼠标飞出整个应用窗口时强制隐藏
    document.addEventListener('mouseleave', () => {
        if (showChatBoxTimer) { clearTimeout(showChatBoxTimer); showChatBoxTimer = null; }
        scheduleHide();
    });

    // 注：chatHistoryPanel 的 mouseenter/leave 穿透已由顶部统一防抖机制（enableMouse/disableMouse）接管
    const chatHistoryPanel = document.getElementById('chat-history-panel');

    // 任务2：关闭按钮（不再操作图钉，纯关面板）
    const closeChatPanelBtn = document.getElementById('close-chat-panel');
    if (closeChatPanelBtn && chatHistoryPanel) {
        closeChatPanelBtn.addEventListener('click', () => {
            chatHistoryPanel.style.display = 'none';
            localStorage.setItem('pet_isHistoryVisible', 'false');
        });
    }

    // 初始化历史面板显隐状态（不再需要固定输入框，因为受隐藏计时器控制）
    // 修改：如果未设置过状态，默认不显示（false）
    const isHistoryVisibleStr = localStorage.getItem('pet_isHistoryVisible');
    const isHistoryVisible = isHistoryVisibleStr === 'true'; // 如果是 undefined/null，则为 false

    if (isHistoryVisible) {
        chatHistoryPanel.style.display = 'flex';
    } else {
        chatHistoryPanel.style.display = 'none';
        // 同步存入 localStorage 建立初始默认状态
        localStorage.setItem('pet_isHistoryVisible', 'false');
    }

    // 📜 历史面板开关按钮（仅操作面板显隐，与图钉解绑）
    const historyToggleBtn = document.getElementById('history-toggle-btn');
    if (historyToggleBtn && chatHistoryPanel) {
        historyToggleBtn.addEventListener('click', () => {
            const messagesArea = document.getElementById('chat-messages-area');
            if (chatHistoryPanel.style.display === 'flex') {
                chatHistoryPanel.style.display = 'none';
                localStorage.setItem('pet_isHistoryVisible', 'false');
            } else {
                chatHistoryPanel.style.display = 'flex';
                localStorage.setItem('pet_isHistoryVisible', 'true');
                if (window.syncHistoryPanelPos) window.syncHistoryPanelPos();
                if (messagesArea) messagesArea.scrollTop = messagesArea.scrollHeight;
            }
        });
    }

    // 📌 全局图钉按钮（控制所有组件常驻）
    const globalPinBtn = document.getElementById('global-pin-btn');
    if (globalPinBtn) {
        globalPinBtn.addEventListener('click', () => {
            isChatPinned = !isChatPinned;
            if (isChatPinned) {
                globalPinBtn.classList.add('active');
            } else {
                globalPinBtn.classList.remove('active');
            }
        });
    }

    // =========================================
    // 任务3：历史面板自由拖拽 + 位置强绑定
    // =========================================
    const syncHistoryPanelPos = () => {
        const panel = document.getElementById('chat-history-panel');
        const inputContainer = document.getElementById('chat-input-container');
        if (!panel || !inputContainer) return;

        // 获取 input 的准时 offsetTop，因为如果它使用 bottom 定位，需要转为 top 计算
        const inputTop = parseInt(inputContainer.style.top) || inputContainer.offsetTop;
        panel.style.top = (inputTop - panel.offsetHeight - 5) + 'px';
        panel.style.left = inputContainer.style.left || inputContainer.offsetLeft + 'px';
        panel.style.bottom = 'auto'; // 清除 bottom，强制使用刚计算的 top
    };
    window.syncHistoryPanelPos = syncHistoryPanelPos; // 暴漏出去

    // =========================================
    // 任务3：历史面板与主界面的拖拽
    // 增强体验：允许按住对话框空白处（边框、底板）进行整个聊天界面的拖拽
    // =========================================
    (function initChatPanelDrag() {
        const inputContainer = document.getElementById('chat-input-container');
        if (!inputContainer) return;

        // 启动时只恢复输入框的独立位置
        const iLeft = localStorage.getItem('chat-input-left');
        const iTop = localStorage.getItem('chat-input-top');
        if (iLeft !== null && iTop !== null) {
            inputContainer.style.left = iLeft;
            inputContainer.style.top = iTop;
            inputContainer.style.bottom = 'auto';
            inputContainer.style.transform = 'none';
        }

        requestAnimationFrame(() => {
            if (window.syncHistoryPanelPos) window.syncHistoryPanelPos();
        });

        let uiDragging = false;
        let dragOffX = 0, dragOffY = 0;

        // 赋予对话框除了功能按钮、输入框本体之外所有区域的拖拽能力
        inputContainer.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            // 排除输入框、图标按钮
            if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'BUTTON' || e.target.closest('button')) return;

            uiDragging = true;

            const rect = inputContainer.getBoundingClientRect();
            dragOffX = e.clientX - rect.left;
            dragOffY = e.clientY - rect.top;

            inputContainer.style.bottom = 'auto';
            inputContainer.style.transform = 'none';

            inputContainer.style.cursor = 'grabbing';
            ipcRenderer.send('enable-mouse-events');

            e.preventDefault();
            e.stopPropagation(); // 阻止事件冒泡到 window，防止拉动模型窗口
        });

        window.addEventListener('mousemove', (e) => {
            if (!uiDragging) return;
            // 依据鼠标位置直接修改 inputContainer
            const iMaxLeft = 500 - inputContainer.offsetWidth;
            const iMaxTop = 500 - inputContainer.offsetHeight;
            const iNewLeft = Math.max(0, Math.min(iMaxLeft, e.clientX - dragOffX));
            const iNewTop = Math.max(0, Math.min(iMaxTop, e.clientY - dragOffY));

            inputContainer.style.left = iNewLeft + 'px';
            inputContainer.style.top = iNewTop + 'px';

            // 强制面板跟随主基准
            if (window.syncHistoryPanelPos) window.syncHistoryPanelPos();
        });

        window.addEventListener('mouseup', (e) => {
            if (!uiDragging) return;
            uiDragging = false;
            inputContainer.style.cursor = 'default';

            // 保存 inputContainer 的位置
            localStorage.setItem('chat-input-left', inputContainer.style.left);
            localStorage.setItem('chat-input-top', inputContainer.style.top);
        });
    })();

    // 文本域自适应高度
    if (userChatInput) {
        userChatInput.addEventListener('input', function () {
            this.style.height = 'auto'; // Reset height
            this.style.height = (this.scrollHeight) + 'px';
        });

        // 绑定 Enter 发送和 Shift+Enter 换行
        userChatInput.addEventListener('keydown', async (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault(); // 阻止默认的回车换行
                const userText = userChatInput.value.trim();
                if (!userText) return;

                userChatInput.value = '';
                userChatInput.style.height = 'auto'; // 恢复初始高度
                userChatInput.blur();

                const apiKey = localStorage.getItem('pet_apiKey');
                if (!apiKey) {
                    window.petActions.showChat("请先右键配置 API Key 才能聊天哦！", 4000);
                    return;
                }

                window.petActions.showChat("让我想想怎么回你...", 0);

                try {
                    const base64Data = await ipcRenderer.invoke('capture-screen');
                    await askAI(base64Data, userText, false); // 手动输入，显示在历史面板
                } catch (err) {
                    console.error('用户聊天失败:', err);
                    window.petActions.showChat("呜...脑子短路了...", 4000);
                }
            } // Close the if block
        });
    }

    // 拖拽中的位移监听，这个可以保持监听 window，保证甩拉平滑
    window.addEventListener('mousemove', (e) => {
        if (isDragging) {
            const dx = e.screenX - mouseOffset.x;
            const dy = e.screenY - mouseOffset.y;

            if (dx !== 0 || dy !== 0) {
                ipcRenderer.send('window-move', dx, dy);
            }

            mouseOffset.x = e.screenX;
            mouseOffset.y = e.screenY;
        }
    });

    window.addEventListener('mouseup', (e) => {
        if (isDragging) {
            isDragging = false;
            isDraggingModel = false; // 新增：解除拖拽锁定

            // 【关键保险】如果设置面板处于打开状态，说明用户正在操作设置，
            // 此时绝对不要去执行隐藏聊天面板或触发 disable-mouse-events（鼠标穿透）的操作。
            if (isSettingsOpen) return;

            // 精准回血：板起后检查鼠标是否仍然停留在 hitbox 内
            // 如果还在里面，保持之前的拦截状态，不要多余决策
            if (hitbox) {
                const hRect = hitbox.getBoundingClientRect();
                const stillInside = (
                    e.clientX >= hRect.left &&
                    e.clientX <= hRect.right &&
                    e.clientY >= hRect.top &&
                    e.clientY <= hRect.bottom
                );
                if (!stillInside) {
                    ipcRenderer.send('disable-mouse-events');
                }
                // 如果还在里面，什么都不做，指针保持已打开状态即可
            } else {
                ipcRenderer.send('disable-mouse-events');
            }
        }
    });

    // ==================
    // 交互③: 气泡点击穿透隔离
    // ==================
    // 如果把鼠标放在气泡上，阻止透传，防止用户想复制文字但点到了桌面背后的东西
    const chatBubble = document.getElementById('chat-bubble');
    if (chatBubble) {
        chatBubble.addEventListener('mouseenter', () => ipcRenderer.send('enable-mouse-events'));
    }

    // ==================
    // 阶段三，任务整合: 设置面板与 AI 触发逻辑
    // ==================
    setupAISettingsAndTriggers();
}

// ==========================================
// 阶段3+4.5：AI 设置与触发器核心逻辑
// ==========================================
function setupAISettingsAndTriggers() {
    const settingsPanel = document.getElementById('settings-panel');
    const urlInput = document.getElementById('ai-url');
    const keyInput = document.getElementById('ai-key');
    const modelInput = document.getElementById('ai-model');
    const intervalInput = document.getElementById('setting-interval');
    const tokensInput = document.getElementById('setting-tokens');
    const memoryCheckbox = document.getElementById('setting-memory');
    const memoryCountInput = document.getElementById('setting-memory-count');
    const saveBtn = document.getElementById('save-settings-btn');

    // 外部定时器句柄
    let autoObserveTimer = null;

    // 1. 初始化读取配置
    urlInput.value = localStorage.getItem('pet_baseUrl') || 'https://api.siliconflow.cn/v1/chat/completions';
    keyInput.value = localStorage.getItem('pet_apiKey') || '';
    modelInput.value = localStorage.getItem('pet_modelName') || 'Qwen/Qwen2.5-VL-72B-Instruct';
    intervalInput.value = localStorage.getItem('pet_interval') || '60';
    tokensInput.value = localStorage.getItem('pet_tokens') || '50';
    if (memoryCheckbox) {
        memoryCheckbox.checked = localStorage.getItem('pet_memory') !== 'false';
    }
    if (memoryCountInput) {
        memoryCountInput.value = localStorage.getItem('pet_memoryCount') || '6';
        MAX_HISTORY = parseInt(memoryCountInput.value) || 6;
    }

    // 新增：初始化隐身模式复选框
    const stealthAutoCheckbox = document.getElementById('setting-stealth-auto');
    if (stealthAutoCheckbox) {
        stealthAutoCheckbox.checked = localStorage.getItem('pet_stealthAutoChat') === 'true';

        // 动态绑定 change 事件，实时响应勾选状态
        stealthAutoCheckbox.addEventListener('change', () => {
            const isStealth = stealthAutoCheckbox.checked;
            localStorage.setItem('pet_stealthAutoChat', isStealth ? 'true' : 'false');

            const autoMsgs = document.querySelectorAll('.history-msg.is-auto');
            autoMsgs.forEach(msg => {
                msg.style.display = isStealth ? 'none' : 'block';
            });

            console.log(`[Debug] 隐身模式已动态切换为: ${isStealth}`);
        });
    }

    // 新增：初始化灵魂配置
    const userNameInput = document.getElementById('setting-user-name');
    const systemPromptInput = document.getElementById('setting-system-prompt');
    if (userNameInput) {
        userNameInput.value = localStorage.getItem('pet_userName') || '前辈';
    }
    if (systemPromptInput) {
        systemPromptInput.value = localStorage.getItem('pet_systemPrompt') || '';
    }

    // 任务3（旧）：初始化模型路径输入框与文件夹选择按钮
    const modelPathInput = document.getElementById('model-path-input');
    const selectFolderBtn = document.getElementById('select-folder-btn');
    if (modelPathInput) {
        modelPathInput.value = localStorage.getItem('model-path') || '';
    }
    if (selectFolderBtn && modelPathInput) {
        selectFolderBtn.addEventListener('click', async () => {
            const folderPath = await ipcRenderer.invoke('select-folder');
            if (folderPath) {
                modelPathInput.value = folderPath;
            }
        });
    }

    // 任务1（新）：初始化 AI 称呼
    const nicknameInput = document.getElementById('ai-nickname');
    const chatPanelTitle = document.getElementById('chat-panel-title');
    if (nicknameInput) {
        nicknameInput.value = localStorage.getItem('pet_nickname') || '后辈';
    }
    if (chatPanelTitle) {
        chatPanelTitle.textContent = localStorage.getItem('pet_nickname') || '后辈';
    }

    // 测试 API 连通性
    const testApiBtn = document.getElementById('test-api-btn');
    const testApiResult = document.getElementById('test-api-result');
    if (testApiBtn && testApiResult) {
        testApiBtn.addEventListener('click', async () => {
            const tempUrl = urlInput.value.trim();
            const tempKey = keyInput.value.trim();
            const tempModel = modelInput.value.trim();

            if (!tempUrl || !tempKey || !tempModel) {
                testApiResult.style.color = '#ff6b6b';
                testApiResult.textContent = '❌ 请先填写参数';
                return;
            }

            testApiBtn.disabled = true;
            testApiResult.style.color = '#aee6c0';
            testApiResult.textContent = '⏳ 测试中...';

            try {
                // 修复 API 测试 URL
                const testUrl = tempUrl.endsWith('/chat/completions')
                    ? tempUrl
                    : (tempUrl.endsWith('/') ? tempUrl + 'chat/completions' : tempUrl + '/chat/completions');

                const response = await fetch(testUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${tempKey}`
                    },
                    body: JSON.stringify({
                        model: tempModel,
                        messages: [{ role: 'user', content: 'hello' }],
                        max_tokens: 10
                    })
                });

                if (response.ok) {
                    testApiResult.style.color = '#6ec6f5';
                    testApiResult.textContent = '🟢 连接成功！';
                } else {
                    const err = await response.json().catch(() => ({}));
                    testApiResult.style.color = '#ff6b6b';
                    testApiResult.textContent = '🔴 错误: ' + (err.error?.message || response.statusText || '未知接口错误');
                }
            } catch (err) {
                testApiResult.style.color = '#ff6b6b';
                testApiResult.textContent = '🔴 网络错误: ' + err.message;
            } finally {
                testApiBtn.disabled = false;
            }
        });
    }

    // 重置聊天窗口位置
    const resetChatPosBtn = document.getElementById('reset-chat-pos');
    if (resetChatPosBtn) {
        resetChatPosBtn.addEventListener('click', () => {
            localStorage.removeItem('chat-panel-left');
            localStorage.removeItem('chat-panel-top');
            const panel = document.getElementById('chat-history-panel');
            if (panel) {
                panel.style.left = '10px';
                panel.style.top = '';
                panel.style.bottom = '80px';
            }
            window.petActions.showChat('聊天窗口已归位！📌', 3000);
        });
    }

    // 任务2：图钉按钮切換
    const pinChatBtn = document.getElementById('pin-chat-btn');
    if (pinChatBtn) {
        pinChatBtn.addEventListener('click', () => {
            isChatPinned = !isChatPinned;
            pinChatBtn.classList.toggle('active', isChatPinned);
        });
    }

    // 任务3：设置面板头部拖拽
    (function initSettingsPanelDrag() {
        const panel = document.getElementById('settings-panel');
        const header = panel ? panel.querySelector('.settings-header') : null;
        if (!panel || !header) return;

        let dragging = false;
        let dragOffX = 0, dragOffY = 0;

        header.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            // 切换为 top/left 定位（不依赖 transform）
            const rect = panel.getBoundingClientRect();
            panel.style.top = rect.top + 'px';
            panel.style.left = rect.left + 'px';
            panel.style.right = 'auto';
            panel.style.transform = 'none';
            panel.style.transformOrigin = 'unset';
            dragging = true;
            dragOffX = e.clientX - rect.left;
            dragOffY = e.clientY - rect.top;
            header.style.cursor = 'grabbing';
            ipcRenderer.send('enable-mouse-events');
            e.preventDefault();
        });

        window.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            const maxLeft = 500 - panel.offsetWidth;
            const maxTop = 500 - panel.offsetHeight;
            const newLeft = Math.max(0, Math.min(maxLeft, e.clientX - dragOffX));
            const newTop = Math.max(0, Math.min(maxTop, e.clientY - dragOffY));
            panel.style.left = newLeft + 'px';
            panel.style.top = newTop + 'px';
        });

        window.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            header.style.cursor = 'move';
        });
    })();

    // 2. 右键唤醒配置面板 (必须只绑在 hitbox 身上)
    const hitbox = document.getElementById('hitbox');
    if (hitbox) {
        hitbox.addEventListener('contextmenu', (event) => {
            event.preventDefault(); // 阻止浏览器默认右键菜单
            console.log('[Debug] 右键被触发，准备打开设置');

            // 1. 强制清除拖拽状态
            if (typeof isDraggingModel !== 'undefined') {
                isDraggingModel = false;
            }

            // 2. 开启设置面板状态锁
            isSettingsOpen = true;

            // 3. 呼出设置面板
            const settingsPanel = document.querySelector('#settings-panel');
            if (settingsPanel) {
                settingsPanel.classList.add('show'); // 保持原有的展示 class 逻辑
                ipcRenderer.send('enable-mouse-events'); // 确保能点击输入框
            }

            // 4. 强制隐藏聊天面板 (避免遮挡)
            forceHideAllUI(); // 调用已封装的强隐函数

            console.log('[Debug] 设置面板状态已锁定：isSettingsOpen =', isSettingsOpen);
        });
    }

    // 防止点击面板里面时触发穿透或者关闭
    if (settingsPanel) {
        // [任务1修复] 阻止设置面板内部点击事件冒泡到底层，防止触发背景拖拽或失焦
        settingsPanel.addEventListener('mousedown', (e) => {
            e.stopPropagation();
        });
        settingsPanel.addEventListener('mouseenter', () => ipcRenderer.send('enable-mouse-events'));
    }

    // 右上角关闭按钮：仅隐藏，不保存任何数据
    const panelCloseBtn = document.getElementById('panel-close-btn');
    if (panelCloseBtn) {
        panelCloseBtn.addEventListener('click', () => {
            isSettingsOpen = false; // 解除全局 UI 冲突锁定
            console.log('[Debug] 设置面板已关闭(右上角)：isSettingsOpen =', isSettingsOpen);
            settingsPanel.classList.remove('show');
            // 注意：绝对不调用 localStorage.setItem，不重置定时器
        });
    }

    // 保存并关闭面板
    if (saveBtn) {
        saveBtn.addEventListener('click', () => {
            localStorage.setItem('pet_baseUrl', urlInput.value.trim());
            localStorage.setItem('pet_apiKey', keyInput.value.trim());
            localStorage.setItem('pet_modelName', modelInput.value.trim());
            localStorage.setItem('pet_interval', intervalInput.value.trim());
            localStorage.setItem('pet_tokens', tokensInput.value.trim());
            if (memoryCheckbox) {
                localStorage.setItem('pet_memory', memoryCheckbox.checked ? 'true' : 'false');
            }
            if (memoryCountInput) {
                localStorage.setItem('pet_memoryCount', memoryCountInput.value.trim());
                MAX_HISTORY = parseInt(memoryCountInput.value) || 6;
                if (MAX_HISTORY < 2) MAX_HISTORY = 2;
                if (MAX_HISTORY > 30) MAX_HISTORY = 30;
            }

            // 保存 AI 称呼并同步更新标题
            if (nicknameInput) {
                const newNickname = nicknameInput.value.trim() || '后辈';
                localStorage.setItem('pet_nickname', newNickname);
                if (chatPanelTitle) chatPanelTitle.textContent = newNickname;
            }

            // 保存隐身模式（仅保底写库，显隐逻辑已独立）
            if (stealthAutoCheckbox) {
                localStorage.setItem('pet_stealthAutoChat', stealthAutoCheckbox.checked ? 'true' : 'false');
            }

            // 保存灵魂配置
            if (userNameInput) {
                localStorage.setItem('pet_userName', userNameInput.value.trim());
            }
            if (systemPromptInput) {
                localStorage.setItem('pet_systemPrompt', systemPromptInput.value.trim());
            }

            // 任务3（旧）：保存模型路径，并在路径变化时提示重启
            if (modelPathInput) {
                const oldModelPath = localStorage.getItem('model-path') || '';
                const newModelPath = modelPathInput.value.trim();
                localStorage.setItem('model-path', newModelPath);
                if (newModelPath !== oldModelPath) {
                    isSettingsOpen = false; // 解除锁定
                    settingsPanel.classList.remove('show');
                    window.petActions.showChat('模型路径已更新，请重启桌宠以加载新模型 ♻️', 6000);
                    resetTimer();
                    return;
                }
            }

            isSettingsOpen = false; // 解除锁定
            console.log('[Debug] 设置面板已关闭(保存按钮)：isSettingsOpen =', isSettingsOpen);
            settingsPanel.classList.remove('show');
            window.petActions.showChat("设置已保存！✨", 3000);

            // 重新发送 API Key 到主进程
            ipcRenderer.send('update-api-key', localStorage.getItem('pet_apiKey') || '');

            resetTimer();
        });
    }

    // 3. 双击触发与自动轮询核心：截图 -> AI 分析
    // 使用全局锁变量防止重复执行（不论双击还是定时器）
    let isProcessingAI = false;

    const executeAISequence = async () => {
        if (isProcessingAI) return;

        const apiKey = localStorage.getItem('pet_apiKey');
        // 没配 key 的话保持安静，不报错打扰用户
        if (!apiKey) return;

        isProcessingAI = true;

        // 【任务2：随机文案】
        const waitTexts = [
            "盯——",
            "让我看看你在干什么坏事...",
            "正在扫描屏幕元素...",
            "CPU高速运转中...",
            "哼，我倒要看看屏幕上有什么好玩的！"
        ];
        const randomWaitText = waitTexts[Math.floor(Math.random() * waitTexts.length)];

        window.petActions.showChat(randomWaitText, 0); // 0表示停留，直到被后续结果覆盖

        try {
            // 截图
            const base64Data = await ipcRenderer.invoke('capture-screen');
            if (!base64Data) {
                throw new Error("未能获取到屏幕截图");
            }

            // 截图完的思考状态（也可随机，这里保持简单）
            window.petActions.showChat("看清楚啦，正在思考怎么吐槽...", 0);

            // 请求 AI（自动巡检，isAuto=true 不记入历史面板）
            await askAI(base64Data, null, true);

        } catch (err) {
            console.error("AI 视觉链路失败:", err);
            window.petActions.showChat("糟糕，眼睛有点花，或者网络不通畅...", 4000);
        } finally {
            // 释放锁
            isProcessingAI = false;
        }
    };

    // 手动双击依然可以立即触发：绑在 hitbox 上
    if (hitbox) {
        hitbox.addEventListener('dblclick', async (e) => {
            // 双击专有提示（可选）：如果没配key，弹个特例气泡
            const apiKey = localStorage.getItem('pet_apiKey');
            if (!apiKey) {
                window.petActions.showChat("请先右键桌面配置我的 API Key 才能聊天哦！", 4000);
                return;
            }
            executeAISequence();
        });
    }

    // 辅助函数：根据用户的设定时间重置或者启动定时器
    const resetTimer = () => {
        if (autoObserveTimer) {
            clearInterval(autoObserveTimer);
        }

        let userInterval = parseInt(localStorage.getItem('pet_interval')) || 60;
        if (userInterval < 10) userInterval = 10; // 保底限制最快 10 秒

        autoObserveTimer = setInterval(() => {
            executeAISequence();
        }, userInterval * 1000); // 换算成毫秒
    };

    // 第一次启动
    resetTimer();
}

/**
 * 封装原生 Fetch 请求 AI Vision 接口（支持记忆增强）
 * @param {string} base64Image "data:image/jpeg;base64,..." 格式的截图
 * @param {string} [userText] 用户手动输入的文字（可选，不传则使用默认吐槽提示词）
 */
/**
 * @param {string|null} base64Image  截图 base64（可为 null）
 * @param {string|null} userText     用户输入文字（null 则用默认吐槽词）
 * @param {boolean}     isAuto       true=自动巡检，不渲染到历史面板
 */
async function askAI(base64Image, userText = null, isAuto = false) {
    const baseUrl = localStorage.getItem('pet_baseUrl') || 'https://api.siliconflow.cn/v1/chat/completions';
    const apiKey = localStorage.getItem('pet_apiKey') || '';
    const modelName = localStorage.getItem('pet_modelName') || 'Qwen/Qwen2.5-VL-72B-Instruct';
    const maxTokens = parseInt(localStorage.getItem('pet_tokens')) || 50;
    const memoryEnabled = localStorage.getItem('pet_memory') !== 'false';

    const defaultPrompt = "你现在是一个傲娇可爱的桌面二次元宠物。请用简短的中文（不超过30个字）吐槽或描述一下你现在在我的电脑屏幕上看到了什么。";
    const currentPrompt = userText || defaultPrompt;

    // ==========================================
    // 组装 messages 数组（含滑动窗口记忆）
    // ==========================================
    const messages = [];

    // 系统人设（读取用户自定义，否则使用默认）
    const customSystemPrompt = localStorage.getItem('pet_systemPrompt') || '';
    const customUserName = localStorage.getItem('pet_userName') || '';
    let systemContent = customSystemPrompt || '你是一个傲娇可爱的桌面二次元宠物。请用简短的中文回复，风格活泼俏皮。';
    if (customUserName) {
        systemContent += `\n请称呼用户为「${customUserName}」。`;
    }
    messages.push({
        role: "system",
        content: systemContent
    });

    // 注入纯文本历史记忆（绝对不包含 Base64 截图，防止请求爆炸）
    if (memoryEnabled && chatHistory.length > 0) {
        const recentHistory = chatHistory.slice(-MAX_HISTORY);
        for (const entry of recentHistory) {
            messages.push({ role: entry.role, content: entry.content });
        }
    }

    // 当前这一轮的用户消息：多模态（文字 + 截图）
    const currentUserContent = [];
    currentUserContent.push({ type: "text", text: currentPrompt });
    if (base64Image) {
        currentUserContent.push({ type: "image_url", image_url: { url: base64Image } });
    }
    messages.push({ role: "user", content: currentUserContent });

    // 组装 Payload
    const payload = {
        model: modelName,
        messages: messages,
        max_tokens: maxTokens,
        temperature: 0.7
    };

    const response = await fetch(baseUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`API 请求失败: ${response.status} ${errText}`);
    }

    const data = await response.json();
    const reply = data.choices[0].message.content;

    // 记忆归档（始终写入，保持 AI 上下文完整）
    chatHistory.push({ role: 'user', content: currentPrompt });
    chatHistory.push({ role: 'assistant', content: reply });
    // [重要更正] 始终渲染到 UI，由 CSS 逻辑决定是否显现
    updateChatHistoryUI('user', currentPrompt, isAuto);
    updateChatHistoryUI('assistant', reply, isAuto);
    // 滑动窗口裁剪
    if (chatHistory.length > MAX_HISTORY * 2) {
        chatHistory = chatHistory.slice(-MAX_HISTORY);
    }

    // 把回答打在气泡上
    window.petActions.showChat(reply, 8000);
}

/**
 * 动态渲染历史聊天记录面板
 */
function updateChatHistoryUI(role, content, isAuto = false) {
    // 【核心修复】：如果是自动触发的轮询，它的 Prompt（发给 AI 的内置提示词）
    // 永远不应该出现在 UI 聊天记录里让用户看到，因此直接物理拦截。
    if (isAuto && role === 'user') return;

    const panel = document.getElementById('chat-messages-area');
    if (!panel) return;

    const bubble = document.createElement('div');
    bubble.className = `history-msg ${role}`;
    if (isAuto) {
        bubble.classList.add('is-auto');
        // 根据当前的设置决定初始显隐状态
        const stealthMode = localStorage.getItem('pet_stealthAutoChat') === 'true';
        if (stealthMode) {
            bubble.style.display = 'none';
        }
    }
    bubble.textContent = content;
    panel.appendChild(bubble);

    // 最多保留 30 个可见气泡
    while (panel.children.length > 30) {
        panel.removeChild(panel.firstChild);
    }

    // 强制滚动到底部
    panel.scrollTop = panel.scrollHeight;
}

// ==========================================
// 外部 API 暴露 (供后续主进程通信、AI 回调调用)
// ==========================================
window.petActions = {
    chatTimeout: null,

    /**
     * 显示聊天气泡
     * @param {string} text 显示的内容
     * @param {number} durationMs 显示时长，超时自动隐藏。若设为 0，则永久显示直至下一次调用。
     */
    showChat: function (text, durationMs = 5000) {
        const bubble = document.getElementById('chat-bubble');
        if (!bubble) return;

        // 更新文字
        bubble.innerText = text;

        // 增加 .show CSS class 以触发淡入显示动画
        bubble.classList.add('show');

        // 若之前有正在计时的销毁任务，先清除
        if (this.chatTimeout) {
            clearTimeout(this.chatTimeout);
            this.chatTimeout = null;
        }

        // 设置自动淡出隐藏
        if (durationMs > 0) {
            this.chatTimeout = setTimeout(() => {
                this.hideChat();
            }, durationMs);
        }
    },

    /**
     * 隐藏聊天气泡
     */
    hideChat: function () {
        const bubble = document.getElementById('chat-bubble');
        if (bubble) {
            bubble.classList.remove('show');
        }
    },

    /**
     * 阶段三测试：请求截屏并播报反馈
     */
    testCapture: async function () {
        try {
            console.log("正在呼叫主进程截屏...");
            const base64Data = await ipcRenderer.invoke('capture-screen');

            if (base64Data) {
                // 不刷屏，仅截取 Base64 的开头 50 个字符和打印总长度
                console.log(`✅ 截屏成功！收到数据: ${base64Data.substring(0, 50)}...`);
                console.log(`📦 总数据大小: ${base64Data.length} 字节`);

                // 叫桌宠开口说话
                this.showChat(`咔嚓！我已经拍下你的屏幕啦，图像大小是 ${base64Data.length} 字节！`, 5000);
            } else {
                console.error("❌ 截屏返回空数据！");
                this.showChat("唔... 没能拍到屏幕呢", 3000);
            }
        } catch (err) {
            console.error("调用截屏接口失败:", err);
            this.showChat("拍照功能出故障了...", 3000);
        }
    }
};

document.addEventListener('DOMContentLoaded', init);