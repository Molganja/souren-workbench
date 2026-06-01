import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import {
  MATERIAL_ROOT,
  ROOT_DIR,
  all,
  ensureCaseDirs,
  get,
  now,
  parseJson,
  run,
  safeSegment,
  uid
} from './db.js';

const app = express();
const PORT = Number(process.env.PORT || 5174);

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const STAGES = ['起号期', '决策期', '术后恢复期', '成果期', '收尾期'];
const CONTENT_KINDS = ['素人种草', '日常养号', '爆款提权'];
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.avi', '.webm']);
const TEXT_EXT = new Set(['.txt', '.md', '.docx']);

const STAGE_RATIOS = {
  起号期: { 日常养号: 0.5, 爆款提权: 0.4, 素人种草: 0.1 },
  决策期: { 日常养号: 0.35, 爆款提权: 0.25, 素人种草: 0.4 },
  术后恢复期: { 日常养号: 0.25, 爆款提权: 0.25, 素人种草: 0.5 },
  成果期: { 日常养号: 0.25, 爆款提权: 0.2, 素人种草: 0.55 },
  收尾期: { 日常养号: 0.4, 爆款提权: 0.3, 素人种草: 0.3 }
};

function rowCase(row) {
  if (!row) return null;
  return {
    id: row.id,
    caseCode: row.case_code,
    weixinNick: row.weixin_nick,
    douyinId: row.douyin_id,
    douyinUrl: row.douyin_url,
    project: row.project,
    stage: row.stage,
    persona: parseJson(row.persona, {}),
    staff: row.staff,
    localCaseDir: row.local_case_dir,
    healthStatus: row.health_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowSlot(row) {
  if (!row) return null;
  return {
    id: row.id,
    caseId: row.case_id,
    date: row.date,
    timeWindow: row.time_window,
    contentKind: row.content_kind,
    goal: row.goal,
    stage: row.stage,
    status: row.status,
    selectedCandidateId: row.selected_candidate_id,
    deliveryDir: row.delivery_dir,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowCandidate(row) {
  if (!row) return null;
  return {
    id: row.id,
    slotId: row.slot_id,
    variant: row.variant,
    title: row.title,
    publishText: row.publish_text,
    operatorInstruction: row.operator_instruction,
    format: row.format,
    sourceTemplateId: row.source_template_id,
    complianceHits: parseJson(row.compliance_hits, []),
    selected: Boolean(row.selected),
    createdAt: row.created_at
  };
}

function rowAsset(row) {
  if (!row) return null;
  return {
    id: row.id,
    caseId: row.case_id,
    path: row.path,
    kind: row.kind,
    stage: row.stage,
    source: row.source,
    usage: row.usage,
    reviewStatus: row.review_status,
    createdAt: row.created_at
  };
}

function rowViral(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    rawText: row.raw_text,
    sourceLink: row.source_link,
    category: row.category,
    hotStructure: row.hot_structure,
    suitablePersonas: parseJson(row.suitable_personas, []),
    forbiddenPersonas: parseJson(row.forbidden_personas, []),
    rewritePolicy: row.rewrite_policy,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowImageTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    caseId: row.case_id,
    planSlotId: row.plan_slot_id,
    purpose: row.purpose,
    prompt: row.prompt,
    negativePrompt: row.negative_prompt,
    sourceMaterials: parseJson(row.source_materials, []),
    outputDir: row.output_dir,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowVerify(row) {
  if (!row) return null;
  return {
    id: row.id,
    caseId: row.case_id,
    planItemId: row.plan_item_id,
    douyinUrl: row.douyin_url,
    expectedTitle: row.expected_title,
    expectedPublishDate: row.expected_publish_date,
    expectedAssets: parseJson(row.expected_assets, []),
    status: row.status,
    resultNote: row.result_note,
    metricsSnapshot: parseJson(row.metrics_snapshot, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function caseById(id) {
  return rowCase(get('SELECT * FROM cases WHERE id = ?', [id]));
}

function slotById(id) {
  return rowSlot(get('SELECT * FROM plan_slots WHERE id = ?', [id]));
}

function personaLine(persona = {}) {
  return [persona.city, persona.age ? `${persona.age}岁` : '', persona.occupation, persona.tone]
    .filter(Boolean)
    .join(' · ') || '普通素人人设';
}

function addDays(base, days) {
  const d = new Date(`${base}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function pickWeighted(weights) {
  const entries = Object.entries(weights);
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  let mark = Math.random() * total;
  for (const [key, value] of entries) {
    mark -= value;
    if (mark <= 0) return key;
  }
  return entries[0][0];
}

function inferGoal(kind, stage) {
  if (kind === '素人种草') return `${stage}种草：围绕案例体验、恢复节点和答疑推进`;
  if (kind === '爆款提权') return '提账号权重：套用爆款结构做人设化内容';
  return '日常养号：保持真人感、连续发布和生活痕迹';
}

function timeWindowFor(index) {
  return index % 2 === 0 ? '10:00-12:00' : '19:00-21:00';
}

function stageForDay(caseStage, offset) {
  if (offset < 7) return caseStage || '起号期';
  if (offset < 14) return '决策期';
  if (offset < 35) return '术后恢复期';
  if (offset < 50) return '成果期';
  return '收尾期';
}

function titleFor(kind, stage, persona, viral) {
  const city = persona.city || '本地';
  const occupation = persona.occupation || '上班族';
  if (kind === '爆款提权' && viral) return `${city}${occupation}版：${viral.title}`;
  if (kind === '爆款提权') return `${occupation}最近状态变好的3个小习惯`;
  if (kind === '日常养号') return `${city}${occupation}的一天，不用太精致但要真实`;
  if (stage === '术后恢复期') return `${stage}记录：今天把真实感受说清楚`;
  if (stage === '成果期') return '这段时间变化最明显的几个细节';
  return `${stage}：我为什么开始认真考虑这个项目`;
}

function draftText(kind, variant, caze, slot, viral) {
  const p = caze.persona || {};
  const line = personaLine(p);
  const motivation = p.motivation || '想把状态调整得更稳定一点';
  const city = p.city || '本地';
  const project = caze.project || '项目';
  const base = {
    稳妥版: `我是${line}。\n今天这条不夸张说效果，只按自己的节奏记录：${motivation}。\n如果你也在看${project}，可以先把自己的顾虑列出来，再去判断要不要继续了解。`,
    互动版: `有没有人也和我一样，明明不是特别胖/特别糟，但就是有一个地方总觉得别扭？\n我最近在${city}慢慢记录${project}这件事，今天想聊的是：做决定前最影响我的3个点。\n评论区可以问，我后面挑高频问题单独回。`,
    爆款结构版: `以前我以为状态变好靠一口气改变，后来发现更像是连续做对几件小事。\n1. 先承认自己真实在意什么。\n2. 不急着听别人下结论。\n3. 把过程按天记录下来。\n这条算是我的${project}阶段记录。`
  };
  if (kind === '爆款提权' && viral) {
    return `${line}版改写：\n${variant === '爆款结构版' ? viral.hotStructure : viral.rawText}\n\n换成我的账号，会讲成一个更生活化的版本：最近让我状态变好的，不是突然自律，而是把一件事想清楚以后，整个人松了一点。`;
  }
  if (kind === '日常养号') {
    return {
      稳妥版: `${line}日常。\n今天没安排复杂内容，就是正常上班/吃饭/走路，顺手拍几张。\n这个号后面会多记录真实生活，不想做得太像广告。`,
      互动版: `${city}打工人今天的小记录：\n有时候状态好不好，不一定看大事，反而看今天有没有好好吃饭、有没有把自己收拾舒服。\n你们平时会因为哪件小事觉得自己状态变好了？`,
      爆款结构版: `让普通女生状态稳定的3个细节：\n1. 出门前给自己留10分钟。\n2. 拍照不一定要精修，但光线要舒服。\n3. 不用每天都很满，能持续就行。`
    }[variant];
  }
  return base[variant];
}

function formatForKind(kind) {
  if (kind === '爆款提权') return '图文';
  return Math.random() > 0.55 ? '图文' : '口播';
}

function createCandidate(slot, caze, variant, viral = null) {
  const id = uid('draft');
  const title = titleFor(slot.contentKind, slot.stage, caze.persona, viral);
  const publishText = draftText(slot.contentKind, variant, caze, slot, viral);
  const operatorInstruction = [
    `今天发：${slot.contentKind}`,
    `账号：${caze.weixinNick} / ${caze.douyinId || '未填抖音号'}`,
    `时间窗：${slot.date} ${slot.timeWindow || ''}`,
    '发布前确认图片/视频顺序，发完让兼职回传作品链接或截图。'
  ].join('\n');
  run(
    `INSERT INTO candidate_drafts
    (id, slot_id, variant, title, publish_text, operator_instruction, format, source_template_id, compliance_hits, selected, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    [
      id,
      slot.id,
      variant,
      title,
      publishText,
      operatorInstruction,
      formatForKind(slot.contentKind),
      viral?.id || null,
      JSON.stringify([]),
      now()
    ]
  );
}

function inferAssetKind(file) {
  const ext = path.extname(file).toLowerCase();
  if (IMAGE_EXT.has(ext)) return '图片';
  if (VIDEO_EXT.has(ext)) return '视频';
  if (TEXT_EXT.has(ext)) return '文案';
  return '截图';
}

function inferStage(filePath) {
  const text = filePath.toLowerCase();
  if (text.includes('术前')) return '术前';
  if (text.includes('面诊') || text.includes('探店')) return '面诊';
  if (text.includes('d1')) return 'D1';
  if (text.includes('d3')) return 'D3';
  if (text.includes('d7')) return 'D7';
  if (text.includes('d14')) return 'D14';
  if (text.includes('d30')) return 'D30';
  if (text.includes('对比')) return '对比';
  return '未分组';
}

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkFiles(full);
    return [full];
  });
}

function dashboard() {
  const cases = all('SELECT * FROM cases ORDER BY created_at DESC').map(rowCase);
  const slots = all('SELECT * FROM plan_slots ORDER BY date ASC, created_at ASC').map(rowSlot);
  const assets = all('SELECT * FROM assets ORDER BY created_at DESC').map(rowAsset);
  const today = new Date().toISOString().slice(0, 10);
  const byCase = Object.fromEntries(cases.map((item) => [item.id, item]));
  const withCase = (slot) => ({ ...slot, case: byCase[slot.caseId] });
  return {
    today,
    counts: {
      cases: cases.length,
      pendingGenerate: slots.filter((s) => s.status === '待生成').length,
      pendingChoose: slots.filter((s) => s.status === '候选待选').length,
      readyDelivery: slots.filter((s) => s.status === '可交付').length,
      pendingVerify: slots.filter((s) => s.status === '已汇报').length,
      blocked: slots.filter((s) => s.status === '素材阻塞' || s.status === '异常').length
    },
    todaySlots: slots.filter((s) => s.date <= today && ['待生成', '候选待选', '已锁定', '可交付'].includes(s.status)).map(withCase),
    pendingGenerate: slots.filter((s) => s.status === '待生成').slice(0, 30).map(withCase),
    pendingChoose: slots.filter((s) => s.status === '候选待选').slice(0, 30).map(withCase),
    readyDelivery: slots.filter((s) => s.status === '可交付').slice(0, 30).map(withCase),
    pendingVerify: slots.filter((s) => s.status === '已汇报').slice(0, 30).map(withCase),
    abnormalCases: cases
      .map((caze) => {
        const caseSlots = slots.filter((s) => s.caseId === caze.id);
        const caseAssets = assets.filter((a) => a.caseId === caze.id);
        const pendingVerify = caseSlots.filter((s) => s.status === '已汇报').length;
        const futureSlots = caseSlots.filter((s) => s.date >= today).length;
        const assetGap = caseAssets.length === 0;
        const reasons = [];
        if (pendingVerify >= 2) reasons.push('待核对堆积');
        if (futureSlots === 0) reasons.push('缺少排期');
        if (assetGap) reasons.push('素材未扫描');
        if (caze.healthStatus !== '健康') reasons.push(caze.healthStatus);
        return { ...caze, reasons };
      })
      .filter((caze) => caze.reasons.length > 0)
  };
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, rootDir: ROOT_DIR, materialRoot: MATERIAL_ROOT, imageKeyReady: Boolean(process.env.IMAGE_API_KEY) });
});

app.get('/api/dashboard', (_req, res) => {
  res.json(dashboard());
});

app.get('/api/cases', (_req, res) => {
  res.json(all('SELECT * FROM cases ORDER BY created_at DESC').map(rowCase));
});

app.post('/api/cases', (req, res) => {
  const body = req.body || {};
  const id = uid('case');
  const created = now();
  const project = body.project || '吸脂';
  const stage = body.stage || '起号期';
  const persona = body.persona || {};
  const date = created.slice(0, 10).replaceAll('-', '');
  const seq = all('SELECT id FROM cases').length + 1;
  const caseCode = body.caseCode || `XZ-${date}-${String(seq).padStart(3, '0')}`;
  const dirName = `${caseCode}_${safeSegment(persona.city)}_${safeSegment(project)}_${safeSegment(body.weixinNick)}`;
  const caseDir = path.join(MATERIAL_ROOT, dirName);
  ensureCaseDirs(caseDir);
  fs.writeFileSync(path.join(caseDir, 'case.json'), JSON.stringify({ id, caseCode, ...body }, null, 2));
  run(
    `INSERT INTO cases
    (id, case_code, weixin_nick, douyin_id, douyin_url, project, stage, persona, staff, local_case_dir, health_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      caseCode,
      body.weixinNick || '未命名兼职',
      body.douyinId || '',
      body.douyinUrl || '',
      project,
      stage,
      JSON.stringify(persona),
      body.staff || '',
      caseDir,
      body.healthStatus || '健康',
      created,
      created
    ]
  );
  res.json(caseById(id));
});

app.patch('/api/cases/:id', (req, res) => {
  const caze = caseById(req.params.id);
  if (!caze) return res.status(404).json({ error: 'case not found' });
  const body = req.body || {};
  run(
    `UPDATE cases SET weixin_nick=?, douyin_id=?, douyin_url=?, project=?, stage=?, persona=?, staff=?, health_status=?, updated_at=? WHERE id=?`,
    [
      body.weixinNick ?? caze.weixinNick,
      body.douyinId ?? caze.douyinId,
      body.douyinUrl ?? caze.douyinUrl,
      body.project ?? caze.project,
      body.stage ?? caze.stage,
      JSON.stringify(body.persona ?? caze.persona),
      body.staff ?? caze.staff,
      body.healthStatus ?? caze.healthStatus,
      now(),
      req.params.id
    ]
  );
  res.json(caseById(req.params.id));
});

app.get('/api/cases/:id', (req, res) => {
  const caze = caseById(req.params.id);
  if (!caze) return res.status(404).json({ error: 'case not found' });
  const slots = all('SELECT * FROM plan_slots WHERE case_id = ? ORDER BY date ASC', [caze.id]).map(rowSlot);
  const candidates = all(
    `SELECT cd.* FROM candidate_drafts cd JOIN plan_slots ps ON ps.id = cd.slot_id WHERE ps.case_id = ? ORDER BY cd.created_at ASC`,
    [caze.id]
  ).map(rowCandidate);
  const assets = all('SELECT * FROM assets WHERE case_id = ? ORDER BY created_at DESC', [caze.id]).map(rowAsset);
  const imageTasks = all('SELECT * FROM image_tasks WHERE case_id = ? ORDER BY created_at DESC', [caze.id]).map(rowImageTask);
  const verifyTasks = all('SELECT * FROM verify_tasks WHERE case_id = ? ORDER BY created_at DESC', [caze.id]).map(rowVerify);
  res.json({ case: caze, slots, candidates, assets, imageTasks, verifyTasks });
});

app.post('/api/cases/:id/scan-assets', (req, res) => {
  const caze = caseById(req.params.id);
  if (!caze) return res.status(404).json({ error: 'case not found' });
  const roots = ['00-原始素材', '01-已筛选素材', '02-生成补充', '04-发布回收'].map((name) => path.join(caze.localCaseDir, name));
  let inserted = 0;
  roots.flatMap(walkFiles).forEach((file) => {
    const ext = path.extname(file).toLowerCase();
    if (![...IMAGE_EXT, ...VIDEO_EXT, ...TEXT_EXT].includes(ext)) return;
    try {
      run(
        `INSERT INTO assets (id, case_id, path, kind, stage, source, usage, review_status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uid('asset'),
          caze.id,
          file,
          inferAssetKind(file),
          inferStage(file),
          file.includes('02-生成补充') ? 'AI生成' : '真实',
          '备用',
          '待处理',
          now()
        ]
      );
      inserted += 1;
    } catch {
      // Existing file path for this case; keep current review status.
    }
  });
  res.json({ inserted, assets: all('SELECT * FROM assets WHERE case_id = ? ORDER BY created_at DESC', [caze.id]).map(rowAsset) });
});

