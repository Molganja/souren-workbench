import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const APP_DIR = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
const productName = pkg.build?.productName || '素人种草运营工作台';
const packageDir = process.arch === 'arm64' ? 'mac-arm64' : 'mac';
const appExe = path.join(APP_DIR, 'release', packageDir, `${productName}.app`, 'Contents', 'MacOS', productName);
const port = Number(process.env.PACKAGE_SMOKE_PORT || (5196 + (process.pid % 300)));
const baseUrl = `http://127.0.0.1:${port}`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(pathname) {
  const res = await fetch(`${baseUrl}${pathname}`);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${pathname}: ${data?.error || res.status}`);
  return data;
}

async function portIsBusy() {
  try {
    await readJson('/api/health');
    return true;
  } catch {
    return false;
  }
}

async function waitForHealth(child, logLines) {
  for (let i = 0; i < 80; i += 1) {
    if (child.exitCode !== null) {
      throw new Error(`客户端提前退出，日志：\n${logLines.slice(-20).join('')}`);
    }
    try {
      return await readJson('/api/health');
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`客户端未在 ${baseUrl} 启动，日志：\n${logLines.slice(-20).join('')}`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 1200);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function main() {
  if (process.platform !== 'darwin') {
    console.log('SKIP 客户端包启动烟测只在 macOS 运行');
    return;
  }
  assert(fs.existsSync(appExe), `缺少打包后的客户端，请先运行 npm run client:mac\n${appExe}`);
  assert(!(await portIsBusy()), `端口 ${port} 已被占用，请设置 PACKAGE_SMOKE_PORT 换一个端口`);

  const logLines = [];
  const child = spawn(appExe, [], {
    env: { ...process.env, PORT: String(port), SOUREN_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => logLines.push(String(chunk)));
  child.stderr.on('data', (chunk) => logLines.push(String(chunk)));

  try {
    const health = await waitForHealth(child, logLines);
    assert(health.ok === true, '客户端内置后端 health 未通过');
    assert(health.network?.port === port, '客户端未使用烟测端口启动');
    assert(String(health.rootDir || '').includes('Application Support'), '客户端没有使用 macOS 应用数据目录');
    assert(String(health.rootDir || '').includes('工作数据'), '客户端没有创建独立工作数据目录');
    assert(String(health.materialRoot || '').startsWith(String(health.rootDir)), '客户端素材目录不在工作数据目录内');
    assert(health.readiness?.total >= 8, '客户端 readiness 信息不完整');
    console.log(`OK 客户端包可启动 ${baseUrl}`);
    console.log(`OK 客户端工作数据目录 ${health.rootDir}`);
  } finally {
    await stop(child);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
