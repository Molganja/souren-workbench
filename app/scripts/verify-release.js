import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const APP_DIR = path.resolve(import.meta.dirname, '..');
const ROOT_DIR = path.resolve(APP_DIR, '..');
const VERIFY_ROOT = path.join(ROOT_DIR, '.tmp-verify');
const PORT = 5186;
const BASE = `http://127.0.0.1:${PORT}/api`;
const WITH_CONSULT = process.argv.includes('--consult');

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

async function verifyRuntime() {
  fs.rmSync(VERIFY_ROOT, { recursive: true, force: true });
  fs.mkdirSync(VERIFY_ROOT, { recursive: true });
  const env = { ...process.env, PORT: String(PORT), SOUREN_ROOT_DIR: VERIFY_ROOT };
  if (!WITH_CONSULT) env.SOUREN_LOCAL_AI_DISABLED = '1';
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
    assert(health.readiness?.total >= 10, 'health readiness summary missing');
    const readiness = await api('/readiness');
    assert(readiness.summary.ready >= 8, 'readiness ready count too low');
    assert(readiness.checks.some((item) => item.key === 'operator-packet' && item.status === 'ready'), 'operator packet readiness missing');
    if (WITH_CONSULT) {
      const consult = await api('/dashboard/ai-consult', { method: 'POST' });
      assert(['completed', 'unavailable', 'timeout', 'error'].includes(consult.status), 'AI consult status invalid');
      assert(consult.consultPath && fs.existsSync(consult.consultPath), 'AI consult record missing');
      assert(consult.packetPath && fs.existsSync(consult.packetPath), 'AI consult packet missing');
      console.log(`OK local AI consult attempted: ${consult.status}`);
    }
    console.log('OK runtime health/readiness verified');
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.rmSync(VERIFY_ROOT, { recursive: true, force: true });
  }
}

async function main() {
  await run('npm', ['run', 'doctor']);
  await run('npm', ['run', 'check']);
  await run('npm', ['run', 'test:e2e']);
  await verifyRuntime();
  console.log(WITH_CONSULT ? 'VERIFY CONSULT PASS' : 'VERIFY PASS');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
