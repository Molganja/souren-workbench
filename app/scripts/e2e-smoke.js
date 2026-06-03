import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';

const TEST_PORT = 5184;
const TEST_IMAGE_APP_PORT = 5188;
const TEST_IMAGE_PORT = 5189;
const TEST_AUTH_PORT = 5190;
const TEST_LAN_FAIL_PORT = 5191;
const TEST_IMAGE_KEY_ONLY_PORT = 5192;
const TEST_PLACEHOLDER_PORT = 5193;
const TEST_LAN_CONFIG_PORT = 5194;
const ORIGIN = `http://127.0.0.1:${TEST_PORT}`;
const BASE = `${ORIGIN}/api`;
const E2E_SETUP_HEADER = { 'X-Souren-E2E-Setup': '1' };
const APP_DIR = path.resolve(import.meta.dirname, '..');
const REAL_ROOT_DIR = path.resolve(APP_DIR, '..');
const ROOT_DIR = path.join(REAL_ROOT_DIR, '.tmp-e2e');
const IMAGE_ROOT_DIR = path.join(REAL_ROOT_DIR, '.tmp-e2e-image');
const IMAGE_KEY_ONLY_ROOT_DIR = path.join(REAL_ROOT_DIR, '.tmp-e2e-image-key-only');
const AUTH_ROOT_DIR = path.join(REAL_ROOT_DIR, '.tmp-e2e-auth');
const LAN_FAIL_ROOT_DIR = path.join(REAL_ROOT_DIR, '.tmp-e2e-lan-fail');
const PLACEHOLDER_ROOT_DIR = path.join(REAL_ROOT_DIR, '.tmp-e2e-placeholder');
const LAN_CONFIG_ROOT_DIR = path.join(REAL_ROOT_DIR, '.tmp-e2e-lan-config');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function localDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function api(pathname, options = {}, base = BASE) {
  const res = await fetch(`${base}${pathname}`, {
    headers: { 'Content-Type': 'application/json', ...E2E_SETUP_HEADER, ...(options.headers || {}) },
    ...options
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${pathname}: ${data?.error || res.status}`);
  return data;
}

function caseDeleteConfirmText(caze = {}) {
  return `删除 ${caze.weixinNick || caze.caseCode || '这个案例'}`;
}

async function deleteCase(caze, base = BASE) {
  return api(`/cases/${caze.id}`, {
    method: 'DELETE',
    body: JSON.stringify({ confirmText: caseDeleteConfirmText(caze) })
  }, base);
}

function deliveryMediaStepKey(file) {
  return `media:${file.path || file.url || file.name}`;
}

function handoffDoneForDeliveryView(view) {
  const texts = view.texts || {};
  const keys = ['recipient'];
  if (view.shouldSendFreelancerGuide && texts.freelancerGuide) keys.push('guide');
  if (texts.operatorInstruction) keys.push('operator');
  if (texts.publishText) keys.push('publish');
  if (view.isVideo && texts.voiceover) keys.push('voiceover');
  if (view.isVideo && texts.editBrief) keys.push('editBrief');
  (view.mediaFiles || []).forEach((file) => keys.push(deliveryMediaStepKey(file)));
  return keys;
}

async function waitForServer(child, base = BASE) {
  for (let i = 0; i < 40; i += 1) {
    if (child.exitCode !== null) throw new Error('server exited early');
    try {
      await api('/health', {}, base);
      return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error('server did not start');
}

async function imageGenerationSmoke() {
  fs.rmSync(path.join(IMAGE_ROOT_DIR, 'data'), { recursive: true, force: true });
  fs.rmSync(path.join(IMAGE_ROOT_DIR, '素材库'), { recursive: true, force: true });
  fs.mkdirSync(IMAGE_ROOT_DIR, { recursive: true });
  let receivedBody = '';
  const imageServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk.toString(); });
    req.on('end', () => {
      receivedBody = body;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: [{ b64_json: Buffer.from('fake generated image').toString('base64') }]
      }));
    });
  });
  await new Promise((resolve) => imageServer.listen(TEST_IMAGE_PORT, '127.0.0.1', resolve));
  const imageBase = `http://127.0.0.1:${TEST_IMAGE_APP_PORT}/api`;
  const server = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      PORT: String(TEST_IMAGE_APP_PORT),
      SOUREN_ROOT_DIR: IMAGE_ROOT_DIR,
      SOUREN_GITHUB_SYNC_CHECK_DISABLED: '1',
      SOUREN_E2E_QUEUE_BYPASS: '1',
      IMAGE_API_KEY: 'fake-image-key',
      IMAGE_API_URL: `http://127.0.0.1:${TEST_IMAGE_PORT}/images/generate`,
      IMAGE_MODEL: 'fake-image-model',
      IMAGE_SIZE: '1024x1024'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', (chunk) => process.stdout.write(chunk));
  server.stderr.on('data', (chunk) => process.stderr.write(chunk));
  try {
    await waitForServer(server, imageBase);
    const config = await api('/config', {}, imageBase);
    assert(config.image.ready === true && config.image.model === 'fake-image-model', 'image config did not show ready');
    assert(config.image.apiUrlConfigured === true && config.image.apiUrlDefaulted === false, 'custom image URL config was not reported');
    const caze = await api('/cases', {
      method: 'POST',
      body: JSON.stringify({
        weixinNick: '图片生成兼职',
        douyinUrl: 'https://www.douyin.com/user/image-smoke',
        project: '吸脂',
        sourceMaterialDir: makeSharedSourceDir(IMAGE_ROOT_DIR, '图片生成兼职'),
        persona: { city: '成都', occupation: '上班族' }
      })
    }, imageBase);
    const task = await api('/image-tasks', {
      method: 'POST',
      body: JSON.stringify({ caseId: caze.id, purpose: '封面图' })
    }, imageBase);
    assert(task.status === 'draft', 'image task should be draft when image API is ready');
    const generated = await api(`/image-tasks/${task.id}/generate`, { method: 'POST' }, imageBase);
    assert(generated.task.status === 'review', 'generated image task not moved to review');
    assert(generated.files.length === 1 && fs.existsSync(generated.files[0]), 'generated image file missing');
    assert(generated.assets.some((asset) => asset?.source === 'AI生成'), 'generated image asset not inserted');
    assert(receivedBody.includes('图片用途：封面图') && receivedBody.includes('fake-image-model'), 'image API did not receive system prompt or model');
  } finally {
    server.kill('SIGTERM');
    imageServer.close();
    await sleep(300);
    fs.rmSync(IMAGE_ROOT_DIR, { recursive: true, force: true });
  }
}

async function imageKeyOnlyConfigSmoke() {
  fs.rmSync(path.join(IMAGE_KEY_ONLY_ROOT_DIR, 'data'), { recursive: true, force: true });
  fs.rmSync(path.join(IMAGE_KEY_ONLY_ROOT_DIR, '素材库'), { recursive: true, force: true });
  fs.mkdirSync(IMAGE_KEY_ONLY_ROOT_DIR, { recursive: true });
  const imageBase = `http://127.0.0.1:${TEST_IMAGE_KEY_ONLY_PORT}/api`;
  const server = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      PORT: String(TEST_IMAGE_KEY_ONLY_PORT),
      SOUREN_ROOT_DIR: IMAGE_KEY_ONLY_ROOT_DIR,
      SOUREN_GITHUB_SYNC_CHECK_DISABLED: '1',
      IMAGE_API_KEY: 'key-only-image-key',
      IMAGE_API_URL: '',
      IMAGE_MODEL: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', (chunk) => process.stdout.write(chunk));
  server.stderr.on('data', (chunk) => process.stderr.write(chunk));
  try {
    await waitForServer(server, imageBase);
    const config = await api('/config', {}, imageBase);
    assert(config.image.ready === true, 'image config should be ready with key only');
    assert(config.image.model === 'gpt-image-1', 'key-only image config should use the default GPT image model');
    assert(config.image.apiUrlConfigured === false && config.image.apiUrlDefaulted === true, 'key-only image config did not use default endpoint');
  } finally {
    server.kill('SIGTERM');
    await sleep(300);
    fs.rmSync(IMAGE_KEY_ONLY_ROOT_DIR, { recursive: true, force: true });
  }
}

async function authAccessSmoke() {
  fs.rmSync(path.join(AUTH_ROOT_DIR, 'data'), { recursive: true, force: true });
  fs.rmSync(path.join(AUTH_ROOT_DIR, '素材库'), { recursive: true, force: true });
  fs.mkdirSync(AUTH_ROOT_DIR, { recursive: true });
  const authOrigin = `http://127.0.0.1:${TEST_AUTH_PORT}`;
  const authBase = `${authOrigin}/api`;
  const server = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      PORT: String(TEST_AUTH_PORT),
      SOUREN_ROOT_DIR: AUTH_ROOT_DIR,
      SOUREN_ACCESS_CODE: 'lan-test-code',
      SOUREN_AUTH_LOCAL_BYPASS: '0',
      SOUREN_GITHUB_SYNC_CHECK_DISABLED: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', (chunk) => process.stdout.write(chunk));
  server.stderr.on('data', (chunk) => process.stderr.write(chunk));
  try {
    await waitForServer(server, authBase);
    const session = await api('/session', {}, authBase);
    assert(session.authRequired === true && session.authenticated === false, 'auth session did not require access code');
    const blockedDashboard = await fetch(`${authBase}/dashboard`);
    assert(blockedDashboard.status === 401, 'dashboard was accessible without access code');
    const blockedFiles = await fetch(`${authOrigin}/files/app/.env`);
    assert(blockedFiles.status === 401, 'files route was accessible without access code');
    const badLogin = await fetch(`${authBase}/session/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessCode: 'wrong' })
    });
    assert(badLogin.status === 401, 'wrong access code was accepted');
    const login = await fetch(`${authBase}/session/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessCode: 'lan-test-code' })
    });
    assert(login.ok, 'correct access code was rejected');
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    assert(cookie?.startsWith('souren_access='), 'login did not set access cookie');
    const allowedDashboard = await fetch(`${authBase}/dashboard`, { headers: { Cookie: cookie } });
    assert(allowedDashboard.ok, 'dashboard was not accessible after access code login');
  } finally {
    server.kill('SIGTERM');
    fs.rmSync(AUTH_ROOT_DIR, { recursive: true, force: true });
  }
}

async function lanFailClosedSmoke() {
  fs.rmSync(path.join(LAN_FAIL_ROOT_DIR, 'data'), { recursive: true, force: true });
  fs.rmSync(path.join(LAN_FAIL_ROOT_DIR, '素材库'), { recursive: true, force: true });
  fs.mkdirSync(LAN_FAIL_ROOT_DIR, { recursive: true });
  let output = '';
  const server = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      PORT: String(TEST_LAN_FAIL_PORT),
      SOUREN_ROOT_DIR: LAN_FAIL_ROOT_DIR,
      SOUREN_HOST: '0.0.0.0',
      SOUREN_ACCESS_CODE: '',
      SOUREN_GITHUB_SYNC_CHECK_DISABLED: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', (chunk) => { output += chunk.toString(); });
  server.stderr.on('data', (chunk) => { output += chunk.toString(); });
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.kill('SIGTERM');
      reject(new Error('LAN fail-closed server did not exit'));
    }, 5000);
    server.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  fs.rmSync(LAN_FAIL_ROOT_DIR, { recursive: true, force: true });
  assert(exitCode !== 0, 'LAN server without access code should fail startup');
  assert(output.includes('SOUREN_ACCESS_CODE') || output.includes('访问码'), 'LAN fail-closed message missing access code guidance');
}