app.post('/api/cases/:id/generate-slots', (req, res) => {
  const caze = caseById(req.params.id);
  if (!caze) return res.status(404).json({ error: 'case not found' });
  const days = Number(req.body?.days || 30);
  const startDate = req.body?.startDate || new Date().toISOString().slice(0, 10);
  const created = [];
  for (let i = 0; i < days; i += 1) {
    const date = addDays(startDate, i);
    const exists = get('SELECT id FROM plan_slots WHERE case_id = ? AND date = ?', [caze.id, date]);
    if (exists) continue;
    const stage = stageForDay(caze.stage, i);
    const contentKind = pickWeighted(STAGE_RATIOS[stage] || STAGE_RATIOS.起号期);
    const slotId = uid('slot');
    run(
      `INSERT INTO plan_slots
      (id, case_id, date, time_window, content_kind, goal, stage, status, selected_candidate_id, delivery_dir, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, '待生成', NULL, NULL, ?, ?)`,
      [slotId, caze.id, date, timeWindowFor(i), contentKind, inferGoal(contentKind, stage), stage, now(), now()]
    );
    created.push(slotById(slotId));
  }
  res.json({ created });
});

app.post('/api/slots/:id/generate-candidates', (req, res) => {
  const slot = slotById(req.params.id);
  if (!slot) return res.status(404).json({ error: 'slot not found' });
  const caze = caseById(slot.caseId);
  const viral = rowViral(get('SELECT * FROM viral_templates ORDER BY created_at DESC LIMIT 1'));
  run('DELETE FROM candidate_drafts WHERE slot_id = ? AND selected = 0', [slot.id]);
  ['稳妥版', '互动版', '爆款结构版'].forEach((variant) => createCandidate(slot, caze, variant, slot.contentKind === '爆款提权' ? viral : null));
  run('UPDATE plan_slots SET status = ?, updated_at = ? WHERE id = ?', ['候选待选', now(), slot.id]);
  res.json(all('SELECT * FROM candidate_drafts WHERE slot_id = ? ORDER BY created_at ASC', [slot.id]).map(rowCandidate));
});

