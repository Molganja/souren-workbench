import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';

const TEST_PORT = 5184;
const TEST_IMAGE_APP_PORT = 5188;
const TEST_IMAGE_PORT = 5189;
const TEST_AUTH_PORT = 5190;
const TEST_LAN_FAIL_PORT = 5191;
const ORIGIN = `http://127.0.0.1:${TEST_PORT}`;
const BASE = `${ORIGIN}/api`;
const APP_DIR = path.resolve(import.meta.dirname, '..');
const REAL_ROOT_DIR = path.resolve(APP_DIR, '..');
const ROOT_DIR = path.join(REAL_ROOT_DIR, '.tmp-e2e');
const IMAGE_ROOT_DIR = path.join(REAL_ROOT_DIR, '.tmp-e2e-image');
const AUTH_ROOT_DIR = path.join(REAL_ROOT_DIR, '.tmp-e2e-auth');
const LAN_FAIL_ROOT_DIR = path.join(REAL_ROOT_DIR, '.tmp-e2e-lan-fail');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(pathname, options = {}, base = BASE) {
  const res = await fetch(`${base}${pathname}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${pathname}: ${data?.error || res.status}`);
  return data;
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
    const caze = await api('/cases', {
      method: 'POST',
      body: JSON.stringify({ weixinNick: '图片生成兼职', persona: { city: '成都', occupation: '上班族' } })
    }, imageBase);
    const task = await api('/image-tasks', {
      method: 'POST',
      body: JSON.stringify({ caseId: caze.id, purpose: '封面图', prompt: '图片生成接口验收提示词' })
    }, imageBase);
    assert(task.status === 'draft', 'image task should be draft when image API is ready');
    const generated = await api(`/image-tasks/${task.id}/generate`, { method: 'POST' }, imageBase);
    assert(generated.task.status === 'review', 'generated image task not moved to review');
    assert(generated.files.length === 1 && fs.existsSync(generated.files[0]), 'generated image file missing');
    assert(generated.assets.some((asset) => asset?.source === 'AI生成'), 'generated image asset not inserted');
    assert(receivedBody.includes('图片生成接口验收提示词') && receivedBody.includes('fake-image-model'), 'image API did not receive prompt or model');
  } finally {
    server.kill('SIGTERM');
    imageServer.close();
    await sleep(300);
    fs.rmSync(IMAGE_ROOT_DIR, { recursive: true, force: true });
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
      IMAGE_API_KEY: '',
      IMAGE_API_URL: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', (chunk) => process.stdout.write(chunk));
  server.stderr.on('data', (chunk) => process.stderr.write(chunk));

  try {
    await waitForServer(server);

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
    const viralAnalysisTask = await api(`/viral-templates/${linkOnlyViral.id}/analysis-task`);
    assert(viralAnalysisTask.text.includes('https://www.douyin.com/video/link-only-smoke') && viralAnalysisTask.text.includes('记录到系统'), 'viral analysis task text missing');
    const viralDashboard = await api('/dashboard');
    assert(viralDashboard.counts.pendingViral >= 1, 'dashboard pending viral count missing');
    assert(viralDashboard.pendingViralTemplates.some((item) => item.id === linkOnlyViral.id), 'dashboard pending viral list missing link-only template');
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
        baseWeight: 1000
      })
    });
    assert(videoSeed.id, 'video content seed not created');

    const bulk = await api('/cases/bulk', {
      method: 'POST',
      body: JSON.stringify({
        text: [
          '批量小林,https://www.douyin.com/user/bulk-lin,吸脂',
          '批量小陈,https://www.douyin.com/user/bulk-chen,复诊',
          '无效账号,不是抖音链接,吸脂,/Volumes/共享素材/无效账号'
        ].join('\n')
      })
    });
    assert(bulk.createdCount === 2, 'bulk import should only accept rows with a Douyin link in the second field');
    assert(bulk.cases[0].douyinUrl.includes('bulk-lin') && bulk.cases[1].project === '复诊', 'bulk simplified fields missing');
    assert(bulk.cases.every((item) => item.stage === '起号期'), 'bulk import accepted external case stage');
    assert(fs.existsSync(path.join(bulk.cases[0].localCaseDir, '00-原始素材')), 'bulk case material dir missing');
    const deletedCaseDir = bulk.cases[1].localCaseDir;
    assert(fs.existsSync(deletedCaseDir), 'case directory missing before delete');
    const deletedCase = await api(`/cases/${bulk.cases[1].id}`, { method: 'DELETE' });
    assert(deletedCase.removedDir === true, 'case delete did not report local directory removal');
    assert(!fs.existsSync(deletedCaseDir), 'case delete did not move original material directory');
    assert(deletedCase.archivedDir?.includes('_deleted') && fs.existsSync(deletedCase.archivedDir), 'case delete did not archive local material directory');
    const afterDelete = await api('/cases');
    assert(afterDelete.length === 1 && afterDelete[0].id === bulk.cases[0].id, 'case delete failed');
    const batchGenerated = await api('/dashboard/generate-today', { method: 'POST' });
    assert(batchGenerated.slotCount >= 1 && batchGenerated.candidateCount >= 3, 'dashboard batch generate did not create candidates');

    const sharedSourceDir = path.join(ROOT_DIR, '员工共享素材', '验收兼职');
    fs.mkdirSync(sharedSourceDir, { recursive: true });
    fs.writeFileSync(path.join(sharedSourceDir, '共享-D1.jpg'), 'fake shared case image');
    const caze = await api('/cases', {
      method: 'POST',
      body: JSON.stringify({
        douyinId: 'smoke_dy',
        douyinUrl: 'https://www.douyin.com/',
        project: '吸脂',
        sourceMaterialDir: sharedSourceDir,
        stage: '成果期',
        persona: { city: '成都', occupation: '上班族' }
      })
    });
    assert(caze.weixinNick.includes('成都') && caze.persona.age && caze.persona.tone && caze.persona.motivation, 'case random defaults missing');
    assert(caze.stage === '起号期' && caze.slotsCreated >= 14, 'case create should ignore external stage and generate schedule by default');
    assert(caze.sourceMaterialDir === sharedSourceDir, 'case source material dir missing');
    assert(fs.existsSync(path.join(caze.localCaseDir, '00-原始素材')), 'case material dir missing');
    const syncedMaterials = await api(`/cases/${caze.id}/sync-source-materials`, { method: 'POST' });
    assert(syncedMaterials.copied === 1 && syncedMaterials.inserted === 1, 'source material sync did not copy and insert shared asset');
    const syncedAssetPath = path.join(caze.localCaseDir, '00-原始素材', '共享同步', '共享-D1.jpg');
    assert(fs.existsSync(syncedAssetPath), 'synced source material missing in local case dir');
    assert(syncedMaterials.assets.some((asset) => asset.path === syncedAssetPath && asset.originPath === path.join(sharedSourceDir, '共享-D1.jpg') && asset.source === '共享导入' && asset.usage === '案例过程'), 'synced source material metadata missing');
    fs.writeFileSync(path.join(sharedSourceDir, '共享-对比.jpg'), 'fake unsynced shared case image');
    const beforeSyncDashboard = await api('/dashboard');
    const pendingSync = beforeSyncDashboard.materialSync.find((item) => item.case?.id === caze.id);
    assert(beforeSyncDashboard.counts.materialSync >= 1 && pendingSync?.unsyncedCount === 1, 'dashboard missing pending shared material sync');
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
    const minimalCase = await api('/cases', {
      method: 'POST',
      body: JSON.stringify({ douyinUrl: 'https://www.douyin.com/video/minimal-smoke' })
    });
    assert(minimalCase.weixinNick && minimalCase.weixinNick !== '未命名兼职', 'minimal case did not generate nick');
    assert(minimalCase.persona.city && minimalCase.persona.motivation, 'minimal case defaults missing');
    assert(!minimalCase.localCaseDir.includes('未命名'), 'minimal case directory used unnamed segment');
    assert(minimalCase.slotsCreated >= 14, 'minimal case did not auto generate default slots');
    const minimalDetail = await api(`/cases/${minimalCase.id}`);
    assert(minimalDetail.slots.length >= 14 && minimalDetail.slots.every((item) => item.status === '待生成'), 'minimal case default slots missing');
    const dueOnlyDashboard = await api('/dashboard');
    assert(dueOnlyDashboard.pendingGenerate.every((item) => item.date <= dueOnlyDashboard.today), 'dashboard leaked future pending generation slots');
    const minimalAfterRolling = await api(`/cases/${minimalCase.id}`);
    assert(minimalAfterRolling.slots.length >= 14, 'dashboard did not roll schedule forward for active case');
    const throttleCase = await api('/cases', {
      method: 'POST',
      body: JSON.stringify({ weixinNick: '降频验收兼职', douyinUrl: 'https://www.douyin.com/user/throttle-smoke', project: '吸脂' })
    });
    await api('/douyin-monitor/ingest', {
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
    const throttleMonitor = await api('/douyin-monitor');
    const throttleAccount = throttleMonitor.accounts.find((item) => item.case?.id === throttleCase.id);
    assert(throttleAccount?.activityTier === '偏冷', 'two cold videos should mark account cold');
    assert(throttleAccount.postingStrategy?.mode === '两天一条', 'cold account should throttle posting');
    assert(throttleAccount.collectionPolicy?.intervalHours === 72, 'cold account should collect every three days');
    await api('/dashboard');
    const throttleDetail = await api(`/cases/${throttleCase.id}`);
    assert(throttleDetail.slots.length > 0 && throttleDetail.slots.length <= 8, 'throttled account generated too many future slots');
    assert(throttleDetail.monitor.postingStrategy?.mode === '两天一条', 'case detail missing throttled posting strategy');

    const sleepCase = await api('/cases', {
      method: 'POST',
      body: JSON.stringify({ weixinNick: '休眠验收兼职', douyinUrl: 'https://www.douyin.com/user/sleep-smoke', project: '吸脂' })
    });
    await api('/douyin-monitor/ingest', {
      method: 'POST',
      body: JSON.stringify({
        caseId: sleepCase.id,
        collectedAt: '2026-06-01T16:00:00.000Z',
        source: 'chrome-agent',
        account: { fans: 52, following: 10, totalLikes: 120, totalWorks: 3 },
        videos: [
          { videoId: 'sleep-video-1', url: 'https://www.douyin.com/video/sleep-1', title: '休眠低播放1', publishTime: '2026-06-01', plays: 500, likes: 12, comments: 2 },
          { videoId: 'sleep-video-2', url: 'https://www.douyin.com/video/sleep-2', title: '休眠低播放2', publishTime: '2026-06-01', plays: 700, likes: 16, comments: 3 },
          { videoId: 'sleep-video-3', url: 'https://www.douyin.com/video/sleep-3', title: '休眠低播放3', publishTime: '2026-06-01', plays: 900, likes: 18, comments: 4 }
        ]
      })
    });
    const sleepMonitor = await api('/douyin-monitor');
    const sleepAccount = sleepMonitor.accounts.find((item) => item.case?.id === sleepCase.id);
    assert(sleepAccount?.activityTier === '休眠', 'three cold videos should mark account sleeping');
    assert(sleepAccount.postingStrategy?.mode === '暂停自动补', 'sleeping account should pause automatic posting');
    assert(sleepAccount.collectionPolicy?.intervalHours === 168, 'sleeping account should collect weekly');
    await api('/dashboard');
    const sleepDetail = await api(`/cases/${sleepCase.id}`);
    assert(sleepDetail.slots.length === 0, 'sleeping account should not auto generate future slots');

    const lostCase = await api('/cases', {
      method: 'POST',
      body: JSON.stringify({ weixinNick: '失联验收兼职', douyinUrl: 'https://www.douyin.com/user/lost-smoke', project: '吸脂' })
    });
    await api(`/cases/${lostCase.id}/slots`, {
      method: 'POST',
      body: JSON.stringify({ date: '2026-05-28', contentKind: '日常养号', stage: '起号期', goal: '失联派发验收', status: '已派发' })
    });
    const lostMonitor = await api('/douyin-monitor');
    const lostAccount = lostMonitor.accounts.find((item) => item.case?.id === lostCase.id);
    assert(lostAccount?.activityTier === '失联暂停', 'overdue sent slot should mark account lost');
    assert(lostAccount.postingStrategy?.mode === '暂停自动补', 'lost account should pause automatic posting');
    assert(lostAccount.collectionPolicy?.intervalHours == null, 'lost account should not enter collection queue');
    const lostDashboard = await api('/dashboard');
    assert(lostDashboard.monitorActions.some((item) => item.kind === '失联处理' && item.case?.id === lostCase.id), 'lost account action missing');
    assert(!lostDashboard.todaySlots.some((item) => item.case?.id === lostCase.id), 'lost account leaked into normal due slots');
    const lostAfterPrune = await api(`/cases/${lostCase.id}`);
    assert(!lostAfterPrune.slots.some((item) => item.date >= lostDashboard.today && item.status === '待生成'), 'lost account future pending slots were not pruned');
    await api(`/cases/${lostCase.id}`, { method: 'PATCH', body: JSON.stringify({ healthStatus: '失联暂停' }) });
    const lostPausedDashboard = await api('/dashboard');
    assert(!lostPausedDashboard.monitorActions.some((item) => item.kind === '失联处理' && item.case?.id === lostCase.id), 'paused lost account still prompted action');
    const resumedLost = await api(`/cases/${lostCase.id}/resume`, { method: 'POST' });
    assert(resumedLost.case.healthStatus === '健康', 'resume did not restore case health');
    assert(resumedLost.canceledCount >= 1 && resumedLost.slotsCreated >= 1, 'resume did not cancel stale sent slots and create new schedule');
    const resumedLostDetail = await api(`/cases/${lostCase.id}`);
    assert(resumedLostDetail.slots.some((item) => item.status === '已取消'), 'resume did not keep stale sent slot as cancelled');
    assert(resumedLostDetail.slots.some((item) => item.date >= lostDashboard.today && item.status === '待生成'), 'resume did not create future pending slot');
    assert(resumedLostDetail.monitor.activityTier !== '失联暂停', 'resumed account still marked lost');
    await api(`/cases/${throttleCase.id}`, { method: 'DELETE' });
    await api(`/cases/${sleepCase.id}`, { method: 'DELETE' });
    await api(`/cases/${lostCase.id}`, { method: 'DELETE' });
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
    const scan = await api(`/cases/${caze.id}/scan-assets`, { method: 'POST' });
    assert(scan.inserted === 2, 'asset scan did not insert two files');
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
    const gapImage = await api('/image-tasks', {
      method: 'POST',
      body: JSON.stringify({ caseId: caze.id, purpose: withGaps.materialGaps[0].label, prompt: `补${withGaps.materialGaps[0].label}` })
    });
    assert(gapImage.purpose === withGaps.materialGaps[0].label, 'gap image task failed');
    assert(fs.existsSync(path.join(gapImage.outputDir, `${gapImage.id}-图片任务说明.txt`)), 'image task brief missing');
    const gapImagePrompt = await api(`/image-tasks/${gapImage.id}/prompt`);
    assert(gapImagePrompt.text.includes('正向提示词：') && gapImagePrompt.text.includes('反向提示词：'), 'image prompt copy text missing');
    const imageDashboard = await api('/dashboard');
    assert(imageDashboard.counts.imageTasks >= 1 && imageDashboard.counts.imageWaitingKey >= 1, 'dashboard image task counts missing');
    assert(imageDashboard.imageTasks.some((item) => item.id === gapImage.id && item.case?.id === caze.id), 'dashboard image task list missing case task');

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
      body: JSON.stringify({ date: '2026-06-01', contentKind: '日常养号', stage: '起号期', goal: '一键准备验收' })
    });
    const prepared = await api('/dashboard/prepare-today', { method: 'POST' });
    assert(prepared.generatedCount >= 1 && prepared.selectedCount >= 1 && prepared.deliveryCount >= 1, 'dashboard prepare today did not complete the chain');
    const preparedDetail = await api(`/cases/${caze.id}`);
    const preparedSlot = preparedDetail.slots.find((item) => item.id === prepareSlot.id);
    assert(preparedSlot.status === '可交付' && preparedSlot.deliveryDir, 'prepared slot not ready for delivery');

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
    const clip = await api('/clip-tasks', { method: 'POST', body: JSON.stringify({ caseId: caze.id, planSlotId: slot.id, title: '验收剪辑任务' }) });
    assert(fs.existsSync(path.join(clip.outputDir, '剪辑任务单.txt')), 'clip brief file missing');
    const clipBrief = fs.readFileSync(path.join(clip.outputDir, '剪辑任务单.txt'), 'utf8');
    assert(clip.brief.includes('固定剪辑配方'), 'clip task response missing fixed edit recipe');
    assert(clipBrief.includes('固定剪辑配方') && clipBrief.includes('不临时改结构'), 'clip brief file missing fixed edit recipe');
    const clipDashboard = await api('/dashboard');
    assert(clipDashboard.counts.clipTasks >= 1, 'dashboard clip task count missing');
    assert(clipDashboard.clipTasks.some((item) => item.id === clip.id && item.case?.id === caze.id), 'dashboard clip task list missing case task');
    const reviewedClip = await api(`/clip-tasks/${clip.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'completed' }) });
    assert(reviewedClip.status === 'completed', 'clip status update failed');
    const clipDashboardAfter = await api('/dashboard');
    assert(!clipDashboardAfter.clipTasks.some((item) => item.id === clip.id), 'completed clip task still shown as pending');
    const delivery = await api(`/slots/${slot.id}/delivery`, { method: 'POST' });
    const wxChecklistPath = path.join(delivery.deliveryDir, '00-微信发送清单.txt');
    assert(fs.existsSync(wxChecklistPath), 'delivery package missing WeChat checklist');
    assert(fs.existsSync(path.join(delivery.deliveryDir, '00-兼职须知.txt')), 'delivery package missing freelancer guide');
    assert(fs.existsSync(path.join(caze.localCaseDir, '00-兼职须知.txt')), 'case folder missing freelancer guide');
    const wxChecklist = fs.readFileSync(wxChecklistPath, 'utf8');
    assert(wxChecklist.includes('发给：验收兼职改名') && wxChecklist.includes('抖音号：smoke_dy'), 'WeChat checklist missing recipient routing');
    assert(wxChecklist.includes('发送顺序') && wxChecklist.includes('兼职须知') && wxChecklist.includes('完成口径'), 'WeChat checklist missing send or completion instructions');
    assert(fs.existsSync(path.join(delivery.deliveryDir, '01-发给兼职文案.txt')), 'delivery package missing operator text');
    assert(fs.existsSync(path.join(delivery.deliveryDir, '05-素材顺序清单.txt')), 'delivery asset order file missing');
    assert(delivery.copiedAssets.length >= 1, 'delivery copied asset list missing');
    const deliveryView = await api(`/slots/${slot.id}/delivery-view`);
    assert(deliveryView.texts.operatorInstruction.includes('账号：验收兼职改名'), 'delivery view missing operator instruction');
    assert(deliveryView.texts.operatorInstruction.includes('固定发布说明'), 'delivery view missing fixed publish instructions');
    assert(deliveryView.texts.freelancerGuide.includes('兼职须知') && deliveryView.texts.freelancerGuide.includes('发完后回复'), 'delivery view missing freelancer guide');
    assert(deliveryView.texts.publishText.includes(drafts[0].title), 'delivery view missing publish text');
    assert(deliveryView.mediaFiles.length >= 1 && deliveryView.mediaFiles[0].url.startsWith('/files/'), 'delivery view missing downloadable media');
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
    assert(Number.isInteger(deliveryDashboard.counts.locked) && Number.isInteger(deliveryDashboard.counts.sentWaitReport), 'dashboard work split counts missing');

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
        project: '合规验收项目'
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
    assert(fs.existsSync(path.join(complianceDelivery.deliveryDir, '00-合规阻塞说明.txt')), 'compliance blocked note missing');
    const complianceView = await api(`/slots/${complianceSlot.id}/delivery-view`);
    assert(complianceView.texts.complianceNote.includes('合规提示'), 'compliance delivery view missing note');
    await api(`/cases/${complianceCase.id}`, { method: 'DELETE' });

    await imageGenerationSmoke();
    await authAccessSmoke();
    await lanFailClosedSmoke();

    const videoCase = await api('/cases', {
      method: 'POST',
      body: JSON.stringify({
        weixinNick: '视频验收兼职',
        douyinUrl: 'https://www.douyin.com/user/video-smoke',
        project: '视频验收项目'
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
    assert(videoDrafts[0].format === '视频', 'video seed did not produce video format');
    await api(`/candidates/${videoDrafts[0].id}/select`, { method: 'POST' });
    const videoDelivery = await api(`/slots/${videoSlot.id}/delivery`, { method: 'POST' });
    assert(fs.existsSync(path.join(videoDelivery.deliveryDir, '03-口播字幕文案.txt')), 'video delivery missing script file');
    assert(fs.existsSync(path.join(videoDelivery.deliveryDir, '04-剪辑要求.txt')), 'video delivery missing edit brief');
    assert(fs.existsSync(path.join(videoDelivery.deliveryDir, '07-成片回收说明.txt')), 'video delivery missing final video return note');
    assert(videoDelivery.copiedAssets.some((asset) => asset.fileName.startsWith('08-')), 'video delivery asset numbering did not avoid task files');
    const videoDeliveryView = await api(`/slots/${videoSlot.id}/delivery-view`);
    assert(videoDeliveryView.isVideo === true && videoDeliveryView.editing.finalVideoPath.endsWith('final.mp4'), 'video delivery view missing editing output path');
    assert(videoDeliveryView.texts.editBrief.includes('剪辑要求'), 'video delivery view missing edit brief');
    assert(videoDeliveryView.texts.editBrief.includes('固定剪辑配方') && videoDeliveryView.texts.editBrief.includes('只替换素材和标题'), 'video delivery edit brief missing fixed recipe');
    await api(`/cases/${videoCase.id}`, { method: 'DELETE' });

    const batchDeliverySlot = await api(`/cases/${caze.id}/slots`, {
      method: 'POST',
      body: JSON.stringify({ date: '2026-06-01', contentKind: '日常养号', stage: '起号期', goal: '批量交付包验收' })
    });
    const batchDeliveryDrafts = await api(`/slots/${batchDeliverySlot.id}/generate-candidates`, { method: 'POST' });
    await api(`/candidates/${batchDeliveryDrafts[0].id}/select`, { method: 'POST' });
    const batchDelivered = await api('/dashboard/deliver-today', { method: 'POST' });
    assert(batchDelivered.deliveryCount >= 1, 'dashboard batch delivery did not create delivery packages');

    await api(`/slots/${slot.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: '已派发' }) });
    await api(`/slots/${slot.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: '已完成' }) });
    const completedDashboard = await api('/dashboard');
    assert(completedDashboard.todaySlots.some((item) => item.id === slot.id && item.status === '已完成'), 'dashboard today chain dropped completed slot');
    const monitorQueued = await api('/douyin-monitor/run', { method: 'POST', body: JSON.stringify({ source: 'smoke-manual' }) });
    assert(monitorQueued.createdCount >= 2, 'monitor run did not register Chrome collection tasks');
    assert(monitorQueued.monitor.totals.collectionQueued >= 2 && monitorQueued.monitor.totals.waitingChrome >= 2, 'monitor run did not mark queued Chrome collection');
    const chromeQueue = await api('/douyin-monitor/chrome-queue');
    assert(chromeQueue.count >= 2, 'chrome collection queue missing due accounts');
    assert(chromeQueue.text.includes('/api/douyin-monitor/ingest') && chromeQueue.text.includes('Chrome抖音采集清单'), 'chrome collection queue text missing ingest instructions');
    assert(chromeQueue.targets.some((item) => item.ingestPayloadTemplate?.caseId === caze.id), 'chrome collection queue missing payload template');
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
    const coldSlot = await api('/douyin-monitor/actions/slot', {
      method: 'POST',
      body: JSON.stringify({ caseId: minimalCase.id, kind: '偏冷补内容', date: '2026-06-08' })
    });
    assert(coldSlot.created === true && coldSlot.slot.contentKind === '爆款提权', 'cold monitor action did not create viral slot');
    const repeatedColdSlot = await api('/douyin-monitor/actions/slot', {
      method: 'POST',
      body: JSON.stringify({ caseId: minimalCase.id, kind: '偏冷补内容', date: '2026-06-08' })
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
      body: JSON.stringify({ caseId: minimalCase.id, kind: '增长承接', date: '2026-06-09' })
    });
    assert(growthSlot.created === true && growthSlot.slot.contentKind === '素人种草', 'growth monitor action did not create carry slot');
    await api(`/viral-alerts/${ingested.viralAlerts[0].id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'handled', interactionNote: '烟测已安排互动' })
    });
    const afterHandledDashboard = await api('/dashboard');
    assert(!afterHandledDashboard.viralAlerts.some((item) => item.id === ingested.viralAlerts[0].id), 'handled viral alert still shown as active');
    assert(!afterHandledDashboard.monitorActions.some((item) => item.alertId === ingested.viralAlerts[0].id), 'handled viral alert still shown in monitor actions');
    const abnormalSlot = await api(`/slots/${manualSlot.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: '异常' }) });
    assert(abnormalSlot.status === '异常', 'manual abnormal status failed');
    let invalidSlotStatusRejected = false;
    try {
      await api(`/slots/${manualSlot.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: '乱写状态' }) });
    } catch (error) {
      invalidSlotStatusRejected = /400/.test(error.message) || /非法槽位状态/.test(error.message);
    }
    assert(invalidSlotStatusRejected, 'invalid slot status was accepted');
    const afterInvalidStatus = await api(`/cases/${caze.id}`);
    assert(afterInvalidStatus.slots.find((item) => item.id === manualSlot.id)?.status === '异常', 'invalid slot status changed persisted status');

    const imageTask = await api('/image-tasks', { method: 'POST', body: JSON.stringify({ caseId: caze.id, purpose: '封面图' }) });
    assert(imageTask.status === 'waiting_key' || imageTask.status === 'draft', 'image task status invalid');
    await api(`/image-tasks/${imageTask.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved' }) });

    const pausedViralCase = await api('/cases', {
      method: 'POST',
      body: JSON.stringify({ weixinNick: '暂停爆款验收兼职', douyinUrl: 'https://www.douyin.com/user/paused-viral-smoke', project: '吸脂', healthStatus: '失联暂停' })
    });
    const viralBulk = await api(`/viral-templates/${viral.id}/bulk-generate`, { method: 'POST', body: JSON.stringify({ date: '2026-06-02' }) });
    assert(viralBulk.createdCount === 4, 'viral bulk generation failed');
    assert(viralBulk.skipped.some((item) => item.caseId === pausedViralCase.id && item.reason.includes('暂停')), 'viral bulk did not skip paused account');
    assert(!viralBulk.slots.some((item) => item.caseId === pausedViralCase.id), 'viral bulk created slot for paused account');
    await api(`/cases/${pausedViralCase.id}`, { method: 'DELETE' });
    const filteredBulk = await api(`/viral-templates/${filteredViral.id}/bulk-generate`, { method: 'POST', body: JSON.stringify({ date: '2026-06-03' }) });
    assert(filteredBulk.createdCount >= 1 && filteredBulk.skippedCount >= 1, 'viral persona filter bulk generation failed');
    let pendingRejected = false;
    try {
      await api(`/viral-templates/${linkOnlyViral.id}/bulk-generate`, { method: 'POST', body: JSON.stringify({ date: '2026-06-04' }) });
    } catch (error) {
      pendingRejected = /409/.test(error.message) || /结构分析/.test(error.message);
    }
    assert(pendingRejected, 'pending link-only viral template allowed bulk generation');
    const analyzedViral = await api(`/viral-templates/${linkOnlyViral.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        title: '分析后的爆款链接',
        rawText: '原视频内容：真实生活开头，三段转折，评论提问。',
        category: '情绪',
        hotStructure: '生活场景开头 + 三段状态变化 + 评论区提问',
        suitablePersonas: ['吸脂'],
        rewritePolicy: '结构模仿'
      })
    });
    assert(analyzedViral.title === '分析后的爆款链接' && analyzedViral.category === '情绪', 'viral analysis patch failed');
    const analyzedBulk = await api(`/viral-templates/${analyzedViral.id}/bulk-generate`, { method: 'POST', body: JSON.stringify({ date: '2026-06-05' }) });
    assert(analyzedBulk.createdCount >= 1, 'analyzed viral link did not generate filtered slots');

    const review = await api('/review');
    assert(review.totals.cases === 4, 'review case total invalid');
    assert(review.totals.accountSnapshots === 3, 'review account snapshot total invalid');
    assert(review.totals.videoSnapshots === 2, 'review video snapshot total invalid');
    assert(review.contentKindStats.some((item) => item.kind === '爆款提权' && item.total >= 1), 'review content kind stats missing');
    assert(review.topAccounts.length >= 2, 'review top account missing');
    const config = await api('/config');
    assert(config.materialTemplates.吸脂.length > 0, 'config material template missing');
    assert(config.stageRatios.起号期, 'config ratios missing');
    assert(config.caseLibraryRoot.endsWith(path.join('素材库', '服务器案例库')) && config.caseLibrary.total >= 1, 'config missing case library status');
    const hiddenConfigKeys = ['back' + 'ups', 'local' + 'Ai', 'll' + 'm', 'll' + 'mKeyReady', 'operator' + 'PacketDir', 'ai' + 'ConsultDir'];
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
    fs.rmSync(AUTH_ROOT_DIR, { recursive: true, force: true });
    fs.rmSync(LAN_FAIL_ROOT_DIR, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
