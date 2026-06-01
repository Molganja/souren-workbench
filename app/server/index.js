import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import {
  DATA_DIR,
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
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const STAGES = ['起号期', '决策期', '术后恢复期', '成果期', '收尾期'];
const CONTENT_KINDS = ['素人种草', '日常养号', '爆款提权'];
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.avi', '.webm']);
const TEXT_EXT = new Set(['.txt', '.md', '.docx']);
const ALLOWED_OPEN_ROOTS = [ROOT_DIR];

const STAGE_RATIOS = {
  起号期: { 日常养号: 0.5, 爆款提权: 0.4, 素人种草: 0.1 },
  决策期: { 日常养号: 0.35, 爆款提权: 0.25, 素人种草: 0.4 },
  术后恢复期: { 日常养号: 0.25, 爆款提权: 0.25, 素人种草: 0.5 },
  成果期: { 日常养号: 0.25, 爆款提权: 0.2, 素人种草: 0.55 },
  收尾期: { 日常养号: 0.4, 爆款提权: 0.3, 素人种草: 0.3 }
};

const MATERIAL_TEMPLATES = {
  吸脂: [
    { key: 'pre-front', label: '术前正面/基准照', stage: '术前', required: true, match: ['术前', '基准'] },
    { key: 'consult', label: '面诊/探店素材', stage: '面诊', required: false, match: ['面诊', '探店'] },
    { key: 'd1', label: '术后 D1 素材', stage: 'D1', required: false, match: ['D1'] },
    { key: 'd3', label: '术后 D3 素材', stage: 'D3', required: false, match: ['D3'] },
    { key: 'd7', label: '术后 D7 素材', stage: 'D7', required: false, match: ['D7'] },
    { key: 'd14', label: '术后 D14 素材', stage: 'D14', required: false, match: ['D14'] },
    { key: 'd30', label: '术后 D30 素材', stage: 'D30', required: false, match: ['D30'] },
    { key: 'compare', label: '对比素材', stage: '对比', required: true, match: ['对比'] },
    { key: 'daily', label: '日常穿搭/生活素材', stage: '未分组', required: false, match: ['日常', '穿搭', '生活', '未分组'] }
  ],
  默认: [
    { key: 'before', label: '前期/基准素材', stage: '术前', required: true, match: ['术前', '基准'] },
    { key: 'process', label: '过程素材', stage: '未分组', required: false, match: ['D1', 'D3', 'D7', '过程', '未分组'] },
    { key: 'result', label: '结果/对比素材', stage: '对比', required: true, match: ['对比', '结果'] },
    { key: 'daily', label: '日常素材', stage: '未分组', required: false, match: ['日常', '生活', '未分组'] }
  ]
};

const RANDOM_CASE_PROFILES = {
  cities: ['成都', '杭州', '重庆', '西安', '长沙', '武汉', '南京', '苏州', '广州', '深圳'],
  ages: [23, 24, 25, 26, 27, 28, 29, 30, 31, 32],
  occupations: ['上班族', '自由职业', '美业顾问', '行政', '设计师', '护士', '教师', '运营', '店员', '宝妈'],
  tones: ['自然', '轻松', '克制', '真实记录', '生活化', '碎碎念'],
  motivations: [
    '想把状态变化记录下来',
    '想做一点真实生活记录',
    '想看看自己坚持更新后的变化',
    '想把纠结和决策过程讲清楚',
    '想用普通人的方式记录恢复过程',
    '想让账号看起来更像真实日常'
  ]
};

const DEFAULT_CONTENT_SEEDS = [
  {
    project: '通用',
    stage: '起号期',
    contentKind: '日常养号',
    format: '图文',
    titleTemplate: '{城市}{occupation}今天的小记录',
    contentTemplate: '{城市}{occupation}日常。\n今天不做复杂内容，就是正常上班、吃饭、走路，顺手拍几张。\n这个号后面会多记录真实生活，不想做得太像广告。',
    tags: ['日常', '起号']
  },
  {
    project: '通用',
    stage: '通用',
    contentKind: '日常养号',
    format: '图文',
    titleTemplate: '普通女生状态稳定的几个小细节',
    contentTemplate: '让状态慢慢变好的，不一定是什么大改变。\n1. 出门前给自己留一点时间。\n2. 拍照不用精修，但光线舒服一点。\n3. 每天记录一点点，别断太久。',
    tags: ['状态', '清单']
  },
  {
    project: '吸脂',
    stage: '决策期',
    contentKind: '素人种草',
    format: '口播',
    titleTemplate: '{城市}{年龄}岁，我为什么开始认真看{项目}',
    contentTemplate: '我是{城市}{年龄}岁，{occupation}。\n一开始看{项目}不是因为冲动，而是{motivation}。\n今天先说我做决定前最纠结的3件事：恢复期、真实变化、以及自己能不能接受过程。',
    tags: ['决策', '口播']
  },
  {
    project: '吸脂',
    stage: '术后恢复期',
    contentKind: '素人种草',
    format: '图文',
    titleTemplate: '{项目}{阶段}记录：今天真实感受',
    contentTemplate: '今天按{项目}{阶段}来记录，不把话说满。\n身体状态、穿衣感受、情绪变化都分开写。\n如果你也在看类似项目，建议先看过程，不要只看单张结果图。',
    tags: ['恢复', '图文']
  }
];

function seedDefaultContentSeeds() {
  const count = get('SELECT COUNT(*) AS count FROM content_seeds')?.count || 0;
  if (count > 0) return;
  DEFAULT_CONTENT_SEEDS.forEach((item) => {
    run(
      `INSERT INTO content_seeds
      (id, project, stage, content_kind, format, title_template, content_template, tags, base_weight, usage_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        uid('seed'),
        item.project,
        item.stage,
        item.contentKind,
        item.format,
        item.titleTemplate,
        item.contentTemplate,
        JSON.stringify(item.tags || []),
        item.baseWeight || 1,
        now(),
        now()
      ]
    );
  });
}

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

function rowContentSeed(row) {
  if (!row) return null;
  return {
    id: row.id,
    project: row.project,
    stage: row.stage,
    contentKind: row.content_kind,
    format: row.format,
    titleTemplate: row.title_template,
    contentTemplate: row.content_template,
    tags: parseJson(row.tags, []),
    baseWeight: row.base_weight,
    usageCount: row.usage_count,
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

function rowClipTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    caseId: row.case_id,
    planSlotId: row.plan_slot_id,
    title: row.title,
    brief: row.brief,
    outputDir: row.output_dir,
    status: row.status,
    finalVideoPath: row.final_video_path,
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

function rowMetric(row) {
  if (!row) return null;
  return {
    id: row.id,
    caseId: row.case_id,
    date: row.date,
    fans: row.fans,
    plays: row.plays,
    likes: row.likes,
    comments: row.comments,
    note: row.note,
    createdAt: row.created_at
  };
}

function assertInsideRoot(targetPath) {
  const resolved = path.resolve(targetPath);
  const ok = ALLOWED_OPEN_ROOTS.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
  if (!ok) {
    const err = new Error('path is outside allowed workspace');
    err.status = 400;
    throw err;
  }
  return resolved;
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

function pickRandom(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function randomPersona(input = {}) {
  return {
    city: input.city || pickRandom(RANDOM_CASE_PROFILES.cities),
    age: input.age || pickRandom(RANDOM_CASE_PROFILES.ages),
    occupation: input.occupation || pickRandom(RANDOM_CASE_PROFILES.occupations),
    tone: input.tone || pickRandom(RANDOM_CASE_PROFILES.tones),
    motivation: input.motivation || pickRandom(RANDOM_CASE_PROFILES.motivations)
  };
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

function fillVars(template, caze) {
  const p = caze.persona || {};
  const vars = {
    昵称: p.nickname || caze.weixinNick || '我',
    城市: p.city || '本地',
    年龄: p.age || '',
    occupation: p.occupation || '上班族',
    职业: p.occupation || '上班族',
    tone: p.tone || '自然',
    语气: p.tone || '自然',
    motivation: p.motivation || '想把状态调整得更稳定一点',
    动机: p.motivation || '想把状态调整得更稳定一点',
    项目: caze.project || '项目',
    阶段: caze.stage || '当前阶段'
  };
  return String(template || '').replace(/\{([^}]+)\}/g, (_, key) => vars[key] ?? '');
}

function seedVariantText(base, variant) {
  if (variant === '互动版') return `${base}\n\n你们会更想看过程记录，还是直接看结果和踩坑？`;
  if (variant === '爆款结构版') return `先说结论：这件事最重要的不是冲动决定，而是把过程拆清楚。\n\n${base}\n\n我后面会按时间线继续记。`;
  return base;
}

function pickContentSeed(slot, caze) {
  const rows = all(
    `SELECT * FROM content_seeds
    WHERE content_kind = ?
      AND (project = ? OR project = '通用')
      AND (stage = ? OR stage = '通用')
    ORDER BY usage_count ASC, created_at DESC`,
    [slot.contentKind, caze.project, slot.stage]
  ).map(rowContentSeed);
  if (!rows.length) return null;
  const weighted = rows.flatMap((item) => Array(Math.max(1, Math.round(Number(item.baseWeight || 1)))).fill(item));
  return weighted[Math.floor(Math.random() * weighted.length)];
}

function draftText(kind, variant, caze, slot, viral, seed) {
  if (seed) return seedVariantText(fillVars(seed.contentTemplate, caze), variant);
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

function formatForKind(kind, seed) {
  if (seed?.format) return seed.format;
  if (kind === '爆款提权') return '图文';
  return Math.random() > 0.55 ? '图文' : '口播';
}

function createCandidate(slot, caze, variant, viral = null, seed = null) {
  const id = uid('draft');
  const title = seed ? fillVars(seed.titleTemplate, caze) : titleFor(slot.contentKind, slot.stage, caze.persona, viral);
  const publishText = draftText(slot.contentKind, variant, caze, slot, viral, seed);
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
      formatForKind(slot.contentKind, seed),
      viral?.id || seed?.id || null,
      JSON.stringify([]),
      now()
    ]
  );
  if (seed) run('UPDATE content_seeds SET usage_count = usage_count + 1, updated_at = ? WHERE id = ?', [now(), seed.id]);
}

function createSlotForCase(caze, input = {}) {
  const contentKind = CONTENT_KINDS.includes(input.contentKind) ? input.contentKind : '日常养号';
  const stage = STAGES.includes(input.stage) ? input.stage : caze.stage;
  const slotId = uid('slot');
  run(
    `INSERT INTO plan_slots
    (id, case_id, date, time_window, content_kind, goal, stage, status, selected_candidate_id, delivery_dir, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    [
      slotId,
      caze.id,
      input.date || new Date().toISOString().slice(0, 10),
      input.timeWindow || '19:00-21:00',
      contentKind,
      input.goal || inferGoal(contentKind, stage),
      stage,
      input.status || '待生成',
      now(),
      now()
    ]
  );
  return slotById(slotId);
}

function createCaseFromBody(body = {}) {
  const id = uid('case');
  const created = now();
  const project = body.project || '吸脂';
  const stage = body.stage || '起号期';
  const persona = randomPersona(body.persona || {});
  const date = created.slice(0, 10).replaceAll('-', '');
  const seq = all('SELECT id FROM cases').length + 1;
  const caseCode = body.caseCode || `XZ-${date}-${String(seq).padStart(3, '0')}`;
  const dirName = `${caseCode}_${safeSegment(persona.city)}_${safeSegment(project)}_${safeSegment(body.weixinNick)}`;
  const caseDir = path.join(MATERIAL_ROOT, dirName);
  ensureCaseDirs(caseDir);
  run(
    `INSERT INTO cases
    (id, case_code, weixin_nick, douyin_id, douyin_url, project, stage, persona, staff, local_case_dir, health_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      caseCode,
      body.weixinNick || `${persona.city}${persona.occupation}`,
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
  const createdCase = caseById(id);
  writeCaseManifest(createdCase);
  return createdCase;
}

function writeCaseManifest(caze) {
  if (!caze?.localCaseDir) return;
  ensureCaseDirs(caze.localCaseDir);
  fs.writeFileSync(path.join(caze.localCaseDir, 'case.json'), JSON.stringify(caze, null, 2));
}

function imagePromptFor(caze, slot, purpose, sourceMaterials = []) {
  const p = caze.persona || {};
  return [
    `账号人设：${personaLine(p)}`,
    `内容类型：${slot?.contentKind || purpose}`,
    `当前阶段：${slot?.stage || caze.stage}`,
    '发布平台：抖音图文/封面',
    `图片用途：${purpose}`,
    `参考素材路径：${sourceMaterials.length ? sourceMaterials.join('；') : '暂无，按账号人设和内容阶段生成'}`,
    '风格要求：自然生活感，手机拍摄质感，画面干净，适合微信发给兼职后直接保存使用。',
    '输出要求：生成后保存到指定 outputDir，并回到系统标记 review / approved / rejected。'
  ].join('\n');
}

function personaMatchTokens(caze) {
  const p = caze.persona || {};
  return [caze.weixinNick, caze.project, caze.stage, p.city, p.age ? `${p.age}岁` : '', p.occupation, p.tone, p.motivation]
    .filter(Boolean)
    .map((item) => String(item).toLowerCase());
}

function viralSuitableForCase(viral, caze) {
  const tokens = personaMatchTokens(caze);
  const suitable = viral.suitablePersonas.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
  const forbidden = viral.forbiddenPersonas.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
  const hasForbidden = forbidden.some((rule) => tokens.some((token) => token.includes(rule)));
  if (hasForbidden) return false;
  if (suitable.length === 0) return true;
  return suitable.every((rule) => tokens.some((token) => token.includes(rule)));
}

function parseBulkCaseText(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const parts = line.split(/,|\t/).map((item) => item.trim());
      const [weixinNick, douyinId, douyinUrl, project, stage, city, age, occupation, tone, motivation] = parts;
      return {
        weixinNick,
        douyinId,
        douyinUrl,
        project: project || '吸脂',
        stage: STAGES.includes(stage) ? stage : '起号期',
        persona: {
          city: city || '',
          age: Number(age) || '',
          occupation: occupation || '',
          tone: tone || '',
          motivation: motivation || ''
        }
      };
    })
    .filter((item) => item.weixinNick);
}

function inferAssetKind(file) {
  const ext = path.extname(file).toLowerCase();
  if (IMAGE_EXT.has(ext)) return '图片';
  if (VIDEO_EXT.has(ext)) return '视频';
  if (TEXT_EXT.has(ext)) return '文案';
  return '截图';
}

function materialTemplate(project) {
  return MATERIAL_TEMPLATES[project] || MATERIAL_TEMPLATES.默认;
}

function materialGaps(project, assets) {
  return materialTemplate(project).map((item) => {
    const matched = assets.filter((asset) => {
      const haystack = `${asset.stage} ${asset.path}`.toLowerCase();
      return item.match.some((word) => haystack.includes(String(word).toLowerCase()));
    });
    return {
      ...item,
      count: matched.length,
      status: matched.length > 0 ? '已满足' : item.required ? '必补' : '可补',
      suggestion:
        matched.length > 0
          ? '已有素材'
          : item.required
            ? `请把${item.label}放入 00-原始素材 或 01-已筛选素材 后重新扫描`
            : `可补充${item.label}，或创建 Image/剪辑任务作为辅助`
    };
  });
}

function caseHealth(caze, caseSlots, caseAssets, metrics, today) {
  const reasons = [];
  const actions = [];
  const pendingVerify = caseSlots.filter((s) => s.status === '已汇报').length;
  const futureSlots = caseSlots.filter((s) => s.date >= today).length;
  const recentGrass = caseSlots.filter((s) => s.contentKind === '素人种草' && s.date >= addDays(today, -7)).length;
  const recentViral = caseSlots.filter((s) => s.contentKind === '爆款提权' && s.date >= addDays(today, -7)).length;
  const gaps = materialGaps(caze.project, caseAssets);
  const requiredMissing = gaps.filter((gap) => gap.required && gap.count === 0).length;
  const latest = metrics[0];
  const prev = metrics[1];

  if (pendingVerify >= 2) {
    reasons.push('待核对堆积');
    actions.push('先处理核对队列，回填播放/点赞/评论后再判断下一轮内容');
  }
  if (futureSlots === 0) {
    reasons.push('缺少排期');
    actions.push('补未来 7-30 天排期，起号期优先日常养号和爆款提权');
  }
  if (caseAssets.length === 0) {
    reasons.push('素材未扫描');
    actions.push('打开素材目录，把原始素材放入 00-原始素材 后扫描素材');
  }
  if (requiredMissing > 0) {
    reasons.push(`必补素材 ${requiredMissing} 项`);
    actions.push('优先处理必补素材缺口，缺口旁可创建 Image/剪辑任务');
  }
  if (recentGrass >= 4 && recentViral === 0) {
    reasons.push('种草偏密，需要爆款提权');
    actions.push('下一条改发爆款提权，降低连续种草密度');
  }
  if (latest?.plays != null && prev?.plays != null && latest.plays < prev.plays * 0.6) {
    reasons.push('播放下滑');
    actions.push('增加爆款提权或互动版内容，暂缓高密度种草');
  }
  if (caze.healthStatus !== '健康') {
    reasons.push(caze.healthStatus);
    actions.push('按人工标记状态优先处理，必要时手动新增临时槽位');
  }

  const status = reasons.length === 0 ? '健康' : reasons.includes('播放下滑') ? '偏冷' : reasons[0];
  return { status, reasons, actions: Array.from(new Set(actions)), gaps };
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

function backupList() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => {
      const full = path.join(BACKUP_DIR, entry.name);
      const stat = fs.statSync(full);
      return {
        name: entry.name,
        path: full,
        size: stat.size,
        createdAt: stat.birthtime.toISOString(),
        updatedAt: stat.mtime.toISOString()
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function exportData() {
  return {
    exportedAt: now(),
    cases: all('SELECT * FROM cases').map(rowCase),
    planSlots: all('SELECT * FROM plan_slots').map(rowSlot),
    candidateDrafts: all('SELECT * FROM candidate_drafts').map(rowCandidate),
    viralTemplates: all('SELECT * FROM viral_templates').map(rowViral),
    contentSeeds: all('SELECT * FROM content_seeds').map(rowContentSeed),
    assets: all('SELECT * FROM assets').map(rowAsset),
    imageTasks: all('SELECT * FROM image_tasks').map(rowImageTask),
    clipTasks: all('SELECT * FROM clip_tasks').map(rowClipTask),
    verifyTasks: all('SELECT * FROM verify_tasks').map(rowVerify),
    metrics: all('SELECT * FROM metrics').map(rowMetric)
  };
}

function writeLocalBackup(reason = 'manual') {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(BACKUP_DIR, `${stamp}_${safeSegment(reason)}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...exportData(), reason }, null, 2));
  return backupList().find((item) => item.path === file);
}

function groupCount(items, keyFn) {
  return items.reduce((acc, item) => {
    const key = keyFn(item) || '未分类';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function reviewSummary() {
  const cases = all('SELECT * FROM cases ORDER BY created_at DESC').map(rowCase);
  const slots = all('SELECT * FROM plan_slots ORDER BY date ASC, created_at ASC').map(rowSlot);
  const candidates = all('SELECT * FROM candidate_drafts ORDER BY created_at DESC').map(rowCandidate);
  const assets = all('SELECT * FROM assets ORDER BY created_at DESC').map(rowAsset);
  const imageTasks = all('SELECT * FROM image_tasks ORDER BY created_at DESC').map(rowImageTask);
  const clipTasks = all('SELECT * FROM clip_tasks ORDER BY created_at DESC').map(rowClipTask);
  const verifyTasks = all('SELECT * FROM verify_tasks ORDER BY created_at DESC').map(rowVerify);
  const metrics = all('SELECT * FROM metrics ORDER BY date DESC, created_at DESC').map(rowMetric);
  const today = new Date().toISOString().slice(0, 10);
  const byCase = Object.fromEntries(cases.map((item) => [item.id, item]));
  const metricsByCase = cases.reduce((acc, caze) => {
    acc[caze.id] = metrics.filter((item) => item.caseId === caze.id);
    return acc;
  }, {});
  const caseRows = cases.map((caze) => {
    const caseSlots = slots.filter((item) => item.caseId === caze.id);
    const caseAssets = assets.filter((item) => item.caseId === caze.id);
    const caseMetrics = metricsByCase[caze.id] || [];
    const health = caseHealth(caze, caseSlots, caseAssets, caseMetrics, today);
    const latest = caseMetrics[0] || null;
    const prev = caseMetrics[1] || null;
    return {
      ...caze,
      healthStatus: health.status,
      reasons: health.reasons,
      slots: caseSlots.length,
      readySlots: caseSlots.filter((item) => ['可交付', '已派发', '已汇报', '已核对'].includes(item.status)).length,
      pendingVerify: caseSlots.filter((item) => item.status === '已汇报').length,
      materialGaps: health.gaps.length,
      actions: health.actions,
      latestMetric: latest,
      delta: latest && prev ? {
        fans: (latest.fans || 0) - (prev.fans || 0),
        plays: (latest.plays || 0) - (prev.plays || 0),
        likes: (latest.likes || 0) - (prev.likes || 0),
        comments: (latest.comments || 0) - (prev.comments || 0)
      } : null
    };
  });
  const topAccounts = caseRows
    .filter((item) => item.latestMetric)
    .sort((a, b) => (b.latestMetric.plays || 0) - (a.latestMetric.plays || 0))
    .slice(0, 12);
  const needsAttention = caseRows
    .filter((item) => item.reasons.length > 0 || item.pendingVerify > 0 || item.materialGaps > 0)
    .sort((a, b) => (b.pendingVerify + b.materialGaps + b.reasons.length) - (a.pendingVerify + a.materialGaps + a.reasons.length))
    .slice(0, 20);

  return {
    today,
    totals: {
      cases: cases.length,
      slots: slots.length,
      candidates: candidates.length,
      assets: assets.length,
      usableAssets: assets.filter((item) => item.reviewStatus === '可用').length,
      deliveryReady: slots.filter((item) => item.status === '可交付').length,
      sent: slots.filter((item) => ['已派发', '已汇报', '已核对'].includes(item.status)).length,
      verified: verifyTasks.filter((item) => item.status === 'verified').length,
      metrics: metrics.length,
      imageWaitingKey: imageTasks.filter((item) => item.status === 'waiting_key').length,
      clipPending: clipTasks.filter((item) => ['draft', 'review'].includes(item.status)).length
    },
    statusStats: groupCount(slots, (item) => item.status),
    contentKindStats: CONTENT_KINDS.map((kind) => ({
      kind,
      total: slots.filter((item) => item.contentKind === kind).length,
      pending: slots.filter((item) => item.contentKind === kind && ['待生成', '候选待选'].includes(item.status)).length,
      ready: slots.filter((item) => item.contentKind === kind && ['可交付', '已派发', '已汇报', '已核对'].includes(item.status)).length
    })),
    stageStats: STAGES.map((stage) => ({
      stage,
      cases: cases.filter((item) => item.stage === stage).length,
      slots: slots.filter((item) => item.stage === stage).length
    })),
    healthStats: groupCount(caseRows, (item) => item.healthStatus),
    topAccounts,
    needsAttention,
    recentMetrics: metrics.slice(0, 20).map((item) => ({
      ...item,
      case: byCase[item.caseId] || null
    }))
  };
}

function scheduleSummary() {
  const cases = all('SELECT * FROM cases ORDER BY created_at DESC').map(rowCase);
  const slots = all('SELECT * FROM plan_slots ORDER BY date ASC, time_window ASC, created_at ASC').map(rowSlot);
  const candidates = all('SELECT * FROM candidate_drafts ORDER BY created_at ASC').map(rowCandidate);
  const byCase = Object.fromEntries(cases.map((item) => [item.id, item]));
  const withMeta = slots.map((slot) => {
    const slotCandidates = candidates.filter((item) => item.slotId === slot.id);
    return {
      ...slot,
      case: byCase[slot.caseId] || null,
      candidateCount: slotCandidates.length,
      selectedCandidate: slotCandidates.find((item) => item.selected) || null
    };
  });
  const byDate = withMeta.reduce((acc, slot) => {
    if (!acc[slot.date]) acc[slot.date] = [];
    acc[slot.date].push(slot);
    return acc;
  }, {});
  return {
    today: new Date().toISOString().slice(0, 10),
    slots: withMeta,
    days: Object.entries(byDate).map(([date, items]) => ({ date, items })),
    counts: {
      total: withMeta.length,
      pendingGenerate: withMeta.filter((item) => item.status === '待生成').length,
      pendingChoose: withMeta.filter((item) => item.status === '候选待选').length,
      locked: withMeta.filter((item) => item.status === '已锁定').length,
      readyDelivery: withMeta.filter((item) => item.status === '可交付').length,
      pendingVerify: withMeta.filter((item) => item.status === '已汇报').length
    }
  };
}

function dashboard() {
  const cases = all('SELECT * FROM cases ORDER BY created_at DESC').map(rowCase);
  const slots = all('SELECT * FROM plan_slots ORDER BY date ASC, created_at ASC').map(rowSlot);
  const candidates = all('SELECT * FROM candidate_drafts ORDER BY created_at ASC').map(rowCandidate);
  const assets = all('SELECT * FROM assets ORDER BY created_at DESC').map(rowAsset);
  const metrics = all('SELECT * FROM metrics ORDER BY date DESC, created_at DESC').map(rowMetric);
  const today = new Date().toISOString().slice(0, 10);
  const byCase = Object.fromEntries(cases.map((item) => [item.id, item]));
  const withCase = (slot) => {
    const slotCandidates = candidates.filter((item) => item.slotId === slot.id);
    return {
      ...slot,
      case: byCase[slot.caseId],
      candidateCount: slotCandidates.length,
      selectedCandidate: slotCandidates.find((item) => item.selected) || null
    };
  };
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
        const caseMetrics = metrics.filter((m) => m.caseId === caze.id);
        const health = caseHealth(caze, caseSlots, caseAssets, caseMetrics, today);
        return { ...caze, healthStatus: health.status, reasons: health.reasons, actions: health.actions };
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

app.get('/api/review', (_req, res) => {
  res.json(reviewSummary());
});

app.get('/api/schedule', (_req, res) => {
  res.json(scheduleSummary());
});

app.get('/api/cases', (_req, res) => {
  res.json(all('SELECT * FROM cases ORDER BY created_at DESC').map(rowCase));
});

app.post('/api/cases', (req, res) => {
  res.json(createCaseFromBody(req.body || {}));
});

app.post('/api/cases/bulk', (req, res) => {
  const body = req.body || {};
  const rows = Array.isArray(body.cases) ? body.cases : parseBulkCaseText(body.text);
  if (!rows.length) return res.status(400).json({ error: 'no valid case rows' });
  const created = rows.map((row) => createCaseFromBody(row));
  if (body.generateSlots) {
    created.forEach((caze) => {
      for (let i = 0; i < Number(body.days || 7); i += 1) {
        const stage = stageForDay(caze.stage, i);
        const contentKind = pickWeighted(STAGE_RATIOS[stage] || STAGE_RATIOS.起号期);
        createSlotForCase(caze, {
          date: addDays(new Date().toISOString().slice(0, 10), i),
          timeWindow: timeWindowFor(i),
          contentKind,
          stage
        });
      }
    });
  }
  res.json({ createdCount: created.length, cases: created });
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
  const updated = caseById(req.params.id);
  writeCaseManifest(updated);
  res.json(updated);
});

app.delete('/api/cases/:id', (req, res) => {
  const caze = caseById(req.params.id);
  if (!caze) return res.status(404).json({ error: 'case not found' });
  run('DELETE FROM cases WHERE id = ?', [caze.id]);
  res.json({ deleted: true, id: caze.id });
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
  const clipTasks = all('SELECT * FROM clip_tasks WHERE case_id = ? ORDER BY created_at DESC', [caze.id]).map(rowClipTask);
  const verifyTasks = all('SELECT * FROM verify_tasks WHERE case_id = ? ORDER BY created_at DESC', [caze.id]).map(rowVerify);
  const metrics = all('SELECT * FROM metrics WHERE case_id = ? ORDER BY date DESC, created_at DESC', [caze.id]).map(rowMetric);
  const health = caseHealth(caze, slots, assets, metrics, new Date().toISOString().slice(0, 10));
  res.json({
    case: { ...caze, healthStatus: health.status },
    slots,
    candidates,
    assets,
    imageTasks,
    clipTasks,
    verifyTasks,
    metrics,
    materialGaps: health.gaps,
    healthReasons: health.reasons,
    healthActions: health.actions
  });
});

app.get('/api/config', (_req, res) => {
  res.json({
    stages: STAGES,
    contentKinds: CONTENT_KINDS,
    stageRatios: STAGE_RATIOS,
    materialTemplates: MATERIAL_TEMPLATES,
    imageKeyReady: Boolean(process.env.IMAGE_API_KEY),
    llmKeyReady: Boolean(process.env.LLM_API_KEY),
    materialRoot: MATERIAL_ROOT,
    backupDir: BACKUP_DIR,
    backups: backupList().slice(0, 10)
  });
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

app.post('/api/cases/:id/slots', (req, res) => {
  const caze = caseById(req.params.id);
  if (!caze) return res.status(404).json({ error: 'case not found' });
  const body = req.body || {};
  res.json(createSlotForCase(caze, body));
});

app.post('/api/slots/:id/generate-candidates', (req, res) => {
  const slot = slotById(req.params.id);
  if (!slot) return res.status(404).json({ error: 'slot not found' });
  if (slot.selectedCandidateId || ['已锁定', '可交付', '已派发', '已汇报', '已核对'].includes(slot.status)) {
    return res.status(409).json({ error: '该槽位已锁定，不能重新生成候选' });
  }
  const caze = caseById(slot.caseId);
  const viral = rowViral(get('SELECT * FROM viral_templates ORDER BY created_at DESC LIMIT 1'));
  const seed = slot.contentKind === '爆款提权' ? null : pickContentSeed(slot, caze);
  run('DELETE FROM candidate_drafts WHERE slot_id = ? AND selected = 0', [slot.id]);
  ['稳妥版', '互动版', '爆款结构版'].forEach((variant) => createCandidate(slot, caze, variant, slot.contentKind === '爆款提权' ? viral : null, seed));
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
    const expectedAssets = slot.deliveryDir && fs.existsSync(path.join(slot.deliveryDir, '05-素材顺序清单.txt'))
      ? fs.readFileSync(path.join(slot.deliveryDir, '05-素材顺序清单.txt'), 'utf8').split('\n').filter((line) => /^\d+\./.test(line.trim()))
      : [];
    const exists = get('SELECT id FROM verify_tasks WHERE plan_item_id = ?', [slot.id]);
    if (!exists) {
      run(
        `INSERT INTO verify_tasks
        (id, case_id, plan_item_id, douyin_url, expected_title, expected_publish_date, expected_assets, status, result_note, metrics_snapshot, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', '', NULL, ?, ?)`,
        [uid('verify'), caze.id, slot.id, caze.douyinUrl, selected?.title || '', slot.date, JSON.stringify(expectedAssets), now(), now()]
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
  const assets = all('SELECT * FROM assets WHERE case_id = ? AND review_status IN (?, ?) ORDER BY created_at DESC LIMIT 9', [caze.id, '可用', '待处理']).map(rowAsset);
  const copied = [];
  assets.forEach((asset, index) => {
    if (!fs.existsSync(asset.path)) return;
    const ext = path.extname(asset.path);
    const label = asset.kind === '视频' ? '视频' : '图片';
    const fileName = `${String(index + 3).padStart(2, '0')}-${label}${index + 1}${ext}`;
    fs.copyFileSync(asset.path, path.join(deliveryDir, fileName));
    copied.push({ order: index + 1, fileName, kind: asset.kind, stage: asset.stage, source: asset.source, originalPath: asset.path });
  });
  const assetLines = copied.length
    ? copied.map((item) => `${item.order}. ${item.fileName}｜${item.kind}｜${item.stage}｜${item.source}\n   原路径：${item.originalPath}`).join('\n')
    : '本次未复制素材，请先在案例详情扫描并标记可用素材，或创建 Image/剪辑任务补齐。';
  fs.writeFileSync(path.join(deliveryDir, '05-素材顺序清单.txt'), assetLines);
  fs.writeFileSync(path.join(deliveryDir, '06-发布要求.txt'), [
    `类型：${slot.contentKind}`,
    `形式：${candidate.format}`,
    `日期：${slot.date}`,
    `时间窗：${slot.timeWindow || ''}`,
    `标题：${candidate.title}`,
    '',
    '发送给兼职顺序：',
    '1. 先发 01-发给兼职文案.txt',
    '2. 再发 02-抖音发布文案.txt',
    '3. 按 05-素材顺序清单.txt 的顺序发送图片或视频',
    '4. 发完后让兼职回传作品链接或截图',
    '',
    '素材顺序：',
    assetLines
  ].join('\n'));
  run('UPDATE plan_slots SET status = ?, delivery_dir = ?, updated_at = ? WHERE id = ?', ['可交付', deliveryDir, now(), slot.id]);
  res.json({ deliveryDir, copiedAssets: copied, slot: slotById(slot.id) });
});

app.post('/api/image-tasks', (req, res) => {
  const body = req.body || {};
  const caze = caseById(body.caseId);
  if (!caze) return res.status(404).json({ error: 'case not found' });
  const slot = body.planSlotId ? slotById(body.planSlotId) : null;
  const purpose = body.purpose || slot?.contentKind || '日常养号';
  const outputDir = path.join(caze.localCaseDir, '02-生成补充', safeSegment(purpose));
  fs.mkdirSync(outputDir, { recursive: true });
  const sourceMaterials = body.sourceMaterials || [];
  const prompt = body.prompt || imagePromptFor(caze, slot, purpose, sourceMaterials);
  const negativePrompt = body.negativePrompt || '过度精修，夸张效果，水印，低清晰度，错误文字，变形肢体，不符合账号人设的场景';
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
      negativePrompt,
      JSON.stringify(sourceMaterials),
      outputDir,
      status,
      now(),
      now()
    ]
  );
  fs.writeFileSync(path.join(outputDir, `${id}-图片任务说明.txt`), [
    `任务ID：${id}`,
    `状态：${status}`,
    `用途：${purpose}`,
    `保存目录：${outputDir}`,
    '',
    'Prompt:',
    prompt,
    '',
    'Negative prompt:',
    negativePrompt
  ].join('\n'));
  res.json(rowImageTask(get('SELECT * FROM image_tasks WHERE id = ?', [id])));
});

app.patch('/api/image-tasks/:id', (req, res) => {
  const task = rowImageTask(get('SELECT * FROM image_tasks WHERE id = ?', [req.params.id]));
  if (!task) return res.status(404).json({ error: 'image task not found' });
  const body = req.body || {};
  run(
    `UPDATE image_tasks SET purpose = ?, prompt = ?, negative_prompt = ?, status = ?, updated_at = ? WHERE id = ?`,
    [
      body.purpose ?? task.purpose,
      body.prompt ?? task.prompt,
      body.negativePrompt ?? task.negativePrompt,
      body.status ?? task.status,
      now(),
      task.id
    ]
  );
  res.json(rowImageTask(get('SELECT * FROM image_tasks WHERE id = ?', [task.id])));
});

app.post('/api/clip-tasks', (req, res) => {
  const body = req.body || {};
  const caze = caseById(body.caseId);
  if (!caze) return res.status(404).json({ error: 'case not found' });
  const slot = body.planSlotId ? slotById(body.planSlotId) : null;
  const selected = slot?.selectedCandidateId ? rowCandidate(get('SELECT * FROM candidate_drafts WHERE id = ?', [slot.selectedCandidateId])) : null;
  const title = body.title || selected?.title || `${caze.weixinNick}剪辑任务`;
  const outputDir = path.join(caze.localCaseDir, '02-生成补充', '剪辑任务', safeSegment(title));
  fs.mkdirSync(outputDir, { recursive: true });
  const assets = all('SELECT * FROM assets WHERE case_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 8', [caze.id, '视频']).map(rowAsset);
  const brief = body.brief || [
    `剪辑任务：${title}`,
    `案例：${caze.caseCode} / ${caze.weixinNick}`,
    `账号：${caze.douyinId || '未填'}`,
    `阶段：${slot?.stage || caze.stage}`,
    `内容类型：${slot?.contentKind || '视频'}`,
    `建议比例：9:16`,
    `建议时长：20-35秒`,
    '',
    '发布文案/口播参考：',
    selected ? `${selected.title}\n${selected.publishText}` : '暂无锁定候选，可先按素材做生活化短视频。',
    '',
    '可用视频素材：',
    assets.length ? assets.map((asset, index) => `${index + 1}. ${asset.path}`).join('\n') : '暂无已扫描视频素材，请先放入 00-原始素材 后扫描。',
    '',
    '交付要求：输出 final.mp4 放回本目录；如需要封面图，放 cover.jpg。'
  ].join('\n');
  fs.writeFileSync(path.join(outputDir, '剪辑任务单.txt'), brief);
  const id = uid('clip');
  run(
    `INSERT INTO clip_tasks
    (id, case_id, plan_slot_id, title, brief, output_dir, status, final_video_path, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      caze.id,
      body.planSlotId || null,
      title,
      brief,
      outputDir,
      body.status || 'waiting_edit',
      body.finalVideoPath || '',
      now(),
      now()
    ]
  );
  res.json(rowClipTask(get('SELECT * FROM clip_tasks WHERE id = ?', [id])));
});

app.patch('/api/clip-tasks/:id', (req, res) => {
  const task = rowClipTask(get('SELECT * FROM clip_tasks WHERE id = ?', [req.params.id]));
  if (!task) return res.status(404).json({ error: 'clip task not found' });
  const body = req.body || {};
  const finalPath = body.finalVideoPath ?? task.finalVideoPath;
  run(
    `UPDATE clip_tasks SET title = ?, brief = ?, status = ?, final_video_path = ?, updated_at = ? WHERE id = ?`,
    [
      body.title ?? task.title,
      body.brief ?? task.brief,
      body.status ?? task.status,
      finalPath,
      now(),
      task.id
    ]
  );
  res.json(rowClipTask(get('SELECT * FROM clip_tasks WHERE id = ?', [task.id])));
});

app.get('/api/viral-templates', (_req, res) => {
  res.json(all('SELECT * FROM viral_templates ORDER BY created_at DESC').map(rowViral));
});

app.get('/api/content-seeds', (_req, res) => {
  res.json(all('SELECT * FROM content_seeds ORDER BY created_at DESC').map(rowContentSeed));
});

app.post('/api/content-seeds', (req, res) => {
  const body = req.body || {};
  const id = uid('seed');
  run(
    `INSERT INTO content_seeds
    (id, project, stage, content_kind, format, title_template, content_template, tags, base_weight, usage_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [
      id,
      body.project || '通用',
      body.stage || '通用',
      body.contentKind || '日常养号',
      body.format || '图文',
      body.titleTemplate || '未命名内容种子',
      body.contentTemplate || '',
      JSON.stringify(body.tags || []),
      Number(body.baseWeight || 1),
      now(),
      now()
    ]
  );
  res.json(rowContentSeed(get('SELECT * FROM content_seeds WHERE id = ?', [id])));
});

app.patch('/api/content-seeds/:id', (req, res) => {
  const seed = rowContentSeed(get('SELECT * FROM content_seeds WHERE id = ?', [req.params.id]));
  if (!seed) return res.status(404).json({ error: 'content seed not found' });
  const body = req.body || {};
  run(
    `UPDATE content_seeds
    SET project = ?, stage = ?, content_kind = ?, format = ?, title_template = ?, content_template = ?, tags = ?, base_weight = ?, updated_at = ?
    WHERE id = ?`,
    [
      body.project ?? seed.project,
      body.stage ?? seed.stage,
      body.contentKind ?? seed.contentKind,
      body.format ?? seed.format,
      body.titleTemplate ?? seed.titleTemplate,
      body.contentTemplate ?? seed.contentTemplate,
      JSON.stringify(body.tags ?? seed.tags),
      Number(body.baseWeight ?? seed.baseWeight),
      now(),
      seed.id
    ]
  );
  res.json(rowContentSeed(get('SELECT * FROM content_seeds WHERE id = ?', [seed.id])));
});

app.delete('/api/content-seeds/:id', (req, res) => {
  run('DELETE FROM content_seeds WHERE id = ?', [req.params.id]);
  res.json({ deleted: true });
});

app.post('/api/viral-templates', (req, res) => {
  const body = req.body || {};
  const id = uid('viral');
  const linkOnly = Boolean(body.sourceLink) && !String(body.rawText || '').trim();
  run(
    `INSERT INTO viral_templates
    (id, title, raw_text, source_link, category, hot_structure, suitable_personas, forbidden_personas, rewrite_policy, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      body.title || (linkOnly ? `待分析爆款链接 ${new Date().toISOString().slice(0, 10)}` : '未命名爆款模板'),
      body.rawText || (linkOnly ? '待用青豆提取原视频文案' : ''),
      body.sourceLink || '',
      body.category || (linkOnly ? '待分析' : '情绪'),
      body.hotStructure || (linkOnly ? '待青豆提取后补充：标题、正文、爆点结构、适合人设和下一步建议' : '开头提出共鸣问题，中段列出3个细节，结尾引导评论'),
      JSON.stringify(body.suitablePersonas || []),
      JSON.stringify(body.forbiddenPersonas || []),
      body.rewritePolicy || (linkOnly ? '仅参考' : '结构模仿'),
      now(),
      now()
    ]
  );
  res.json(rowViral(get('SELECT * FROM viral_templates WHERE id = ?', [id])));
});

app.post('/api/viral-templates/:id/bulk-generate', (req, res) => {
  const viral = rowViral(get('SELECT * FROM viral_templates WHERE id = ?', [req.params.id]));
  if (!viral) return res.status(404).json({ error: 'viral template not found' });
  if (viral.rawText.startsWith('待用青豆') || viral.hotStructure.startsWith('待青豆')) {
    return res.status(409).json({ error: '这个爆款链接还没完成青豆提取和结构分析，先不要批量生成' });
  }
  const body = req.body || {};
  const cases = all('SELECT * FROM cases ORDER BY created_at ASC').map(rowCase);
  const created = [];
  cases.forEach((caze) => {
    if (!viralSuitableForCase(viral, caze)) return;
    const slot = createSlotForCase(caze, {
      date: body.date || new Date().toISOString().slice(0, 10),
      timeWindow: body.timeWindow || '19:00-21:00',
      contentKind: '爆款提权',
      stage: caze.stage,
      status: '候选待选',
      goal: `爆款提权：按「${viral.title}」做人设化改写`
    });
    ['稳妥版', '互动版', '爆款结构版'].forEach((variant) => createCandidate(slot, caze, variant, viral, null));
    created.push(slotById(slot.id));
  });
  res.json({ createdCount: created.length, skippedCount: cases.length - created.length, slots: created });
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
    const snapshot = body.metricsSnapshot || {};
    const hasMetric = ['fans', 'plays', 'likes', 'comments'].some((key) => snapshot[key] !== undefined && snapshot[key] !== '');
    if (hasMetric) {
      run(
        `INSERT INTO metrics (id, case_id, date, fans, plays, likes, comments, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uid('metric'),
          task.caseId,
          new Date().toISOString().slice(0, 10),
          snapshot.fans === '' ? null : Number(snapshot.fans),
          snapshot.plays === '' ? null : Number(snapshot.plays),
          snapshot.likes === '' ? null : Number(snapshot.likes),
          snapshot.comments === '' ? null : Number(snapshot.comments),
          body.resultNote || '核对回填',
          now()
        ]
      );
    }
  }
  res.json(rowVerify(get('SELECT * FROM verify_tasks WHERE id = ?', [task.id])));
});

app.get('/api/export', (_req, res) => {
  res.json(exportData());
});

app.get('/api/backups', (_req, res) => {
  res.json({ backupDir: BACKUP_DIR, backups: backupList() });
});

app.post('/api/backups', (req, res) => {
  res.json({ backup: writeLocalBackup(req.body?.reason || 'manual') });
});

app.post('/api/import', (req, res) => {
  const data = req.body || {};
  if (!Array.isArray(data.cases)) return res.status(400).json({ error: 'invalid backup: cases missing' });
  const importedAt = now();
  const preImportBackup = writeLocalBackup('before-import');
  run('DELETE FROM metrics');
  run('DELETE FROM verify_tasks');
  run('DELETE FROM clip_tasks');
  run('DELETE FROM image_tasks');
  run('DELETE FROM assets');
  run('DELETE FROM candidate_drafts');
  run('DELETE FROM plan_slots');
  run('DELETE FROM content_seeds');
  run('DELETE FROM viral_templates');
  run('DELETE FROM cases');

  (data.cases || []).forEach((item) => {
    const caseDir = item.localCaseDir || path.join(MATERIAL_ROOT, `${item.caseCode || item.id}_${safeSegment(item.weixinNick)}`);
    ensureCaseDirs(caseDir);
    run(
      `INSERT INTO cases
      (id, case_code, weixin_nick, douyin_id, douyin_url, project, stage, persona, staff, local_case_dir, health_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        item.id,
        item.caseCode || item.case_code || uid('code'),
        item.weixinNick || item.weixin_nick || '未命名兼职',
        item.douyinId || item.douyin_id || '',
        item.douyinUrl || item.douyin_url || '',
        item.project || '吸脂',
        item.stage || '起号期',
        JSON.stringify(item.persona || {}),
        item.staff || '',
        caseDir,
        item.healthStatus || item.health_status || '健康',
        item.createdAt || importedAt,
        item.updatedAt || importedAt
      ]
    );
    writeCaseManifest(caseById(item.id));
  });

  (data.viralTemplates || []).forEach((item) => {
    run(
      `INSERT INTO viral_templates
      (id, title, raw_text, source_link, category, hot_structure, suitable_personas, forbidden_personas, rewrite_policy, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        item.id,
        item.title || '未命名爆款模板',
        item.rawText || item.raw_text || '',
        item.sourceLink || item.source_link || '',
        item.category || '情绪',
        item.hotStructure || item.hot_structure || '',
        JSON.stringify(item.suitablePersonas || []),
        JSON.stringify(item.forbiddenPersonas || []),
        item.rewritePolicy || item.rewrite_policy || '结构模仿',
        item.createdAt || importedAt,
        item.updatedAt || importedAt
      ]
    );
  });

  (data.contentSeeds || []).forEach((item) => {
    run(
      `INSERT INTO content_seeds
      (id, project, stage, content_kind, format, title_template, content_template, tags, base_weight, usage_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        item.id,
        item.project || '通用',
        item.stage || '通用',
        item.contentKind || item.content_kind || '日常养号',
        item.format || '图文',
        item.titleTemplate || item.title_template || '',
        item.contentTemplate || item.content_template || '',
        JSON.stringify(item.tags || []),
        Number(item.baseWeight || item.base_weight || 1),
        Number(item.usageCount || item.usage_count || 0),
        item.createdAt || importedAt,
        item.updatedAt || importedAt
      ]
    );
  });
  seedDefaultContentSeeds();

  (data.planSlots || []).forEach((item) => {
    run(
      `INSERT INTO plan_slots
      (id, case_id, date, time_window, content_kind, goal, stage, status, selected_candidate_id, delivery_dir, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        item.id,
        item.caseId || item.case_id,
        item.date,
        item.timeWindow || item.time_window || '',
        item.contentKind || item.content_kind,
        item.goal || '',
        item.stage || '起号期',
        item.status || '待生成',
        item.selectedCandidateId || item.selected_candidate_id || null,
        item.deliveryDir || item.delivery_dir || null,
        item.createdAt || importedAt,
        item.updatedAt || importedAt
      ]
    );
  });

  (data.candidateDrafts || []).forEach((item) => {
    run(
      `INSERT INTO candidate_drafts
      (id, slot_id, variant, title, publish_text, operator_instruction, format, source_template_id, compliance_hits, selected, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        item.id,
        item.slotId || item.slot_id,
        item.variant || '稳妥版',
        item.title || '',
        item.publishText || item.publish_text || '',
        item.operatorInstruction || item.operator_instruction || '',
        item.format || '图文',
        item.sourceTemplateId || item.source_template_id || null,
        JSON.stringify(item.complianceHits || []),
        item.selected ? 1 : 0,
        item.createdAt || importedAt
      ]
    );
  });

  (data.assets || []).forEach((item) => {
    run(
      `INSERT OR IGNORE INTO assets
      (id, case_id, path, kind, stage, source, usage, review_status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        item.id,
        item.caseId || item.case_id,
        item.path,
        item.kind || '图片',
        item.stage || '未分组',
        item.source || '真实',
        item.usage || '备用',
        item.reviewStatus || item.review_status || '待处理',
        item.createdAt || importedAt
      ]
    );
  });

  (data.imageTasks || []).forEach((item) => {
    run(
      `INSERT INTO image_tasks
      (id, case_id, plan_slot_id, purpose, prompt, negative_prompt, source_materials, output_dir, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        item.id,
        item.caseId || item.case_id,
        item.planSlotId || item.plan_slot_id || null,
        item.purpose || '日常养号',
        item.prompt || '',
        item.negativePrompt || item.negative_prompt || '',
        JSON.stringify(item.sourceMaterials || []),
        item.outputDir || item.output_dir || '',
        item.status || 'draft',
        item.createdAt || importedAt,
        item.updatedAt || importedAt
      ]
    );
  });

  (data.clipTasks || []).forEach((item) => {
    run(
      `INSERT INTO clip_tasks
      (id, case_id, plan_slot_id, title, brief, output_dir, status, final_video_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        item.id,
        item.caseId || item.case_id,
        item.planSlotId || item.plan_slot_id || null,
        item.title || '剪辑任务',
        item.brief || '',
        item.outputDir || item.output_dir || '',
        item.status || 'waiting_edit',
        item.finalVideoPath || item.final_video_path || '',
        item.createdAt || importedAt,
        item.updatedAt || importedAt
      ]
    );
  });

  (data.verifyTasks || []).forEach((item) => {
    run(
      `INSERT INTO verify_tasks
      (id, case_id, plan_item_id, douyin_url, expected_title, expected_publish_date, expected_assets, status, result_note, metrics_snapshot, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        item.id,
        item.caseId || item.case_id,
        item.planItemId || item.plan_item_id,
        item.douyinUrl || item.douyin_url || '',
        item.expectedTitle || item.expected_title || '',
        item.expectedPublishDate || item.expected_publish_date || '',
        JSON.stringify(item.expectedAssets || []),
        item.status || 'pending',
        item.resultNote || item.result_note || '',
        item.metricsSnapshot ? JSON.stringify(item.metricsSnapshot) : null,
        item.createdAt || importedAt,
        item.updatedAt || importedAt
      ]
    );
  });

  (data.metrics || []).forEach((item) => {
    run(
      `INSERT INTO metrics (id, case_id, date, fans, plays, likes, comments, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        item.id,
        item.caseId || item.case_id,
        item.date || importedAt.slice(0, 10),
        item.fans ?? null,
        item.plays ?? null,
        item.likes ?? null,
        item.comments ?? null,
        item.note || '',
        item.createdAt || importedAt
      ]
    );
  });

  res.json({ imported: true, cases: data.cases.length, preImportBackup });
});

app.patch('/api/assets/:id', (req, res) => {
  const asset = rowAsset(get('SELECT * FROM assets WHERE id = ?', [req.params.id]));
  if (!asset) return res.status(404).json({ error: 'asset not found' });
  const body = req.body || {};
  run(
    'UPDATE assets SET stage = ?, source = ?, usage = ?, review_status = ? WHERE id = ?',
    [
      body.stage ?? asset.stage,
      body.source ?? asset.source,
      body.usage ?? asset.usage,
      body.reviewStatus ?? asset.reviewStatus,
      asset.id
    ]
  );
  res.json(rowAsset(get('SELECT * FROM assets WHERE id = ?', [asset.id])));
});

app.post('/api/open-path', (req, res) => {
  try {
    const target = assertInsideRoot(req.body?.path || ROOT_DIR);
    if (!fs.existsSync(target)) return res.status(404).json({ error: 'path not found' });
    execFile('open', [target], (error) => {
      if (error) return res.status(500).json({ error: error.message });
      res.json({ opened: target });
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.use('/files', express.static(ROOT_DIR));

seedDefaultContentSeeds();

if (fs.existsSync(path.join(process.cwd(), 'dist'))) {
  app.use(express.static(path.join(process.cwd(), 'dist')));
  app.get('*splat', (_req, res) => res.sendFile(path.join(process.cwd(), 'dist', 'index.html')));
}

app.listen(PORT, '127.0.0.1', () => {
  console.log(`API running at http://127.0.0.1:${PORT}`);
  console.log(`Material root: ${MATERIAL_ROOT}`);
});