app.post('/api/candidates/:id/select', (req, res) => {
  const candidate = rowCandidate(get('SELECT * FROM candidate_drafts WHERE id = ?', [req.params.id]));
  if (!candidate) return res.status(404).json({ error: 'candidate not found' });
  run('UPDATE candidate_drafts SET selected = 0 WHERE slot_id = ?', [candidate.slotId]);
  run('UPDATE candidate_drafts SET selected = 1 WHERE id = ?', [candidate.id]);
  run('UPDATE plan_slots SET selected_candidate_id = ?, status = ?, updated_at = ? WHERE id = ?', [candidate.id, '已锁定', now(), candidate.slotId]);
  res.json({ slot: slotById(candidate.slotId), candidate: rowCandidate(get('SELECT * FROM candidate_drafts WHERE id = ?', [candidate.id])) });
});

app.patch('/api/slots/:id/status', (req, res) => {
  const slot = slotById(req.params.id);
  if (!slot) return res.status(404).json({ error: 'slot not found' });
  const status = req.body?.status || slot.status;
  run('UPDATE plan_slots SET status = ?, updated_at = ? WHERE id = ?', [status, now(), slot.id]);
  if (status === '已汇报') {
    const caze = caseById(slot.caseId);
    const selected = rowCandidate(get('SELECT * FROM candidate_drafts WHERE id = ?', [slot.selectedCandidateId]));
    const exists = get('SELECT id FROM verify_tasks WHERE plan_item_id = ?', [slot.id]);
    if (!exists) {
      run(
        `INSERT INTO verify_tasks
        (id, case_id, plan_item_id, douyin_url, expected_title, expected_publish_date, expected_assets, status, result_note, metrics_snapshot, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, '[]', 'pending', '', NULL, ?, ?)`,
        [uid('verify'), caze.id, slot.id, caze.douyinUrl, selected?.title || '', slot.date, now(), now()]
      );
    }
  }
  res.json(slotById(slot.id));
});

