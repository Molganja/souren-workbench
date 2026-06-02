import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const APP_DIR = path.resolve(import.meta.dirname, '..');
const ROOT_DIR = path.resolve(APP_DIR, '..');
const VERIFY_ROOT = path.join(ROOT_DIR, '.tmp-verify');
const PORT = 5186;
const BASE = `http://127.0.0.1:${PORT}/api`;
const STRICT_GITHUB = process.argv.includes('--strict-github');

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: APP_DIR,
      env: { ...process.env, ...(options.env || {}) },
      stdio: 'inherit'
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited ${code}`));
    });
    child.on('error', reject);
  });
}

async function api(pathname, options = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${pathname}: ${data?.error || res.status}`);
  return data;
}

async function waitForServer(child) {
  for (let i = 0; i < 40; i += 1) {
    if (child.exitCode !== null) throw new Error('verify server exited early');
    try {
      await api('/health');
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error('verify server did not start');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function gitOutput(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT_DIR, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function verifyGitHubSync() {
  const remote = gitOutput(['remote', 'get-url', 'origin']);
  if (!remote) {
    const message = 'WARN 远端代码仓库未配置';
    if (STRICT_GITHUB) throw new Error(message);
    console.log(message);
    return;
  }
  const local = gitOutput(['rev-parse', 'HEAD']);
  const remoteHead = gitOutput(['ls-remote', '--heads', 'origin', 'main']).split(/\s+/)[0] || '';
  if (local && remoteHead && local === remoteHead) {
    console.log(`OK 远端主分支已同步 ${local.slice(0, 7)}`);
    return;
  }
  const message = `WARN 远端主分支未同步，本地 ${local.slice(0, 7) || 'unknown'}，远端 ${remoteHead.slice(0, 7) || 'unknown'}；当前 shell 缺少写权限时需要手动认证后上传。`;
  if (STRICT_GITHUB) throw new Error(message);
  console.log(message);
}

async function verifyRuntime() {
  fs.rmSync(VERIFY_ROOT, { recursive: true, force: true });
  fs.mkdirSync(VERIFY_ROOT, { recursive: true });
  const env = { ...process.env, PORT: String(PORT), SOUREN_ROOT_DIR: VERIFY_ROOT };
  env.SOUREN_GITHUB_SYNC_CHECK_DISABLED = '1';
  const child = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
    cwd: APP_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  try {
    await waitForServer(child);
    const health = await api('/health');
    assert(health.ok === true, 'health not ok');
    assert(health.readiness?.total >= 8, 'health readiness summary missing');
    const readiness = await api('/readiness');
    assert(readiness.summary.ready >= 7, 'readiness ready count too low');
    assert(readiness.checks.some((item) => item.key === 'viral-analysis' && item.status === 'ready'), 'viral analysis readiness missing');
    const hiddenReadinessKeys = ['local' + '-ai', 'll' + 'm-copy', 'github' + '-sync', 'operator' + '-packet'];
    assert(!readiness.checks.some((item) => hiddenReadinessKeys.includes(item.key)), 'readiness exposed removed checks');
    console.log('OK runtime health/readiness verified');
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.rmSync(VERIFY_ROOT, { recursive: true, force: true });
  }
}

async function main() {
  await run('npm', ['run', 'doctor']);
  await run('npm', ['run', 'collect:douyin:self-test']);
  await run('npm', ['run', 'check']);
  await run('npm', ['run', 'client:check']);
  await run('npm', ['run', 'test:e2e']);
  await verifyRuntime();
  if (STRICT_GITHUB) verifyGitHubSync();
  console.log('VERIFY PASS');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
