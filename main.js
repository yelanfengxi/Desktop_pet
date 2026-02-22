const { app, BrowserWindow, ipcMain, desktopCapturer, Tray, Menu, nativeImage, dialog } = require('electron');
const path = require('path');
const zlib = require('zlib');

let petWindow = null;
let tray = null; // 全局引用，防止被垃圾回收器吴嘺掉
let isMousePenetrating = false; // 全局穿透强制状态

function createPetWindow() {
    petWindow = new BrowserWindow({
        width: 500,
        height: 500,
        minWidth: 500,
        minHeight: 500,
        maxWidth: 500,
        maxHeight: 500,
        transparent: true,
        frame: false,
        alwaysOnTop: true,
        resizable: false,
        skipTaskbar: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            enableRemoteModule: true
        }
    });

    petWindow.loadFile(path.join(__dirname, 'src/renderer/pet/index.html'));

    // 默认不自动开启调试工具，由托盘菜单自己决定
    // petWindow.webContents.openDevTools({ mode: 'detach' });

    petWindow.on('closed', () => {
        petWindow = null;
    });

    petWindow.setIgnoreMouseEvents(true, { forward: true });

    ipcMain.on('enable-mouse-events', () => {
        // 如果用户在托盘强制开启了穿透，那么忽略前端的防抖恢复请求
        if (isMousePenetrating) return;
        petWindow.setIgnoreMouseEvents(false);
    });

    ipcMain.on('disable-mouse-events', () => {
        petWindow.setIgnoreMouseEvents(true, { forward: true });
    });

    ipcMain.on('window-move', (event, deltaX, deltaY) => {
        if (!petWindow) {
            console.warn('无法移动窗口：petWindow 实例已不存在');
            return;
        }

        if (typeof deltaX !== 'number' || typeof deltaY !== 'number') {
            console.error('窗口移动参数错误：deltaX 和 deltaY 必须是数字');
            return;
        }

        const maxMoveDistance = 100;
        if (Math.abs(deltaX) > maxMoveDistance || Math.abs(deltaY) > maxMoveDistance) {
            console.warn('窗口移动距离过大，已限制单次移动范围');
            deltaX = Math.max(-maxMoveDistance, Math.min(maxMoveDistance, deltaX));
            deltaY = Math.max(-maxMoveDistance, Math.min(maxMoveDistance, deltaY));
        }

        try {
            const bounds = petWindow.getBounds();
            const newX = bounds.x + deltaX;
            const newY = bounds.y + deltaY;
            // 修复 Windows 缩放比例下拖拽会导致窗口越来越大的 Bug
            // 强制将宽和高锁死在目前的固定尺寸(500x500)
            petWindow.setBounds({
                x: newX,
                y: newY,
                width: 500,
                height: 500
            });
        } catch (error) {
            console.error('移动窗口时出错:', error);
        }
    });

    // ==========================================
    // 阶段三功能：主进程截屏服务
    // ==========================================
    ipcMain.handle('capture-screen', async (event) => {
        try {
            // 获取当前桌面的画面源（支持多显示器，这里取默认第一个/主屏幕）
            // 注意：thumbnailSize 决定了截图的分辨率质量
            const sources = await desktopCapturer.getSources({
                types: ['screen'],
                thumbnailSize: { width: 1920, height: 1080 }
            });

            if (sources && sources.length > 0) {
                // 获取主屏幕的 NativeImage 对象
                const mainScreen = sources[0];
                // 修复 400 Bad Request: 绝对不能扔长宽几千像素的纯 PNG，必须压缩宽高与为 JPEG！
                const img = mainScreen.thumbnail.resize({ width: 1024 });
                const base64Image = `data:image/jpeg;base64,${img.toJPEG(80).toString('base64')}`;
                return base64Image;
            } else {
                throw new Error("未能获取到任何屏幕源");
            }
        } catch (err) {
            console.error("截屏失败:", err);
            return null;
        }
    });

    // ==========================================
    // 任务3：文件夹选择 IPC 处理器
    // ==========================================
    ipcMain.handle('select-folder', async () => {
        const result = await dialog.showOpenDialog(petWindow, {
            title: '选择 Live2D 模型文件夹',
            properties: ['openDirectory']
        });
        return result.canceled ? null : result.filePaths[0];
    });
}

app.whenReady().then(() => {
    createPetWindow();

    // ==============================================
    // 系统托盘图标与菜单
    // ==============================================

    // 纯代码生成一个 32x32 淡蓝色圆形透明 PNG，无任何外部依赖
    function makeCirclePNG() {
        const SIZE = 32;
        const R = SIZE / 2 - 2;
        const CX = SIZE / 2 - 0.5;
        const CY = SIZE / 2 - 0.5;

        // 生成 RGBA 扐描行（每行先一个 0x00 过滤类型字节）
        const rows = [];
        for (let y = 0; y < SIZE; y++) {
            const row = [0]; // filter = None
            for (let x = 0; x < SIZE; x++) {
                const dist = Math.hypot(x - CX, y - CY);
                if (dist <= R) {
                    const t = Math.max(0, 1 - dist / R) * 0.4;
                    row.push(
                        Math.min(255, (100 + t * 155) | 0), // R
                        Math.min(255, (185 + t * 70) | 0),  // G
                        245,                                  // B 始终亮蓝
                        255                                   // A 完全不透明
                    );
                } else {
                    row.push(0, 0, 0, 0); // 完全透明
                }
            }
            rows.push(Buffer.from(row));
        }

        // CRC32 实现
        const crcTable = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            crcTable[n] = c;
        }
        function crc32(buf) {
            let c = 0xffffffff;
            for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
            return (c ^ 0xffffffff) >>> 0;
        }

        function chunk(type, data) {
            const t = Buffer.from(type, 'ascii');
            const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
            const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
            return Buffer.concat([len, t, data, crc]);
        }

        const ihdr = Buffer.alloc(13);
        ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
        ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA

        const idat = zlib.deflateSync(Buffer.concat(rows));

        const png = Buffer.concat([
            Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG 文件头
            chunk('IHDR', ihdr),
            chunk('IDAT', idat),
            chunk('IEND', Buffer.alloc(0))
        ]);

        return nativeImage.createFromBuffer(png);
    }

    tray = new Tray(makeCirclePNG());
    tray.setToolTip('Live2D 桌宠');

    const buildMenu = () => Menu.buildFromTemplate([
        {
            label: '开启鼠标穿透',
            type: 'checkbox',
            checked: isMousePenetrating,
            click: (item) => {
                isMousePenetrating = item.checked;
                // 立刻应用到底层窗口
                if (petWindow) {
                    petWindow.setIgnoreMouseEvents(isMousePenetrating, { forward: true });
                    petWindow.webContents.send('mouse-passthrough-changed', isMousePenetrating);
                }
            }
        },
        { type: 'separator' },
        {
            label: '显示桌宠',
            click: () => { if (petWindow) petWindow.show(); }
        },
        {
            label: '隐藏桌宠',
            click: () => { if (petWindow) petWindow.hide(); }
        },
        {
            label: '切换开发者工具',
            click: () => {
                if (!petWindow) return;
                if (petWindow.webContents.isDevToolsOpened()) {
                    petWindow.webContents.closeDevTools();
                } else {
                    petWindow.webContents.openDevTools({ mode: 'detach' });
                }
            }
        },
        { type: 'separator' },
        {
            label: '退出程序',
            click: () => app.quit()
        }
    ]);

    tray.setContextMenu(buildMenu());
    tray.on('click', () => tray.popUpContextMenu());

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createPetWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