app.post('/api/slots/:id/delivery', (req, res) => {
  const slot = slotById(req.params.id);
  if (!slot) return res.status(404).json({ error: 'slot not found' });
  const caze = caseById(slot.caseId);
  const candidate = rowCandidate(get('SELECT * FROM candidate_drafts WHERE id = ?', [slot.selectedCandidateId]));
  if (!candidate) return res.status(400).json({ error: 'select a candidate first' });
  const folder = `${slot.date}_${safeSegment(slot.stage)}_${safeSegment(slot.contentKind)}`;
  const deliveryDir = path.join(caze.localCaseDir, '03-交付给兼职', folder);
  fs.mkdirSync(deliveryDir, { recursive: true });
  fs.writeFileSync(path.join(deliveryDir, '01-发给兼职文案.txt'), candidate.operatorInstruction);
  fs.writeFileSync(path.join(deliveryDir, '02-抖音发布文案.txt'), `${candidate.title}\n\n${candidate.publishText}`);
  fs.writeFileSync(path.join(deliveryDir, '06-发布要求.txt'), `类型：${slot.contentKind}\n形式：${candidate.format}\n日期：${slot.date}\n时间窗：${slot.timeWindow || ''}\n发完后回传作品链接或截图。`);
  const assets = all('SELECT * FROM assets WHERE case_id = ? AND review_status IN (?, ?) ORDER BY created_at DESC LIMIT 9', [caze.id, '可用', '待处理']).map(rowAsset);
  assets.forEach((asset, index) => {
    if (!fs.existsSync(asset.path)) return;
    const ext = path.extname(asset.path);
    const label = asset.kind === '视频' ? '视频' : '图片';
    fs.copyFileSync(asset.path, path.join(deliveryDir, `${String(index + 3).padStart(2, '0')}-${label}${index + 1}${ext}`));
  });
  run('UPDATE plan_slots SET status = ?, delivery_dir = ?, updated_at = ? WHERE id = ?', ['可交付', deliveryDir, now(), slot.id]);
  res.json({ deliveryDir, slot: slotById(slot.id) });
});

