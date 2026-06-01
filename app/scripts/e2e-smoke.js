import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const TEST_PORT = 5184;
const BASE = `http://127.0.0.1:${TEST_PORT}/api`;
const APP_DIR = path.resolve(import.meta.dirname, '..');
const REAL_ROOT_DIR = path.resolve(APP_DIR, '..');
const ROOT_DIR = path.join(REAL_ROOT_DIR, '.tmp-e2e');

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
  fs.mkdirSync(ROOT_DIR, { recursive: true });

  const server = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
    cwd: APP_DIR,
    env: { ...process.env, PORT: String(TEST_PORT), SOUREN_ROOT_DIR: ROOT_DIR },
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
        title: '成都上班族专用爆款',
        rawText: '只给成都上班族生成。',
        category: '职场',
        hotStructure: '城市 + 职业 + 三点清单',
        suitablePersonas: ['成都', '上班族'],
        forbiddenPersonas: ['杭州'],
        rewritePolicy: '结构模仿'
      })
    });
    assert(filteredViral.suitablePersonas.length === 2 && filteredViral.forbiddenPersonas.length === 1, 'viral persona filters not saved');
    const linkOnlyViral = await api('/viral-templates', {
      method: 'POST',
      body: JSON.stringify({ sourceLink: 'https://www.douyin.com/video/link-only-smoke' })
    });
    assert(linkOnlyViral.rawText.includes('待用青豆') && linkOnlyViral.category === '待分析', 'link-only viral template not marked pending analysis');
    const qingdouTask = await api(`/viral-templates/${linkOnlyViral.id}/qingdou-task`);
    assert(qingdouTask.text.includes('https://www.douyin.com/video/link-only-smoke') && qingdouTask.text.includes('回填到系统'), 'qingdou task text missing');
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
        project: '吸脂',
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
        text: '批量小林,bulk_dy_1,,吸脂,起号期,成都,25,上班族,自然,批量导入验证,咨询A\n批量小陈,bulk_dy_2,,吸脂,起号期,杭州,27,自由职业,轻松,批量导入验证,咨询B',
        generateSlots: true,
        days: 2
      })
    });
    assert(bulk.createdCount === 2, 'bulk import did not create two cases');
    assert(bulk.cases[0].staff === '咨询A' && bulk.cases[1].staff === '咨询B', 'bulk import staff missing');
    assert(fs.existsSync(path.join(bulk.cases[0].localCaseDir, '00-原始素材')), 'bulk case material dir missing');
    await api(`/cases/${bulk.cases[1].id}`, { method: 'DELETE' });
    const afterDelete = await api('/cases');
    assert(afterDelete.length === 1 && afterDelete[0].id === bulk.cases[0].id, 'case delete failed');
    const batchGenerated = await api('/dashboard/generate-today', { method: 'POST' });
    assert(batchGenerated.slotCount >= 1 && batchGenerated.candidateCount >= 3, 'dashboard batch generate did not create candidates');

    const caze = await api('/cases', {
      method: 'POST',
      body: JSON.stringify({
        douyinId: 'smoke_dy',
        douyinUrl: 'https://www.douyin.com/',
        project: '吸脂',
        stage: '起号期',
        staff: '咨询C',
        persona: { city: '成都', occupation: '上班族' }
      })
    });
    assert(caze.weixinNick.includes('成都') && caze.persona.age && caze.persona.tone && caze.persona.motivation, 'case random defaults missing');
    assert(fs.existsSync(path.join(caze.localCaseDir, '00-原始素材')), 'case material dir missing');
    const minimalCase = await api('/cases', {
      method: 'POST',
      body: JSON.stringify({ douyinUrl: 'https://www.douyin.com/video/minimal-smoke', staff: '咨询Z', generateSlots: true, days: 3 })
    });
    assert(minimalCase.weixinNick && minimalCase.weixinNick !== '未命名兼职', 'minimal case did not generate nick');
    assert(minimalCase.staff === '咨询Z' && minimalCase.persona.city && minimalCase.persona.motivation, 'minimal case defaults missing');
    assert(!minimalCase.localCaseDir.includes('未命名'), 'minimal case directory used unnamed segment');
    assert(minimalCase.slotsCreated === 3, 'minimal case did not auto generate slots');
    const minimalDetail = await api(`/cases/${minimalCase.id}`);
    assert(minimalDetail.slots.length === 3 && minimalDetail.slots.every((item) => item.status === '待生成'), 'minimal case slots missing');
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
      body: JSON.stringify({ weixinNick: '验收兼职改名', staff: '咨询D', persona: { ...caze.persona, city: '重庆' } })
    });
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert(editedCase.weixinNick === '验收兼职改名' && editedCase.staff === '咨询D' && manifest.staff === '咨询D', 'case manifest not synced after edit');

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
    assert(intakeNote.text.includes('素材补齐说明') && intakeNote.text.includes('00-原始素材'), 'material intake note missing target dir');
    assert(intakeNote.text.includes('必补素材') && intakeNote.text.includes(caze.caseCode), 'material intake note missing gap summary');
    const gapImage = await api('/image-tasks', {
      method: 'POST',
      body: JSON.stringify({ caseId: caze.id, purpose: withGaps.materialGaps[0].label, prompt: `补${withGaps.materialGaps[0].label}` })
    });
    assert(gapImage.purpose === withGaps.materialGaps[0].label, 'gap image task failed');
    assert(fs.existsSync(path.join(gapImage.outputDir, `${gapImage.id}-图片任务说明.txt`)), 'image task brief missing');
    const gapImagePrompt = await api(`/image-tasks/${gapImage.id}/prompt`);
    assert(gapImagePrompt.text.includes('Prompt:') && gapImagePrompt.text.includes('Negative prompt:'), 'image prompt copy text missing');
    const imageDashboard = await api('/dashboard');
    assert(imageDashboard.counts.imageTasks >= 1 && imageDashboard.counts.imageWaitingKey >= 1, 'dashboard image task counts missing');
    assert(imageDashboard.imageTasks.some((item) => item.id === gapImage.id && item.case?.id === caze.id), 'dashboard image task list missing case task');

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

    const slots = await api(`/cases/${caze.id}/generate-slots`, { method: 'POST', body: JSON.stringify({ days: 2 }) });
    assert(slots.created.length >= 1, 'generated slots missing');
    const schedule = await api('/schedule');
    assert(schedule.counts.total >= 1, 'schedule total missing');
    assert(schedule.days.some((day) => day.items.some((item) => item.case?.id === caze.id)), 'schedule case slot missing');
    const slot = slots.created[0];
    const drafts = await api(`/slots/${slot.id}/generate-candidates`, { method: 'POST' });
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
    const clipDashboard = await api('/dashboard');
    assert(clipDashboard.counts.clipTasks >= 1, 'dashboard clip task count missing');
    assert(clipDashboard.clipTasks.some((item) => item.id === clip.id && item.case?.id === caze.id), 'dashboard clip task list missing case task');
    const reviewedClip = await api(`/clip-tasks/${clip.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved' }) });
    assert(reviewedClip.status === 'approved', 'clip status update failed');
    const clipDashboardAfter = await api('/dashboard');
    assert(!clipDashboardAfter.clipTasks.some((item) => item.id === clip.id), 'approved clip task still shown as pending');
    const delivery = await api(`/slots/${slot.id}/delivery`, { method: 'POST' });
    const wxChecklistPath = path.join(delivery.deliveryDir, '00-微信发送清单.txt');
    assert(fs.existsSync(wxChecklistPath), 'delivery package missing WeChat checklist');
    const wxChecklist = fs.readFileSync(wxChecklistPath, 'utf8');
    assert(wxChecklist.includes('发给：验收兼职改名') && wxChecklist.includes('对接人：咨询D'), 'WeChat checklist missing recipient routing');
    assert(wxChecklist.includes('发送顺序') && wxChecklist.includes('回传要求'), 'WeChat checklist missing send or report instructions');
    assert(fs.existsSync(path.join(delivery.deliveryDir, '01-发给兼职文案.txt')), 'delivery package missing operator text');
    assert(fs.existsSync(path.join(delivery.deliveryDir, '05-素材顺序清单.txt')), 'delivery asset order file missing');
    assert(delivery.copiedAssets.length >= 1, 'delivery copied asset list missing');
    const deliveryDashboard = await api('/dashboard');
    const deliveryDashboardSlot = deliveryDashboard.readyDelivery.find((item) => item.id === slot.id)
      || deliveryDashboard.todaySlots.find((item) => item.id === slot.id);
    assert(deliveryDashboardSlot?.selectedCandidate?.operatorInstruction, 'dashboard missing ready delivery copy data');
    assert(deliveryDashboardSlot.case.staff === '咨询D', 'dashboard missing contact staff');
    assert(deliveryDashboardSlot.selectedCandidate.operatorInstruction.includes('对接人：咨询D'), 'operator instruction missing contact staff');
    assert(Number.isInteger(deliveryDashboard.counts.locked) && Number.isInteger(deliveryDashboard.counts.sentWaitReport), 'dashboard work split counts missing');

    const videoSlot = await api(`/cases/${caze.id}/slots`, {
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

    const batchDeliverySlot = await api(`/cases/${caze.id}/slots`, {
      method: 'POST',
      body: JSON.stringify({ date: '2026-06-01', contentKind: '日常养号', stage: '起号期', goal: '批量交付包验收' })
    });
    const batchDeliveryDrafts = await api(`/slots/${batchDeliverySlot.id}/generate-candidates`, { method: 'POST' });
    await api(`/candidates/${batchDeliveryDrafts[0].id}/select`, { method: 'POST' });
    const batchDelivered = await api('/dashboard/deliver-today', { method: 'POST' });
    assert(batchDelivered.deliveryCount >= 1, 'dashboard batch delivery did not create delivery packages');

    await api(`/slots/${slot.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: '已派发' }) });
    await api(`/slots/${slot.id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: '已汇报',
        douyinUrl: 'https://www.douyin.com/video/smoke-published',
        resultNote: '兼职回传作品链接：https://www.douyin.com/video/smoke-published'
      })
    });
    const detailBeforeVerify = await api(`/cases/${caze.id}`);
    assert(detailBeforeVerify.verifyTasks.length === 1, 'verify task missing');
    assert(detailBeforeVerify.verifyTasks[0].expectedAssets.length >= 1, 'verify task expected assets missing');
    assert(detailBeforeVerify.verifyTasks[0].douyinUrl === 'https://www.douyin.com/video/smoke-published', 'verify task did not store reported douyin url');
    const verifyChecklist = await api(`/verify-tasks/${detailBeforeVerify.verifyTasks[0].id}/checklist`);
    assert(verifyChecklist.text.includes('抖音发布核对清单') && verifyChecklist.text.includes('https://www.douyin.com/video/smoke-published'), 'verify checklist missing link');
    assert(verifyChecklist.text.includes('预期素材') && verifyChecklist.text.includes('回填到系统'), 'verify checklist missing assets or follow-up');
    const verifySchedule = await api('/schedule');
    const verifyScheduleSlot = verifySchedule.slots.find((item) => item.id === slot.id);
    assert(verifyScheduleSlot?.verifyTask?.douyinUrl === 'https://www.douyin.com/video/smoke-published', 'schedule missing reported douyin url');
    const verifyDashboard = await api('/dashboard');
    const verifyDashboardSlot = verifyDashboard.pendingVerify.find((item) => item.id === slot.id);
    assert(verifyDashboardSlot?.verifyTask?.douyinUrl === 'https://www.douyin.com/video/smoke-published', 'dashboard missing reported douyin url');
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
    assert(viralBulk.createdCount === 3, 'viral bulk generation failed');
    const filteredBulk = await api(`/viral-templates/${filteredViral.id}/bulk-generate`, { method: 'POST', body: JSON.stringify({ date: '2026-06-03' }) });
    assert(filteredBulk.createdCount >= 1 && filteredBulk.skippedCount >= 1, 'viral persona filter bulk generation failed');
    let pendingRejected = false;
    try {
      await api(`/viral-templates/${linkOnlyViral.id}/bulk-generate`, { method: 'POST', body: JSON.stringify({ date: '2026-06-04' }) });
    } catch (error) {
      pendingRejected = /409/.test(error.message) || /青豆/.test(error.message);
    }
    assert(pendingRejected, 'pending link-only viral template allowed bulk generation');
    const analyzedViral = await api(`/viral-templates/${linkOnlyViral.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        title: '青豆分析后的链接',
        rawText: '青豆提取：真实生活开头，三段转折，评论提问。',
        category: '情绪',
        hotStructure: '生活场景开头 + 三段状态变化 + 评论区提问',
        suitablePersonas: ['成都'],
        rewritePolicy: '结构模仿'
      })
    });
    assert(analyzedViral.title === '青豆分析后的链接' && analyzedViral.category === '情绪', 'viral analysis patch failed');
    const analyzedBulk = await api(`/viral-templates/${analyzedViral.id}/bulk-generate`, { method: 'POST', body: JSON.stringify({ date: '2026-06-05' }) });
    assert(analyzedBulk.createdCount >= 1, 'analyzed viral link did not generate filtered slots');

    const exported = await api('/export');
    assert(exported.cases.length === 3, 'export missing cases');
    assert(exported.metrics.length === 1, 'export missing metrics');
    assert(exported.contentSeeds.length >= 1, 'export missing content seeds');
    assert(exported.clipTasks.length === 1, 'export missing clip task');
    const manualBackup = await api('/backups', { method: 'POST', body: JSON.stringify({ reason: 'smoke-test' }) });
    assert(fs.existsSync(manualBackup.backup.path), 'manual backup file missing');
    const importResult = await api('/import', { method: 'POST', body: JSON.stringify(exported) });
    assert(fs.existsSync(importResult.preImportBackup.path), 'pre-import backup file missing');
    let badImportRejected = false;
    try {
      await api('/import', {
        method: 'POST',
        body: JSON.stringify({
          ...exported,
          planSlots: [{ ...exported.planSlots[0], id: 'bad_slot_fk', caseId: 'missing_case' }]
        })
      });
    } catch (error) {
      badImportRejected = /import failed/.test(error.message);
    }
    assert(badImportRejected, 'bad import was not rejected');
    const afterBadImportCases = await api('/cases');
    assert(afterBadImportCases.length === 3, 'bad import changed existing cases');
    const review = await api('/review');
    assert(review.totals.cases === 3, 'review case total invalid');
    assert(review.totals.metrics === 1, 'review metrics total invalid');
    assert(review.contentKindStats.some((item) => item.kind === '爆款提权' && item.total >= 1), 'review content kind stats missing');
    assert(review.topAccounts.length === 1, 'review top account missing');
    const config = await api('/config');
    assert(config.materialTemplates.吸脂.length > 0, 'config material template missing');
    assert(config.stageRatios.起号期, 'config ratios missing');
    assert(config.backups.length >= 2, 'config backup list missing');

    const finalDetail = await api(`/cases/${caze.id}`);
    assert(finalDetail.metrics.length === 1, 'case metrics missing');
    assert(finalDetail.clipTasks.length === 1, 'case clip tasks missing');

    console.log('E2E smoke PASS');
  } finally {
    server.kill('SIGTERM');
    await sleep(300);
    fs.rmSync(ROOT_DIR, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