async function lanAccessConfigSmoke() {
  fs.rmSync(LAN_CONFIG_ROOT_DIR, { recursive: true, force: true });
  fs.mkdirSync(LAN_CONFIG_ROOT_DIR, { recursive: true });
  const envPath = path.join(LAN_CONFIG_ROOT_DIR, 'runtime.env');
  fs.writeFileSync(envPath, 'IMAGE_API_KEY=keep-this-key\n');
  const lanBase = `http://127.0.0.1:${TEST_LAN_CONFIG_PORT}/api`;
  const server = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      PORT: String(TEST_LAN_CONFIG_PORT),
      SOUREN_ROOT_DIR: LAN_CONFIG_ROOT_DIR,
      SOUREN_ENV_PATH: envPath,
      SOUREN_GITHUB_SYNC_CHECK_DISABLED: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', (chunk) => process.stdout.write(chunk));
  server.stderr.on('data', (chunk) => process.stderr.write(chunk));
  try {
    await waitForServer(server, lanBase);
    const before = await api('/config', {}, lanBase);
    assert(before.network.lanEnabled === false && before.network.localRequest === true, 'LAN config smoke should start local-only');
    const result = await api('/network/lan-access', { method: 'POST', body: JSON.stringify({ action: 'enable' }) }, lanBase);
    assert(result.restartRequired === true && /^\d{6}$/.test(result.accessCode), 'LAN enable did not return a six digit access code');
    const envText = fs.readFileSync(envPath, 'utf8');
    assert(envText.includes('IMAGE_API_KEY=keep-this-key'), 'LAN enable did not preserve existing env values');
    assert(envText.includes('SOUREN_HOST=0.0.0.0'), 'LAN enable did not write host');
    assert(envText.includes(`SOUREN_ACCESS_CODE=${result.accessCode}`), 'LAN enable did not write generated access code');
    const disabled = await api('/network/lan-access', { method: 'POST', body: JSON.stringify({ action: 'disable' }) }, lanBase);
    assert(disabled.restartRequired === true, 'LAN disable did not ask for restart');
    const disabledEnv = fs.readFileSync(envPath, 'utf8');
    assert(disabledEnv.includes('IMAGE_API_KEY=keep-this-key'), 'LAN disable did not preserve existing env values');
    assert(disabledEnv.includes('SOUREN_HOST=127.0.0.1'), 'LAN disable did not restore local host');
    assert(disabledEnv.includes('SOUREN_ACCESS_CODE='), 'LAN disable did not clear access code');
  } finally {
    server.kill('SIGTERM');
    await sleep(300);
    fs.rmSync(LAN_CONFIG_ROOT_DIR, { recursive: true, force: true });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function makeSharedSourceDir(rootDir, name) {
  const dir = path.join(rootDir, '员工共享素材', name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function placeholderDouyinCollectionSmoke() {
  fs.rmSync(path.join(PLACEHOLDER_ROOT_DIR, 'data'), { recursive: true, force: true });
  fs.rmSync(path.join(PLACEHOLDER_ROOT_DIR, '素材库'), { recursive: true, force: true });
  fs.mkdirSync(PLACEHOLDER_ROOT_DIR, { recursive: true });
  const placeholderBase = `http://127.0.0.1:${TEST_PLACEHOLDER_PORT}/api`;
  const server = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      PORT: String(TEST_PLACEHOLDER_PORT),
      SOUREN_ROOT_DIR: PLACEHOLDER_ROOT_DIR,
      SOUREN_GITHUB_SYNC_CHECK_DISABLED: '1',
      DOUYIN_COLLECTOR_AUTO_RUN: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', (chunk) => process.stdout.write(chunk));
  server.stderr.on('data', (chunk) => process.stderr.write(chunk));
  try {
    await waitForServer(server, placeholderBase);
    const demoCase = await api('/cases', {
      method: 'POST',
      body: JSON.stringify({
        weixinNick: '演示采集保护兼职',
        douyinUrl: 'https://www.douyin.com/user/demo_autocollect',
        project: '吸脂',
        sourceMaterialDir: makeSharedSourceDir(PLACEHOLDER_ROOT_DIR, '演示采集保护兼职')
      })
    }, placeholderBase);
    assert(demoCase.collectionQueue?.registeredCount === 0 && demoCase.collectionQueue?.count === 0, 'placeholder Douyin URL should not register Chrome collection');
    const queue = await api('/douyin-monitor/chrome-queue?includeFresh=1&limit=10', {}, placeholderBase);
    assert(!queue.targets.some((item) => item.caseId === demoCase.id), 'placeholder Douyin URL leaked into Chrome collection queue');
    const legacyRunId = 'collect_legacy_placeholder_smoke';
    const legacyDb = new DatabaseSync(path.join(PLACEHOLDER_ROOT_DIR, 'data', 'souren.sqlite'));
    const createdAt = new Date().toISOString();
    legacyDb.prepare(`
      INSERT INTO collection_runs
      (id, case_id, started_at, finished_at, status, source, note, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      legacyRunId,
      demoCase.id,
      createdAt,
      null,
      'waiting_chrome',
      'legacy-smoke',
      '历史演示链接等待采集单',
      createdAt,
      createdAt
    );
    legacyDb.close();
    const monitor = await api('/douyin-monitor', {}, placeholderBase);
    const account = monitor.accounts.find((item) => item.case?.id === demoCase.id);
    assert(account?.collectionPolicy?.intervalHours == null && /演示|测试/.test(account.collectionPolicy.reason), 'placeholder Douyin URL missing no-collection policy');
    assert(account.collectionQueued === false, 'placeholder Douyin URL kept legacy waiting Chrome collection');
    assert(monitor.totals.canceledBlockedCollectionRuns >= 1, 'placeholder legacy collection run was not reported as canceled');
    const cleanupDb = new DatabaseSync(path.join(PLACEHOLDER_ROOT_DIR, 'data', 'souren.sqlite'));
    const legacyRun = cleanupDb.prepare('SELECT status, note FROM collection_runs WHERE id = ?').get(legacyRunId);
    cleanupDb.close();
    assert(legacyRun?.status === 'canceled' && /演示|测试/.test(legacyRun.note), 'placeholder legacy collection run not canceled');
  } finally {
    server.kill('SIGTERM');
    await sleep(300);
    fs.rmSync(PLACEHOLDER_ROOT_DIR, { recursive: true, force: true });
  }
}

async function main() {
  fs.rmSync(path.join(ROOT_DIR, 'data'), { recursive: true, force: true });
  fs.rmSync(path.join(ROOT_DIR, '素材库'), { recursive: true, force: true });
  fs.mkdirSync(ROOT_DIR, { recursive: true });

  const server = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      SOUREN_ROOT_DIR: ROOT_DIR,
      SOUREN_GITHUB_SYNC_CHECK_DISABLED: '1',
      SOUREN_E2E_QUEUE_BYPASS: '1',
      IMAGE_API_KEY: '',
      IMAGE_API_URL: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', (chunk) => process.stdout.write(chunk));
  server.stderr.on('data', (chunk) => process.stderr.write(chunk));

  try {
    await waitForServer(server);
    const initialDashboard = await api('/dashboard');
    assert(initialDashboard.today === localDate(), 'dashboard today should use local date');

    let blankViralRejected = false;
    try {
      await api('/viral-templates', {
        method: 'POST',
        body: JSON.stringify({ sourceLink: '   ' })
      });
    } catch (error) {
      blankViralRejected = /爆款视频链接/.test(error.message);
    }
    assert(blankViralRejected, 'blank viral link created a template');

    const forbiddenViralAnalysisCreateResponse = await fetch(`${BASE}/viral-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceLink: 'https://www.douyin.com/video/forbidden-analysis-create',
        rawText: '临时手填爆款正文',
        hotStructure: '临时手填结构'
      })
    });
    assert(forbiddenViralAnalysisCreateResponse.status === 400, 'viral template create accepted manual analysis fields');
    const afterForbiddenViralCreate = await api('/viral-templates');
    assert(!afterForbiddenViralCreate.some((item) => item.sourceLink === 'https://www.douyin.com/video/forbidden-analysis-create'), 'manual analysis create inserted a viral template');

    const viral = await api('/viral-templates', {
      method: 'POST',
      body: JSON.stringify({
        title: '普通女生状态变好的3个细节',
        rawText: '状态变好不是突然自律，而是三个小细节。',
        category: '情绪',
        hotStructure: '共鸣开头 + 三点清单 + 评论互动',
        rewritePolicy: '结构模仿'
      })
    });
    assert(viral.id, 'viral template not created');
    const filteredViral = await api('/viral-templates', {
      method: 'POST',
      body: JSON.stringify({
        title: '吸脂账号专用爆款',
        rawText: '只给吸脂项目生成，并排除指定微信昵称。',
        category: '职场',
        hotStructure: '项目 + 账号筛选 + 三点清单',
        suitablePersonas: ['吸脂'],
        forbiddenPersonas: ['批量小林'],
        rewritePolicy: '结构模仿'
      })
    });
    assert(filteredViral.suitablePersonas.length === 1 && filteredViral.forbiddenPersonas.length === 1, 'viral persona filters not saved');
    const linkOnlyViral = await api('/viral-templates', {
      method: 'POST',
      body: JSON.stringify({ sourceLink: 'https://www.douyin.com/video/link-only-smoke' })
    });
    assert(linkOnlyViral.rawText.includes('待分析') && linkOnlyViral.category === '待分析', 'link-only viral template not marked pending analysis');
    const forbiddenViralAnalysisPatchResponse = await fetch(`${BASE}/viral-templates/${linkOnlyViral.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rawText: '临时补一点正文',
        category: '情绪',
        hotStructure: '临时结构'
      })
    });
    assert(forbiddenViralAnalysisPatchResponse.status === 400, 'viral template patch accepted manual analysis fields');
    const afterForbiddenViralPatch = await api('/viral-templates');
    const stillPendingViral = afterForbiddenViralPatch.find((item) => item.id === linkOnlyViral.id);
    assert(stillPendingViral?.rawText?.includes('待分析') && stillPendingViral.category === '待分析', 'manual analysis patch changed pending viral template');
    const viralAnalysisTask = await api(`/viral-templates/${linkOnlyViral.id}/analysis-task`);
    assert(viralAnalysisTask.text.includes('https://www.douyin.com/video/link-only-smoke') && viralAnalysisTask.text.includes('/analysis-result'), 'viral analysis task text missing writeback endpoint');
    const viralDashboard = await api('/dashboard');
    assert(viralDashboard.counts.pendingViral >= 1, 'dashboard pending viral count missing');
    assert(viralDashboard.pendingViralTemplates.some((item) => item.id === linkOnlyViral.id), 'dashboard pending viral list missing link-only template');
    const agentWorkAfterViral = await api('/agent-work');
    assert(agentWorkAfterViral.counts.viralAnalysis >= 1 && agentWorkAfterViral.items.some((item) => item.kind === '爆款分析' && item.viralTemplateId === linkOnlyViral.id && item.endpoint.endsWith('/analysis-result')), 'agent work queue missing pending viral analysis');
    let emptySeedRejected = false;
    try {
      await api('/content-seeds', {
        method: 'POST',
        body: JSON.stringify({
          project: '吸脂',
          stage: '起号期',
          contentKind: '素人种草',
          format: '图文',
          titleTemplate: '空正文种子',
          contentTemplate: '   ',
          baseWeight: 1
        })
      });
    } catch (error) {
      emptySeedRejected = /正文配方/.test(error.message);
    }
    assert(emptySeedRejected, 'content seed accepted an empty content template');
    let viralSeedRejected = false;
    try {
      await api('/content-seeds', {
        method: 'POST',
        body: JSON.stringify({
          project: '吸脂',
          stage: '起号期',
          contentKind: '爆款提权',
          format: '图文',
          titleTemplate: '爆款提权种子',
          contentTemplate: '爆款提权不应该走内容种子池',
          baseWeight: 1
        })
      });
    } catch (error) {
      viralSeedRejected = /爆款链接分析/.test(error.message);
    }
    assert(viralSeedRejected, 'content seed accepted viral boost kind');
    let seedWeightRejected = false;
    try {
      await api('/content-seeds', {
        method: 'POST',
        body: JSON.stringify({
          project: '吸脂',
          stage: '起号期',
          contentKind: '日常养号',
          format: '图文',
          titleTemplate: '极端权重种子',
          contentTemplate: '这条种子权重过高，不应该进入抽取池。',
          baseWeight: 1000
        })
      });
    } catch (error) {
      seedWeightRejected = /权重/.test(error.message);
    }
    assert(seedWeightRejected, 'content seed accepted an extreme base weight');
    const seed = await api('/content-seeds', {
      method: 'POST',
      body: JSON.stringify({
        project: '吸脂',
        stage: '起号期',
        contentKind: '素人种草',
        format: '图文',
        titleTemplate: '验收种子：{城市}{occupation}',
        contentTemplate: '这是验收内容种子，{城市}{occupation}，{motivation}',
        tags: ['验收'],
        baseWeight: 5
      })
    });
    assert(seed.id, 'content seed not created');
    let seedPatchWeightRejected = false;
    try {
      await api(`/content-seeds/${seed.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ baseWeight: 1000 })
      });
    } catch (error) {
      seedPatchWeightRejected = /权重/.test(error.message);
    }
    assert(seedPatchWeightRejected, 'content seed patch accepted an extreme base weight');
    const videoSeed = await api('/content-seeds', {
      method: 'POST',
      body: JSON.stringify({
        project: '视频验收项目',
        stage: '起号期',
        contentKind: '日常养号',
        format: '视频',
        titleTemplate: '验收视频：{城市}{occupation}',
        contentTemplate: '这是验收视频口播，{城市}{occupation}，{motivation}',
        tags: ['验收', '视频'],
        baseWeight: 10
      })
    });
    assert(videoSeed.id, 'video content seed not created');

    const invalidBulkSourceDir = makeSharedSourceDir(ROOT_DIR, '批量失败不应创建');
    fs.writeFileSync(path.join(invalidBulkSourceDir, '批量失败素材.jpg'), 'fake failed bulk material');
    let invalidBulkRejected = false;
    try {
      await api('/cases/bulk', {
        method: 'POST',
        body: JSON.stringify({
          text: [
            `批量失败小吴,https://www.douyin.com/user/bulk-fail-wu,吸脂,${invalidBulkSourceDir}`,
            `批量失败小郑,https://www.douyin.com/user/bulk-fail-zheng,吸脂,${path.join(ROOT_DIR, '不存在的批量共享目录')}`
          ].join('\n')
        })
      });
    } catch (error) {
      invalidBulkRejected = /不存在或不是目录/.test(error.message);
    }
    assert(invalidBulkRejected, 'bulk import allowed a row with missing shared source directory');
    const afterInvalidBulk = await api('/cases');
    assert(afterInvalidBulk.length === 0, 'bulk import created partial cases before failing validation');
    const missingBulkProjectDir = makeSharedSourceDir(ROOT_DIR, '批量缺项目不应创建');
    fs.writeFileSync(path.join(missingBulkProjectDir, '批量缺项目素材.jpg'), 'fake missing project material');
    let missingBulkProjectRejected = false;
    try {
      await api('/cases/bulk', {
        method: 'POST',
        body: JSON.stringify({
          text: `批量缺项目,https://www.douyin.com/user/bulk-missing-project,,${missingBulkProjectDir}`
        })
      });
    } catch (error) {
      missingBulkProjectRejected = /缺少项目/.test(error.message);
    }
    assert(missingBulkProjectRejected, 'bulk import allowed a row with missing project');
    const afterMissingBulkProject = await api('/cases');
    assert(afterMissingBulkProject.length === 0, 'bulk import created a case before rejecting missing project');
    const forbiddenHealthCreateDir = makeSharedSourceDir(ROOT_DIR, '禁止新建改状态');
    const forbiddenHealthCreateResponse = await fetch(`${BASE}/cases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        weixinNick: '禁止新建改状态',
        douyinUrl: 'https://www.douyin.com/user/forbidden-health-create',
        project: '吸脂',
        sourceMaterialDir: forbiddenHealthCreateDir,
        healthStatus: '失联暂停'
      })
    });
    assert(forbiddenHealthCreateResponse.status === 400, 'case create health status override was allowed');
    const afterForbiddenHealthCreate = await api('/cases');
    assert(afterForbiddenHealthCreate.length === 0, 'case create health status override inserted a case');

    const bulkLinDir = makeSharedSourceDir(ROOT_DIR, '批量小林');
    const bulkChenDir = makeSharedSourceDir(ROOT_DIR, '批量小陈');
    fs.writeFileSync(path.join(bulkLinDir, '批量小林-D1.jpg'), 'fake bulk lin material');
    fs.writeFileSync(path.join(bulkChenDir, '批量小陈-D1.jpg'), 'fake bulk chen material');
    const bulk = await api('/cases/bulk', {
      method: 'POST',
      body: JSON.stringify({
        text: [
          `批量小林,https://www.douyin.com/user/bulk-lin,吸脂,${bulkLinDir}`,
          `批量小陈,https://www.douyin.com/user/bulk-chen,复诊,${bulkChenDir}`
        ].join('\n')
      })
    });
    assert(bulk.createdCount === 2, 'bulk import should only accept rows with WeChat, Douyin link and shared source path');
    assert(bulk.syncedCount === 2 && bulk.cases.every((item) => item.sync?.inserted === 1), 'bulk import did not automatically sync shared materials');
    assert(bulk.cases[0].douyinUrl.includes('bulk-lin') && bulk.cases[1].project === '复诊', 'bulk simplified fields missing');
    assert(bulk.cases.every((item) => item.stage === '起号期'), 'bulk import accepted external case stage');
    assert(bulk.collectionQueue?.registeredCount === 2 && bulk.collectionQueue.runs.every((item) => bulk.cases.some((c) => c.id === item.caseId)), 'bulk import did not immediately queue Chrome collection');
    assert(fs.existsSync(path.join(bulk.cases[0].localCaseDir, '00-原始素材')), 'bulk case material dir missing');
    const deletedCaseDir = bulk.cases[1].localCaseDir;
    assert(fs.existsSync(deletedCaseDir), 'case directory missing before delete');
    const deleteWithoutConfirm = await fetch(`${BASE}/cases/${bulk.cases[1].id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...E2E_SETUP_HEADER }
    });
    assert(deleteWithoutConfirm.status === 409, 'case delete without confirmation should be blocked');
    assert(fs.existsSync(deletedCaseDir), 'case directory was removed without delete confirmation');
    const deleteWrongConfirm = await fetch(`${BASE}/cases/${bulk.cases[1].id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...E2E_SETUP_HEADER },
      body: JSON.stringify({ confirmText: '删除 错误账号' })
    });
    assert(deleteWrongConfirm.status === 409, 'case delete with wrong confirmation should be blocked');
    assert(fs.existsSync(deletedCaseDir), 'case directory was removed with wrong delete confirmation');
    const deletedCase = await deleteCase(bulk.cases[1]);
    assert(deletedCase.removedDir === true, 'case delete did not report local directory removal');
    assert(!fs.existsSync(deletedCaseDir), 'case delete did not remove local material directory');
    const archivedKey = 'archived' + 'Dir';
    assert(!(archivedKey in deletedCase), 'case delete still returned a retained local directory');
    const afterDelete = await api('/cases');
    assert(afterDelete.length === 1 && afterDelete[0].id === bulk.cases[0].id, 'case delete failed');

    const gapCaseADir = makeSharedSourceDir(ROOT_DIR, '删后编号A');
    const gapCaseBDir = makeSharedSourceDir(ROOT_DIR, '删后编号B');
    const gapCaseCDir = makeSharedSourceDir(ROOT_DIR, '删后编号C');
    fs.writeFileSync(path.join(gapCaseADir, '编号A-D1.jpg'), 'fake gap case a material');
    fs.writeFileSync(path.join(gapCaseBDir, '编号B-D1.jpg'), 'fake gap case b material');
    fs.writeFileSync(path.join(gapCaseCDir, '编号C-D1.jpg'), 'fake gap case c material');
    const gapCaseA = await api('/cases', {
      method: 'POST',
      body: JSON.stringify({
        weixinNick: '删后编号A',
        douyinUrl: 'https://www.douyin.com/user/case-code-gap-a',
        project: '吸脂',
        sourceMaterialDir: gapCaseADir
      })
    });
    const gapCaseB = await api('/cases', {
      method: 'POST',
      body: JSON.stringify({
        weixinNick: '删后编号B',
        douyinUrl: 'https://www.douyin.com/user/case-code-gap-b',
        project: '吸脂',
        sourceMaterialDir: gapCaseBDir
      })
    });
    await deleteCase(gapCaseA);
    const gapCaseC = await api('/cases', {
      method: 'POST',
      body: JSON.stringify({
        weixinNick: '删后编号C',
        douyinUrl: 'https://www.douyin.com/user/case-code-gap-c',
        project: '吸脂',
        sourceMaterialDir: gapCaseCDir
      })
    });
    const gapCaseBSeq = Number(gapCaseB.caseCode.split('-').pop());
    const gapCaseCSeq = Number(gapCaseC.caseCode.split('-').pop());
    assert(gapCaseC.caseCode !== gapCaseB.caseCode && gapCaseCSeq > gapCaseBSeq, 'case code generation reused an existing code after delete');
    await deleteCase(gapCaseB);
    await deleteCase(gapCaseC);

    const legacyDir = makeSharedSourceDir(ROOT_DIR, '历史缺资料账号');
    fs.writeFileSync(path.join(legacyDir, '历史-D1.jpg'), 'fake legacy material');
    const legacyCase = await api('/cases', {
      method: 'POST',
      body: JSON.stringify({
        weixinNick: '历史缺资料账号',
        douyinUrl: 'https://www.douyin.com/user/legacy-intake-smoke',
        project: '吸脂',
        sourceMaterialDir: legacyDir
      })
    });
    const legacyReadySlot = await api(`/cases/${legacyCase.id}/slots`, {
      method: 'POST',
      body: JSON.stringify({
        date: localDate(),
        contentKind: '素人种草',
        stage: '起号期',
        goal: '缺资料账号不应先交付',
        status: '可交付'
      })
    });
    const legacyDb = new DatabaseSync(path.join(ROOT_DIR, 'data', 'souren.sqlite'));
    legacyDb.exec('PRAGMA foreign_keys = ON;');
    legacyDb.prepare('UPDATE cases SET douyin_url = ?, project = ?, source_material_dir = ?, updated_at = ? WHERE id = ?').run('', '', '', new Date().toISOString(), legacyCase.id);
    legacyDb.close();
    const intakeDashboard = await api('/dashboard');
    const intakeIssue = intakeDashboard.intakeIssues.find((item) => item.caseId === legacyCase.id);
    assert(intakeIssue?.issues.includes('缺少抖音链接') && intakeIssue.issues.includes('缺少项目') && intakeIssue.issues.includes('缺少共享原始素材路径'), 'legacy missing account did not enter intake issue queue');
    assert(intakeDashboard.counts.intakeIssues >= 1, 'dashboard missing intake issue count');
    const legacyQueueActions = intakeDashboard.priorityActions.filter((item) => item.case?.id === legacyCase.id);
    assert(legacyQueueActions.length === 1 && legacyQueueActions[0].kind === '补登记', 'intake issue should gate other queue actions for same account');
    assert(legacyQueueActions[0].note.includes('点“补资料”') && !legacyQueueActions[0].note.includes('点“编辑案例”'), 'intake issue queue still tells staff to use the old edit flow');
    assert(!intakeDashboard.readyDelivery.some((item) => item.id === legacyReadySlot.id), 'intake issue ready delivery leaked into dashboard delivery queue');
    assert(!intakeDashboard.todaySlots.some((item) => item.id === legacyReadySlot.id), 'intake issue active slot leaked into dashboard today slots');
    let invalidSourcePatchRejected = false;
    try {
      await api(`/cases/${legacyCase.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ douyinUrl: 'https://www.douyin.com/user/legacy-fixed-smoke', project: '吸脂', sourceMaterialDir: path.join(ROOT_DIR, '不存在的编辑共享目录') })
      });
    } catch (error) {
      invalidSourcePatchRejected = /共享原始素材路径不存在/.test(error.message);
    }
    assert(invalidSourcePatchRejected, 'case edit allowed a missing shared source directory');
    let blankWeixinPatchRejected = false;
    try {
      await api(`/cases/${legacyCase.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          weixinNick: '   ',
          douyinUrl: 'https://www.douyin.com/user/legacy-fixed-smoke',
          project: '吸脂',
          sourceMaterialDir: legacyDir
        })
      });
    } catch (error) {
      blankWeixinPatchRejected = /兼职微信昵称/.test(error.message);
    }
    assert(blankWeixinPatchRejected, 'case edit allowed blank WeChat nickname');
    let blankProjectPatchRejected = false;
    try {
      await api(`/cases/${legacyCase.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          weixinNick: '历史缺资料账号',
          douyinUrl: 'https://www.douyin.com/user/legacy-fixed-smoke',
          project: '   ',
          sourceMaterialDir: legacyDir
        })
      });
    } catch (error) {
      blankProjectPatchRejected = /必须填写项目/.test(error.message);
    }
    assert(blankProjectPatchRejected, 'case edit allowed blank project');
    const fixedLegacyCase = await api(`/cases/${legacyCase.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        weixinNick: '历史缺资料账号改',
        douyinId: 'manual_should_ignore',
        douyinUrl: 'https://www.douyin.com/user/legacy-fixed-smoke',
        project: '复诊',
        persona: { city: '不该写入', age: 99, occupation: '不该写入' },
        sourceMaterialDir: legacyDir
      })
    });
    assert(fixedLegacyCase.weixinNick === '历史缺资料账号改' && fixedLegacyCase.project === '复诊', 'case edit did not persist simplified editable fields');
    assert(fixedLegacyCase.douyinUrl.includes('legacy-fixed-smoke') && fixedLegacyCase.sourceMaterialDir === legacyDir, 'case edit did not restore intake fields');
    assert(fixedLegacyCase.douyinId === 'legacy-fixed-smoke', 'case edit accepted manual Douyin id');
    assert(fixedLegacyCase.persona.city !== '不该写入' && fixedLegacyCase.persona.occupation !== '不该写入', 'case edit accepted hidden persona patch');
    const fixedLegacyDetail = await api(`/cases/${legacyCase.id}`);
    assert(
      fixedLegacyCase.collectionQueue?.runs?.some((item) => item.caseId === legacyCase.id)
        || fixedLegacyCase.collectionQueue?.targets?.some((item) => item.caseId === legacyCase.id && item.collectionQueued),
      'case edit did not leave restored account queued for Chrome collection'
    );
    assert(fixedLegacyDetail.monitor.pendingCollectionRun?.status === 'waiting_chrome', 'restored case missing pending Chrome collection run');
    const fixedIntakeDashboard = await api('/dashboard');
    assert(!fixedIntakeDashboard.intakeIssues.some((item) => item.caseId === legacyCase.id), 'fixed legacy account still appears in intake issue queue');
    assert(fixedIntakeDashboard.readyDelivery.some((item) => item.id === legacyReadySlot.id), 'fixed intake account did not release its ready delivery slot');
    await deleteCase(fixedLegacyCase);

    const queueGenerated = await api('/dashboard/generate-today', { method: 'POST' });
    assert(queueGenerated.slotCount <= 1 && queueGenerated.candidateCount <= 3, 'dashboard generate should only process the queue head');
    assert(queueGenerated.processedId === null || queueGenerated.slots.every((item) => item.id === queueGenerated.processedId), 'dashboard generate processed a non-head slot');
    if (queueGenerated.reason) assert(queueGenerated.reason.includes('不能越过队首') || queueGenerated.reason.includes('今日队列已清空'), 'dashboard generate missing queue-head refusal reason');

    const sharedSourceDir = path.join(ROOT_DIR, '员工共享素材', '验收兼职');
    fs.mkdirSync(sharedSourceDir, { recursive: true });
    fs.writeFileSync(path.join(sharedSourceDir, '共享-D1.jpg'), 'fake shared case image');
    const caze = await api('/cases', {
      method: 'POST',
      body: JSON.stringify({
        weixinNick: '验收兼职',
        douyinId: 'smoke_dy',
        douyinUrl: 'https://www.douyin.com/',
        project: '吸脂',
        sourceMaterialDir: sharedSourceDir,
        stage: '成果期',
        persona: { city: '成都', occupation: '上班族' }
      })
    });
    assert(caze.weixinNick === '验收兼职' && caze.persona.age && caze.persona.tone && caze.persona.motivation, 'case required nickname or random defaults missing');
    assert(caze.douyinId !== 'smoke_dy', 'case create accepted manual Douyin id');
    assert(caze.stage === '起号期' && caze.slotsCreated >= 14, 'case create should ignore external stage and generate schedule by default');
    assert(caze.sourceMaterialDir === sharedSourceDir, 'case source material dir missing');
    assert(caze.sync?.copied === 1 && caze.sync?.inserted === 1, 'case create did not automatically sync shared source material');
    assert(caze.collectionQueue?.registeredCount === 1 && caze.collectionQueue.runs[0]?.caseId === caze.id, 'case create did not immediately queue Chrome collection');
    assert(fs.existsSync(path.join(caze.localCaseDir, '00-原始素材')), 'case material dir missing');
    const agentWorkAfterCase = await api('/agent-work');
    assert(agentWorkAfterCase.counts.douyinCollection >= 1 && agentWorkAfterCase.items.some((item) => item.kind === '抖音采集' && item.case?.id === caze.id && item.endpoint === '/api/douyin-monitor/ingest'), 'agent work queue missing chrome collection work');
    const syncedMaterials = await api(`/cases/${caze.id}/sync-source-materials`, { method: 'POST' });
    assert(syncedMaterials.copied === 0 && syncedMaterials.inserted === 0, 'source material sync duplicated asset that was already synced on create');
    const syncedAssetPath = path.join(caze.localCaseDir, '00-原始素材', '共享同步', '共享-D1.jpg');
    assert(fs.existsSync(syncedAssetPath), 'synced source material missing in local case dir');
    const createdCaseDetail = await api(`/cases/${caze.id}`);
    assert(createdCaseDetail.assets.some((asset) => asset.path === syncedAssetPath && asset.originPath === path.join(sharedSourceDir, '共享-D1.jpg') && asset.source === '共享导入' && asset.usage === '案例过程'), 'synced source material metadata missing');
    fs.writeFileSync(path.join(sharedSourceDir, '共享-对比.jpg'), 'fake unsynced shared case image');
    const materialGuardSourceDir = path.join(ROOT_DIR, '共享素材-素材队首守门');
    fs.mkdirSync(materialGuardSourceDir, { recursive: true });
    const materialGuardCase = await api('/cases', {
      method: 'POST',
      body: JSON.stringify({
        weixinNick: '素材队首守门兼职',
        douyinUrl: 'https://www.douyin.com/user/MS4wLjABAAAA_material_guard',
        project: '吸脂',
        sourceMaterialDir: materialGuardSourceDir,
        persona: { city: '成都', occupation: '上班族' }
      })
    });
    fs.rmSync(materialGuardSourceDir, { recursive: true, force: true });
    const beforeSyncDashboard = await api('/dashboard');
    const pendingSync = beforeSyncDashboard.materialSync.find((item) => item.case?.id === caze.id);
    const blockingMaterialSync = beforeSyncDashboard.materialSync.find((item) => item.case?.id === materialGuardCase.id && item.status === '目录不可用');
    assert(beforeSyncDashboard.counts.materialSync >= 1 && pendingSync?.unsyncedCount === 1, 'dashboard missing pending shared material sync');
    const queueHeadMaterialCaseId = beforeSyncDashboard.queueHead?.materialSync?.caseId || beforeSyncDashboard.queueHead?.materialSync?.case?.id;
    const queueHeadSlotCaseId = ['素材阻塞', '异常'].includes(beforeSyncDashboard.queueHead?.slot?.status)
      ? beforeSyncDashboard.queueHead?.slot?.caseId || beforeSyncDashboard.queueHead?.slot?.case?.id
      : null;
    assert(blockingMaterialSync, 'material queue guard setup missing another material action');
    assert(String(queueHeadMaterialCaseId || '') !== String(caze.id) && String(queueHeadSlotCaseId || '') !== String(caze.id), 'material queue guard setup left target case as queue head');
    const nonHeadSyncResponse = await fetch(`${BASE}/cases/${caze.id}/sync-source-materials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    assert(nonHeadSyncResponse.status === 409, 'non-head material sync was allowed');
    const afterBlockedSync = await api('/dashboard');
    assert(afterBlockedSync.materialSync.some((item) => item.case?.id === caze.id && item.unsyncedCount === 1), 'non-head material sync changed material queue');
    const syncedAgain = await api(`/cases/${caze.id}/sync-source-materials`, { method: 'POST' });
    assert(syncedAgain.copied === 1 && syncedAgain.inserted === 1, 'second source material sync did not copy new file');
    const afterSyncDashboard = await api('/dashboard');
    assert(!afterSyncDashboard.materialSync.some((item) => item.case?.id === caze.id), 'dashboard still shows synced case as pending material sync');
    const libraryCaseDir = path.join(ROOT_DIR, '素材库', '服务器案例库', '吸脂', '成都案例小库');
    fs.mkdirSync(path.join(libraryCaseDir, '术前'), { recursive: true });
    fs.mkdirSync(path.join(libraryCaseDir, '术后D7'), { recursive: true });
    fs.writeFileSync(path.join(libraryCaseDir, '术前', '人物-术前.jpg'), 'fake library person image');
    fs.writeFileSync(path.join(libraryCaseDir, '术后D7', '恢复过程.mp4'), 'fake library process video');
    const libraryScan = await api('/case-library');
    const libraryCandidate = libraryScan.candidates.find((item) => item.sourceMaterialDir === libraryCaseDir);
    assert(libraryScan.root.endsWith(path.join('素材库', '服务器案例库')), 'case library root missing');
    assert(libraryCandidate && libraryCandidate.fileCount === 2 && libraryCandidate.imageCount === 1 && libraryCandidate.videoCount === 1, 'case library scan missing candidate counts');
    assert(libraryCandidate.project === '吸脂' && !libraryCandidate.alreadyRegistered, 'case library candidate metadata invalid');
    let missingLibraryWeixinRejected = false;
    try {
      await api('/case-library/register', {
        method: 'POST',
        body: JSON.stringify({ sourceMaterialDir: libraryCaseDir })
      });
    } catch (error) {
      missingLibraryWeixinRejected = /兼职微信昵称/.test(error.message);
    }
    assert(missingLibraryWeixinRejected, 'case library register allowed missing WeChat nickname');
    let missingLibraryDouyinRejected = false;
    try {
      await api('/case-library/register', {
        method: 'POST',
        body: JSON.stringify({ sourceMaterialDir: libraryCaseDir, weixinNick: '库登记缺抖音' })
      });
    } catch (error) {
      missingLibraryDouyinRejected = /抖音/.test(error.message);
    }
    assert(missingLibraryDouyinRejected, 'case library register allowed missing Douyin URL');
    const registeredLibraryCase = await api('/case-library/register', {
      method: 'POST',
      body: JSON.stringify({
        sourceMaterialDir: libraryCaseDir,
        weixinNick: '库登记小李',
        douyinUrl: 'https://www.douyin.com/user/library-li'
      })
    });
    assert(registeredLibraryCase.case.sourceMaterialDir === libraryCaseDir, 'case library register did not bind source dir');
    assert(registeredLibraryCase.sync.copied === 2 && registeredLibraryCase.sync.inserted === 2, 'case library register did not sync source materials');
    assert(registeredLibraryCase.slotsCreated >= 14, 'case library register did not generate default slots');
    assert(registeredLibraryCase.collectionQueue?.registeredCount === 1 && registeredLibraryCase.collectionQueue.runs[0]?.caseId === registeredLibraryCase.case.id, 'case library register did not immediately queue Chrome collection');
    const afterLibraryScan = await api('/case-library');
    const registeredCandidate = afterLibraryScan.candidates.find((item) => item.sourceMaterialDir === libraryCaseDir);
    assert(registeredCandidate?.alreadyRegistered === true && registeredCandidate.caseId === registeredLibraryCase.case.id, 'case library did not mark registered candidate');
    const libraryDetail = await api(`/cases/${registeredLibraryCase.case.id}`);
    assert(libraryDetail.assets.length === 2 && libraryDetail.assets.every((asset) => asset.originPath.startsWith(libraryCaseDir)), 'registered library case assets missing origin path');
    let duplicateLibraryRejected = false;
    try {
      await api('/case-library/register', {
        method: 'POST',
        body: JSON.stringify({ sourceMaterialDir: libraryCaseDir, weixinNick: '重复登记' })
      });
    } catch (error) {
      duplicateLibraryRejected = /已经登记/.test(error.message);
    }
    assert(duplicateLibraryRejected, 'case library allowed duplicate source directory');
    let duplicateSourceEditRejected = false;
    try {
      await api(`/cases/${caze.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          weixinNick: caze.weixinNick,
          douyinUrl: caze.douyinUrl,
          project: caze.project,
          sourceMaterialDir: libraryCaseDir
        })
      });
    } catch (error) {
      duplicateSourceEditRejected = /已经登记/.test(error.message);
    }
    assert(duplicateSourceEditRejected, 'case edit allowed a shared source directory already bound to another account');
    const validationDir = makeSharedSourceDir(ROOT_DIR, '字段校验');
    let missingWeixinRejected = false;
    try {
      await api('/cases', {
        method: 'POST',
        body: JSON.stringify({
          douyinUrl: 'https://www.douyin.com/video/minimal-smoke',
          project: '吸脂',
          sourceMaterialDir: validationDir
        })
      });
    } catch (error) {
      missingWeixinRejected = /兼职微信昵称/.test(error.message);
    }
    assert(missingWeixinRejected, 'case create allowed missing WeChat nickname');
    let missingDouyinRejected = false;
    try {
      await api('/cases', {
        method: 'POST',
        body: JSON.stringify({
          weixinNick: '缺抖音验收兼职',
          project: '吸脂',
          sourceMaterialDir: validationDir
        })
      });
    } catch (error) {
      missingDouyinRejected = /抖音/.test(error.message);
    }
    assert(missingDouyinRejected, 'case create allowed missing Douyin URL');
    let missingProjectRejected = false;
    try {
      await api('/cases', {
        method: 'POST',
        body: JSON.stringify({
          weixinNick: '缺项目验收兼职',
          douyinUrl: 'https://www.douyin.com/user/missing-project-smoke',
          sourceMaterialDir: validationDir
        })
      });
    } catch (error) {
      missingProjectRejected = /必须填写项目/.test(error.message);
    }
    assert(missingProjectRejected, 'case create allowed missing project');
    let invalidDouyinRejected = false;
    try {
      await api('/cases', {
        method: 'POST',
        body: JSON.stringify({
          weixinNick: '假链接验收兼职',
          douyinUrl: 'https://example.com/not-douyin',
          project: '吸脂',
          sourceMaterialDir: validationDir
        })
      });
    } catch (error) {
      invalidDouyinRejected = /抖音/.test(error.message);
    }
    assert(invalidDouyinRejected, 'case create allowed non-Douyin URL');
    let missingSourceRejected = false;
    try {
      await api('/cases', {
        method: 'POST',
        body: JSON.stringify({
          weixinNick: '缺共享路径验收兼职',
          douyinUrl: 'https://www.douyin.com/user/missing-source-smoke',
          project: '吸脂'
        })
      });
    } catch (error) {
      missingSourceRejected = /共享原始素材路径/.test(error.message);
    }
    assert(missingSourceRejected, 'case create allowed missing shared source path');
    let invalidSourceRejected = false;
    try {
      await api('/cases', {
        method: 'POST',
        body: JSON.stringify({
          weixinNick: '假共享路径验收兼职',
          douyinUrl: 'https://www.douyin.com/user/invalid-source-smoke',
          project: '吸脂',
          sourceMaterialDir: path.join(ROOT_DIR, '不存在的共享目录')
        })
      });
    } catch (error) {
      invalidSourceRejected = /不存在或不是目录/.test(error.message);
    }
    assert(invalidSourceRejected, 'case create allowed missing shared source directory');
    const minimalCase = await api('/cases', {
      method: 'POST',
      body: JSON.stringify({
        weixinNick: '最小验收兼职',
        douyinUrl: 'https://www.douyin.com/video/minimal-smoke',
        project: '吸脂',
        sourceMaterialDir: makeSharedSourceDir(ROOT_DIR, '最小验收兼职')
      })
    });
    const retiredReturnDir = path.join(minimalCase.localCaseDir, ['04', '发布回收'].join('-'));
    assert(minimalCase.weixinNick === '最小验收兼职', 'minimal case did not preserve required WeChat nickname');
    assert(minimalCase.persona.city && minimalCase.persona.motivation, 'minimal case defaults missing');
    assert(!minimalCase.localCaseDir.includes('未命名'), 'minimal case directory used unnamed segment');
    assert(!fs.existsSync(retiredReturnDir), 'minimal case created retired publish return folder');
    assert(minimalCase.slotsCreated >= 14, 'minimal case did not auto generate default slots');
    const minimalDetail = await api(`/cases/${minimalCase.id}`);
    assert(minimalDetail.slots.length >= 14 && minimalDetail.slots.every((item) => item.status === '待生成'), 'minimal case default slots missing');
    const dueOnlyDashboard = await api('/dashboard');
    assert(dueOnlyDashboard.pendingGenerate.every((item) => item.date <= dueOnlyDashboard.today), 'dashboard leaked future pending generation slots');
    const minimalAfterRolling = await api(`/cases/${minimalCase.id}`);
    assert(minimalAfterRolling.slots.length >= 14, 'dashboard did not roll schedule forward for active case');
    const throttleCase = await api('/cases', {
      method: 'POST',
      body: JSON.stringify({
        weixinNick: '降频验收兼职',
        douyinUrl: 'https://www.douyin.com/user/throttle-smoke',
        project: '吸脂',
        sourceMaterialDir: makeSharedSourceDir(ROOT_DIR, '降频验收兼职')
      })
    });
    const throttleIngest = await api('/douyin-monitor/ingest', {
      method: 'POST',
      body: JSON.stringify({
        caseId: throttleCase.id,
        collectedAt: '2026-06-01T15:00:00.000Z',
        source: 'chrome-agent',
        account: { fans: 66, following: 12, totalLikes: 180, totalWorks: 2 },
        videos: [
          { videoId: 'throttle-video-1', url: 'https://www.douyin.com/video/throttle-1', title: '降频低播放1', publishTime: '2026-06-01', plays: 800, likes: 20, comments: 4 },
          { videoId: 'throttle-video-2', url: 'https://www.douyin.com/video/throttle-2', title: '降频低播放2', publishTime: '2026-06-01', plays: 1200, likes: 28, comments: 8 }
        ]
      })
    });
    assert(throttleIngest.scheduleMaintenance?.prunedCount > 0, 'cold ingest did not immediately prune future pending slots');
    const throttleMonitor = await api('/douyin-monitor');
    const throttleAccount = throttleMonitor.accounts.find((item) => item.case?.id === throttleCase.id);
    assert(throttleAccount?.activityTier === '偏冷', 'two cold videos should mark account cold');
    assert(throttleAccount.postingStrategy?.mode === '两天一条', 'cold account should throttle posting');
    assert(throttleAccount.collectionPolicy?.intervalHours === 72, 'cold account should collect every three days');
    const throttleDetail = await api(`/cases/${throttleCase.id}`);
    assert(throttleDetail.slots.length > 0 && throttleDetail.slots.length <= 8, 'throttled account generated too many future slots');
    assert(throttleDetail.monitor.postingStrategy?.mode === '两天一条', 'case detail missing throttled posting strategy');
    const throttleActionSlot = await api('/douyin-monitor/actions/slot', {
      method: 'POST',
      body: JSON.stringify({ caseId: throttleCase.id, kind: '偏冷补内容' })
    });
    assert(throttleActionSlot.created === true && throttleActionSlot.slot.contentKind === '爆款提权', 'throttled strategy action did not create one viral slot');
    const repeatedThrottleAction = await api('/douyin-monitor/actions/slot', {
      method: 'POST',
      body: JSON.stringify({ caseId: throttleCase.id, kind: '偏冷补内容' })
    });
    assert(repeatedThrottleAction.created === false && repeatedThrottleAction.slot.id === throttleActionSlot.slot.id, 'throttled strategy action duplicated instead of reusing existing slot');

    const sleepCase = await api('/cases', {
      method: 'POST',
      body: JSON.stringify({
        weixinNick: '休眠验收兼职',
        douyinUrl: 'https://www.douyin.com/user/sleep-smoke',
        project: '吸脂',
        sourceMaterialDir: makeSharedSourceDir(ROOT_DIR, '休眠验收兼职')
      })
    });
    const sleepBeforeIngest = await api(`/cases/${sleepCase.id}`);
    const sleepPreparedSlot = sleepBeforeIngest.slots[0];
    await api(`/slots/${sleepPreparedSlot.id}/generate-candidates`, { method: 'POST' });
    const sleepIngest = await api('/douyin-monitor/ingest', {
      method: 'POST',
      body: JSON.stringify({
        caseId: sleepCase.id,
        collectedAt: '2026-05-20T16:00:00.000Z',
        source: 'chrome-agent',
        account: { fans: 52, following: 10, totalLikes: 120, totalWorks: 3 },
        videos: [
          { videoId: 'sleep-video-1', url: 'https://www.douyin.com/video/sleep-1', title: '休眠低播放1', publishTime: '2026-06-01', plays: 500, likes: 12, comments: 2 },
          { videoId: 'sleep-video-2', url: 'https://www.douyin.com/video/sleep-2', title: '休眠低播放2', publishTime: '2026-06-01', plays: 700, likes: 16, comments: 3 },
          { videoId: 'sleep-video-3', url: 'https://www.douyin.com/video/sleep-3', title: '休眠低播放3', publishTime: '2026-06-01', plays: 900, likes: 18, comments: 4 }
        ]
      })
    });
    assert(sleepIngest.scheduleMaintenance?.prunedCount > 0, 'sleeping ingest did not immediately remove future pending slots');
    assert(sleepIngest.scheduleMaintenance?.canceledCount >= 1, 'sleeping ingest did not cancel prepared unsent slots');
    const sleepMonitor = await api('/douyin-monitor');
    const sleepAccount = sleepMonitor.accounts.find((item) => item.case?.id === sleepCase.id);
    assert(sleepAccount?.activityTier === '休眠', 'three cold videos should mark account sleeping');
    assert(sleepAccount.postingStrategy?.mode === '暂停自动补', 'sleeping account should pause automatic posting');
    assert(sleepAccount.collectionPolicy?.intervalHours === 168, 'sleeping account should collect weekly');
    const sleepDashboard = await api('/dashboard');
    assert(!sleepDashboard.monitorActions.some((item) => item.kind === '偏冷补内容' && item.case?.id === sleepCase.id), 'sleeping account should not show cold content action');
    const sleepDetail = await api(`/cases/${sleepCase.id}`);
    assert(!sleepDetail.slots.some((item) => ['待生成', '候选待选', '已锁定', '素材阻塞', '可交付', '已派发', '异常'].includes(item.status)), 'sleeping account should not keep active operator slots');
    assert(sleepDetail.slots.some((item) => item.id === sleepPreparedSlot.id && item.status === '已取消'), 'sleeping account should cancel prepared unsent slot');
    const sleepActionSlot = await api('/douyin-monitor/actions/slot', {
      method: 'POST',
      body: JSON.stringify({ caseId: sleepCase.id, kind: '偏冷补内容' })
    });
    assert(sleepActionSlot.created === false && !sleepActionSlot.slot && sleepActionSlot.reason.includes('暂停'), 'sleeping account strategy action should not create a slot');
    const hotQueueCase = await api('/cases', {
      method: 'POST',
      body: JSON.stringify({
        weixinNick: '起量采集验收兼职',
        douyinUrl: 'https://www.douyin.com/user/hot-queue-smoke',
        project: '吸脂',
        sourceMaterialDir: makeSharedSourceDir(ROOT_DIR, '起量采集验收兼职')
      })
    });
    await api('/douyin-monitor/ingest', {
      method: 'POST',
      body: JSON.stringify({
        caseId: hotQueueCase.id,
        collectedAt: '2026-05-20T17:00:00.000Z',
        source: 'chrome-agent',
        account: { fans: 300, following: 12, totalLikes: 3000, totalWorks: 4 },
        videos: [
          { videoId: 'hot-queue-video-1', url: 'https://www.douyin.com/video/hot-queue-1', title: '起量采集排序', publishTime: '2026-05-20', plays: 9000, likes: 620, comments: 90 }
        ]
      })
    });
    const priorityChromeQueue = await api('/douyin-monitor/chrome-queue?includeFresh=1&limit=200');
    const hotQueueIndex = priorityChromeQueue.targets.findIndex((item) => item.caseId === hotQueueCase.id);
    const sleepQueueIndex = priorityChromeQueue.targets.findIndex((item) => item.caseId === sleepCase.id);
    assert(hotQueueIndex >= 0 && sleepQueueIndex >= 0 && hotQueueIndex < sleepQueueIndex, 'chrome collection queue should prioritize active or hot accounts before sleeping accounts');
    assert(priorityChromeQueue.targets[hotQueueIndex].collectionPriority > priorityChromeQueue.targets[sleepQueueIndex].collectionPriority, 'chrome collection queue missing activity priority scores');

    const lostCase = await api('/cases', {
      method: 'POST',
      body: JSON.stringify({
        weixinNick: '失联验收兼职',
        douyinUrl: 'https://www.douyin.com/user/lost-smoke',
        project: '吸脂',
        sourceMaterialDir: makeSharedSourceDir(ROOT_DIR, '失联验收兼职')
      })
    });
    await api(`/cases/${lostCase.id}/slots`, {
      method: 'POST',
      body: JSON.stringify({ date: '2026-05-28', contentKind: '日常养号', stage: '起号期', goal: '失联派发验收', status: '已派发' })
    });
    const lostMonitor = await api('/douyin-monitor');
    const lostAccount = lostMonitor.accounts.find((item) => item.case?.id === lostCase.id);
    assert(lostAccount?.activityTier === '失联暂停', 'overdue sent slot should mark account lost');
    assert(lostAccount.lostContact?.paused === true, 'lost account should be automatically paused');
    assert(lostAccount.postingStrategy?.mode === '暂停自动补', 'lost account should pause automatic posting');
    assert(lostAccount.collectionPolicy?.intervalHours == null, 'lost account should not enter collection queue');
    const lostDashboard = await api('/dashboard');
    assert(!lostDashboard.monitorActions.some((item) => item.kind === '失联处理' && item.case?.id === lostCase.id), 'lost account should not ask staff to confirm pause');
    assert(!lostDashboard.todaySlots.some((item) => item.case?.id === lostCase.id), 'lost account leaked into normal due slots');
    const lostAfterPrune = await api(`/cases/${lostCase.id}`);
    assert(lostAfterPrune.case.healthStatus === '失联暂停', 'lost account case was not auto-paused');
    assert(!lostAfterPrune.slots.some((item) => ['待生成', '候选待选', '已锁定', '素材阻塞', '可交付', '已派发', '异常'].includes(item.status)), 'auto-paused lost account still has active slots');
    assert(!lostAfterPrune.slots.some((item) => item.date >= lostDashboard.today && item.status === '待生成'), 'lost account future pending slots were not pruned');
    const lostChromeQueue = await api('/douyin-monitor/chrome-queue?includeFresh=1&limit=200');
    assert(!lostChromeQueue.targets.some((item) => item.caseId === lostCase.id), 'lost account appeared in chrome collection queue');
    const editHealthResponse = await fetch(`${BASE}/cases/${lostCase.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ healthStatus: '健康' })
    });
    assert(editHealthResponse.status === 400, 'case edit health status override was allowed');
    const afterEditHealthAttempt = await api(`/cases/${lostCase.id}`);
    assert(afterEditHealthAttempt.case.healthStatus === '失联暂停', 'case edit health status override changed paused account');
    const resumeWithoutConfirm = await fetch(`${BASE}/cases/${lostCase.id}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...E2E_SETUP_HEADER }
    });
    assert(resumeWithoutConfirm.status === 409, 'resume without reply confirmation should be blocked');
    const stillPausedLost = await api(`/cases/${lostCase.id}`);
    assert(stillPausedLost.case.healthStatus === '失联暂停', 'unconfirmed resume changed paused account status');
    assert(!stillPausedLost.slots.some((item) => item.date >= lostDashboard.today && item.status === '待生成'), 'unconfirmed resume created new schedule');
    const resumedLost = await api(`/cases/${lostCase.id}/resume`, { method: 'POST', body: JSON.stringify({ resumeConfirmed: true }) });
    assert(resumedLost.case.healthStatus === '健康', 'resume did not restore case health');
    assert(resumedLost.slotsCreated >= 1, 'resume did not create new schedule');
    assert(resumedLost.collectionQueue?.registeredCount === 1 && resumedLost.collectionQueue.runs[0]?.caseId === lostCase.id, 'resume did not immediately queue Chrome collection');
    const resumedLostDetail = await api(`/cases/${lostCase.id}`);
    assert(resumedLostDetail.slots.some((item) => item.status === '已取消'), 'resume did not keep stale sent slot as cancelled');
    assert(resumedLostDetail.slots.some((item) => item.date >= lostDashboard.today && item.status === '待生成'), 'resume did not create future pending slot');
    assert(resumedLostDetail.monitor.activityTier !== '失联暂停', 'resumed account still marked lost');
    await deleteCase(throttleCase);
    await deleteCase(sleepCase);
    await deleteCase(hotQueueCase);
    await deleteCase(lostCase);
    const noAssetSlot = minimalDetail.slots[0];
    const noAssetDrafts = await api(`/slots/${noAssetSlot.id}/generate-candidates`, { method: 'POST' });
    await api(`/candidates/${noAssetDrafts[0].id}/select`, { method: 'POST' });
    const blockedDelivery = await api(`/slots/${noAssetSlot.id}/delivery`, { method: 'POST' });
    assert(blockedDelivery.blocked && blockedDelivery.slot.status === '素材阻塞', 'delivery without assets was not blocked');
    assert(fs.existsSync(path.join(blockedDelivery.deliveryDir, '00-素材阻塞说明.txt')), 'blocked delivery note missing');
    const blockedDashboard = await api('/dashboard');
    assert(blockedDashboard.todaySlots.some((item) => item.id === noAssetSlot.id && item.status === '素材阻塞'), 'blocked slot missing from dashboard');
    const manifestPath = path.join(caze.localCaseDir, 'case.json');
    assert(fs.existsSync(manifestPath), 'case manifest missing');
    const editedCase = await api(`/cases/${caze.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ weixinNick: '验收兼职改名', persona: { ...caze.persona, city: '重庆' } })
    });
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert(editedCase.weixinNick === '验收兼职改名' && manifest.weixinNick === '验收兼职改名', 'case manifest not synced after edit');

    fs.writeFileSync(path.join(caze.localCaseDir, '00-原始素材', 'D1-test.jpg'), 'fake image');
    fs.writeFileSync(path.join(caze.localCaseDir, '00-原始素材', 'D1-test.mp4'), 'fake video');
    const beforeBlockedScan = await api(`/cases/${caze.id}`);
    const nonHeadScanResponse = await fetch(`${BASE}/cases/${caze.id}/scan-assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    assert(nonHeadScanResponse.status === 409, 'non-head material scan was allowed');
    const afterBlockedScan = await api(`/cases/${caze.id}`);
    assert(afterBlockedScan.assets.length === beforeBlockedScan.assets.length, 'non-head material scan inserted assets');
    const scan = await api(`/cases/${caze.id}/scan-assets`, { method: 'POST' });
    assert(scan.inserted === 2, 'asset scan did not insert two files');
    const nonHeadAssetPatch = await fetch(`${BASE}/assets/${scan.assets[0].id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewStatus: '可用' })
    });
    assert(nonHeadAssetPatch.status === 409, 'non-head asset patch was allowed');
    const afterBlockedAssetPatch = await api(`/cases/${caze.id}`);
    assert(afterBlockedAssetPatch.assets.find((item) => item.id === scan.assets[0].id)?.reviewStatus !== '可用', 'non-head asset patch changed review status');
    await api(`/assets/${scan.assets[0].id}`, { method: 'PATCH', body: JSON.stringify({ reviewStatus: '可用' }) });
    const withGaps = await api(`/cases/${caze.id}`);
    assert(Array.isArray(withGaps.materialGaps) && withGaps.materialGaps.length > 0, 'material gaps missing');
    assert(Array.isArray(withGaps.healthReasons), 'health reasons missing');
    assert(Array.isArray(withGaps.healthActions) && withGaps.healthActions.length > 0, 'health actions missing');
    const gapDashboard = await api('/dashboard');
    const gapCase = gapDashboard.abnormalCases.find((item) => item.id === caze.id);
    assert(gapDashboard.counts.requiredMaterialGaps >= 1, 'dashboard missing required material gap count');
    assert(gapCase?.materialGaps?.some((gap) => gap.status === '必补'), 'dashboard missing material gap details');
    const intakeNote = await api(`/cases/${caze.id}/material-intake-note`);
    assert(intakeNote.text.includes('素材补齐说明') && intakeNote.text.includes('同步共享素材') && intakeNote.text.includes(sharedSourceDir), 'material intake note missing shared source workflow');
    assert(intakeNote.text.includes('必补素材') && intakeNote.text.includes(caze.caseCode), 'material intake note missing gap summary');
    let missingImagePurposeRejected = false;
    try {
      await api('/image-tasks', {
        method: 'POST',
        body: JSON.stringify({ caseId: caze.id })
      });
    } catch (error) {
      missingImagePurposeRejected = /明确用途/.test(error.message);
    }
    assert(missingImagePurposeRejected, 'image task without explicit purpose was allowed');
    let customImagePromptRejected = false;
    try {
      await api('/image-tasks', {
        method: 'POST',
        body: JSON.stringify({
          caseId: caze.id,
          purpose: withGaps.materialGaps[0].label,
          prompt: '临时写一个自由发挥图片提示词',
          sourceMaterials: [{ path: '/tmp/manual.jpg', role: '手填参考' }]
        })
      });
    } catch (error) {
      customImagePromptRejected = /系统按素材缺口生成/.test(error.message);
    }
    assert(customImagePromptRejected, 'image task accepted a custom prompt or source materials');
    const nonHeadImageCreateResponse = await fetch(`${BASE}/image-tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caseId: caze.id, purpose: '非队首缺口建图验收' })
    });
    const nonHeadImageCreateBody = await nonHeadImageCreateResponse.json();
    assert(nonHeadImageCreateResponse.status === 409 && /素材动作不是今日操作队列队首/.test(nonHeadImageCreateBody.error), 'non-head image task was allowed to create');
    const afterBlockedImageCreate = await api(`/cases/${caze.id}`);
    assert(!afterBlockedImageCreate.imageTasks.some((item) => item.purpose === '非队首缺口建图验收'), 'non-head image task create inserted a task');
    const gapImage = await api('/image-tasks', {
      method: 'POST',
      body: JSON.stringify({ caseId: caze.id, purpose: withGaps.materialGaps[0].label })
    });
    assert(gapImage.purpose === withGaps.materialGaps[0].label, 'gap image task failed');
    assert(gapImage.prompt.includes(`图片用途：${withGaps.materialGaps[0].label}`), 'gap image task did not use the system prompt');
    assert(fs.existsSync(path.join(gapImage.outputDir, `${gapImage.id}-图片任务说明.txt`)), 'image task brief missing');
    const nonHeadImageReviewResponse = await fetch(`${BASE}/image-tasks/${gapImage.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved' })
    });
    const nonHeadImageReviewBody = await nonHeadImageReviewResponse.json();
    assert(nonHeadImageReviewResponse.status === 409 && /素材动作不是今日操作队列队首/.test(nonHeadImageReviewBody.error), 'non-head image task was allowed to review');
    const afterBlockedImageReview = await api(`/cases/${caze.id}`);
    assert(afterBlockedImageReview.imageTasks.find((item) => item.id === gapImage.id)?.status === gapImage.status, 'non-head image task review changed status');
    const nonHeadImageGenerateResponse = await fetch(`${BASE}/image-tasks/${gapImage.id}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const nonHeadImageGenerateBody = await nonHeadImageGenerateResponse.json();
    assert(nonHeadImageGenerateResponse.status === 409 && /素材动作不是今日操作队列队首/.test(nonHeadImageGenerateBody.error), 'non-head image task was allowed to generate');
    const materialGuardDb = new DatabaseSync(path.join(ROOT_DIR, 'data', 'souren.sqlite'));
    materialGuardDb.prepare('UPDATE cases SET health_status = ? WHERE id = ?').run('失联暂停', materialGuardCase.id);
    materialGuardDb.close();
    const gapImagePrompt = await api(`/image-tasks/${gapImage.id}/prompt`);
    assert(gapImagePrompt.text.includes('正向提示词：') && gapImagePrompt.text.includes('反向提示词：'), 'image prompt copy text missing');
    let imagePromptPatchRejected = false;
    try {
      await api(`/image-tasks/${gapImage.id}`, { method: 'PATCH', body: JSON.stringify({ prompt: '把图片提示词改成临时版本' }) });
    } catch (error) {
      imagePromptPatchRejected = /系统按素材缺口生成/.test(error.message);
    }
    assert(imagePromptPatchRejected, 'image task allowed patching the system prompt');
    let imagePurposePatchRejected = false;
    try {
      await api(`/image-tasks/${gapImage.id}`, { method: 'PATCH', body: JSON.stringify({ purpose: '临时用途' }) });
    } catch (error) {
      imagePurposePatchRejected = /用途来自素材缺口/.test(error.message);
    }
    assert(imagePurposePatchRejected, 'image task allowed patching the source purpose');
    const imageDashboard = await api('/dashboard');
    assert(imageDashboard.counts.imageTasks >= 1 && imageDashboard.counts.imageWaitingKey >= 1, 'dashboard image task counts missing');
    assert(imageDashboard.imageTasks.some((item) => item.id === gapImage.id && item.case?.id === caze.id), 'dashboard image task list missing case task');
    const imageAgentWork = await api('/agent-work');
    assert(imageAgentWork.counts.imageWork >= 1 && imageAgentWork.items.some((item) => item.kind === '图片生成' && item.imageTaskId === gapImage.id), 'agent work queue missing image task work');

    const hospitalSharedDir = path.join(ROOT_DIR, '素材库', '通用素材', '医院素材');
    fs.mkdirSync(hospitalSharedDir, { recursive: true });
    fs.writeFileSync(path.join(hospitalSharedDir, '医院环境.jpg'), 'fake hospital shared material');
    const sharedAssetScan = await api('/shared-assets/scan', { method: 'POST' });
    assert(sharedAssetScan.inserted === 1 && sharedAssetScan.assets.some((asset) => asset.category === '医院素材' && asset.usage === '合成背景'), 'shared material scan failed');
    const sharedAssetList = await api('/shared-assets');
    const sharedAsset = sharedAssetList.find((asset) => asset.path.endsWith('医院环境.jpg'));
    assert(sharedAsset?.url?.startsWith('/shared-files/') && sharedAsset.reviewStatus === '可用', 'shared material list missing url or status');
    const patchedSharedAsset = await api(`/shared-assets/${sharedAsset.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ category: '套图素材', usage: '套图参考', reviewStatus: '待处理' })
    });
    assert(patchedSharedAsset.category === '套图素材' && patchedSharedAsset.usage === '套图参考' && patchedSharedAsset.reviewStatus === '待处理', 'shared material patch failed');
    await api(`/shared-assets/${sharedAsset.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ category: '医院素材', usage: '合成背景', reviewStatus: '可用' })
    });
    const sharedConfig = await api('/config');
    assert(sharedConfig.sharedMaterialRoot.endsWith(path.join('素材库', '通用素材')) && sharedConfig.sharedAssets.total === 1 && sharedConfig.sharedAssets.byUsage.some((item) => item.usage === '合成背景'), 'config missing shared material stats');
    const compositionImage = await api('/image-tasks', {
      method: 'POST',
      body: JSON.stringify({ caseId: caze.id, purpose: '种草配图' })
    });
    assert(compositionImage.sourceMaterials.some((item) => item.role === '案例人物参考' || item.role === '案例变化参考'), 'image task missing case reference material');
    assert(compositionImage.sourceMaterials.some((item) => item.role === '医院/场景素材' && item.usage === '合成背景'), 'image task missing shared hospital material');

    const prepareSlot = await api(`/cases/${caze.id}/slots`, {
      method: 'POST',
      body: JSON.stringify({ date: '2026-06-01', contentKind: '日常养号', stage: '起号期', goal: '队首准备验收' })
    });
    const prepared = await api('/dashboard/prepare-today', { method: 'POST' });
    assert(prepared.deliveryCount <= 1 && prepared.deliveries.length <= 1, 'dashboard prepare today processed more than one queue item');
    assert(prepared.processedId === null || prepared.processedId === prepared.queueHead?.slot?.id, 'dashboard prepare today did not stay on queue head');
    const preparedDetail = await api(`/cases/${caze.id}`);
    const preparedSlot = preparedDetail.slots.find((item) => item.id === prepareSlot.id);
    if (prepared.processedId === prepareSlot.id) {
      assert(['可交付', '素材阻塞'].includes(preparedSlot.status), 'queue-head prepare did not advance the current slot');
    } else {
      assert(preparedSlot.status === '待生成' && !preparedSlot.deliveryDir, 'dashboard prepare today jumped past the queue head');
    }

    const forbiddenSlotGoal = '直接创建已派发排期验收';
    const forbiddenSlotResponse = await fetch(`${BASE}/cases/${caze.id}/slots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-06-01', contentKind: '素人种草', stage: '起号期', goal: forbiddenSlotGoal, status: '已派发' })
    });
    assert(forbiddenSlotResponse.status === 400, 'manual slot creation allowed direct sent status');
    const afterForbiddenSlotCreate = await api(`/cases/${caze.id}`);
    assert(!afterForbiddenSlotCreate.slots.some((item) => item.goal === forbiddenSlotGoal), 'manual slot status override inserted a slot');

    const manualSlot = await api(`/cases/${caze.id}/slots`, {
      method: 'POST',
      body: JSON.stringify({ date: '2026-06-01', contentKind: '素人种草', stage: '起号期', goal: '手动槽位验收' })
    });
    assert(manualSlot.contentKind === '素人种草', 'manual slot failed');
    const seededDrafts = await api(`/slots/${manualSlot.id}/generate-candidates`, { method: 'POST' });
    assert(seededDrafts.some((draft) => draft.sourceTemplateId === seed.id), 'seed was not used for daily content');

    const schedule = await api('/schedule');
    assert(schedule.counts.total >= 1, 'schedule total missing');
    assert(schedule.days.some((day) => day.items.some((item) => item.case?.id === caze.id)), 'schedule case slot missing');
    const slot = manualSlot;
    const drafts = seededDrafts;
    assert(drafts.length === 3, 'candidate count is not 3');
    await api(`/candidates/${drafts[0].id}/select`, { method: 'POST' });
    const selectedSchedule = await api('/schedule');
    const selectedScheduleSlot = selectedSchedule.slots.find((item) => item.id === slot.id);
    assert(selectedScheduleSlot?.selectedCandidate?.publishText, 'schedule missing selected candidate copy data');
    let lockedRejected = false;
    try {
      await api(`/slots/${slot.id}/generate-candidates`, { method: 'POST' });
    } catch (error) {
      lockedRejected = /409/.test(error.message) || /锁定/.test(error.message);
    }
    assert(lockedRejected, 'locked slot allowed candidate regeneration');
    let detachedClipRejected = false;
    try {
      await api('/clip-tasks', { method: 'POST', body: JSON.stringify({ caseId: caze.id, title: '无排期剪辑任务' }) });
    } catch (error) {
      detachedClipRejected = /具体排期/.test(error.message);
    }
    assert(detachedClipRejected, 'clip task without a plan slot was allowed');
    let customClipBriefRejected = false;
    try {
      await api('/clip-tasks', {
        method: 'POST',
        body: JSON.stringify({
          caseId: caze.id,
          planSlotId: slot.id,
          title: '临时剪辑说明验收',
          brief: '临时加一段自由发挥剪辑要求'
        })
      });
    } catch (error) {
      customClipBriefRejected = /固定剪辑配方/.test(error.message);
    }
    assert(customClipBriefRejected, 'clip task accepted a custom brief instead of the fixed recipe');
    let clipCreateStatusRejected = false;
    try {
      await api('/clip-tasks', {
        method: 'POST',
        body: JSON.stringify({
          caseId: caze.id,
          planSlotId: slot.id,
          title: '直接完成剪辑任务',
          status: 'completed',
          recipeConfirmed: true
        })
      });
    } catch (error) {
      clipCreateStatusRejected = /不能手动指定状态/.test(error.message);
    }
    assert(clipCreateStatusRejected, 'clip task creation accepted a manual status');
    const clip = await api('/clip-tasks', { method: 'POST', body: JSON.stringify({ caseId: caze.id, planSlotId: slot.id, title: '验收剪辑任务' }) });
    assert(clip.status === 'waiting_edit', 'clip task did not start as waiting edit');
    const repeatedClip = await api('/clip-tasks', { method: 'POST', body: JSON.stringify({ caseId: caze.id, planSlotId: slot.id, title: '验收重复剪辑任务' }) });
    assert(repeatedClip.id === clip.id && repeatedClip.alreadyExisting === true, 'duplicate clip task was created for the same slot');
    assert(clip.brief.includes('固定剪辑配方'), 'clip task response missing fixed edit recipe');
    assert(clip.brief.includes('固定剪辑配方') && clip.brief.includes('不临时改结构'), 'clip brief missing fixed edit recipe');
    assert(clip.brief.includes('剪辑填空卡') && clip.brief.includes('只换这些空') && clip.brief.includes('镜头固定模板'), 'clip brief missing fill-in recipe card');
    assert(clip.brief.includes('不需要上传成片') && !clip.brief.includes('final.mp4 放回'), 'clip brief still asks for final video upload');
    assert(!('outputDir' in clip), 'clip task still exposes a local output directory');
    const clipSchemaDb = new DatabaseSync(path.join(ROOT_DIR, 'data', 'souren.sqlite'));
    const clipColumns = clipSchemaDb.prepare('PRAGMA table_info(clip_tasks)').all().map((item) => item.name);
    clipSchemaDb.close();
    assert(!clipColumns.includes('output_dir') && !clipColumns.includes('final_video_path'), 'clip task table still keeps local output columns');
    let clipReviewStatusRejected = false;
    try {
      await api(`/clip-tasks/${clip.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'review' }) });
    } catch (error) {
      clipReviewStatusRejected = /只需要标记已完成/.test(error.message);
    }
    assert(clipReviewStatusRejected, 'clip task allowed a waiting-confirm status');
    let clipRejectedStatusRejected = false;
    try {
      await api(`/clip-tasks/${clip.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'rejected' }) });
    } catch (error) {
      clipRejectedStatusRejected = /只需要标记已完成/.test(error.message);
    }
    assert(clipRejectedStatusRejected, 'clip task allowed a rework status instead of staying pending');
    let clipBriefPatchRejected = false;
    try {
      await api(`/clip-tasks/${clip.id}`, { method: 'PATCH', body: JSON.stringify({ brief: '把结构改成自由剪辑' }) });
    } catch (error) {
      clipBriefPatchRejected = /固定剪辑配方/.test(error.message);
    }
    assert(clipBriefPatchRejected, 'clip task allowed patching the fixed recipe brief');
    let clipCompletedWithoutRecipeRejected = false;
    try {
      await api(`/clip-tasks/${clip.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'completed' }) });
    } catch (error) {
      clipCompletedWithoutRecipeRejected = /固定剪辑配方/.test(error.message);
    }
    assert(clipCompletedWithoutRecipeRejected, 'clip task completed without viewing fixed recipe');
    const clipDashboard = await api('/dashboard');
    assert(clipDashboard.counts.clipTasks >= 1, 'dashboard clip task count missing');
    assert(clipDashboard.clipTasks.some((item) => item.id === clip.id && item.case?.id === caze.id), 'dashboard clip task list missing case task');
    const reviewedClip = await api(`/clip-tasks/${clip.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'completed', recipeConfirmed: true }) });
    assert(reviewedClip.status === 'completed', 'clip status update failed');
    const clipDashboardAfter = await api('/dashboard');
    assert(!clipDashboardAfter.clipTasks.some((item) => item.id === clip.id), 'completed clip task still shown as pending');
    const delivery = await api(`/slots/${slot.id}/delivery`, { method: 'POST' });
    const wxChecklistPath = path.join(delivery.deliveryDir, '00-微信发送清单.txt');
    assert(fs.existsSync(wxChecklistPath), 'delivery package missing WeChat checklist');
    assert(fs.existsSync(path.join(delivery.deliveryDir, '00-兼职须知.txt')), 'delivery package missing freelancer guide');
    assert(fs.existsSync(path.join(caze.localCaseDir, '00-兼职须知.txt')), 'case folder missing freelancer guide');
    const wxChecklist = fs.readFileSync(wxChecklistPath, 'utf8');
    assert(wxChecklist.includes('发给：验收兼职改名') && wxChecklist.includes('抖音：https://www.douyin.com/') && !wxChecklist.includes('smoke_dy'), 'WeChat checklist missing recipient routing');
    assert(wxChecklist.includes('发送顺序') && wxChecklist.includes('兼职须知') && wxChecklist.includes('完成口径'), 'WeChat checklist missing send or completion instructions');
    const operatorTextPath = path.join(delivery.deliveryDir, '01-发给兼职文案.txt');
    assert(fs.existsSync(operatorTextPath), 'delivery package missing operator text');
    const operatorTextFile = fs.readFileSync(operatorTextPath, 'utf8');
    assert(!operatorTextFile.includes('系统动作'), 'operator text should not include internal system action');
    assert(fs.existsSync(path.join(delivery.deliveryDir, '05-素材顺序清单.txt')), 'delivery asset order file missing');
    assert(delivery.copiedAssets.length >= 1, 'delivery copied asset list missing');
    const deliveryView = await api(`/slots/${slot.id}/delivery-view`);
    assert(deliveryView.texts.operatorInstruction.includes('微信收件人：验收兼职改名'), 'delivery view missing operator instruction');
    assert(deliveryView.texts.operatorInstruction.includes('固定发布说明') && deliveryView.texts.operatorInstruction.includes('时间窗') && deliveryView.texts.operatorInstruction.includes('话题只用文案里已有的'), 'delivery view missing fixed publish instructions');
    assert(!deliveryView.texts.operatorInstruction.includes('系统动作'), 'delivery view should not expose internal system action');
    assert(!deliveryView.texts.operatorInstruction.includes('smoke_dy /') && !deliveryView.texts.operatorInstruction.includes(' / https://www.douyin.com/'), 'delivery view still displays derived Douyin id');
    assert(deliveryView.texts.freelancerGuide.includes('兼职须知') && deliveryView.texts.freelancerGuide.includes('发完后回复') && deliveryView.texts.freelancerGuide.includes('话题只用抖音发布文案里已有的'), 'delivery view missing freelancer guide');
    assert(deliveryView.texts.publishText.includes(drafts[0].title), 'delivery view missing publish text');
    assert(deliveryView.mediaFiles.length >= 1 && deliveryView.mediaFiles[0].url.startsWith('/files/'), 'delivery view missing downloadable media');
    assert(Array.isArray(deliveryView.handoffDone) && deliveryView.handoffDone.length === 0, 'new delivery should start with empty persisted handoff progress');
    const deliveryHandoffKeys = handoffDoneForDeliveryView(deliveryView);
    let handoffOutOfOrderRejected = false;
    try {
      await api(`/slots/${slot.id}/handoff`, {
        method: 'PATCH',
        body: JSON.stringify({ handoffDone: [deliveryHandoffKeys[1]] })
      });
    } catch (error) {
      handoffOutOfOrderRejected = /按发送顺序/.test(error.message);
    }
    assert(handoffOutOfOrderRejected, 'handoff progress allowed saving a later step before recipient confirmation');
    const partialHandoff = await api(`/slots/${slot.id}/handoff`, {
      method: 'PATCH',
      body: JSON.stringify({ handoffDone: [deliveryHandoffKeys[0]] })
    });
    assert(partialHandoff.handoffDone.length === 1 && partialHandoff.handoffDone[0] === deliveryHandoffKeys[0], 'handoff progress did not persist the first step');
    const reopenedPartialDeliveryView = await api(`/slots/${slot.id}/delivery-view`);
    assert(reopenedPartialDeliveryView.handoffDone.length === 1 && reopenedPartialDeliveryView.handoffDone[0] === deliveryHandoffKeys[0], 'delivery view did not restore persisted handoff progress after reopening');
    let handoffRollbackRejected = false;
    try {
      await api(`/slots/${slot.id}/handoff`, {
        method: 'PATCH',
        body: JSON.stringify({ handoffDone: [] })
      });
    } catch (error) {
      handoffRollbackRejected = /不能回退/.test(error.message);
    }
    assert(handoffRollbackRejected, 'handoff progress allowed clearing already completed steps');
    const afterRollbackAttemptView = await api(`/slots/${slot.id}/delivery-view`);
    assert(afterRollbackAttemptView.handoffDone.length === 1 && afterRollbackAttemptView.handoffDone[0] === deliveryHandoffKeys[0], 'handoff rollback changed persisted progress');

    const staleMediaSlot = await api(`/cases/${caze.id}/slots`, {
      method: 'POST',
      body: JSON.stringify({ date: '2026-06-23', contentKind: '日常养号', stage: '起号期', goal: '交付素材丢失门禁验收' })
    });
    const staleMediaDrafts = await api(`/slots/${staleMediaSlot.id}/generate-candidates`, { method: 'POST' });
    await api(`/candidates/${staleMediaDrafts[0].id}/select`, { method: 'POST' });
    const staleMediaDelivery = await api(`/slots/${staleMediaSlot.id}/delivery`, { method: 'POST' });
    fs.readdirSync(staleMediaDelivery.deliveryDir)
      .filter((file) => /\.(jpe?g|png|webp|gif|heic|mp4|mov|m4v|avi|webm)$/i.test(file))
      .forEach((file) => fs.rmSync(path.join(staleMediaDelivery.deliveryDir, file), { force: true }));
    const staleMediaView = await api(`/slots/${staleMediaSlot.id}/delivery-view`);
    assert(staleMediaView.mediaFiles.length === 0, 'stale delivery media simulation failed');
    let dispatchWithoutMediaRejected = false;
    let dispatchWithoutMediaError = '';
    try {
      await api(`/slots/${staleMediaSlot.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: '已派发', handoffDone: handoffDoneForDeliveryView(staleMediaView) })
      });
    } catch (error) {
      dispatchWithoutMediaError = error.message;
      dispatchWithoutMediaRejected = /可发送图片或视频/.test(error.message);
    }
    assert(dispatchWithoutMediaRejected, `ready delivery without media was allowed to dispatch: ${dispatchWithoutMediaError || 'status changed to sent'}`);
    const staleMediaDb = new DatabaseSync(path.join(ROOT_DIR, 'data', 'souren.sqlite'));
    staleMediaDb.prepare('UPDATE plan_slots SET status = ? WHERE id = ?').run('已取消', staleMediaSlot.id);
    staleMediaDb.close();

    const nonHeadGenerateSlot = await api(`/cases/${caze.id}/slots`, {
      method: 'POST',
      body: JSON.stringify({ date: '2026-06-20', contentKind: '日常养号', stage: '起号期', goal: '非队首生成门禁验收' })
    });
    const nonHeadGenerateResponse = await fetch(`${BASE}/slots/${nonHeadGenerateSlot.id}/generate-candidates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    assert(nonHeadGenerateResponse.status === 409, 'non-head slot was allowed to generate candidates');
    const nonHeadSelectSlot = await api(`/cases/${caze.id}/slots`, {
      method: 'POST',
      body: JSON.stringify({ date: '2026-06-21', contentKind: '日常养号', stage: '起号期', goal: '非队首选稿门禁验收' })
    });
    const nonHeadSelectDrafts = await api(`/slots/${nonHeadSelectSlot.id}/generate-candidates`, { method: 'POST' });
    const nonHeadSelectResponse = await fetch(`${BASE}/candidates/${nonHeadSelectDrafts[0].id}/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    assert(nonHeadSelectResponse.status === 409, 'non-head slot was allowed to select a candidate');
    const nonHeadDeliverySlot = await api(`/cases/${caze.id}/slots`, {
      method: 'POST',
      body: JSON.stringify({ date: '2026-06-22', contentKind: '日常养号', stage: '起号期', goal: '非队首交付门禁验收' })
    });
    const nonHeadDeliveryDrafts = await api(`/slots/${nonHeadDeliverySlot.id}/generate-candidates`, { method: 'POST' });
    await api(`/candidates/${nonHeadDeliveryDrafts[0].id}/select`, { method: 'POST' });
    const nonHeadDeliveryResponse = await fetch(`${BASE}/slots/${nonHeadDeliverySlot.id}/delivery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    assert(nonHeadDeliveryResponse.status === 409, 'non-head slot was allowed to generate delivery');
    const nonHeadDispatchSlot = await api(`/cases/${caze.id}/slots`, {
      method: 'POST',
      body: JSON.stringify({ date: '2026-06-01', contentKind: '日常养号', stage: '起号期', goal: '非队首派发验收' })
    });
    const nonHeadDispatchDrafts = await api(`/slots/${nonHeadDispatchSlot.id}/generate-candidates`, { method: 'POST' });
    await api(`/candidates/${nonHeadDispatchDrafts[0].id}/select`, { method: 'POST' });
    await api(`/slots/${nonHeadDispatchSlot.id}/delivery`, { method: 'POST' });
    const nonHeadDispatchView = await api(`/slots/${nonHeadDispatchSlot.id}/delivery-view`);
    const nonHeadDispatchResponse = await fetch(`${BASE}/slots/${nonHeadDispatchSlot.id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: '已派发', handoffDone: handoffDoneForDeliveryView(nonHeadDispatchView) })
    });
    assert(nonHeadDispatchResponse.status === 409, 'non-head ready delivery was allowed to dispatch');
    const mediaResponse = await fetch(`${ORIGIN}${deliveryView.mediaFiles[0].url}`);
    assert(mediaResponse.ok, 'delivery media url did not serve material file');
    const lockedDeliveryResponse = await fetch(`${BASE}/slots/${slot.id}/delivery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    assert(lockedDeliveryResponse.status === 409, 'ready delivery allowed regeneration');
    const lockedCandidateResponse = await fetch(`${BASE}/candidates/${drafts[1].id}/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    assert(lockedCandidateResponse.status === 409, 'delivered slot allowed candidate reselection');
    const envLeak = await fetch(`${ORIGIN}/files/app/.env`);
    assert(envLeak.status === 404, 'files route exposed app env file');
    const dbLeak = await fetch(`${ORIGIN}/files/data/souren.sqlite`);
    assert(dbLeak.status === 404, 'files route exposed sqlite database');
    const deliveryDashboard = await api('/dashboard');
    const deliveryDashboardSlot = deliveryDashboard.readyDelivery.find((item) => item.id === slot.id)
      || deliveryDashboard.todaySlots.find((item) => item.id === slot.id);
    assert(deliveryDashboardSlot?.selectedCandidate?.operatorInstruction, 'dashboard missing ready delivery copy data');
    assert(deliveryDashboardSlot.case.weixinNick === '验收兼职改名', 'dashboard missing case recipient');
    assert(Number.isInteger(deliveryDashboard.counts.locked) && Number.isInteger(deliveryDashboard.counts.sentWaitDone), 'dashboard work split counts missing');
    assert(!('sentWaitReport' in deliveryDashboard.counts), 'dashboard still exposes old sent wait report count');
    assert(Array.isArray(deliveryDashboard.priorityActions), 'dashboard missing backend priority action queue');
    assert(deliveryDashboard.priorityActions.length > 0, 'dashboard priority action queue unexpectedly empty');
    assert(deliveryDashboard.queueHead?.id === deliveryDashboard.priorityActions[0].id, 'dashboard queueHead diverged from first priority action');
    assert(deliveryDashboard.queueHead.case?.weixinNick && deliveryDashboard.queueHead.title && deliveryDashboard.queueHead.detail && deliveryDashboard.queueHead.note, 'backend queue head missing display fields');

    const complianceSeed = await api('/content-seeds', {
      method: 'POST',
      body: JSON.stringify({
        project: '合规验收项目',
        stage: '起号期',
        contentKind: '素人种草',
        format: '图文',
        titleTemplate: '保证当天见效的记录',
        contentTemplate: '这个内容写着保证当天见效，用来验收合规阻断。',
        tags: ['合规验收'],
        baseWeight: 1
      })
    });
    assert(complianceSeed.id, 'compliance seed not created');
    const complianceCase = await api('/cases', {
      method: 'POST',
      body: JSON.stringify({
        weixinNick: '合规验收兼职',
        douyinUrl: 'https://www.douyin.com/user/compliance-smoke',
        project: '合规验收项目',
        sourceMaterialDir: makeSharedSourceDir(ROOT_DIR, '合规验收兼职')
      })
    });
    const complianceSlot = await api(`/cases/${complianceCase.id}/slots`, {
      method: 'POST',
      body: JSON.stringify({ date: '2026-06-01', contentKind: '素人种草', stage: '起号期', goal: '合规阻断验收' })
    });
    const complianceDrafts = await api(`/slots/${complianceSlot.id}/generate-candidates`, { method: 'POST' });
    assert(complianceDrafts.every((draft) => draft.complianceHits?.length > 0), 'candidate compliance hits were not written');
    await api(`/candidates/${complianceDrafts[0].id}/select`, { method: 'POST' });
    const complianceDelivery = await api(`/slots/${complianceSlot.id}/delivery`, { method: 'POST' });
    assert(complianceDelivery.blocked === true && complianceDelivery.reason === 'compliance_hits', 'compliance delivery was not blocked');
    assert(complianceDelivery.slot.status === '异常', 'compliance blocked slot was not marked abnormal');
    assert(complianceDelivery.slot.operatorNote === '文案命中合规提示', 'compliance blocked slot missing abnormal note');
    assert(fs.existsSync(path.join(complianceDelivery.deliveryDir, '00-合规阻塞说明.txt')), 'compliance blocked note missing');
    const complianceView = await api(`/slots/${complianceSlot.id}/delivery-view`);
    assert(complianceView.texts.complianceNote.includes('合规提示'), 'compliance delivery view missing note');
    await deleteCase(complianceCase);

    await imageGenerationSmoke();
    await imageKeyOnlyConfigSmoke();
    await authAccessSmoke();
    await lanFailClosedSmoke();
    await lanAccessConfigSmoke();
    await placeholderDouyinCollectionSmoke();

    const videoCase = await api('/cases', {
      method: 'POST',
      body: JSON.stringify({
        weixinNick: '视频验收兼职',
        douyinUrl: 'https://www.douyin.com/user/video-smoke',
        project: '视频验收项目',
        sourceMaterialDir: makeSharedSourceDir(ROOT_DIR, '视频验收兼职')
      })
    });
    fs.writeFileSync(path.join(videoCase.localCaseDir, '00-原始素材', '视频素材.mp4'), 'fake video asset');
    const videoScan = await api(`/cases/${videoCase.id}/scan-assets`, { method: 'POST' });
    for (const asset of videoScan.assets) {
      await api(`/assets/${asset.id}`, { method: 'PATCH', body: JSON.stringify({ reviewStatus: '可用' }) });
    }
    const videoSlot = await api(`/cases/${videoCase.id}/slots`, {
      method: 'POST',
      body: JSON.stringify({ date: '2026-06-06', contentKind: '日常养号', stage: '起号期', goal: '视频交付包验收' })
    });
    const videoDrafts = await api(`/slots/${videoSlot.id}/generate-candidates`, { method: 'POST' });
    const videoDraft = videoDrafts.find((draft) => draft.format === '视频');
    assert(videoDraft, 'video seed did not produce a video candidate');
    await api(`/candidates/${videoDraft.id}/select`, { method: 'POST' });
    const videoDelivery = await api(`/slots/${videoSlot.id}/delivery`, { method: 'POST' });
    assert(fs.existsSync(path.join(videoDelivery.deliveryDir, '03-口播字幕文案.txt')), 'video delivery missing script file');
    assert(fs.existsSync(path.join(videoDelivery.deliveryDir, '04-剪辑要求.txt')), 'video delivery missing edit brief');
    assert(!fs.existsSync(path.join(videoDelivery.deliveryDir, '07-成片回收说明.txt')), 'video delivery should not ask for final video return');
    assert(videoDelivery.copiedAssets.some((asset) => asset.fileName.startsWith('08-')), 'video delivery asset numbering did not avoid task files');
    const videoDeliveryView = await api(`/slots/${videoSlot.id}/delivery-view`);
    assert(videoDeliveryView.isVideo === true && videoDeliveryView.editing.completionNote.includes('不需要上传成片'), 'video delivery view missing completion-only note');
    assert(videoDeliveryView.texts.editBrief.includes('剪辑要求'), 'video delivery view missing edit brief');
    assert(videoDeliveryView.texts.editBrief.includes('固定剪辑配方') && videoDeliveryView.texts.editBrief.includes('只替换素材和标题'), 'video delivery edit brief missing fixed recipe');
    assert(videoDeliveryView.texts.editBrief.includes('剪辑填空卡') && videoDeliveryView.texts.editBrief.includes('只换这些空'), 'video delivery edit brief missing fill-in recipe card');
    assert(!videoDeliveryView.texts.editBrief.includes('final.mp4') && !('finalVideoPath' in videoDeliveryView.editing), 'video delivery still exposes final video path');
    await deleteCase(videoCase);

    const batchDeliverySlot = await api(`/cases/${caze.id}/slots`, {
      method: 'POST',
      body: JSON.stringify({ date: '2026-06-01', contentKind: '日常养号', stage: '起号期', goal: '批量交付包验收' })
    });
    const batchDeliveryDrafts = await api(`/slots/${batchDeliverySlot.id}/generate-candidates`, { method: 'POST' });
    await api(`/candidates/${batchDeliveryDrafts[0].id}/select`, { method: 'POST' });
    const queueDelivered = await api('/dashboard/deliver-today', { method: 'POST' });
    assert(queueDelivered.deliveryCount <= 1, 'dashboard delivery should only process the queue head');
    assert(queueDelivered.processedId === null || queueDelivered.deliveries.every((item) => item.slot.id === queueDelivered.processedId), 'dashboard delivery processed a non-head slot');
    if (queueDelivered.reason) assert(queueDelivered.reason.includes('不能越过队首') || queueDelivered.reason.includes('今日队列已清空'), 'dashboard delivery missing queue-head refusal reason');

    let dispatchWithoutChecklistRejected = false;
    try {
      await api(`/slots/${slot.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: '已派发' }) });
    } catch (error) {
      dispatchWithoutChecklistRejected = /交付动作还没完成/.test(error.message);
    }
    assert(dispatchWithoutChecklistRejected, 'ready delivery allowed dispatch without completed handoff checklist');
    let forgedDispatchRejected = false;
    try {
      await api(`/slots/${slot.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: '已派发', handoffDone: handoffDoneForDeliveryView(deliveryView) })
      });
    } catch (error) {
      forgedDispatchRejected = /交付动作还没完成/.test(error.message);
    }
    assert(forgedDispatchRejected, 'ready delivery allowed dispatch with forged request handoff checklist');
    const afterForgedDispatchView = await api(`/slots/${slot.id}/delivery-view`);
    assert(afterForgedDispatchView.handoffDone.length === 1, 'forged dispatch request changed persisted handoff progress');
    let dispatchOutOfOrderProgressRejected = false;
    try {
      await api(`/slots/${slot.id}/handoff`, {
        method: 'PATCH',
        body: JSON.stringify({ handoffDone: handoffDoneForDeliveryView(deliveryView).reverse() })
      });
    } catch (error) {
      dispatchOutOfOrderProgressRejected = /按发送顺序/.test(error.message);
    }
    assert(dispatchOutOfOrderProgressRejected, 'handoff progress allowed out-of-order checklist');
    const fullHandoff = await api(`/slots/${slot.id}/handoff`, {
      method: 'PATCH',
      body: JSON.stringify({ handoffDone: deliveryHandoffKeys })
    });
    assert(fullHandoff.handoffDone.length === deliveryHandoffKeys.length, 'full handoff progress did not persist before dispatch');
    const reopenedFullDeliveryView = await api(`/slots/${slot.id}/delivery-view`);
    assert(reopenedFullDeliveryView.handoffDone.length === deliveryHandoffKeys.length, 'reopened delivery view did not keep all handoff steps');
    let staleHandoffRollbackRejected = false;
    try {
      await api(`/slots/${slot.id}/handoff`, {
        method: 'PATCH',
        body: JSON.stringify({ handoffDone: [deliveryHandoffKeys[0]] })
      });
    } catch (error) {
      staleHandoffRollbackRejected = /不能回退/.test(error.message);
    }
    assert(staleHandoffRollbackRejected, 'stale handoff request allowed rolling back completed steps');
    const afterStaleRollbackView = await api(`/slots/${slot.id}/delivery-view`);
    assert(afterStaleRollbackView.handoffDone.length === deliveryHandoffKeys.length, 'stale handoff rollback changed persisted progress');
    await api(`/slots/${slot.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: '已派发' }) });
    const sentDeliveryView = await api(`/slots/${slot.id}/delivery-view`);
    assert(sentDeliveryView.freelancerGuideAlreadySent === true, 'sent delivery should mark freelancer guide covered');
    assert(sentDeliveryView.shouldSendFreelancerGuide === false && !sentDeliveryView.texts.freelancerGuide, 'sent delivery should not keep freelancer guide copyable');
    assert(sentDeliveryView.handoffDone.length === deliveryHandoffKeys.length, 'sent delivery did not keep persisted handoff history');
    const sentDashboard = await api('/dashboard');
    assert(sentDashboard.sentWaitDone.some((item) => item.id === slot.id), 'sent slot should move to non-blocking wait confirmation list');
    assert(!sentDashboard.readyDelivery.some((item) => item.id === slot.id), 'sent slot should leave delivery queue');
    let completionWithoutReplyRejected = false;
    try {
      await api(`/slots/${slot.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: '已完成' }) });
    } catch (error) {
      completionWithoutReplyRejected = /完成回复/.test(error.message);
    }
    assert(completionWithoutReplyRejected, 'sent slot completed without explicit reply confirmation');
    await api(`/slots/${slot.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: '已完成', completionConfirmed: true }) });
    const repeatGuideSlot = await api(`/cases/${caze.id}/slots`, {
      method: 'POST',
      body: JSON.stringify({ date: '2026-06-10', contentKind: '日常养号', stage: '起号期', goal: '兼职须知不重复验收' })
    });
    const repeatGuideDrafts = await api(`/slots/${repeatGuideSlot.id}/generate-candidates`, { method: 'POST' });
    await api(`/candidates/${repeatGuideDrafts[0].id}/select`, { method: 'POST' });
    await api(`/slots/${repeatGuideSlot.id}/delivery`, { method: 'POST' });
    const repeatGuideView = await api(`/slots/${repeatGuideSlot.id}/delivery-view`);
    assert(repeatGuideView.freelancerGuideAlreadySent === true, 'later delivery did not detect previous guide send');
    assert(repeatGuideView.shouldSendFreelancerGuide === false, 'later delivery still asks to send freelancer guide');
    assert(!repeatGuideView.texts.freelancerGuide && repeatGuideView.texts.freelancerGuideNote.includes('后续不重复发'), 'later delivery should only keep a guide status note');
    const completedDashboard = await api('/dashboard');
    assert(!completedDashboard.todaySlots.some((item) => item.id === slot.id), 'completed slot should disappear from dashboard today queue');
    assert(!completedDashboard.readyDelivery.some((item) => item.id === slot.id), 'completed slot should disappear from delivery queue');
    const pauseCleanupCase = await api('/cases', {
      method: 'POST',
      body: JSON.stringify({
        weixinNick: '暂停清理验收兼职',
        douyinUrl: 'https://www.douyin.com/user/pause-cleanup-smoke',
        project: '吸脂',
        sourceMaterialDir: makeSharedSourceDir(ROOT_DIR, '暂停清理验收兼职')
      })
    });
    assert(pauseCleanupCase.collectionQueue?.registeredCount === 1, 'case create before pause cleanup did not queue Chrome collection');
    const monitorQueued = await api('/douyin-monitor/run', { method: 'POST', body: JSON.stringify({ source: 'smoke-manual' }) });
    assert(monitorQueued.skippedQueuedCount >= 2, 'monitor run should see already queued Chrome collection tasks');
    assert(monitorQueued.monitor.totals.collectionQueued >= 2 && monitorQueued.monitor.totals.waitingChrome >= 2, 'monitor run did not preserve queued Chrome collection');
    assert(monitorQueued.collector?.autoRun === false && monitorQueued.collector?.started === false, 'E2E monitor run should not auto-open Chrome collector');
    const monitorQueuedAgain = await api('/douyin-monitor/run', { method: 'POST', body: JSON.stringify({ source: 'smoke-manual-repeat' }) });
    assert(monitorQueuedAgain.createdCount === 0 && monitorQueuedAgain.skippedQueuedCount >= monitorQueued.createdCount, 'monitor run duplicated already waiting Chrome collection tasks');
    assert(monitorQueuedAgain.monitor.totals.waitingChrome === monitorQueued.monitor.totals.waitingChrome, 'duplicate monitor run changed waiting Chrome count');
    await api(`/cases/${pauseCleanupCase.id}/slots`, {
      method: 'POST',
      body: JSON.stringify({ date: '2026-05-28', contentKind: '日常养号', stage: '起号期', goal: '自动暂停清理验收', status: '已派发' })
    });
    await api('/dashboard');
    const pauseCleanupDetail = await api(`/cases/${pauseCleanupCase.id}`);
    assert(pauseCleanupDetail.case.healthStatus === '失联暂停', 'auto pause cleanup did not pause account');
    assert(!pauseCleanupDetail.slots.some((item) => ['待生成', '候选待选', '已锁定', '素材阻塞', '可交付', '已派发', '异常'].includes(item.status)), 'paused account still has active operator slots');
    const chromeQueue = await api('/douyin-monitor/chrome-queue');
    assert(chromeQueue.count >= 2, 'chrome collection queue missing due accounts');
    assert(chromeQueue.text.includes('/api/douyin-monitor/ingest') && chromeQueue.text.includes('Chrome抖音采集清单'), 'chrome collection queue text missing ingest instructions');
    assert(chromeQueue.targets.some((item) => item.ingestPayloadTemplate?.caseId === caze.id), 'chrome collection queue missing payload template');
    assert(!chromeQueue.targets.some((item) => item.caseId === pauseCleanupCase.id), 'paused account still appears in chrome collection queue');
    await deleteCase(pauseCleanupCase);
    const registeredChromeQueue = await api('/douyin-monitor/chrome-queue', { method: 'POST', body: JSON.stringify({ limit: 20 }) });
    assert(registeredChromeQueue.registeredCount === 0 && registeredChromeQueue.skippedQueuedCount >= 2, 'chrome queue duplicated already queued accounts');
    const ingested = await api('/douyin-monitor/ingest', {
      method: 'POST',
      body: JSON.stringify({
        caseId: caze.id,
        collectedAt: '2026-06-01T12:00:00.000Z',
        source: 'smoke-chrome',
        account: { fans: 100, following: 20, totalLikes: 500, totalWorks: 2 },
        videos: [
          {
            videoId: 'smoke-video-1',
            url: 'https://www.douyin.com/video/smoke-published',
            title: '烟测爆款作品',
            publishTime: '2026-06-01',
            plays: 8000,
            likes: 520,
            comments: 66,
            shares: 12,
            favorites: 9
          }
        ]
      })
    });
    assert(ingested.accountSnapshot?.fans === 100, 'monitor ingest missing account snapshot');
    assert(ingested.videoSnapshots.length === 1, 'monitor ingest missing video snapshot');
    assert(ingested.viralAlerts.length >= 1, 'monitor ingest did not create viral alert');
    const monitorDashboard = await api('/dashboard');
    assert(monitorDashboard.counts.viralAlerts >= 1, 'dashboard viral alert count missing');
    assert(monitorDashboard.viralAlerts.some((item) => item.case?.id === caze.id && item.video?.url === 'https://www.douyin.com/video/smoke-published'), 'dashboard viral alert list missing ingested video');
    assert(monitorDashboard.counts.monitorActions >= 1, 'dashboard monitor action count missing');
    assert(monitorDashboard.monitorActions.some((item) => item.kind === '爆款互动' && item.case?.id === caze.id), 'dashboard monitor actions missing viral interaction');
    const detailAfterIngest = await api(`/cases/${caze.id}`);
    assert(detailAfterIngest.monitor.latestSnapshot.fans === 100, 'case monitor latest snapshot missing');
    assert(!detailAfterIngest.monitor.pendingCollectionRun, 'case pending collection was not closed after ingest');
    assert(detailAfterIngest.videos.some((item) => item.latestSnapshot?.plays === 8000), 'case video metrics missing');
    const chromeAgentIngest = await api('/douyin-monitor/ingest', {
      method: 'POST',
      body: JSON.stringify({
        caseId: minimalCase.id,
        collectedAt: '2026-06-01T13:00:00.000Z',
        source: 'chrome-agent',
        account: { fans: 88, following: 18, totalLikes: 320, totalWorks: 1 },
        videos: [
          {
            url: 'https://www.douyin.com/video/chrome-agent-smoke',
            title: 'Chrome采集写入作品',
            publishTime: '2026-06-01',
            plays: 1200,
            likes: 44,
            comments: 8,
            shares: 2,
            favorites: 3
          }
        ],
        note: 'Chrome采集写入验收'
      })
    });
    assert(chromeAgentIngest.accountSnapshot?.fans === 88, 'chrome agent ingest missing account snapshot');
    const minimalAfterIngest = await api(`/cases/${minimalCase.id}`);
    assert(minimalAfterIngest.monitor.latestSnapshot.fans === 88, 'chrome agent ingest latest snapshot missing');
    assert(!minimalAfterIngest.monitor.pendingCollectionRun, 'minimal case pending collection was not closed after ingest');
    assert(minimalAfterIngest.videos.some((item) => item.latestSnapshot?.plays === 1200), 'chrome agent ingest video metrics missing');
    const afterChromeAgentDashboard = await api('/dashboard');
    assert(afterChromeAgentDashboard.monitorActions.some((item) => item.kind === '偏冷补内容' && item.case?.id === minimalCase.id), 'dashboard monitor actions missing cold content action');
    const nonHeadStrategyAction = afterChromeAgentDashboard.monitorActions.find((item) => (
      ['偏冷补内容', '增长承接'].includes(item.kind)
      && item.case?.id
      && !(afterChromeAgentDashboard.queueHead?.monitorAction?.kind === item.kind
        && afterChromeAgentDashboard.queueHead?.monitorAction?.case?.id === item.case.id)
    ));
    assert(nonHeadStrategyAction, 'missing non-head monitor action for queue guard smoke');
    const nonHeadStrategyDetail = await api(`/cases/${nonHeadStrategyAction.case.id}`);
    const nonHeadStrategySlotCount = nonHeadStrategyDetail.slots.filter((item) => String(item.goal || '').includes('账号策略动作')).length;
    const nonHeadStrategyResponse = await fetch(`${BASE}/douyin-monitor/actions/slot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caseId: nonHeadStrategyAction.case.id, kind: nonHeadStrategyAction.kind })
    });
    assert(nonHeadStrategyResponse.status === 409, 'non-head monitor action was allowed to create strategy slot');
    const nonHeadStrategyAfterBlocked = await api(`/cases/${nonHeadStrategyAction.case.id}`);
    assert(
      nonHeadStrategyAfterBlocked.slots.filter((item) => String(item.goal || '').includes('账号策略动作')).length === nonHeadStrategySlotCount,
      'non-head monitor action created a strategy slot'
    );
    const coldSlot = await api('/douyin-monitor/actions/slot', {
      method: 'POST',
      body: JSON.stringify({ caseId: minimalCase.id, kind: '偏冷补内容' })
    });
    assert(coldSlot.created === true && coldSlot.slot.contentKind === '爆款提权', 'cold monitor action did not create viral slot');
    const repeatedColdSlot = await api('/douyin-monitor/actions/slot', {
      method: 'POST',
      body: JSON.stringify({ caseId: minimalCase.id, kind: '偏冷补内容' })
    });
    assert(repeatedColdSlot.created === false && repeatedColdSlot.slot.id === coldSlot.slot.id, 'cold monitor action duplicate guard failed');
    await api('/douyin-monitor/ingest', {
      method: 'POST',
      body: JSON.stringify({
        caseId: minimalCase.id,
        collectedAt: '2026-06-01T14:00:00.000Z',
        source: 'chrome-agent',
        account: { fans: 150, following: 19, totalLikes: 360, totalWorks: 1 },
        videos: [],
        note: '增长承接验收'
      })
    });
    const afterGrowthDashboard = await api('/dashboard');
    assert(afterGrowthDashboard.monitorActions.some((item) => item.kind === '增长承接' && item.case?.id === minimalCase.id), 'dashboard monitor actions missing growth action');
    const growthSlot = await api('/douyin-monitor/actions/slot', {
      method: 'POST',
      body: JSON.stringify({ caseId: minimalCase.id, kind: '增长承接' })
    });
    assert(growthSlot.created === true && growthSlot.slot.contentKind === '素人种草', 'growth monitor action did not create carry slot');
    let invalidViralAlertStatusRejected = false;
    try {
      await api(`/viral-alerts/${ingested.viralAlerts[0].id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'ignored', interactionNote: '试图无痕跳过爆款互动' })
      });
    } catch (error) {
      invalidViralAlertStatusRejected = /爆款提醒状态/.test(error.message);
    }
    assert(invalidViralAlertStatusRejected, 'viral alert accepted an invalid status');
    const afterInvalidViralAlertPatch = await api('/dashboard');
    assert(afterInvalidViralAlertPatch.viralAlerts.some((item) => item.id === ingested.viralAlerts[0].id), 'invalid viral alert status hid an active alert');
    await api(`/viral-alerts/${ingested.viralAlerts[0].id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'handled', interactionNote: '烟测已安排互动' })
    });
    const afterHandledDashboard = await api('/dashboard');
    assert(!afterHandledDashboard.viralAlerts.some((item) => item.id === ingested.viralAlerts[0].id), 'handled viral alert still shown as active');
    assert(!afterHandledDashboard.monitorActions.some((item) => item.alertId === ingested.viralAlerts[0].id), 'handled viral alert still shown in monitor actions');
    let completedToAbnormalRejected = false;
    try {
      await api(`/slots/${manualSlot.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: '异常' }) });
    } catch (error) {
      completedToAbnormalRejected = /409/.test(error.message) || /交付链路/.test(error.message);
    }
    assert(completedToAbnormalRejected, 'completed slot was allowed to move back to abnormal');
    const abnormalTestSlot = await api(`/cases/${caze.id}/slots`, {
      method: 'POST',
      body: JSON.stringify({ date: '2026-06-07', contentKind: '日常养号', stage: '起号期', goal: '异常标记验收' })
    });
    let abnormalWithoutNoteRejected = false;
    try {
      await api(`/slots/${abnormalTestSlot.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: '异常' }) });
    } catch (error) {
      abnormalWithoutNoteRejected = /填写原因/.test(error.message);
    }
    assert(abnormalWithoutNoteRejected, 'manual abnormal status without note was accepted');
    const abnormalSlot = await api(`/slots/${abnormalTestSlot.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: '异常', operatorNote: '素材没法确认：烟测暂缓' }) });
    assert(abnormalSlot.status === '异常', 'manual abnormal status failed');
    assert(abnormalSlot.operatorNote === '素材没法确认：烟测暂缓', 'manual abnormal note was not persisted');
    let invalidSlotStatusRejected = false;
    try {
      await api(`/slots/${abnormalTestSlot.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: '乱写状态' }) });
    } catch (error) {
      invalidSlotStatusRejected = /400/.test(error.message) || /非法槽位状态/.test(error.message);
    }
    assert(invalidSlotStatusRejected, 'invalid slot status was accepted');
    const afterInvalidStatus = await api(`/cases/${caze.id}`);
    assert(afterInvalidStatus.slots.find((item) => item.id === manualSlot.id)?.status === '已完成', 'completed slot status changed after rejected abnormal update');
    assert(afterInvalidStatus.slots.find((item) => item.id === abnormalTestSlot.id)?.status === '异常', 'invalid slot status changed persisted status');

    let detachedImageRejected = false;
    try {
      await api('/image-tasks', { method: 'POST', body: JSON.stringify({ caseId: caze.id }) });
    } catch (error) {
      detachedImageRejected = /明确用途/.test(error.message);
    }
    assert(detachedImageRejected, 'detached image task without purpose was allowed');
    const imageTask = await api('/image-tasks', { method: 'POST', body: JSON.stringify({ caseId: caze.id, purpose: '封面图' }) });
    assert(imageTask.status === 'waiting_key' || imageTask.status === 'draft', 'image task status invalid');
    let invalidImageStatusRejected = false;
    try {
      await api(`/image-tasks/${imageTask.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'hidden_done' }) });
    } catch (error) {
      invalidImageStatusRejected = /待检查、可用或不用/.test(error.message);
    }
    assert(invalidImageStatusRejected, 'image task accepted an unknown status');
    const approvedImageTask = await api(`/image-tasks/${imageTask.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved' }) });
    assert(approvedImageTask.status === 'approved', 'image task did not accept approved status');
    let approvedImageRegenerateRejected = false;
    try {
      await api(`/image-tasks/${imageTask.id}/generate`, { method: 'POST' });
    } catch (error) {
      approvedImageRegenerateRejected = /不能重新生成/.test(error.message);
    }
    assert(approvedImageRegenerateRejected, 'approved image task was allowed to regenerate');
    const afterApprovedGenerateAttempt = await api(`/cases/${caze.id}`);
    assert(afterApprovedGenerateAttempt.imageTasks.find((item) => item.id === imageTask.id)?.status === 'approved', 'regenerate attempt changed approved image task status');

    const pausedViralCase = await api('/cases', {
      method: 'POST',
      body: JSON.stringify({
        weixinNick: '暂停爆款验收兼职',
        douyinUrl: 'https://www.douyin.com/user/paused-viral-smoke',
        project: '吸脂',
        healthStatus: '失联暂停',
        sourceMaterialDir: makeSharedSourceDir(ROOT_DIR, '暂停爆款验收兼职')
      })
    });
    const viralBulk = await api(`/viral-templates/${viral.id}/bulk-generate`, { method: 'POST', body: JSON.stringify({ date: '2026-06-02' }) });
    assert(viralBulk.createdCount === 4, 'viral bulk generation failed');
    assert(viralBulk.skipped.some((item) => item.caseId === pausedViralCase.id && item.reason.includes('暂停')), 'viral bulk did not skip paused account');
    assert(!viralBulk.slots.some((item) => item.caseId === pausedViralCase.id), 'viral bulk created slot for paused account');
    const pausedViralIngest = await api('/douyin-monitor/ingest', {
      method: 'POST',
      body: JSON.stringify({
        caseId: pausedViralCase.id,
        collectedAt: '2026-06-01T15:00:00.000Z',
        source: 'paused-viral-smoke',
        account: { fans: 200, following: 10, totalLikes: 1000, totalWorks: 1 },
        videos: [
          {
            videoId: 'paused-viral-video',
            url: 'https://www.douyin.com/video/paused-viral',
            title: '暂停账号历史爆款',
            publishTime: '2026-06-01',
            plays: 9000,
            likes: 600,
            comments: 80
          }
        ]
      })
    });
    assert(pausedViralIngest.viralAlerts.length >= 1, 'paused account ingest did not create raw viral alert');
    const pausedViralDashboard = await api('/dashboard');
    assert(!pausedViralDashboard.viralAlerts.some((item) => item.case?.id === pausedViralCase.id), 'paused account viral alert leaked into dashboard queue');
    assert(!pausedViralDashboard.monitorActions.some((item) => item.kind === '爆款互动' && item.case?.id === pausedViralCase.id), 'paused account viral action leaked into monitor actions');
    await deleteCase(pausedViralCase);
    const filteredBulk = await api(`/viral-templates/${filteredViral.id}/bulk-generate`, { method: 'POST', body: JSON.stringify({ date: '2026-06-03' }) });
    assert(filteredBulk.createdCount >= 1 && filteredBulk.skippedCount >= 1, 'viral persona filter bulk generation failed');
    let pendingRejected = false;
    try {
      await api(`/viral-templates/${linkOnlyViral.id}/bulk-generate`, { method: 'POST', body: JSON.stringify({ date: '2026-06-04' }) });
    } catch (error) {
      pendingRejected = /409/.test(error.message) || /结构分析/.test(error.message);
    }
    assert(pendingRejected, 'pending link-only viral template allowed bulk generation');
    let incompleteAnalysisRejected = false;
    try {
      await api(`/viral-templates/${linkOnlyViral.id}/analysis-result`, {
        method: 'POST',
        body: JSON.stringify({ title: '缺结构的爆款分析', rawText: '只有原视频内容' })
      });
    } catch (error) {
      incompleteAnalysisRejected = /爆款分析结果缺少/.test(error.message);
    }
    assert(incompleteAnalysisRejected, 'viral analysis result accepted incomplete payload');
    const analyzedViral = await api(`/viral-templates/${linkOnlyViral.id}/analysis-result`, {
      method: 'POST',
      body: JSON.stringify({
        title: '分析后的爆款链接',
        rawText: '原视频内容：真实生活开头，三段转折，评论提问。',
        category: '情绪',
        hotStructure: '生活场景开头 + 三段状态变化 + 评论区提问',
        suitablePersonas: ['吸脂'],
        forbiddenPersonas: ['不做医美'],
        rewritePolicy: '结构模仿'
      })
    });
    assert(analyzedViral.title === '分析后的爆款链接' && analyzedViral.category === '情绪' && analyzedViral.forbiddenPersonas.length === 1, 'viral analysis writeback failed');
    const analyzedBulk = await api(`/viral-templates/${analyzedViral.id}/bulk-generate`, { method: 'POST', body: JSON.stringify({ date: '2026-06-05' }) });
    assert(analyzedBulk.createdCount >= 1, 'analyzed viral link did not generate filtered slots');
    for (let i = 0; i < 35; i += 1) {
      await api(`/cases/${caze.id}/slots`, {
        method: 'POST',
        body: JSON.stringify({
          date: '2026-06-02',
          contentKind: '日常养号',
          stage: '起号期',
          goal: `百人队列可交付覆盖 ${i + 1}`,
          status: '可交付'
        })
      });
    }
    const largeQueueDashboard = await api('/dashboard');
    assert(largeQueueDashboard.readyDelivery.length >= 35, 'dashboard ready delivery queue was truncated before 35 items');
    assert(largeQueueDashboard.priorityActions.filter((item) => item.kind === '微信交付').length >= 35, 'backend priority queue omitted delivery items beyond old page limit');

    const review = await api('/review');
    const reviewCases = await api('/cases');
    assert(review.totals.cases === reviewCases.length, 'review case total invalid');
    assert(review.totals.accountSnapshots === 3, 'review account snapshot total invalid');
    assert(review.totals.videoSnapshots === 2, 'review video snapshot total invalid');
    assert(review.contentKindStats.some((item) => item.kind === '爆款提权' && item.total >= 1), 'review content kind stats missing');
    assert(review.topAccounts.length >= 2, 'review top account missing');
    const config = await api('/config');
    assert(config.caseLibraryRoot.endsWith(path.join('素材库', '服务器案例库')) && config.caseLibrary.total >= 1, 'config missing case library status');
    assert(config.douyinCollector?.autoRun === false && config.douyinCollector?.running === false, 'test config should keep Chrome collector disabled');
    const hiddenConfigKeys = ['back' + 'ups', 'local' + 'Ai', 'll' + 'm', 'll' + 'mKeyReady', 'operator' + 'PacketDir', 'ai' + 'ConsultDir', 'stageRatios', 'materialTemplates', 'stages', 'contentKinds'];
    assert(!hiddenConfigKeys.some((key) => key in config), 'config exposed removed operational keys');
    assert(config.readiness?.summary?.total >= 8, 'config readiness summary missing');
    assert(config.readiness.checks.some((item) => item.key === 'delivery-package' && item.status === 'ready'), 'readiness delivery package missing');
    assert(config.readiness.checks.some((item) => item.key === 'viral-analysis' && item.status === 'ready'), 'readiness viral analysis missing');
    const hiddenReadinessKeys = ['local' + '-ai', 'll' + 'm-copy', 'github' + '-sync', 'operator' + '-packet'];
    assert(!config.readiness.checks.some((item) => hiddenReadinessKeys.includes(item.key)), 'readiness exposed removed checks');
    const health = await api('/health');
    assert(health.readiness?.total >= 8, 'health readiness summary missing');
    const readiness = await api('/readiness');
    assert(readiness.checks.some((item) => item.key === 'viral-analysis' && item.status === 'ready'), 'readiness endpoint missing viral analysis');
    assert(!readiness.checks.some((item) => hiddenReadinessKeys.includes(item.key)), 'readiness endpoint exposed removed checks');

    const finalDetail = await api(`/cases/${caze.id}`);
    assert(finalDetail.monitor.latestSnapshot.fans === 100, 'case monitor snapshot missing');
    assert(finalDetail.videos.length === 1, 'case video data missing');
    assert(finalDetail.clipTasks.length === 1, 'case clip tasks missing');

    console.log('E2E smoke PASS');
  } finally {
    server.kill('SIGTERM');
    await sleep(300);
    fs.rmSync(ROOT_DIR, { recursive: true, force: true });
    fs.rmSync(IMAGE_ROOT_DIR, { recursive: true, force: true });
    fs.rmSync(IMAGE_KEY_ONLY_ROOT_DIR, { recursive: true, force: true });
    fs.rmSync(AUTH_ROOT_DIR, { recursive: true, force: true });
    fs.rmSync(LAN_FAIL_ROOT_DIR, { recursive: true, force: true });
    fs.rmSync(PLACEHOLDER_ROOT_DIR, { recursive: true, force: true });
    fs.rmSync(LAN_CONFIG_ROOT_DIR, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