app.post('/api/image-tasks', (req, res) => {
  const body = req.body || {};
  const caze = caseById(body.caseId);
  if (!caze) return res.status(404).json({ error: 'case not found' });
  const slot = body.planSlotId ? slotById(body.planSlotId) : null;
  const purpose = body.purpose || slot?.contentKind || '日常养号';
  const outputDir = path.join(caze.localCaseDir, '02-生成补充', safeSegment(purpose));
  fs.mkdirSync(outputDir, { recursive: true });
  const p = caze.persona || {};
  const prompt =
    body.prompt ||
    `为${personaLine(p)}生成一张适合抖音${purpose}的图，场景贴近日常真实感，适合${slot?.stage || caze.stage}阶段，画面自然，手机拍摄质感。`;
  const status = process.env.IMAGE_API_KEY ? 'draft' : 'waiting_key';
  const id = uid('image');
  run(
    `INSERT INTO image_tasks
    (id, case_id, plan_slot_id, purpose, prompt, negative_prompt, source_materials, output_dir, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      caze.id,
      body.planSlotId || null,
      purpose,
      prompt,
      body.negativePrompt || '过度精修，夸张效果，水印，低清晰度',
      JSON.stringify(body.sourceMaterials || []),
      outputDir,
      status,
      now(),
      now()
    ]
  );
  res.json(rowImageTask(get('SELECT * FROM image_tasks WHERE id = ?', [id])));
});

app.get('/api/viral-templates', (_req, res) => {
  res.json(all('SELECT * FROM viral_templates ORDER BY created_at DESC').map(rowViral));
});

app.post('/api/viral-templates', (req, res) => {
  const body = req.body || {};
  const id = uid('viral');
  run(
    `INSERT INTO viral_templates
    (id, title, raw_text, source_link, category, hot_structure, suitable_personas, forbidden_personas, rewrite_policy, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      body.title || '未命名爆款模板',
      body.rawText || '',
      body.sourceLink || '',
      body.category || '情绪',
      body.hotStructure || '开头提出共鸣问题，中段列出3个细节，结尾引导评论',
      JSON.stringify(body.suitablePersonas || []),
      JSON.stringify(body.forbiddenPersonas || []),
      body.rewritePolicy || '结构模仿',
      now(),
      now()
    ]
  );
  res.json(rowViral(get('SELECT * FROM viral_templates WHERE id = ?', [id])));
});

