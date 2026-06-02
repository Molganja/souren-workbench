const { app, BrowserWindow, Menu, dialog } = require('electron');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PORT = Number(process.env.PORT || 5174);
const BASE_URL = `http://127.0.0.1:${PORT}`;
let mainWindow = null;
let embeddedServerStarted = false;

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
  process.env.PORT = String(PORT);
  process.env.SOUREN_ROOT_DIR = rootDir();
  process.env.SOUREN_DESKTOP = '1';
  process.chdir(appDir());
  const serverUrl = pathToFileURL(path.join(appDir(), 'server', 'index.js')).href;
  await import(serverUrl);
  embeddedServerStarted = true;
  if (!(await waitForServer())) {
    throw new Error('本地服务启动超时，请重新打开客户端，或先运行“启动素人工作台.command”。');
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
  if (embeddedServerStarted) console.log('本地服务随客户端退出。');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
