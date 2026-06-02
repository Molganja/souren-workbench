const { app, BrowserWindow, Menu, dialog } = require('electron');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const PORT = Number(process.env.PORT || 5174);
const BASE_URL = `http://127.0.0.1:${PORT}`;
let serverProcess = null;
let mainWindow = null;

function appDir() {
  return app.isPackaged ? app.getAppPath() : path.resolve(__dirname, '..');
}

function rootDir() {
  return app.isPackaged ? path.join(app.getPath('userData'), '工作数据') : path.resolve(appDir(), '..');
}

function healthCheck() {
  return new Promise((resolve) => {
    const req = http.get(`${BASE_URL}/api/health`, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 300);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(800, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForServer() {
  for (let i = 0; i < 50; i += 1) {
    if (await healthCheck()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function ensureServer() {
  if (await healthCheck()) return;
  const nodeBin = process.env.SOUREN_NODE_BIN || 'node';
  serverProcess = spawn(nodeBin, ['--no-warnings', 'server/index.js'], {
    cwd: appDir(),
    env: {
      ...process.env,
      PORT: String(PORT),
      SOUREN_ROOT_DIR: rootDir(),
      SOUREN_DESKTOP: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProcess.stdout.on('data', (chunk) => process.stdout.write(chunk));
  serverProcess.stderr.on('data', (chunk) => process.stderr.write(chunk));
  serverProcess.on('error', (error) => {
    dialog.showErrorBox('启动失败', `无法启动本地服务：${error.message}\n\n请确认已经安装 Node.js 24+。`);
  });
  if (!(await waitForServer())) {
    throw new Error('本地服务启动超时，请确认 Node.js 24+ 可用，或先运行“启动素人工作台.command”。');
  }
}

async function createWindow() {
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1100,
    minHeight: 720,
    title: '素人种草运营工作台',
    backgroundColor: '#f6f7f8',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  await mainWindow.loadURL(BASE_URL);
}

app.whenReady().then(async () => {
  try {
    await ensureServer();
    await createWindow();
  } catch (error) {
    dialog.showErrorBox('素人工作台启动失败', error.message);
    app.quit();
  }
});

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    await createWindow();
  }
});

app.on('before-quit', () => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill('SIGTERM');
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
