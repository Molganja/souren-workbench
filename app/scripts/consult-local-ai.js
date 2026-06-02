import { spawn } from 'node:child_process';

const APP_DIR = new URL('..', import.meta.url).pathname;
const PORT = Number(process.env.PORT || 5174);
const BASE = `http://127.0.0.1:${PORT}/api`;

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
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error('local server exited early');
    try {
      await api('/health');
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error('local server did not start');
}

async function ensureServer() {
  try {
    await api('/health');
    return null;
  } catch {
    const child = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
      cwd: APP_DIR,
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', (chunk) => process.stdout.write(chunk));
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    await waitForServer(child);
    return child;
  }
}

async function main() {
  const child = await ensureServer();
  try {
    const result = await api('/dashboard/ai-consult', { method: 'POST' });
    console.log(`assistant consult status: ${result.status}`);
    console.log(`Packet: ${result.packetPath}`);
    console.log(`Record: ${result.consultPath}`);
    if (result.command) console.log(`Command: ${result.command}`);
    if (result.stdout?.trim()) {
      console.log('\n--- stdout ---');
      console.log(result.stdout.trim());
    }
    if (result.stderr?.trim()) {
      console.log('\n--- stderr ---');
      console.log(result.stderr.trim());
    }
  } finally {
    if (child) {
      child.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