app.patch('/api/verify-tasks/:id', (req, res) => {
  const task = rowVerify(get('SELECT * FROM verify_tasks WHERE id = ?', [req.params.id]));
  if (!task) return res.status(404).json({ error: 'verify task not found' });
  const body = req.body || {};
  run(
    'UPDATE verify_tasks SET status = ?, result_note = ?, metrics_snapshot = ?, updated_at = ? WHERE id = ?',
    [
      body.status || task.status,
      body.resultNote ?? task.resultNote,
      body.metricsSnapshot ? JSON.stringify(body.metricsSnapshot) : JSON.stringify(task.metricsSnapshot),
      now(),
      task.id
    ]
  );
  if (body.status === 'verified') {
    run('UPDATE plan_slots SET status = ?, updated_at = ? WHERE id = ?', ['已核对', now(), task.planItemId]);
  }
  res.json(rowVerify(get('SELECT * FROM verify_tasks WHERE id = ?', [task.id])));
});

app.get('/api/export', (_req, res) => {
  res.json({
    exportedAt: now(),
    cases: all('SELECT * FROM cases').map(rowCase),
    planSlots: all('SELECT * FROM plan_slots').map(rowSlot),
    candidateDrafts: all('SELECT * FROM candidate_drafts').map(rowCandidate),
    viralTemplates: all('SELECT * FROM viral_templates').map(rowViral),
    assets: all('SELECT * FROM assets').map(rowAsset),
    imageTasks: all('SELECT * FROM image_tasks').map(rowImageTask),
    verifyTasks: all('SELECT * FROM verify_tasks').map(rowVerify)
  });
});

app.use('/files', express.static(ROOT_DIR));

if (fs.existsSync(path.join(process.cwd(), 'dist'))) {
  app.use(express.static(path.join(process.cwd(), 'dist')));
  app.get('*splat', (_req, res) => res.sendFile(path.join(process.cwd(), 'dist', 'index.html')));
}

app.listen(PORT, '127.0.0.1', () => {
  console.log(`API running at http://127.0.0.1:${PORT}`);
  console.log(`Material root: ${MATERIAL_ROOT}`);
});
