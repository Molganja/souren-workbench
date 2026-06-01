import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const TEST_PORT = 5184;
const BASE = `http://127.0.0.1:${TEST_PORT}/api`;
const APP_DIR = path.resolve(import.meta.dirname, '..');
const ROOT_DIR = path.resolve(APP_DIR, '..');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    if (child.exitCode !== null) throw new Error('server exited early');
    try {
      await api('/health');
      return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error('server did not start');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  fs.rmSync(path.join(ROOT_DIR, 'data'), { recursive: true, force: true });
  fs.rmSync(path.join(ROOT_DIR, '素材库'), { recursive: true, force: true });

  const server = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
    cwd: APP_DIR,
    env: { ...process.env, PORT: String(TEST_PORT) },
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

    const bulk = await api('/cases/bulk', {
      method: 'POST',
      body: JSON.stringify({
        text: '批量小林,bulk_dy_1,,吸脂,起号期,成都,25,上班族,自然,批量导入验证\n批量小陈,bulk_dy_2,,吸脂,起号期,杭州,27,自由职业,轻松,批量导入验证',
        generateSlots: true,
        days: 2
      })
    });
    assert(bulk.createdCount === 2, 'bulk import did not create two cases');
    assert(fs.existsSync(path.join(bulk.cases[0].localCaseDir, '00-原始素材')), 'bulk case material dir missing');
    await api(`/cases/${bulk.cases[1].id}`, { method: 'DELETE' });
    const afterDelete = await api('/cases');
    assert(afterDelete.length === 1 && afterDelete[0].id === bulk.cases[0].id, 'case delete failed');

    const caze = await api('/cases', {
      method: 'POST',
      body: JSON.stringify({
        weixinNick: '验收兼职',
        douyinId: 'smoke_dy',
        douyinUrl: 'https://www.douyin.com/',
        project: '吸脂',
        stage: '起号期',
        persona: { city: '成都', age: 25, occupation: '上班族', tone: '自然', motivation: '记录状态变化' }
      })
    });
    assert(fs.existsSync(path.join(caze.localCaseDir, '00-原始素材')), 'case material dir missing');

    fs.writeFileSync(path.join(caze.localCaseDir, '00-原始素材', 'D1-test.jpg'), 'fake image');
    const scan = await api(`/cases/${caze.id}/scan-assets`, { method: 'POST' });
    assert(scan.inserted === 1, 'asset scan did not insert one file');
    await api(`/assets/${scan.assets[0].id}`, { method: 'PATCH', body: JSON.stringify({ reviewStatus: '可用' }) });
    const withGaps = await api(`/cases/${caze.id}`);
    assert(Array.isArray(withGaps.materialGaps) && withGaps.materialGaps.length > 0, 'material gaps missing');
    assert(Array.isArray(withGaps.healthReasons), 'health reasons missing');
    const gapImage = await api('/image-tasks', {
      method: 'POST',
      body: JSON.stringify({ caseId: caze.id, purpose: withGaps.materialGaps[0].label, prompt: `补${withGaps.materialGaps[0].label}` })
    });
    assert(gapImage.purpose === withGaps.materialGaps[0].label, 'gap image task failed');

    const manualSlot = await api(`/cases/${caze.id}/slots`, {
      method: 'POST',
      body: JSON.stringify({ date: '2026-06-01', contentKind: '素人种草', stage: '起号期', goal: '手动槽位验收' })
    });
    assert(manualSlot.contentKind === '素人种草', 'manual slot failed');
    const seededDrafts = await api(`/slots/${manualSlot.id}/generate-candidates`, { method: 'POST' });
    assert(seededDrafts.some((draft) => draft.sourceTemplateId === seed.id), 'seed was not used for daily content');

    const slots = await api(`/cases/${caze.id}/generate-slots`, { method: 'POST', body: JSON.stringify({ days: 2 }) });
    assert(slots.created.length >= 1, 'generated slots missing');
    const slot = slots.created[0];
    const drafts = await api(`/slots/${slot.id}/generate-candidates`, { method: 'POST' });
    assert(drafts.length === 3, 'candidate count is not 3');
    await api(`/candidates/${drafts[0].id}/select`, { method: 'POST' });
    let lockedRejected = false;
    try {
      await api(`/slots/${slot.id}/generate-candidates`, { method: 'POST' });
    } catch (error) {
      lockedRejected = /409/.test(error.message) || /锁定/.test(error.message);
    }
    assert(lockedRejected, 'locked slot allowed candidate regeneration');
    const clip = await api('/clip-tasks', { method: 'POST', body: JSON.stringify({ caseId: caze.id, planSlotId: slot.id, title: '验收剪辑任务' }) });
    assert(fs.existsSync(path.join(clip.outputDir, '剪辑任务单.txt')), 'clip brief file missing');
    const reviewedClip = await api(`/clip-tasks/${clip.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved' }) });
    assert(reviewedClip.status === 'approved', 'clip status update failed');
    const delivery = await api(`/slots/${slot.id}/delivery`, { method: 'POST' });
    assert(fs.existsSync(path.join(delivery.deliveryDir, '01-发给兼职文案.txt')), 'delivery package missing operator text');

    await api(`/slots/${slot.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: '已派发' }) });
    await api(`/slots/${slot.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: '已汇报' }) });
    const detailBeforeVerify = await api(`/cases/${caze.id}`);
    assert(detailBeforeVerify.verifyTasks.length === 1, 'verify task missing');
    await api(`/verify-tasks/${detailBeforeVerify.verifyTasks[0].id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'verified',
        resultNote: '验收核对',
        metricsSnapshot: { fans: '100', plays: '2000', likes: '88', comments: '9' }
      })
    });
    const abnormalSlot = await api(`/slots/${manualSlot.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: '异常' }) });
    assert(abnormalSlot.status === '异常', 'manual abnormal status failed');

    const imageTask = await api('/image-tasks', { method: 'POST', body: JSON.stringify({ caseId: caze.id, purpose: '封面图' }) });
    assert(imageTask.status === 'waiting_key' || imageTask.status === 'draft', 'image task status invalid');
    await api(`/image-tasks/${imageTask.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved' }) });

    const viralBulk = await api(`/viral-templates/${viral.id}/bulk-generate`, { method: 'POST', body: JSON.stringify({ date: '2026-06-02' }) });
    assert(viralBulk.createdCount === 2, 'viral bulk generation failed');

    const exported = await api('/export');
    assert(exported.cases.length === 2, 'export missing cases');
    assert(exported.metrics.length === 1, 'export missing metrics');
    assert(exported.contentSeeds.length >= 1, 'export missing content seeds');
    assert(exported.clipTasks.length === 1, 'export missing clip task');
    const review = await api('/review');
    assert(review.totals.cases === 2, 'review case total invalid');
    assert(review.totals.metrics === 1, 'review metrics total invalid');
    assert(review.contentKindStats.some((item) => item.kind === '爆款提权' && item.total >= 1), 'review content kind stats missing');
    assert(review.topAccounts.length === 1, 'review top account missing');
    const config = await api('/config');
    assert(config.materialTemplates.吸脂.length > 0, 'config material template missing');
    assert(config.stageRatios.起号期, 'config ratios missing');

    const finalDetail = await api(`/cases/${caze.id}`);
    assert(finalDetail.metrics.length === 1, 'case metrics missing');
    assert(finalDetail.clipTasks.length === 1, 'case clip tasks missing');

    console.log('E2E smoke PASS');
  } finally {
    server.kill('SIGTERM');
    await sleep(300);
    fs.rmSync(path.join(ROOT_DIR, 'data'), { recursive: true, force: true });
    fs.rmSync(path.join(ROOT_DIR, '素材库'), { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
