import fs from 'node:fs';
import path from 'node:path';

const APP_DIR = path.resolve(import.meta.dirname, '..');
const ROOT_DIR = path.resolve(APP_DIR, '..');
const pkgPath = path.join(APP_DIR, 'package.json');
const electronMain = path.join(APP_DIR, 'electron', 'main.cjs');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

function ok(message) {
  console.log(`OK ${message}`);
}

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
}

if (pkg.main === 'electron/main.cjs') ok('Electron 入口已配置');
else fail('package.json main 未指向 electron/main.cjs');

if (fs.existsSync(electronMain)) ok(`存在 ${path.relative(ROOT_DIR, electronMain)}`);
else fail('缺少 Electron 主进程文件');

if (pkg.scripts?.client && pkg.scripts?.['client:mac']) ok('客户端启动和 Mac 打包脚本已配置');
else fail('缺少 client / client:mac 脚本');

if (pkg.devDependencies?.electron && pkg.devDependencies?.['electron-builder']) ok('Electron 依赖已安装');
else fail('缺少 Electron 或 electron-builder 依赖');

if (pkg.build?.asar === false) ok('客户端包关闭 asar，Electron 内置 Node 可读取后端文件');
else fail('Electron build.asar 应为 false');

const files = pkg.build?.files || [];
if (files.includes('!.env')) ok('客户端打包排除真实 .env');
else fail('客户端打包未显式排除真实 .env');

if (files.includes('dist/**/*') && files.includes('server/**/*') && files.includes('electron/**/*')) ok('客户端打包包含前端、后端和桌面壳');
else fail('客户端打包文件范围不完整');

const electronMainText = fs.readFileSync(electronMain, 'utf8');
if (electronMainText.includes('import(serverUrl)') && electronMainText.includes('pathToFileURL')) ok('桌面端使用 Electron 内置 Node 启动后端');
else fail('桌面端未使用 Electron 内置 Node 启动后端');

if (!electronMainText.includes('SOUREN_NODE_BIN')) ok('桌面端不依赖外部 node 命令');
else fail('桌面端仍依赖外部 node 命令');

const electronCli = path.join(APP_DIR, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
const electronPackage = path.join(APP_DIR, 'node_modules', 'electron', 'package.json');
if (fs.existsSync(electronCli) && fs.existsSync(electronPackage)) ok('Electron 本地安装文件可用');
else fail('Electron 本地安装文件缺失，请重新运行 npm install');

if (process.exitCode) process.exit(process.exitCode);
