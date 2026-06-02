import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  CASE_LIBRARY_ROOT,
  DATA_DIR,
  MATERIAL_ROOT,
  ROOT_DIR,
  SHARED_MATERIAL_ROOT,
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
const LISTEN_HOST = process.env.SOUREN_HOST || '127.0.0.1';
const ACCESS_CODE = String(process.env.SOUREN_ACCESS_CODE || '').trim();
const AUTH_LOCAL_BYPASS = process.env.SOUREN_AUTH_LOCAL_BYPASS !== '0';
const AUTH_COOKIE = 'souren_access';
const AUTH_SECRET = process.env.SOUREN_AUTH_SECRET || `${ROOT_DIR}:${ACCESS_CODE || 'local'}`;
const DEFAULT_IMAGE_MODEL = 'gpt-image-1';
const DEFAULT_IMAGE_API_URL = 'https://api.openai.com/v1/images/generations';
const DOUYIN_COLLECTION_CHECK_INTERVAL_MS = Number(process.env.DOUYIN_COLLECTION_CHECK_INTERVAL_MS || 6 * 60 * 60 * 1000);
const DOUYIN_COLLECTOR_AUTO_RUN = process.env.DOUYIN_COLLECTOR_AUTO_RUN !== '0' && process.env.SOUREN_GITHUB_SYNC_CHECK_DISABLED !== '1';
const DOUYIN_COLLECTOR_LIMIT = Math.max(1, Math.min(Number(process.env.DOUYIN_COLLECTOR_LIMIT || 10), 50));
const DOUYIN_COLLECTOR_WAIT_MS = Math.max(1000, Math.min(Number(process.env.DOUYIN_COLLECTOR_WAIT_MS || 6000), 30000));
const DOUYIN_COLLECTOR_COOLDOWN_MS = Math.max(0, Number(process.env.DOUYIN_COLLECTOR_COOLDOWN_MS || 15 * 60 * 1000));
const ROLLING_SCHEDULE_DAYS = Math.max(0, Number(process.env.SOUREN_ROLLING_SCHEDULE_DAYS || 14));
const LOOPBACK_LISTEN_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
let douyinCollectorRun = null;
let douyinCollectorLastStartedAt = null;
let douyinCollectorLastFinishedAt = null;
let douyinCollectorLastSource = null;
let douyinCollectorLastResult = null;
let douyinCollectorLastError = null;

if (!LOOPBACK_LISTEN_HOSTS.has(LISTEN_HOST) && !ACCESS_CODE) {
  console.error('安全限制：开放局域网访问时必须设置 SOUREN_ACCESS_CODE。请改回 SOUREN_HOST=127.0.0.1，或填写访问码后再启动。');
  process.exit(1);
}

app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/api/session', (req, res) => {
  res.json(authSession(req));
});

app.post('/api/session/login', (req, res) => {
  const accessCode = String(req.body?.accessCode || '').trim();
  if (!ACCESS_CODE) return res.json(authSession(req));
  if (accessCode !== ACCESS_CODE) return res.status(401).json({ error: '访问码不正确' });
  res.cookie(AUTH_COOKIE, authToken(), {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/'
  });
  res.json({ ...authSession(req), authenticated: true });
});

app.use('/api', (req, res, next) => {
  if (['/session', '/session/login', '/health'].includes(req.path)) return next();
  return requireWorkbenchAccess(req, res, next);
});
app.use('/files', requireWorkbenchAccess);
app.use('/shared-files', requireWorkbenchAccess);

const STAGES = ['起号期', '决策期', '术后恢复期', '成果期', '收尾期'];
const CONTENT_KINDS = ['素人种草', '日常养号', '爆款提权'];
const PLAN_SLOT_STATUSES = ['待生成', '候选待选', '已锁定', '素材阻塞', '可交付', '已派发', '已完成', '异常', '已取消'];
const ACTIVE_OPERATOR_STATUSES = ['待生成', '候选待选', '已锁定', '素材阻塞', '可交付', '已派发', '异常'];
const PAUSE_CANCEL_SLOT_STATUSES = ACTIVE_OPERATOR_STATUSES;
const STRATEGY_CANCEL_SLOT_STATUSES = ['候选待选', '已锁定', '素材阻塞', '可交付', '异常'];
const DELIVERY_GENERATION_STATUSES = ['已锁定', '素材阻塞', '异常'];
const CANDIDATE_SELECT_STATUSES = ['候选待选'];
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.avi', '.webm']);
const TEXT_EXT = new Set(['.txt', '.md', '.docx']);
const OPEN_IMAGE_STATUSES = ['waiting_key', 'draft', 'review', 'timeout'];
const OPEN_CLIP_STATUSES = ['waiting_edit', 'draft', 'review'];
const OPEN_COLLECTION_STATUSES = ['waiting_chrome'];
const STATUS_LABELS = {
  waiting_key: '待接入图片接口',
  draft: '待生成',
  generating: '生成中',
  review: '待检查',
  approved: '可用',
  rejected: '不用',
  waiting_edit: '待剪辑',
  completed: '已完成',
  unavailable: '未接入',
  error: '异常',
  timeout: '超时',
  active: '待互动',
  handled: '已处理',
  canceled: '已取消',
  waiting_chrome: '等待浏览器采集',
  unknown: '未知',
  ready: '已就绪',
  waiting: '待接入',
  warning: '需处理'
};

const COMPLIANCE_RULES = [
  { label: '绝对化承诺', pattern: /(保证|包成功|百分百|100%|根治|治愈|永久|永不|彻底解决)/i },
  { label: '效果承诺', pattern: /(立刻见效|马上见效|当天见效|快速见效|一次见效|术后立马|效果翻倍)/i },
  { label: '安全无风险表述', pattern: /(零风险|无风险|完全无痛|没有副作用|绝对安全)/i },
  { label: '极限排名表述', pattern: /(第一|唯一|顶级|国家级|最(好|强|快|安全|有效|专业|权威|便宜|厉害|靠谱|自然|明显))/i },
  { label: '诱导性价格表述', pattern: /(低价引流|限时秒杀|错过再等一年|内部价|超低价)/i }
];

function displayStatus(status) {
  return STATUS_LABELS[status] || status || '未知';
}

function complianceHitsForText(text) {
  const content = String(text || '');
  const hits = [];
  COMPLIANCE_RULES.forEach((rule) => {
    const match = content.match(rule.pattern);
    if (match?.[0]) hits.push({ rule: rule.label, match: match[0] });
  });
  return hits;
}

function complianceHitsForCandidate(candidate) {
  return complianceHitsForText(`${candidate?.title || ''}\n${candidate?.publishText || ''}`);
}

function formatComplianceHits(hits) {
  return hits.map((item, index) => `${index + 1}. ${item.rule}：${item.match}`).join('\n');
}

function networkSettings() {
  const interfaces = os.networkInterfaces();
  const lanIps = Object.values(interfaces)
    .flat()
    .filter((item) => item && item.family === 'IPv4' && !item.internal)
    .map((item) => item.address);
  const lanUrls = Array.from(new Set(lanIps.map((ip) => `http://${ip}:${PORT}`)));
  const lanEnabled = !LOOPBACK_LISTEN_HOSTS.has(LISTEN_HOST);
  return {
    listenHost: LISTEN_HOST,
    port: PORT,
    localUrl: `http://127.0.0.1:${PORT}`,
    lanUrls,
    lanEnabled,
    accessCodeRequired: Boolean(ACCESS_CODE),
    localBypass: AUTH_LOCAL_BYPASS
  };
}

function clientIp(req) {
  return String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

function isLoopbackRequest(req) {
  const ip = clientIp(req);
  return ip === '::1' || ip === '127.0.0.1' || ip.startsWith('127.');
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '')
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const index = item.indexOf('=');
      if (index === -1) return [item, ''];
      return [decodeURIComponent(item.slice(0, index)), decodeURIComponent(item.slice(index + 1))];
    }));
}

function authToken() {
  return crypto.createHmac('sha256', AUTH_SECRET).update(ACCESS_CODE).digest('hex');
}

function hasValidAccess(req) {
  if (!ACCESS_CODE) return true;
  if (AUTH_LOCAL_BYPASS && isLoopbackRequest(req)) return true;
  if (req.get('X-Souren-Access') === ACCESS_CODE) return true;
  return parseCookies(req)[AUTH_COOKIE] === authToken();
}

function authSession(req) {
  return {
    authRequired: Boolean(ACCESS_CODE),
    authenticated: hasValidAccess(req),
    localRequest: isLoopbackRequest(req),
    localBypassActive: Boolean(ACCESS_CODE && AUTH_LOCAL_BYPASS && isLoopbackRequest(req)),
    network: networkSettings()
  };
}

function requireWorkbenchAccess(req, res, next) {
  if (hasValidAccess(req)) return next();
  return res.status(401).json({ error: '请输入工作台访问码' });
}

function imageSettings() {
  const apiKey = process.env.IMAGE_API_KEY || '';
  const explicitApiUrl = String(process.env.IMAGE_API_URL || process.env.IMAGE_GENERATE_URL || '').trim();
  const apiUrl = apiKey ? (explicitApiUrl || DEFAULT_IMAGE_API_URL) : '';
  const model = process.env.IMAGE_MODEL || DEFAULT_IMAGE_MODEL;
  const size = process.env.IMAGE_SIZE || '1024x1024';
  const timeoutMs = Number(process.env.IMAGE_TIMEOUT_MS || 90000);
  const missing = !apiKey ? '未填写图片密钥' : '';
  return {
    ready: Boolean(apiKey),
    apiKey,
    apiUrl,
    apiUrlConfigured: Boolean(explicitApiUrl),
    apiUrlDefaulted: Boolean(apiKey && !explicitApiUrl),
    model,
    size,
    timeoutMs,
    missing
  };
}

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
    sourceMaterialDir: row.source_material_dir || '',
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
    originPath: row.origin_path || '',
    reviewStatus: row.review_status,
    createdAt: row.created_at
  };
}

function rowSharedAsset(row) {
  if (!row) return null;
  return {
    id: row.id,
    path: row.path,
    url: safeAssetFileUrl(row.path),
    kind: row.kind,
    category: row.category,
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
    generatedFiles: generatedImageFilesForTask(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function generatedImageFilesForTask(row) {
  if (!row?.output_dir || !fs.existsSync(row.output_dir)) return [];
  return fs.readdirSync(row.output_dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .filter((entry) => entry.name.startsWith(`${row.id}-生成图片-`) && IMAGE_EXT.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => {
      const full = path.join(row.output_dir, entry.name);
      return { name: entry.name, path: full, url: fileUrl(full), kind: '图片' };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

function rowClipTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    caseId: row.case_id,
    planSlotId: row.plan_slot_id,
    title: row.title,
    brief: row.brief,
    status: row.status,
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

function rowAccountSnapshot(row) {
  if (!row) return null;
  return {
    id: row.id,
    caseId: row.case_id,
    collectedAt: row.collected_at,
    fans: row.fans,
    following: row.following,
    totalLikes: row.total_likes,
    totalWorks: row.total_works,
    source: row.source,
    status: row.status,
    note: row.note,
    rawJson: parseJson(row.raw_json, {}),
    createdAt: row.created_at
  };
}

function rowDouyinVideo(row) {
  if (!row) return null;
  return {
    id: row.id,
    caseId: row.case_id,
    douyinVideoId: row.douyin_video_id,
    url: row.url,
    title: row.title,
    publishTime: row.publish_time,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowVideoSnapshot(row) {
  if (!row) return null;
  return {
    id: row.id,
    caseId: row.case_id,
    videoId: row.video_id,
    collectedAt: row.collected_at,
    plays: row.plays,
    likes: row.likes,
    comments: row.comments,
    shares: row.shares,
    favorites: row.favorites,
    source: row.source,
    rawJson: parseJson(row.raw_json, {}),
    createdAt: row.created_at
  };
}

function rowCollectionRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    caseId: row.case_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    source: row.source,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function collectionRunIsOpen(item) {
  return Boolean(item && OPEN_COLLECTION_STATUSES.includes(item.status));
}

function rowViralAlert(row) {
  if (!row) return null;
  const snapshot = row.snapshot_collected_at ? {
    id: row.snapshot_id,
    caseId: row.case_id,
    videoId: row.video_id,
    collectedAt: row.snapshot_collected_at,
    plays: row.snapshot_plays,
    likes: row.snapshot_likes,
    comments: row.snapshot_comments,
    shares: row.snapshot_shares,
    favorites: row.snapshot_favorites
  } : null;
  return {
    id: row.id,
    caseId: row.case_id,
    videoId: row.video_id,
    snapshotId: row.snapshot_id,
    level: row.level,
    reason: row.reason,
    status: row.status,
    interactionNote: row.interaction_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    case: row.case_code ? {
      id: row.case_id,
      caseCode: row.case_code,
      weixinNick: row.weixin_nick,
      douyinId: row.douyin_id,
      douyinUrl: row.douyin_url,
      project: row.project,
      stage: row.stage
    } : null,
    video: row.video_title || row.video_url || row.douyin_video_id ? {
      id: row.video_id,
      douyinVideoId: row.douyin_video_id,
      url: row.video_url,
      title: row.video_title,
      publishTime: row.video_publish_time
    } : null,
    snapshot
  };
}

function assertInsideMaterialRoot(targetPath) {
  const resolved = path.resolve(targetPath);
  if (resolved !== MATERIAL_ROOT && !resolved.startsWith(`${MATERIAL_ROOT}${path.sep}`)) {
    const err = new Error('file is outside material library');
    err.status = 400;
    throw err;
  }
  return resolved;
}

function fileUrl(filePath) {
  const resolved = assertInsideMaterialRoot(filePath);
  const rel = path.relative(MATERIAL_ROOT, resolved);
  return `/files/${rel.split(path.sep).map(encodeURIComponent).join('/')}`;
}

function assetFileUrl(filePath) {
  const resolved = path.resolve(filePath);
  if (resolved === MATERIAL_ROOT || resolved.startsWith(`${MATERIAL_ROOT}${path.sep}`)) return fileUrl(resolved);
  if (resolved === SHARED_MATERIAL_ROOT || resolved.startsWith(`${SHARED_MATERIAL_ROOT}${path.sep}`)) {
    const rel = path.relative(SHARED_MATERIAL_ROOT, resolved);
    return `/shared-files/${rel.split(path.sep).map(encodeURIComponent).join('/')}`;
  }
  return '';
}

function safeAssetFileUrl(filePath) {
  try {
    return assetFileUrl(filePath);
  } catch {
    return '';
  }
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

function fillVars(template, caze, slot = null) {
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
    阶段: slot?.stage || '当前阶段'
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
  const projectPool = rows.some((item) => item.project === caze.project)
    ? rows.filter((item) => item.project === caze.project)
    : rows;
  const stagePool = projectPool.some((item) => item.stage === slot.stage)
    ? projectPool.filter((item) => item.stage === slot.stage)
    : projectPool;
  const weighted = stagePool.flatMap((item) => Array(Math.max(1, Math.round(Number(item.baseWeight || 1)))).fill(item));
  return weighted[Math.floor(Math.random() * weighted.length)];
}

function latestReadyViral() {
  const rows = all('SELECT * FROM viral_templates ORDER BY created_at DESC').map(rowViral);
  return rows.find((item) => !isPendingViralTemplate(item)) || null;
}

function draftText(kind, variant, caze, slot, viral, seed) {
  if (seed) return seedVariantText(fillVars(seed.contentTemplate, caze, slot), variant);
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

function isVideoDelivery(format) {
  return ['视频', '口播'].includes(format);
}

function douyinAccountText(caze = {}) {
  const douyinUrl = String(caze.douyinUrl || '').trim();
  return douyinUrl || '未填抖音链接';
}

function freelancerGuideForCase(caze = {}) {
  return [
    `微信：${caze.weixinNick || '未命名兼职'}`,
    `抖音：${douyinAccountText(caze)}`,
    '',
    '兼职须知：',
    '1. 每次会收到两段文字：第一段是发给你的说明，第二段是抖音发布文案。',
    '2. 抖音发布时直接使用第二段文案，第一行作为标题。',
    '3. 图片或视频按微信收到的顺序上传；没有特别说明时，第一张图默认做封面。',
    '4. 按每次任务写的时间窗发布；没写具体小时就当天发。',
    '5. 话题只用抖音发布文案里已有的，不自己额外加。',
    '6. 不临时改标题、正文、素材顺序和封面逻辑；有问题先微信确认。',
    '7. 发完后回复“已发 + 作品链接或截图”。',
    '8. 如果是剪辑任务，按固定剪辑配方换素材，不临时改结构。'
  ].join('\n');
}

function writeFreelancerGuide(caze) {
  if (!caze?.localCaseDir) return '';
  const guide = freelancerGuideForCase(caze);
  fs.writeFileSync(path.join(caze.localCaseDir, '00-兼职须知.txt'), guide);
  return guide;
}

function fixedPublishRulesText() {
  return [
    '固定发布说明：',
    '1. 下一段“抖音发布文案”直接复制到抖音，第一行做标题。',
    '2. 图片或视频按微信收到的顺序上传；没有特别说明时，第一张图做封面。',
    '3. 按本条任务的时间窗发布；没写具体小时就当天发。',
    '4. 话题只用文案里已有的，不额外加。',
    '5. 不临时改标题、正文、素材顺序和封面逻辑。',
    '6. 发完后回复“已发 + 作品链接或截图”。'
  ].join('\n');
}

function sanitizeOperatorInstruction(text = '') {
  return String(text || '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('系统动作：'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function operatorInstructionFor(slot, caze) {
  return sanitizeOperatorInstruction([
    `今天发：${slot.contentKind}`,
    `微信收件人：${caze.weixinNick}`,
    `抖音：${douyinAccountText(caze)}`,
    `时间窗：${slot.date} ${slot.timeWindow || ''}`,
    '',
    fixedPublishRulesText()
  ].join('\n'));
}

function deliveryOperatorInstructionText(text, slot, caze) {
  const base = sanitizeOperatorInstruction(text) || operatorInstructionFor(slot, caze);
  if (base.includes('固定发布说明')) return base;
  return [
    base,
    '',
    fixedPublishRulesText()
  ].join('\n');
}

function createCandidate(slot, caze, variant, viral = null, seed = null, override = {}) {
  const id = uid('draft');
  const title = override.title || (seed ? fillVars(seed.titleTemplate, caze, slot) : titleFor(slot.contentKind, slot.stage, caze.persona, viral));
  const publishText = override.publishText || draftText(slot.contentKind, variant, caze, slot, viral, seed);
  const operatorInstruction = override.operatorInstruction || operatorInstructionFor(slot, caze);
  const format = override.format || formatForKind(slot.contentKind, seed);
  const complianceHits = Array.isArray(override.complianceHits)
    ? override.complianceHits
    : complianceHitsForText(`${title}\n${publishText}`);
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
      format,
      override.sourceTemplateId || viral?.id || seed?.id || null,
      JSON.stringify(complianceHits),
      now()
    ]
  );
  if (seed) run('UPDATE content_seeds SET usage_count = usage_count + 1, updated_at = ? WHERE id = ?', [now(), seed.id]);
}

async function generateCandidatesForSlot(slot) {
  if (!slot || slot.selectedCandidateId || ['已锁定', '素材阻塞', '可交付', '已派发', '已完成'].includes(slot.status)) {
    return [];
  }
  const caze = caseById(slot.caseId);
  const viral = slot.contentKind === '爆款提权' ? latestReadyViral() : null;
  const seed = slot.contentKind === '爆款提权' ? null : pickContentSeed(slot, caze);
  run('DELETE FROM candidate_drafts WHERE slot_id = ? AND selected = 0', [slot.id]);
  ['稳妥版', '互动版', '爆款结构版'].forEach((variant) => createCandidate(slot, caze, variant, viral, seed));
  run('UPDATE plan_slots SET status = ?, updated_at = ? WHERE id = ?', ['候选待选', now(), slot.id]);
  return all('SELECT * FROM candidate_drafts WHERE slot_id = ? ORDER BY created_at ASC', [slot.id]).map(rowCandidate);
}

function selectRecommendedCandidate(slotId) {
  const drafts = all('SELECT * FROM candidate_drafts WHERE slot_id = ? ORDER BY created_at ASC', [slotId]).map(rowCandidate);
  if (!drafts.length) return null;
  const candidate = drafts.find((item) => item.variant === '稳妥版') || drafts[0];
  run('UPDATE candidate_drafts SET selected = 0 WHERE slot_id = ?', [candidate.slotId]);
  run('UPDATE candidate_drafts SET selected = 1 WHERE id = ?', [candidate.id]);
  run('UPDATE plan_slots SET selected_candidate_id = ?, status = ?, updated_at = ? WHERE id = ?', [candidate.id, '已锁定', now(), candidate.slotId]);
  return rowCandidate(get('SELECT * FROM candidate_drafts WHERE id = ?', [candidate.id]));
}

function canGenerateDeliveryForSlot(slot) {
  if (!slot) return false;
  if (['素材阻塞', '异常'].includes(slot.status)) return true;
  if (slot.status === '已锁定') return !slot.deliveryDir;
  return false;
}

function canPatchSlotStatus(slot, nextStatus) {
  if (!slot) return false;
  if (slot.status === nextStatus) return true;
  if (nextStatus === '异常') return ['待生成', '候选待选', '已锁定', '素材阻塞'].includes(slot.status);
  if (nextStatus === '已派发') return slot.status === '可交付';
  if (nextStatus === '已完成') return slot.status === '已派发';
  return false;
}

function slotIsDashboardQueueHead(slot) {
  if (!slot?.id) return false;
  const queueHead = dashboardQueueHead(dashboard());
  return Boolean(queueHead?.slot?.id && queueHead.slot.id === slot.id);
}

function queueGuardBypassed(req) {
  return process.env.SOUREN_E2E_QUEUE_BYPASS === '1' && req.get('X-Souren-E2E-Setup') === '1';
}

function queueGuardError(message = '这条不是今日操作队列队首，不能越过前面的任务处理') {
  const error = new Error(message);
  error.status = 409;
  return error;
}

function requireQueueHeadForSlot(req, slot, action = '处理') {
  if (queueGuardBypassed(req)) return;
  if (slotIsDashboardQueueHead(slot)) return;
  throw queueGuardError(`这条不是今日操作队列队首，不能越过前面的任务${action}`);
}

function alertIsDashboardQueueHead(alert) {
  if (!alert?.id) return false;
  const queueHead = dashboardQueueHead(dashboard());
  return Boolean(queueHead?.alert?.id && queueHead.alert.id === alert.id);
}

function requireQueueHeadForAlert(req, alert, action = '处理') {
  if (queueGuardBypassed(req)) return;
  if (alertIsDashboardQueueHead(alert)) return;
  throw queueGuardError(`这条爆款提醒不是今日操作队列队首，不能越过前面的任务${action}`);
}

function clipTaskIsDashboardQueueHead(task) {
  if (!task?.id) return false;
  const queueHead = dashboardQueueHead(dashboard());
  return Boolean(queueHead?.clipTask?.id && queueHead.clipTask.id === task.id);
}

function requireQueueHeadForClipTask(req, task, action = '处理') {
  if (queueGuardBypassed(req)) return;
  if (clipTaskIsDashboardQueueHead(task)) return;
  throw queueGuardError(`这条剪辑任务不是今日操作队列队首，不能越过前面的任务${action}`);
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

function generateSlotsForCase(caze, input = {}) {
  const days = Number(input.days || 30);
  const startDate = input.startDate || new Date().toISOString().slice(0, 10);
  const postingStrategy = input.postingStrategy || postingStrategyForCase(caze);
  const created = [];
  if (postingStrategy.intervalDays === 0) return created;
  for (let i = 0; i < days; i += 1) {
    const date = addDays(startDate, i);
    if (!shouldCreateSlotForDate(caze, date, postingStrategy)) continue;
    const exists = get(
      'SELECT id FROM plan_slots WHERE case_id = ? AND date = ? AND status NOT IN (?, ?)',
      [caze.id, date, '已取消', '已完成']
    );
    if (exists) continue;
    const stage = stageForDay(caze.stage, i);
    const contentKind = pickWeighted(STAGE_RATIOS[stage] || STAGE_RATIOS.起号期);
    created.push(createSlotForCase(caze, {
      date,
      timeWindow: timeWindowFor(i),
      contentKind,
      stage
    }));
  }
  return created;
}

function maintainRollingSchedule(cases = all('SELECT * FROM cases ORDER BY created_at ASC').map(rowCase), input = {}) {
  const days = Math.max(0, Number(input.days ?? ROLLING_SCHEDULE_DAYS));
  if (!days) return { days, createdCount: 0, prunedCount: 0, canceledCount: 0, touchedCases: 0, autoPausedLostContact: [], created: [] };
  const startDate = input.startDate || new Date().toISOString().slice(0, 10);
  const autoPausedLostContact = autoPauseLostContactCases(cases);
  if (autoPausedLostContact.length) {
    const pausedIds = new Set(autoPausedLostContact.map((item) => item.caseId));
    cases = cases.map((caze) => (pausedIds.has(caze.id) ? caseById(caze.id) : caze)).filter(Boolean);
  }
  const created = [];
  let prunedCount = 0;
  let canceledCount = 0;
  let touchedCases = 0;
  cases.forEach((caze) => {
    const postingStrategy = postingStrategyForCase(caze);
    prunedCount += prunePendingSlotsForStrategy(caze, postingStrategy, startDate);
    canceledCount += cancelPreparedSlotsForStrategy(caze, postingStrategy, startDate);
    const rows = generateSlotsForCase(caze, { days, startDate, postingStrategy });
    if (rows.length) {
      touchedCases += 1;
      created.push(...rows);
    }
  });
  return { days, startDate, createdCount: created.length, prunedCount, canceledCount, touchedCases, autoPausedLostContact, created };
}

function normalizeDouyinUrl(value) {
  const url = String(value || '').trim();
  if (!/^https?:\/\//i.test(url) || !/douyin\.com/i.test(url)) return '';
  return url;
}

function douyinIdFromUrl(value) {
  const url = normalizeDouyinUrl(value);
  if (!url) return '';
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/(?:share\/)?user\/([^/?#]+)/i);
    return match ? decodeURIComponent(match[1]).slice(0, 120) : '';
  } catch {
    return '';
  }
}

function normalizeSourceMaterialDir(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    const err = new Error('必须填写共享原始素材路径');
    err.status = 400;
    throw err;
  }
  const resolved = path.resolve(raw);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    const err = new Error('共享原始素材路径不存在或不是目录');
    err.status = 404;
    throw err;
  }
  return resolved;
}

function createCaseFromBody(body = {}) {
  const id = uid('case');
  const created = now();
  const project = String(body.project || '').trim();
  if (!project) {
    const err = new Error('必须填写项目');
    err.status = 400;
    throw err;
  }
  const stage = '起号期';
  const persona = randomPersona(body.persona || {});
  const date = created.slice(0, 10).replaceAll('-', '');
  const seq = all('SELECT id FROM cases').length + 1;
  const caseCode = body.caseCode || `XZ-${date}-${String(seq).padStart(3, '0')}`;
  const weixinNick = String(body.weixinNick || body.weixin_nick || '').trim();
  if (!weixinNick) {
    const err = new Error('必须填写兼职微信昵称');
    err.status = 400;
    throw err;
  }
  const douyinUrl = normalizeDouyinUrl(body.douyinUrl || body.douyin_url || '');
  if (!douyinUrl) {
    const err = new Error('必须填写有效的抖音主页或作品链接');
    err.status = 400;
    throw err;
  }
  const sourceMaterialDir = normalizeSourceMaterialDir(body.sourceMaterialDir || body.source_material_dir || '');
  const dirName = `${caseCode}_${safeSegment(persona.city)}_${safeSegment(project)}_${safeSegment(weixinNick)}`;
  const caseDir = path.join(MATERIAL_ROOT, dirName);
  ensureCaseDirs(caseDir);
  run(
    `INSERT INTO cases
    (id, case_code, weixin_nick, douyin_id, douyin_url, project, stage, persona, source_material_dir, local_case_dir, health_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      caseCode,
      weixinNick,
      douyinIdFromUrl(douyinUrl),
      douyinUrl,
      project,
      stage,
      JSON.stringify(persona),
      sourceMaterialDir,
      caseDir,
      body.healthStatus || '健康',
      created,
      created
    ]
  );
  const createdCase = caseById(id);
  writeFreelancerGuide(createdCase);
  writeCaseManifest(createdCase);
  return createdCase;
}

function resumeCaseAccount(caseId) {
  const caze = caseById(caseId);
  if (!caze) {
    const error = new Error('case not found');
    error.status = 404;
    throw error;
  }
  const today = new Date().toISOString().slice(0, 10);
  const staleSentSlots = all(
    'SELECT * FROM plan_slots WHERE case_id = ? AND status = ? ORDER BY date ASC',
    [caze.id, '已派发']
  ).map(rowSlot).filter((slot) => daysBetween(slot.date, today) >= 3);
  staleSentSlots.forEach((slot) => {
    run('UPDATE plan_slots SET status = ?, updated_at = ? WHERE id = ?', ['已取消', now(), slot.id]);
  });
  run('UPDATE cases SET health_status = ?, updated_at = ? WHERE id = ?', ['健康', now(), caze.id]);
  const updated = caseById(caze.id);
  const postingStrategy = postingStrategyForCase(updated);
  const createdSlots = generateSlotsForCase(updated, { days: 7, startDate: today, postingStrategy });
  const collectionQueue = registerCaseCollectionQueue([updated.id], 'case-resume');
  writeCaseManifest(updated);
  return {
    case: updated,
    canceledCount: staleSentSlots.length,
    canceledSlots: staleSentSlots.map((slot) => ({ ...slot, status: '已取消' })),
    slotsCreated: createdSlots.length,
    createdSlots,
    postingStrategy,
    collectionQueue
  };
}

const CASE_LIBRARY_PROJECT_WORDS = ['吸脂', '修复', '复诊', '鼻', '眼', '皮肤', '脂肪', '面诊', '医美'];
const CASE_LIBRARY_CITY_WORDS = ['成都', '杭州', '重庆', '西安', '长沙', '武汉', '南京', '苏州', '广州', '深圳', '北京', '上海'];
const CASE_LIBRARY_MATERIAL_FOLDER_WORDS = [
  '00-原始素材',
  '01-已筛选素材',
  '02-生成补充',
  '03-交付给兼职',
  '原始',
  '原始素材',
  '已筛选',
  '筛选',
  '图片',
  '视频',
  '文案',
  '术前',
  '术后',
  '恢复',
  '对比',
  '面诊',
  '医院',
  '日常'
];

function inferProjectFromText(text = '') {
  return CASE_LIBRARY_PROJECT_WORDS.find((word) => String(text).includes(word)) || '吸脂';
}

function inferCityFromText(text = '') {
  return CASE_LIBRARY_CITY_WORDS.find((word) => String(text).includes(word)) || '';
}

function isBroadCaseLibraryBucket(name = '') {
  const normalized = String(name).trim();
  if (!normalized) return false;
  return CASE_LIBRARY_PROJECT_WORDS.includes(normalized)
    || ['待分配', '已分配', '案例', '案例库', '真实案例', '素材', '原始案例', '通用素材'].includes(normalized);
}

function isMaterialSubfolderName(name = '') {
  const normalized = String(name).toLowerCase();
  return CASE_LIBRARY_MATERIAL_FOLDER_WORDS.some((word) => normalized.includes(word.toLowerCase()));
}

function countCaseLibraryFiles(dir) {
  const files = walkFiles(dir).filter(isSupportedAssetFile);
  return {
    fileCount: files.length,
    imageCount: files.filter((file) => IMAGE_EXT.has(path.extname(file).toLowerCase())).length,
    videoCount: files.filter((file) => VIDEO_EXT.has(path.extname(file).toLowerCase())).length,
    textCount: files.filter((file) => TEXT_EXT.has(path.extname(file).toLowerCase())).length,
    sampleFiles: files.slice(0, 5)
  };
}

function caseLibraryDirectoryStats(root = CASE_LIBRARY_ROOT) {
  const resolvedRoot = path.resolve(root);
  if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) return [];
  const stats = [];
  function visit(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      if (!entry.isDirectory() || entry.name.startsWith('.')) return;
      const full = path.join(dir, entry.name);
      const counts = countCaseLibraryFiles(full);
      if (counts.fileCount > 0) {
        const rel = path.relative(resolvedRoot, full);
        const parts = rel.split(path.sep).filter(Boolean);
        const children = fs.readdirSync(full, { withFileTypes: true }).filter((child) => child.isDirectory());
        const childAssetDirs = children
          .map((child) => ({
            name: child.name,
            counts: countCaseLibraryFiles(path.join(full, child.name))
          }))
          .filter((child) => child.counts.fileCount > 0);
        stats.push({
          path: full,
          name: entry.name,
          rel,
          depth: parts.length,
          childCaseLikeCount: childAssetDirs.filter((child) => !isMaterialSubfolderName(child.name)).length,
          directFileCount: fs.readdirSync(full, { withFileTypes: true }).filter((child) => child.isFile() && isSupportedAssetFile(path.join(full, child.name))).length,
          ...counts
        });
      }
      visit(full);
    });
  }
  visit(resolvedRoot);
  return stats;
}

function caseLibraryDirectories(root = CASE_LIBRARY_ROOT) {
  const stats = caseLibraryDirectoryStats(root).sort((a, b) => a.depth - b.depth || a.rel.localeCompare(b.rel, 'zh-Hans-CN'));
  const selected = [];
  stats.forEach((item) => {
    if (selected.some((parent) => item.path.startsWith(`${parent.path}${path.sep}`))) return;
    if (item.depth === 1 && item.directFileCount === 0 && (item.childCaseLikeCount > 1 || isBroadCaseLibraryBucket(item.name))) return;
    selected.push(item);
  });
  return selected;
}

function caseLibraryCandidates() {
  const registered = new Map(
    all('SELECT id, case_code, weixin_nick, source_material_dir FROM cases WHERE source_material_dir IS NOT NULL AND source_material_dir != ? ORDER BY created_at DESC', [''])
      .map((item) => [path.resolve(item.source_material_dir), item])
  );
  const candidates = caseLibraryDirectories().map((item) => {
    const registeredCase = registered.get(path.resolve(item.path));
    const name = item.name.replace(/^\d+[-_ ]?/, '').trim() || item.name;
    const project = inferProjectFromText(`${item.rel} ${name}`);
    const city = inferCityFromText(`${item.rel} ${name}`);
    return {
      sourceMaterialDir: item.path,
      relativePath: item.rel,
      name,
      suggestedWeixinNick: name,
      project,
      city,
      fileCount: item.fileCount,
      imageCount: item.imageCount,
      videoCount: item.videoCount,
      textCount: item.textCount,
      sampleFiles: item.sampleFiles,
      alreadyRegistered: Boolean(registeredCase),
      caseId: registeredCase?.id || '',
      caseCode: registeredCase?.case_code || '',
      weixinNick: registeredCase?.weixin_nick || ''
    };
  });
  return candidates.sort((a, b) => Number(a.alreadyRegistered) - Number(b.alreadyRegistered) || a.relativePath.localeCompare(b.relativePath, 'zh-Hans-CN'));
}

function assertInsideCaseLibraryRoot(targetPath) {
  const resolved = path.resolve(targetPath);
  if (resolved !== CASE_LIBRARY_ROOT && !resolved.startsWith(`${CASE_LIBRARY_ROOT}${path.sep}`)) {
    const error = new Error('案例目录不在服务器案例库根目录内');
    error.status = 400;
    throw error;
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    const error = new Error('服务器案例目录不存在或不是目录');
    error.status = 404;
    throw error;
  }
  return resolved;
}

function createCaseFromLibrary(input = {}) {
  const sourceMaterialDir = assertInsideCaseLibraryRoot(input.sourceMaterialDir || input.source_material_dir || '');
  const existing = get('SELECT id, weixin_nick FROM cases WHERE source_material_dir = ?', [sourceMaterialDir]);
  if (existing) {
    const error = new Error(`该服务器案例目录已经登记到「${existing.weixin_nick}」`);
    error.status = 409;
    throw error;
  }
  const candidate = caseLibraryCandidates().find((item) => path.resolve(item.sourceMaterialDir) === sourceMaterialDir);
  if (!candidate) {
    const error = new Error('该目录下没有可识别的图片、视频或文案素材');
    error.status = 400;
    throw error;
  }
  const created = createCaseFromBody({
    weixinNick: input.weixinNick || input.weixin_nick || '',
    douyinUrl: input.douyinUrl || input.douyin_url || '',
    project: input.project || candidate.project || '吸脂',
    stage: input.stage || '起号期',
    sourceMaterialDir,
    persona: {
      ...(input.persona || {}),
      city: input.persona?.city || candidate.city || ''
    },
    healthStatus: input.healthStatus || '健康'
  });
  const sync = syncCaseSourceMaterials(created);
  const slots = generateSlotsForCase(created, { days: 14 });
  const collectionQueue = registerCaseCollectionQueue([created.id], 'case-library-register');
  return {
    case: { ...created, slotsCreated: slots.length },
    source: candidate,
    sync,
    slotsCreated: slots.length,
    collectionQueue
  };
}

function writeCaseManifest(caze) {
  if (!caze?.localCaseDir) return;
  ensureCaseDirs(caze.localCaseDir);
  fs.writeFileSync(path.join(caze.localCaseDir, 'case.json'), JSON.stringify(caze, null, 2));
}

function removeCaseDirectory(caze) {
  if (!caze?.localCaseDir) return { removedDir: false };
  const target = assertInsideMaterialRoot(caze.localCaseDir);
  if (target === MATERIAL_ROOT) {
    const err = new Error('refuse to delete material root');
    err.status = 400;
    throw err;
  }
  if (!fs.existsSync(target)) return { removedDir: false };
  fs.rmSync(target, { recursive: true, force: true });
  return { removedDir: true };
}

function imagePromptFor(caze, slot, purpose, sourceMaterials = []) {
  const p = caze.persona || {};
  return [
    `账号人设：${personaLine(p)}`,
    `内容类型：${slot?.contentKind || purpose}`,
    `当前阶段：${slot?.stage || caze.stage}`,
    '发布平台：抖音图文/封面',
    `图片用途：${purpose}`,
    `参考素材：${formatSourceMaterials(sourceMaterials)}`,
    '风格要求：自然生活感，手机拍摄质感，画面干净，适合微信发给兼职后直接保存使用。',
    '合成要求：如果包含案例人物参考和医院/场景素材，保持人物身份特征和真实生活质感，把场景自然融合，不要做明显棚拍感。',
    '输出要求：生成后保存到指定目录，并回到系统标记“待检查 / 可用 / 不用”。'
  ].join('\n');
}

function sourceMaterialLine(item, index) {
  if (typeof item === 'string') return `${index + 1}. ${item}`;
  return `${index + 1}. ${item.role || item.usage || '参考素材'}｜${item.kind || ''}｜${item.usage || item.category || ''}\n   ${item.path || ''}`;
}

function formatSourceMaterials(sourceMaterials = []) {
  if (!sourceMaterials.length) return '暂无，按账号人设和内容阶段生成';
  return sourceMaterials.map(sourceMaterialLine).join('\n');
}

function imageExtensionFromContentType(contentType) {
  const type = String(contentType || '').toLowerCase();
  if (type.includes('jpeg') || type.includes('jpg')) return '.jpg';
  if (type.includes('webp')) return '.webp';
  if (type.includes('gif')) return '.gif';
  return '.png';
}

function imageExtensionFromUrl(url) {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    return IMAGE_EXT.has(ext) && ext !== '.heic' ? ext : '.png';
  } catch {
    return '.png';
  }
}

function decodeImageBase64(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('图片接口返回了空图片数据');
  const match = raw.match(/^data:([^;]+);base64,(.+)$/);
  const payload = match ? match[2] : raw;
  const buffer = Buffer.from(payload, 'base64');
  if (!buffer.length) throw new Error('图片接口返回的图片数据无法解码');
  return {
    buffer,
    ext: match ? imageExtensionFromContentType(match[1]) : '.png'
  };
}

function collectImageResponseItems(body) {
  const roots = [
    body,
    ...(Array.isArray(body?.data) ? body.data : []),
    ...(Array.isArray(body?.images) ? body.images : []),
    ...(Array.isArray(body?.output) ? body.output : []),
    ...(Array.isArray(body?.outputs) ? body.outputs : []),
    ...(Array.isArray(body?.result?.images) ? body.result.images : [])
  ].filter(Boolean);
  const items = [];
  roots.forEach((item) => {
    if (typeof item === 'string') {
      if (/^https?:\/\//.test(item)) items.push({ url: item });
      else items.push({ b64: item });
      return;
    }
    const b64 = item.b64_json || item.base64 || item.image_base64 || item.image;
    const url = item.url || item.image_url;
    if (b64) items.push({ b64 });
    if (url) items.push({ url });
  });
  return items;
}

function imageRequestBody(settings, task) {
  const body = {
    model: settings.model,
    prompt: task.prompt,
    size: settings.size,
    n: 1
  };
  if (!settings.apiUrlDefaulted) {
    body.negative_prompt = task.negativePrompt || '';
    body.response_format = 'b64_json';
  }
  return body;
}

async function materializeImageItem(item, task, index, signal) {
  fs.mkdirSync(task.outputDir, { recursive: true });
  let buffer;
  let ext = '.png';
  if (item.b64) {
    const decoded = decodeImageBase64(item.b64);
    buffer = decoded.buffer;
    ext = decoded.ext;
  } else if (item.url) {
    const res = await fetch(item.url, { signal });
    if (!res.ok) throw new Error(`下载生成图片失败：${res.status}`);
    buffer = Buffer.from(await res.arrayBuffer());
    ext = imageExtensionFromContentType(res.headers.get('content-type')) || imageExtensionFromUrl(item.url);
  } else {
    throw new Error('图片接口返回格式无法识别');
  }
  const filePath = path.join(task.outputDir, `${task.id}-生成图片-${index}${ext}`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

function insertGeneratedImageAsset(task, filePath) {
  run(
    `INSERT OR IGNORE INTO assets (id, case_id, path, kind, stage, source, usage, review_status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uid('asset'),
      task.caseId,
      filePath,
      '图片',
      task.purpose,
      'AI生成',
      task.purpose,
      '待处理',
      now()
    ]
  );
  return rowAsset(get('SELECT * FROM assets WHERE case_id = ? AND path = ?', [task.caseId, filePath]));
}

function writeImageTaskBrief(task, extraLines = []) {
  fs.mkdirSync(task.outputDir, { recursive: true });
  fs.writeFileSync(path.join(task.outputDir, `${task.id}-图片任务说明.txt`), [
    `任务ID：${task.id}`,
    `状态：${displayStatus(task.status)}`,
    `用途：${task.purpose}`,
    `保存目录：${task.outputDir}`,
    '',
    '正向提示词：',
    task.prompt,
    '',
    '参考素材：',
    formatSourceMaterials(task.sourceMaterials || []),
    '',
    '反向提示词：',
    task.negativePrompt || '',
    ...extraLines
  ].join('\n'));
}

async function generateImageFiles(task) {
  const settings = imageSettings();
  if (!settings.ready) {
    run('UPDATE image_tasks SET status = ?, updated_at = ? WHERE id = ?', ['waiting_key', now(), task.id]);
    const updated = rowImageTask(get('SELECT * FROM image_tasks WHERE id = ?', [task.id]));
    writeImageTaskBrief(updated, ['', `提示：${settings.missing}，当前会保留提示词，等待图片接口接入后再生成。`]);
    const err = new Error(`${settings.missing}，请先在 app/.env 填 IMAGE_API_KEY`);
    err.status = 409;
    throw err;
  }

  run('UPDATE image_tasks SET status = ?, updated_at = ? WHERE id = ?', ['generating', now(), task.id]);
  const generatingTask = rowImageTask(get('SELECT * FROM image_tasks WHERE id = ?', [task.id]));
  writeImageTaskBrief(generatingTask);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  try {
    const res = await fetch(settings.apiUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify(imageRequestBody(settings, task))
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error?.message || body?.message || `图片接口失败：${res.status}`);
    const items = collectImageResponseItems(body);
    if (!items.length) throw new Error('图片接口没有返回图片文件');
    const files = [];
    const assets = [];
    for (let i = 0; i < Math.min(items.length, 4); i += 1) {
      const filePath = await materializeImageItem(items[i], task, i + 1, controller.signal);
      files.push(filePath);
      assets.push(insertGeneratedImageAsset(task, filePath));
    }
    run('UPDATE image_tasks SET status = ?, updated_at = ? WHERE id = ?', ['review', now(), task.id]);
    const updated = rowImageTask(get('SELECT * FROM image_tasks WHERE id = ?', [task.id]));
    fs.writeFileSync(path.join(updated.outputDir, `${updated.id}-生成结果.txt`), [
      `任务ID：${updated.id}`,
      `状态：${displayStatus(updated.status)}`,
      `生成时间：${now()}`,
      `模型：${settings.model}`,
      '',
      '生成文件：',
      ...files.map((file, index) => `${index + 1}. ${file}`),
      '',
      '下一步：在系统或素材清单里检查图片，适合使用就标记“可用”，不合适就标记“不用”。'
    ].join('\n'));
    writeImageTaskBrief(updated, ['', '生成文件：', ...files.map((file, index) => `${index + 1}. ${file}`)]);
    return { task: updated, files, assets };
  } catch (error) {
    const status = error.name === 'AbortError' ? 'timeout' : 'draft';
    run('UPDATE image_tasks SET status = ?, updated_at = ? WHERE id = ?', [status, now(), task.id]);
    const updated = rowImageTask(get('SELECT * FROM image_tasks WHERE id = ?', [task.id]));
    fs.writeFileSync(path.join(updated.outputDir, `${updated.id}-生成失败.txt`), [
      `任务ID：${updated.id}`,
      `失败时间：${now()}`,
      `错误：${error.name === 'AbortError' ? '图片接口超时' : error.message}`,
      '',
      '下一步：检查图片密钥、模型名和可选接口地址；必要时在任务详情查看提示词。'
    ].join('\n'));
    writeImageTaskBrief(updated, ['', `最近生成失败：${error.name === 'AbortError' ? '图片接口超时' : error.message}`]);
    const err = new Error(error.name === 'AbortError' ? '图片接口超时，请稍后重试' : error.message);
    err.status = error.name === 'AbortError' ? 504 : 502;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function personaMatchTokens(caze) {
  const p = caze.persona || {};
  return [caze.weixinNick, caze.project, p.city, p.age ? `${p.age}岁` : '', p.occupation, p.tone, p.motivation]
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

function isPendingViralTemplate(viral) {
  return String(viral.rawText || '').startsWith('待分析')
    || String(viral.hotStructure || '').startsWith('待分析')
    || viral.category === '待分析';
}

function cleanKeywordList(value) {
  const input = Array.isArray(value) ? value : String(value || '').split(/[,\n，、]/);
  return input.map((item) => String(item).trim()).filter(Boolean);
}

function normalizeViralAnalysisResult(body = {}) {
  const title = String(body.title || '').trim();
  const rawText = String(body.rawText || '').trim();
  const category = String(body.category || '').trim();
  const hotStructure = String(body.hotStructure || '').trim();
  const rewritePolicy = String(body.rewritePolicy || '').trim();
  const missing = [];
  if (!title) missing.push('标题');
  if (!rawText || rawText.startsWith('待分析')) missing.push('原视频内容');
  if (!category || category === '待分析') missing.push('类别');
  if (!hotStructure || hotStructure.startsWith('待分析')) missing.push('结构分析');
  if (!rewritePolicy) missing.push('改写策略');
  if (missing.length) {
    const error = new Error(`爆款分析结果缺少：${missing.join('、')}`);
    error.status = 400;
    throw error;
  }
  return {
    title,
    rawText,
    category,
    hotStructure,
    suitablePersonas: cleanKeywordList(body.suitablePersonas),
    forbiddenPersonas: cleanKeywordList(body.forbiddenPersonas),
    rewritePolicy
  };
}

function viralAnalysisTaskText(viral) {
  return [
    '爆款链接分析任务',
    `链接：${viral.sourceLink || '未填'}`,
    `系统记录ID：${viral.id}`,
    '',
    '需要提取：',
    '1. 原视频标题或前3秒开头',
    '2. 完整口播/字幕正文',
    '3. 内容结构：开头钩子、转折点、主体段落、评论引导',
    '4. 爆点判断：为什么值得改写成账号内容',
    '5. 适合人设关键词：城市、职业、项目、语气等',
    '6. 禁用人设关键词：不适合套用的账号类型',
    '',
    '后台写回接口：',
    `POST /api/viral-templates/${viral.id}/analysis-result`,
    '',
    'JSON字段：',
    'title：标题或备注名',
    'rawText：原视频完整正文/口播/字幕',
    'category：情绪/职场/穿搭/美食/本地生活/清单/反差故事',
    'hotStructure：结构拆解和下一步改写建议',
    'suitablePersonas：适合账号关键词数组',
    'forbiddenPersonas：禁用账号关键词数组',
    'rewritePolicy：结构模仿/话题模仿/仅参考',
    '',
    '写回成功后，前台会从“待分析”变成“可生成”，工作人员不需要填写模板内容。'
  ].join('\n');
}

function materialIntakeText(caze, gaps = []) {
  const openGaps = gaps.filter((gap) => gap.status !== '已满足');
  const required = openGaps.filter((gap) => gap.status === '必补');
  const optional = openGaps.filter((gap) => gap.status === '可补');
  return [
    '素材补齐说明',
    `案例：${caze.caseCode} / ${caze.weixinNick}`,
    `项目：${caze.project}`,
    '',
    caze.sourceMaterialDir ? '工作人员优先把挑好的原始素材放到共享路径：' : '如果有共享盘/服务器目录，先在案例里填写“共享原始素材路径”。',
    caze.sourceMaterialDir || '未填写',
    '',
    '系统同步后会复制到本地受控目录：',
    path.join(caze.localCaseDir, '00-原始素材'),
    '',
    '也可以直接把已筛选好的素材放到本地：',
    path.join(caze.localCaseDir, '01-已筛选素材'),
    '',
    required.length ? '必补素材：' : '必补素材：暂无',
    ...required.map((gap, index) => `${index + 1}. ${gap.label}｜${gap.suggestion}`),
    '',
    optional.length ? '可补素材：' : '可补素材：暂无',
    ...optional.slice(0, 6).map((gap, index) => `${index + 1}. ${gap.label}｜${gap.suggestion}`),
    '',
    '放完素材后：',
    '1. 回到系统案例详情',
    '2. 如果填了共享路径，先点“同步共享素材”',
    '3. 再点“扫描素材”',
    '4. 把可用素材标记为“可用”',
    '5. 再生成候选或交付内容'
  ].join('\n');
}

function imagePromptText(task) {
  return [
    '图片生成任务',
    `任务ID：${task.id}`,
    `用途：${task.purpose}`,
    `状态：${displayStatus(task.status)}`,
    `保存目录：${task.outputDir}`,
    '',
    '正向提示词：',
    task.prompt,
    '',
    '参考素材：',
    formatSourceMaterials(task.sourceMaterials || []),
    '',
    '反向提示词：',
    task.negativePrompt || ''
  ].join('\n');
}

function parseBulkCaseText(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const parts = line.split(/,|\t/).map((item) => item.trim());
      const [weixinNick, douyinUrl, project, sourceMaterialDir] = parts;
      const normalizedDouyinUrl = normalizeDouyinUrl(douyinUrl);
      return {
        weixinNick,
        douyinId: douyinIdFromUrl(normalizedDouyinUrl),
        douyinUrl: normalizedDouyinUrl,
        sourceMaterialDir: sourceMaterialDir || '',
        project: project || '',
        persona: randomPersona()
      };
    })
    .filter((item) => item.weixinNick || item.douyinUrl || item.project || item.sourceMaterialDir);
}

function prepareBulkCaseRows(rows = []) {
  const seenSources = new Set();
  return rows.map((row, index) => {
    const line = index + 1;
    const weixinNick = String(row.weixinNick || row.weixin_nick || '').trim();
    if (!weixinNick) {
      const error = new Error(`第 ${line} 行缺少兼职微信昵称`);
      error.status = 400;
      throw error;
    }
    const douyinUrl = normalizeDouyinUrl(row.douyinUrl || row.douyin_url || '');
    if (!douyinUrl) {
      const error = new Error(`第 ${line} 行缺少有效抖音主页或作品链接`);
      error.status = 400;
      throw error;
    }
    const project = String(row.project || '').trim();
    if (!project) {
      const error = new Error(`第 ${line} 行缺少项目`);
      error.status = 400;
      throw error;
    }
    const sourceMaterialDir = normalizeSourceMaterialDir(row.sourceMaterialDir || row.source_material_dir || '');
    if (seenSources.has(sourceMaterialDir)) {
      const error = new Error(`第 ${line} 行共享原始素材路径重复`);
      error.status = 409;
      throw error;
    }
    seenSources.add(sourceMaterialDir);
    const existing = get('SELECT weixin_nick FROM cases WHERE source_material_dir = ?', [sourceMaterialDir]);
    if (existing) {
      const error = new Error(`第 ${line} 行共享原始素材路径已经登记到「${existing.weixin_nick}」`);
      error.status = 409;
      throw error;
    }
    return {
      ...row,
      weixinNick,
      douyinId: douyinIdFromUrl(douyinUrl),
      douyinUrl,
      sourceMaterialDir,
      project
    };
  });
}

function createBulkCases(rows = []) {
  const preparedRows = prepareBulkCaseRows(rows);
  if (!preparedRows.length) {
    const error = new Error('没有有效账号行：每行必须包含微信昵称、抖音链接和共享原始素材路径');
    error.status = 400;
    throw error;
  }
  const cases = [];
  const syncResults = [];
  let totalSynced = 0;
  let totalSlots = 0;
  preparedRows.forEach((row) => {
    const created = createCaseFromBody(row);
    const sync = syncCaseSourceMaterials(created);
    const slots = generateSlotsForCase(created, { days: 14 });
    cases.push({ ...created, sync, slotsCreated: slots.length });
    syncResults.push({ caseId: created.id, ...sync });
    totalSynced += sync.inserted || 0;
    totalSlots += slots.length;
  });
  const collectionQueue = registerCaseCollectionQueue(cases.map((item) => item.id), 'case-bulk-create');
  return {
    createdCount: cases.length,
    syncedCount: totalSynced,
    slotsCreated: totalSlots,
    collectionQueue,
    cases,
    sync: syncResults
  };
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
      const haystack = `${asset.stage} ${asset.usage} ${asset.path}`.toLowerCase();
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
            : `可补充${item.label}，或创建图片/剪辑任务作为辅助`
    };
  });
}

function isSupportedAssetFile(file) {
  const ext = path.extname(file).toLowerCase();
  return [...IMAGE_EXT, ...VIDEO_EXT, ...TEXT_EXT].includes(ext);
}

function assetSourceForPath(file) {
  if (file.includes('02-生成补充')) return 'AI生成';
  if (file.includes('共享同步')) return '共享导入';
  return '真实';
}

function materialKeywordText(file) {
  return `${file} ${path.basename(file)} ${path.dirname(file)}`.toLowerCase();
}

function includesAny(text, words) {
  return words.some((word) => text.includes(String(word).toLowerCase()));
}

function classifyMaterialFile(file, scope = 'case') {
  const text = materialKeywordText(file);
  const kind = inferAssetKind(file);
  if (scope === 'shared') {
    if (includesAny(text, ['医院', '院内', '病房', '诊室', '前台', '大厅', '手术室', '环境'])) {
      return { category: '医院素材', usage: '合成背景' };
    }
    if (includesAny(text, ['套图', '模板', '拼图', '版式', '参考图', '同款'])) {
      return { category: '套图素材', usage: '套图参考' };
    }
    if (includesAny(text, ['文字卡', '封面', '标题', '卡片'])) {
      return { category: '文字卡素材', usage: '文字卡' };
    }
    if (includesAny(text, ['生活', '街拍', '城市', '工作', '穿搭'])) {
      return { category: '生活场景', usage: '通用配图' };
    }
    return { category: sharedAssetCategory(file), usage: kind === '视频' ? '通用视频' : '通用配图' };
  }
  const stage = inferStage(file);
  if (includesAny(text, ['对比', '前后', 'before', 'after', 'compare'])) return { stage: '对比', usage: '案例对比' };
  if (includesAny(text, ['术前', '基准', 'before'])) return { stage: '术前', usage: '案例人物' };
  if (includesAny(text, ['自拍', '人物', '本人', '脸', '身材', '身体', '正面', '侧面'])) return { stage, usage: '案例人物' };
  if (includesAny(text, ['d1', 'd3', 'd7', 'd14', 'd30', '术后', '恢复', '过程'])) return { stage, usage: '案例过程' };
  if (includesAny(text, ['面诊', '探店', '医院', '咨询'])) return { stage: stage === '未分组' ? '面诊' : stage, usage: '案例场景' };
  if (includesAny(text, ['日常', '生活', '穿搭', '工作', '城市'])) return { stage, usage: '日常素材' };
  if (kind === '视频') return { stage, usage: '案例视频' };
  if (kind === '文案') return { stage, usage: '案例文案' };
  return { stage, usage: '案例素材' };
}

function insertCaseAsset(caze, file, options = {}) {
  const classification = classifyMaterialFile(options.originPath || file, 'case');
  run(
    `INSERT INTO assets (id, case_id, path, kind, stage, source, usage, origin_path, review_status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uid('asset'),
      caze.id,
      file,
      inferAssetKind(file),
      options.stage || classification.stage,
      options.source || assetSourceForPath(file),
      options.usage || classification.usage,
      options.originPath || '',
      options.reviewStatus || '待处理',
      now()
    ]
  );
}

function scanCaseAssets(caze) {
  const roots = ['00-原始素材', '01-已筛选素材', '02-生成补充'].map((name) => path.join(caze.localCaseDir, name));
  let inserted = 0;
  roots.flatMap(walkFiles).forEach((file) => {
    if (!isSupportedAssetFile(file)) return;
    try {
      insertCaseAsset(caze, file);
      inserted += 1;
    } catch {
      // Existing file path for this case; keep current review status.
    }
  });
  return inserted;
}

function syncCaseSourceMaterials(caze) {
  const sourceDir = String(caze.sourceMaterialDir || '').trim();
  if (!sourceDir) {
    const error = new Error('该案例还没有填写共享原始素材路径');
    error.status = 400;
    throw error;
  }
  const resolvedSource = path.resolve(sourceDir);
  if (!fs.existsSync(resolvedSource) || !fs.statSync(resolvedSource).isDirectory()) {
    const error = new Error('共享原始素材路径不存在或不是目录');
    error.status = 404;
    throw error;
  }
  const targetRoot = path.join(caze.localCaseDir, '00-原始素材', '共享同步');
  fs.mkdirSync(targetRoot, { recursive: true });
  let copied = 0;
  let inserted = 0;
  walkFiles(resolvedSource).forEach((file) => {
    if (!isSupportedAssetFile(file)) return;
    const rel = path.relative(resolvedSource, file);
    const target = path.join(targetRoot, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target)) {
      fs.copyFileSync(file, target);
      copied += 1;
    }
    try {
      insertCaseAsset(caze, target, { source: '共享导入', originPath: file });
      inserted += 1;
    } catch {
      // Already synced into this case.
    }
  });
  return { sourceDir: resolvedSource, targetRoot, copied, inserted };
}

function caseSourceMaterialStatus(caze, caseAssets = []) {
  const sourceDir = String(caze.sourceMaterialDir || '').trim();
  if (!sourceDir) {
    return {
      caseId: caze.id,
      sourceDir: '',
      status: '未填写',
      sourceFileCount: 0,
      syncedCount: 0,
      unsyncedCount: 0,
      sampleFiles: []
    };
  }
  const resolvedSource = path.resolve(sourceDir);
  if (!fs.existsSync(resolvedSource) || !fs.statSync(resolvedSource).isDirectory()) {
    return {
      caseId: caze.id,
      sourceDir: resolvedSource,
      status: '目录不可用',
      sourceFileCount: 0,
      syncedCount: 0,
      unsyncedCount: 0,
      sampleFiles: []
    };
  }
  const sourceFiles = walkFiles(resolvedSource).filter(isSupportedAssetFile).map((file) => path.resolve(file));
  const sourceSet = new Set(sourceFiles);
  const syncedSet = new Set(
    caseAssets
      .map((asset) => asset.originPath)
      .filter(Boolean)
      .map((file) => path.resolve(file))
      .filter((file) => sourceSet.has(file))
  );
  const unsyncedFiles = sourceFiles.filter((file) => !syncedSet.has(file));
  return {
    caseId: caze.id,
    sourceDir: resolvedSource,
    status: unsyncedFiles.length > 0 ? '待同步' : '已同步',
    sourceFileCount: sourceFiles.length,
    syncedCount: syncedSet.size,
    unsyncedCount: unsyncedFiles.length,
    sampleFiles: unsyncedFiles.slice(0, 5)
  };
}

function sharedAssetCategory(file) {
  const rel = path.relative(SHARED_MATERIAL_ROOT, file);
  const first = rel.split(path.sep)[0];
  return first && first !== rel ? first : '备用素材';
}

function scanSharedAssets() {
  let inserted = 0;
  walkFiles(SHARED_MATERIAL_ROOT).forEach((file) => {
    if (!isSupportedAssetFile(file)) return;
    const classification = classifyMaterialFile(file, 'shared');
    try {
      run(
        `INSERT INTO shared_assets (id, path, kind, category, source, usage, review_status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uid('shared_asset'),
          file,
          inferAssetKind(file),
          classification.category,
          '工作人员导入',
          classification.usage,
          '可用',
          now()
        ]
      );
      inserted += 1;
    } catch {
      // Existing shared file; keep current review status.
    }
  });
  const assets = all('SELECT * FROM shared_assets ORDER BY created_at DESC').map(rowSharedAsset);
  return { inserted, assets };
}

function sharedAssetsForDelivery(limit = 12) {
  return all('SELECT * FROM shared_assets WHERE review_status IN (?, ?) ORDER BY created_at DESC LIMIT ?', ['可用', '待处理', limit])
    .map(rowSharedAsset)
    .filter((asset) => fs.existsSync(asset.path))
    .map((asset) => ({
      id: asset.id,
      path: asset.path,
      kind: asset.kind,
      stage: asset.category,
      source: '通用素材',
      usage: asset.usage,
      originPath: '',
      reviewStatus: asset.reviewStatus,
      createdAt: asset.createdAt
    }));
}

function deliveryAssetsForSlot(slot, caze, limit = 9) {
  const caseAssets = all('SELECT * FROM assets WHERE case_id = ? AND review_status IN (?, ?) ORDER BY created_at DESC LIMIT ?', [caze.id, '可用', '待处理', limit])
    .map(rowAsset)
    .filter((asset) => fs.existsSync(asset.path));
  if (slot.contentKind === '素人种草') return caseAssets.slice(0, limit);
  return [...caseAssets, ...sharedAssetsForDelivery(limit)].slice(0, limit);
}

function imageSourceMaterialsFor(caze, slot, purpose) {
  const caseAssets = all('SELECT * FROM assets WHERE case_id = ? AND kind IN (?, ?) AND review_status IN (?, ?) ORDER BY created_at DESC LIMIT 30', [caze.id, '图片', '视频', '可用', '待处理'])
    .map(rowAsset)
    .filter((asset) => fs.existsSync(asset.path));
  const personRefs = caseAssets.filter((asset) => ['案例人物', '案例对比', '案例过程'].includes(asset.usage)).slice(0, 3);
  const fallbackCaseRefs = personRefs.length ? [] : caseAssets.slice(0, 2);
  const sharedRefs = sharedAssetsForDelivery(20)
    .filter((asset) => ['合成背景', '套图参考', '通用配图', '文字卡'].includes(asset.usage) || ['医院素材', '套图素材', '生活场景', '文字卡素材'].includes(asset.stage))
    .slice(0, 4);
  const materials = [];
  [...personRefs, ...fallbackCaseRefs].forEach((asset) => {
    materials.push({
      role: asset.usage === '案例对比' ? '案例变化参考' : '案例人物参考',
      scope: '案例素材',
      path: asset.path,
      kind: asset.kind,
      stage: asset.stage,
      usage: asset.usage
    });
  });
  sharedRefs.forEach((asset) => {
    materials.push({
      role: asset.usage === '套图参考' ? '套图结构参考' : asset.usage === '文字卡' ? '文字卡参考' : '医院/场景素材',
      scope: '通用素材',
      path: asset.path,
      kind: asset.kind,
      stage: asset.stage,
      usage: asset.usage
    });
  });
  if (!materials.length) {
    materials.push({
      role: '待补参考素材',
      scope: '提示',
      path: `暂无可用参考素材；先同步案例素材或扫描通用素材，再创建${purpose || slot?.contentKind || '图片'}任务`,
      kind: '说明',
      stage: slot?.stage || caze.stage,
      usage: '待补素材'
    });
  }
  return materials;
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function hoursSince(iso) {
  if (!iso) return Infinity;
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return Infinity;
  return Math.max(0, (Date.now() - time) / (60 * 60 * 1000));
}

function daysBetween(dateA, dateB) {
  const a = new Date(`${String(dateA).slice(0, 10)}T00:00:00`).getTime();
  const b = new Date(`${String(dateB).slice(0, 10)}T00:00:00`).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.floor((b - a) / (24 * 60 * 60 * 1000));
}

function coldVideoSnapshot(snapshot) {
  const plays = Number(snapshot?.plays || 0);
  const comments = Number(snapshot?.comments || 0);
  return plays > 0 && plays < 2000 && comments < 20;
}

function consecutiveColdVideos(snapshots = []) {
  let count = 0;
  for (const snapshot of snapshots) {
    if (!coldVideoSnapshot(snapshot)) break;
    count += 1;
  }
  return count;
}

function recentActiveSlots(slots = [], today = new Date().toISOString().slice(0, 10)) {
  return slots.filter((slot) => {
    const offset = daysBetween(today, slot.date);
    return offset >= -3
      && offset <= 3
      && ['待生成', '候选待选', '已锁定', '素材阻塞', '可交付', '已派发', '已完成'].includes(slot.status);
  });
}

function lostContactSignal(slots = [], today = new Date().toISOString().slice(0, 10)) {
  const overdueSent = slots
    .filter((slot) => slot.status === '已派发')
    .map((slot) => ({ ...slot, overdueDays: daysBetween(slot.date, today) }))
    .filter((slot) => slot.overdueDays >= 3)
    .sort((a, b) => b.overdueDays - a.overdueDays);
  if (!overdueSent.length) {
    return { active: false, overdueSentCount: 0, oldestOverdueDays: 0, reason: '' };
  }
  const oldest = overdueSent[0];
  return {
    active: true,
    overdueSentCount: overdueSent.length,
    oldestOverdueDays: oldest.overdueDays,
    reason: `已派发 ${oldest.overdueDays} 天仍未确认完成，系统已自动暂停。`
  };
}

function caseIsPaused(caze) {
  return ['失联暂停', '已放弃', '停用'].includes(caze?.healthStatus);
}

function pauseCaseWork(caze, reason = '账号已暂停，撤下未完成任务和采集单。') {
  if (!caze?.id) return { canceledSlotCount: 0, canceledSlots: [], canceledCollectionCount: 0, canceledCollectionRuns: [] };
  const slotPlaceholders = PAUSE_CANCEL_SLOT_STATUSES.map(() => '?').join(', ');
  const canceledSlots = all(
    `SELECT * FROM plan_slots WHERE case_id = ? AND status IN (${slotPlaceholders}) ORDER BY date ASC, created_at ASC`,
    [caze.id, ...PAUSE_CANCEL_SLOT_STATUSES]
  ).map(rowSlot);
  canceledSlots.forEach((slot) => {
    run('UPDATE plan_slots SET status = ?, updated_at = ? WHERE id = ?', ['已取消', now(), slot.id]);
  });

  const collectionPlaceholders = OPEN_COLLECTION_STATUSES.map(() => '?').join(', ');
  const canceledCollectionRuns = all(
    `SELECT * FROM collection_runs WHERE case_id = ? AND status IN (${collectionPlaceholders}) ORDER BY started_at ASC, created_at ASC`,
    [caze.id, ...OPEN_COLLECTION_STATUSES]
  ).map(rowCollectionRun);
  canceledCollectionRuns.forEach((item) => {
    run(
      'UPDATE collection_runs SET status = ?, finished_at = ?, note = ?, updated_at = ? WHERE id = ?',
      ['canceled', now(), reason, now(), item.id]
    );
  });

  return {
    canceledSlotCount: canceledSlots.length,
    canceledSlots: canceledSlots.map((slot) => ({ ...slot, status: '已取消' })),
    canceledCollectionCount: canceledCollectionRuns.length,
    canceledCollectionRuns: canceledCollectionRuns.map((item) => ({ ...item, status: 'canceled', note: reason }))
  };
}

function autoPauseLostContactCases(cases = all('SELECT * FROM cases ORDER BY created_at ASC').map(rowCase)) {
  const autoPaused = [];
  cases.forEach((caze) => {
    if (!caze?.id || caseIsPaused(caze)) return;
    const slots = all('SELECT * FROM plan_slots WHERE case_id = ? ORDER BY date ASC', [caze.id]).map(rowSlot);
    const lostContact = lostContactSignal(slots);
    if (!lostContact.active) return;
    run('UPDATE cases SET health_status = ?, updated_at = ? WHERE id = ?', ['失联暂停', now(), caze.id]);
    const updated = caseById(caze.id);
    const pauseMaintenance = pauseCaseWork(updated, lostContact.reason);
    writeCaseManifest(updated);
    autoPaused.push({
      caseId: caze.id,
      reason: lostContact.reason,
      pauseMaintenance
    });
  });
  return autoPaused;
}

function latestUniqueVideoSnapshotsForCase(caseId, snapshots = null) {
  const rows = snapshots || all(
    'SELECT * FROM video_snapshots WHERE case_id = ? ORDER BY collected_at DESC, created_at DESC',
    [caseId]
  ).map(rowVideoSnapshot);
  const seen = new Set();
  const unique = [];
  rows.forEach((snapshot) => {
    if (seen.has(snapshot.videoId)) return;
    seen.add(snapshot.videoId);
    unique.push(snapshot);
  });
  return unique;
}

function accountStrategy(input = {}) {
  const {
    caze,
    latestSnapshot = null,
    initialSnapshot = null,
    topVideo = null,
    recentVideoSnapshots = [],
    slots = [],
    activeViralAlerts = []
  } = input;
  const today = new Date().toISOString().slice(0, 10);
  const activeSlots = recentActiveSlots(slots, today);
  const fanDelta = latestSnapshot?.fans != null && initialSnapshot?.fans != null ? latestSnapshot.fans - initialSnapshot.fans : null;
  const topPlays = Number(topVideo?.latestSnapshot?.plays || 0);
  const topComments = Number(topVideo?.latestSnapshot?.comments || 0);
  const coldCount = consecutiveColdVideos(recentVideoSnapshots);
  const hasHotSignal = activeViralAlerts.length > 0 || topPlays >= 5000 || (fanDelta != null && fanDelta >= 50);
  const lostContact = lostContactSignal(slots, today);
  const paused = caseIsPaused(caze);

  let activityTier = '观察';
  let postingStrategy = { mode: '每日', intervalDays: 1, reason: '没有连续低播放证据，保持常规排期。' };
  if (paused || lostContact.active) {
    activityTier = '失联暂停';
    postingStrategy = {
      mode: '暂停自动补',
      intervalDays: 0,
      reason: paused ? '账号已标记失联暂停，不再自动补排期。' : lostContact.reason
    };
  } else if (!latestSnapshot) {
    activityTier = caze?.douyinUrl ? '待首采' : '未绑定抖音';
    postingStrategy = { mode: '每日', intervalDays: 1, reason: '新账号先保持基础更新，等待首次采集数据。' };
  } else if (hasHotSignal) {
    activityTier = '起量';
    postingStrategy = { mode: '每日', intervalDays: 1, reason: '账号出现爆款、粉丝增长或高播放，保持每日更新并承接。' };
  } else if (coldCount >= 3) {
    activityTier = '休眠';
    postingStrategy = { mode: '暂停自动补', intervalDays: 0, reason: `最近 ${coldCount} 条作品播放不起色，先暂停自动补新排期。` };
  } else if (coldCount >= 2) {
    activityTier = '偏冷';
    postingStrategy = { mode: '两天一条', intervalDays: 2, reason: `最近 ${coldCount} 条作品播放不起色，自动降为两天一条。` };
  } else if (activeSlots.length > 0) {
    activityTier = '活跃';
    postingStrategy = { mode: '每日', intervalDays: 1, reason: '近期仍在投放或交付，保持常规排期。' };
  }

  let collectionIntervalHours = 168;
  let collectionReason = '账号近期没有投放动作，按一周一次采集。';
  if (activityTier === '失联暂停') {
    collectionIntervalHours = null;
    collectionReason = '账号已失联暂停，不进入采集队列。';
  } else if (!caze?.douyinUrl) {
    collectionIntervalHours = null;
    collectionReason = '未填写抖音主页，不进入采集队列。';
  } else if (!latestSnapshot) {
    collectionIntervalHours = 0;
    collectionReason = '账号还没有首次数据，优先采集。';
  } else if (hasHotSignal) {
    collectionIntervalHours = 12;
    collectionReason = '账号起量或有爆款，勤采。';
  } else if (activityTier === '休眠') {
    collectionIntervalHours = 168;
    collectionReason = '账号连续多条不起色，先按一周一次采集。';
  } else if (activityTier === '偏冷') {
    collectionIntervalHours = 72;
    collectionReason = '账号偏冷，三天采一次即可。';
  } else if (activeSlots.length > 0) {
    collectionIntervalHours = 24;
    collectionReason = '近期在投放或刚交付，按日采集。';
  }

  return {
    activityTier,
    coldVideoCount: coldCount,
    topPlays,
    topComments,
    activeSlotCount: activeSlots.length,
    lostContact: {
      ...lostContact,
      active: paused || lostContact.active,
      paused
    },
    postingStrategy,
    collectionPolicy: {
      intervalHours: collectionIntervalHours,
      reason: collectionReason
    }
  };
}

function postingStrategyForCase(caze) {
  if (!caze?.id) return { mode: '每日', intervalDays: 1, reason: '默认每日排期。' };
  const snapshots = all(
    'SELECT * FROM account_snapshots WHERE case_id = ? ORDER BY collected_at DESC, created_at DESC',
    [caze.id]
  ).map(rowAccountSnapshot);
  const videos = all('SELECT * FROM douyin_videos WHERE case_id = ? ORDER BY updated_at DESC', [caze.id]).map(rowDouyinVideo);
  const videoSnapshots = all(
    'SELECT * FROM video_snapshots WHERE case_id = ? ORDER BY collected_at DESC, created_at DESC',
    [caze.id]
  ).map(rowVideoSnapshot);
  const latestSnapshots = latestSnapshotsByVideo(videoSnapshots);
  const topVideo = videos
    .map((video) => ({ ...video, latestSnapshot: latestSnapshots.get(video.id) || null }))
    .filter((video) => video.latestSnapshot)
    .sort((a, b) => (b.latestSnapshot.plays || 0) - (a.latestSnapshot.plays || 0))[0] || null;
  const slots = all('SELECT * FROM plan_slots WHERE case_id = ? ORDER BY date ASC', [caze.id]).map(rowSlot);
  const activeViralAlerts = joinedViralAlerts('va.case_id = ? AND va.status = ?', [caze.id, 'active'], 5);
  return accountStrategy({
    caze,
    latestSnapshot: snapshots[0] || null,
    initialSnapshot: snapshots[snapshots.length - 1] || null,
    topVideo,
    recentVideoSnapshots: latestUniqueVideoSnapshotsForCase(caze.id, videoSnapshots),
    slots,
    activeViralAlerts
  }).postingStrategy;
}

function shouldCreateSlotForDate(caze, date, postingStrategy = {}) {
  const interval = Number(postingStrategy.intervalDays ?? 1);
  if (interval <= 0) return false;
  if (interval <= 1) return true;
  const base = String(caze?.createdAt || date).slice(0, 10);
  return Math.abs(daysBetween(base, date)) % interval === 0;
}

function openSlotForDate(caseId, date) {
  return rowSlot(get(
    `SELECT * FROM plan_slots
    WHERE case_id = ? AND date = ? AND status NOT IN (?, ?)
    ORDER BY date ASC, created_at ASC LIMIT 1`,
    [caseId, date, '已取消', '已完成']
  ));
}

function existingStrategySlot(caze, plan, startDate) {
  return rowSlot(get(
    `SELECT * FROM plan_slots
    WHERE case_id = ? AND date >= ? AND content_kind = ? AND goal = ? AND status NOT IN (?, ?)
    ORDER BY date ASC, created_at ASC LIMIT 1`,
    [caze.id, startDate, plan.contentKind, plan.goal, '已取消', '已完成']
  ));
}

function nextOpenStrategyDate(caze, postingStrategy = {}, startDate = addDays(new Date().toISOString().slice(0, 10), 1), searchDays = 45) {
  for (let i = 0; i < searchDays; i += 1) {
    const date = addDays(startDate, i);
    if (!shouldCreateSlotForDate(caze, date, postingStrategy)) continue;
    if (openSlotForDate(caze.id, date)) continue;
    return date;
  }
  return null;
}

function prunePendingSlotsForStrategy(caze, postingStrategy = {}, startDate = new Date().toISOString().slice(0, 10)) {
  if (!caze?.id) return 0;
  const slots = all(
    'SELECT * FROM plan_slots WHERE case_id = ? AND date >= ? AND status = ? ORDER BY date ASC',
    [caze.id, startDate, '待生成']
  ).map(rowSlot);
  let pruned = 0;
  slots.forEach((slot) => {
    if (shouldCreateSlotForDate(caze, slot.date, postingStrategy)) return;
    run('DELETE FROM plan_slots WHERE id = ?', [slot.id]);
    pruned += 1;
  });
  return pruned;
}

function cancelPreparedSlotsForStrategy(caze, postingStrategy = {}, startDate = new Date().toISOString().slice(0, 10)) {
  if (!caze?.id) return 0;
  const placeholders = STRATEGY_CANCEL_SLOT_STATUSES.map(() => '?').join(', ');
  const slots = all(
    `SELECT * FROM plan_slots WHERE case_id = ? AND date >= ? AND status IN (${placeholders}) ORDER BY date ASC`,
    [caze.id, startDate, ...STRATEGY_CANCEL_SLOT_STATUSES]
  ).map(rowSlot);
  let canceled = 0;
  slots.forEach((slot) => {
    if (shouldCreateSlotForDate(caze, slot.date, postingStrategy)) return;
    run('UPDATE plan_slots SET status = ?, updated_at = ? WHERE id = ?', ['已取消', now(), slot.id]);
    canceled += 1;
  });
  return canceled;
}

function reconcilePendingScheduleForCase(caze, input = {}) {
  if (!caze?.id) return { startDate: '', days: 0, prunedCount: 0, canceledCount: 0, createdCount: 0, postingStrategy: null };
  const current = caseById(caze.id);
  const startDate = input.startDate || new Date().toISOString().slice(0, 10);
  const days = Math.max(0, Number(input.days ?? ROLLING_SCHEDULE_DAYS));
  const postingStrategy = postingStrategyForCase(current);
  const prunedCount = prunePendingSlotsForStrategy(current, postingStrategy, startDate);
  const canceledCount = cancelPreparedSlotsForStrategy(current, postingStrategy, startDate);
  const created = generateSlotsForCase(current, { days, startDate, postingStrategy });
  return {
    startDate,
    days,
    prunedCount,
    canceledCount,
    createdCount: created.length,
    postingStrategy
  };
}

function latestSnapshotForVideo(videoId) {
  return rowVideoSnapshot(get(
    'SELECT * FROM video_snapshots WHERE video_id = ? ORDER BY collected_at DESC, created_at DESC LIMIT 1',
    [videoId]
  ));
}

function previousSnapshotForVideo(videoId, excludeId) {
  return rowVideoSnapshot(get(
    'SELECT * FROM video_snapshots WHERE video_id = ? AND id != ? ORDER BY collected_at DESC, created_at DESC LIMIT 1',
    [videoId, excludeId]
  ));
}

function findDouyinVideo(caseId, payload = {}) {
  const douyinVideoId = String(payload.videoId || payload.douyinVideoId || payload.id || '').trim();
  const url = String(payload.url || payload.douyinUrl || '').trim();
  if (douyinVideoId) {
    const found = rowDouyinVideo(get('SELECT * FROM douyin_videos WHERE case_id = ? AND douyin_video_id = ?', [caseId, douyinVideoId]));
    if (found) return found;
  }
  if (url) {
    const found = rowDouyinVideo(get('SELECT * FROM douyin_videos WHERE case_id = ? AND url = ?', [caseId, url]));
    if (found) return found;
  }
  return null;
}

function upsertDouyinVideo(caseId, payload = {}) {
  const douyinVideoId = String(payload.videoId || payload.douyinVideoId || payload.id || '').trim();
  const url = String(payload.url || payload.douyinUrl || '').trim();
  if (!douyinVideoId && !url) return null;
  const title = String(payload.title || payload.caption || '').trim();
  const publishTime = String(payload.publishTime || payload.publish_time || '').trim();
  const existing = findDouyinVideo(caseId, { douyinVideoId, url });
  if (existing) {
    run(
      'UPDATE douyin_videos SET douyin_video_id = COALESCE(?, douyin_video_id), url = COALESCE(?, url), title = COALESCE(?, title), publish_time = COALESCE(?, publish_time), updated_at = ? WHERE id = ?',
      [douyinVideoId || null, url || null, title || null, publishTime || null, now(), existing.id]
    );
    return rowDouyinVideo(get('SELECT * FROM douyin_videos WHERE id = ?', [existing.id]));
  }
  const id = uid('video');
  run(
    `INSERT INTO douyin_videos
    (id, case_id, douyin_video_id, url, title, publish_time, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, caseId, douyinVideoId || null, url || null, title || null, publishTime || null, now(), now()]
  );
  return rowDouyinVideo(get('SELECT * FROM douyin_videos WHERE id = ?', [id]));
}

function insertVideoSnapshot(caseId, videoId, payload = {}, collectedAt, source) {
  const snapshot = {
    plays: numberOrNull(payload.plays ?? payload.playCount),
    likes: numberOrNull(payload.likes ?? payload.likeCount),
    comments: numberOrNull(payload.comments ?? payload.commentCount),
    shares: numberOrNull(payload.shares ?? payload.shareCount),
    favorites: numberOrNull(payload.favorites ?? payload.collectCount)
  };
  const hasAnyMetric = Object.values(snapshot).some((value) => value !== null);
  if (!hasAnyMetric) return null;
  const id = uid('vsnap');
  run(
    `INSERT INTO video_snapshots
    (id, case_id, video_id, collected_at, plays, likes, comments, shares, favorites, source, raw_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      caseId,
      videoId,
      collectedAt,
      snapshot.plays,
      snapshot.likes,
      snapshot.comments,
      snapshot.shares,
      snapshot.favorites,
      source,
      JSON.stringify(payload || {}),
      now()
    ]
  );
  return rowVideoSnapshot(get('SELECT * FROM video_snapshots WHERE id = ?', [id]));
}

function viralSignal(snapshot, previous) {
  if (!snapshot) return null;
  const plays = snapshot.plays || 0;
  const likes = snapshot.likes || 0;
  const comments = snapshot.comments || 0;
  const shares = snapshot.shares || 0;
  const playDelta = previous?.plays != null ? plays - previous.plays : plays;
  if (plays >= 10000 || likes >= 800 || comments >= 80 || shares >= 80 || playDelta >= 7000) {
    return { level: 'high', label: '强爆款信号' };
  }
  if (plays >= 5000 || likes >= 300 || comments >= 30 || shares >= 30 || playDelta >= 3000) {
    return { level: 'medium', label: '爆款苗头' };
  }
  return null;
}

function upsertViralAlert(caze, video, snapshot, previous) {
  const signal = viralSignal(snapshot, previous);
  if (!signal || !caze || !video) return null;
  const reason = [
    `${signal.label}：播放 ${snapshot.plays ?? 0}`,
    `点赞 ${snapshot.likes ?? 0}`,
    `评论 ${snapshot.comments ?? 0}`,
    previous?.plays != null ? `较上次播放 ${signedNumber((snapshot.plays || 0) - (previous.plays || 0))}` : '首次采集即达标'
  ].join('｜');
  const interactionNote = '安排助理号/阑尾号去评论区互动：顶高质量评论，回复咨询问题，追问用户痛点，把流量承接到咨询。';
  const existing = rowViralAlert(get('SELECT * FROM viral_alerts WHERE video_id = ? AND status = ?', [video.id, 'active']));
  if (existing) {
    run(
      'UPDATE viral_alerts SET snapshot_id = ?, level = ?, reason = ?, interaction_note = ?, updated_at = ? WHERE id = ?',
      [snapshot.id, signal.level, reason, interactionNote, now(), existing.id]
    );
    return rowViralAlert(get('SELECT * FROM viral_alerts WHERE id = ?', [existing.id]));
  }
  const id = uid('alert');
  run(
    `INSERT INTO viral_alerts
    (id, case_id, video_id, snapshot_id, level, reason, status, interaction_note, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    [id, caze.id, video.id, snapshot.id, signal.level, reason, interactionNote, now(), now()]
  );
  return rowViralAlert(get('SELECT * FROM viral_alerts WHERE id = ?', [id]));
}

function joinedViralAlerts(where = 'va.status = ?', params = ['active'], limit = 50) {
  return all(
    `SELECT
      va.id, va.case_id, va.video_id, va.snapshot_id, va.level, va.reason, va.status, va.interaction_note, va.created_at, va.updated_at,
      c.case_code, c.weixin_nick, c.douyin_id, c.douyin_url, c.project, c.stage,
      dv.douyin_video_id, dv.url AS video_url, dv.title AS video_title, dv.publish_time AS video_publish_time,
      vs.collected_at AS snapshot_collected_at, vs.plays AS snapshot_plays, vs.likes AS snapshot_likes,
      vs.comments AS snapshot_comments, vs.shares AS snapshot_shares, vs.favorites AS snapshot_favorites
    FROM viral_alerts va
    JOIN cases c ON c.id = va.case_id
    JOIN douyin_videos dv ON dv.id = va.video_id
    LEFT JOIN video_snapshots vs ON vs.id = va.snapshot_id
    WHERE ${where}
    ORDER BY CASE va.level WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, va.updated_at DESC
    LIMIT ?`,
    [...params, limit]
  ).map(rowViralAlert);
}

function latestSnapshotsByVideo(videoSnapshots) {
  const map = new Map();
  videoSnapshots.forEach((snapshot) => {
    const previous = map.get(snapshot.videoId);
    if (!previous || snapshot.collectedAt > previous.collectedAt) map.set(snapshot.videoId, snapshot);
  });
  return map;
}

function monitorData(cases = all('SELECT * FROM cases ORDER BY created_at DESC').map(rowCase)) {
  const autoPausedLostContact = autoPauseLostContactCases(cases);
  if (autoPausedLostContact.length) {
    const pausedIds = new Set(autoPausedLostContact.map((item) => item.caseId));
    cases = cases.map((caze) => (pausedIds.has(caze.id) ? caseById(caze.id) : caze)).filter(Boolean);
  }
  const byCase = Object.fromEntries(cases.map((item) => [item.id, item]));
  const accountSnapshots = all('SELECT * FROM account_snapshots ORDER BY collected_at DESC, created_at DESC').map(rowAccountSnapshot);
  const videos = all('SELECT * FROM douyin_videos ORDER BY updated_at DESC').map(rowDouyinVideo);
  const videoSnapshots = all('SELECT * FROM video_snapshots ORDER BY collected_at DESC, created_at DESC').map(rowVideoSnapshot);
  const slots = all('SELECT * FROM plan_slots ORDER BY date ASC, created_at ASC').map(rowSlot);
  const collectionRuns = all('SELECT * FROM collection_runs ORDER BY started_at DESC, created_at DESC').map(rowCollectionRun);
  const viralAlerts = joinedViralAlerts('va.status = ?', ['active'], 30)
    .filter((alert) => !caseIsPaused(byCase[alert.caseId]));
  const latestVideoSnapshots = latestSnapshotsByVideo(videoSnapshots);
  const accountByCase = {};
  const videosByCase = {};
  const snapshotsByCase = {};
  const slotsByCase = {};
  const runsByCase = {};
  const alertsByCase = {};

  accountSnapshots.forEach((item) => {
    accountByCase[item.caseId] = accountByCase[item.caseId] || [];
    accountByCase[item.caseId].push(item);
  });
  videos.forEach((item) => {
    videosByCase[item.caseId] = videosByCase[item.caseId] || [];
    videosByCase[item.caseId].push(item);
  });
  videoSnapshots.forEach((item) => {
    snapshotsByCase[item.caseId] = snapshotsByCase[item.caseId] || [];
    snapshotsByCase[item.caseId].push(item);
  });
  slots.forEach((item) => {
    slotsByCase[item.caseId] = slotsByCase[item.caseId] || [];
    slotsByCase[item.caseId].push(item);
  });
  collectionRuns.forEach((item) => {
    if (!item.caseId) return;
    runsByCase[item.caseId] = runsByCase[item.caseId] || [];
    runsByCase[item.caseId].push(item);
  });
  viralAlerts.forEach((item) => {
    alertsByCase[item.caseId] = alertsByCase[item.caseId] || [];
    alertsByCase[item.caseId].push(item);
  });

  const videoLeaders = videos
    .map((video) => ({
      ...video,
      case: byCase[video.caseId] || null,
      latestSnapshot: latestVideoSnapshots.get(video.id) || null
    }))
    .filter((item) => item.latestSnapshot)
    .sort((a, b) => (b.latestSnapshot.plays || 0) - (a.latestSnapshot.plays || 0))
    .slice(0, 20);

  const accounts = cases.map((caze) => {
    const snapshots = accountByCase[caze.id] || [];
    const caseVideos = videosByCase[caze.id] || [];
    const caseRuns = runsByCase[caze.id] || [];
    const latestSnapshot = snapshots[0] || null;
    const initialSnapshot = snapshots[snapshots.length - 1] || null;
    const pendingCollectionRun = caseRuns.find(collectionRunIsOpen) || null;
    const topVideo = caseVideos
      .map((video) => ({ ...video, latestSnapshot: latestVideoSnapshots.get(video.id) || null }))
      .filter((video) => video.latestSnapshot)
      .sort((a, b) => (b.latestSnapshot.plays || 0) - (a.latestSnapshot.plays || 0))[0] || null;
    const strategy = accountStrategy({
      caze,
      latestSnapshot,
      initialSnapshot,
      topVideo,
      recentVideoSnapshots: latestUniqueVideoSnapshotsForCase(caze.id, snapshotsByCase[caze.id] || []),
      slots: slotsByCase[caze.id] || [],
      activeViralAlerts: alertsByCase[caze.id] || []
    });
    const collectionIntervalHours = strategy.collectionPolicy.intervalHours;
    const needsCollection = Boolean(caze.douyinUrl) && (
      collectionIntervalHours === 0
        || (collectionIntervalHours != null && (!latestSnapshot || hoursSince(latestSnapshot.collectedAt) >= collectionIntervalHours))
    );
    return {
      case: caze,
      initialSnapshot,
      latestSnapshot,
      fanDelta: latestSnapshot?.fans != null && initialSnapshot?.fans != null ? latestSnapshot.fans - initialSnapshot.fans : null,
      lastCollectedAt: latestSnapshot?.collectedAt || null,
      needsCollection,
      dueCollection: needsCollection && !pendingCollectionRun,
      collectionQueued: Boolean(pendingCollectionRun),
      pendingCollectionRun,
      videos: caseVideos.length,
      snapshots: (snapshotsByCase[caze.id] || []).length,
      topVideo,
      lastRun: caseRuns[0] || null,
      activeViralAlerts: alertsByCase[caze.id] || [],
      activityTier: strategy.activityTier,
      coldVideoCount: strategy.coldVideoCount,
      lostContact: strategy.lostContact,
      postingStrategy: strategy.postingStrategy,
      collectionPolicy: strategy.collectionPolicy,
      collectionIntervalHours
    };
  });

  return {
    totals: {
      monitoredAccounts: cases.filter((item) => item.douyinUrl).length,
      accountSnapshots: accountSnapshots.length,
      videos: videos.length,
      videoSnapshots: videoSnapshots.length,
      viralAlerts: viralAlerts.length,
      dueCollection: accounts.filter((item) => item.dueCollection).length,
      collectionQueued: accounts.filter((item) => item.collectionQueued).length,
      waitingChrome: collectionRuns.filter((item) => item.status === 'waiting_chrome').length,
      autoPausedLostContact: autoPausedLostContact.length
    },
    autoPausedLostContact,
    accounts,
    viralAlerts,
    videoLeaders,
    recentAccountSnapshots: accountSnapshots.slice(0, 20).map((item) => ({ ...item, case: byCase[item.caseId] || null })),
    recentVideoSnapshots: videoSnapshots.slice(0, 20).map((item) => {
      const video = videos.find((row) => row.id === item.videoId) || null;
      return { ...item, case: byCase[item.caseId] || null, video };
    }),
    recentRuns: collectionRuns.slice(0, 20).map((item) => ({ ...item, case: item.caseId ? byCase[item.caseId] || null : null }))
  };
}

function signedNumber(value) {
  if (value == null) return '—';
  return value >= 0 ? `+${value}` : String(value);
}

function monitorForCase(monitor, caseId) {
  return monitor.accounts.find((item) => item.case.id === caseId) || {};
}

function monitorActionQueue(monitor = {}) {
  const actions = [];
  (monitor.viralAlerts || []).forEach((alert) => {
    actions.push({
      id: `viral-${alert.id}`,
      priority: alert.level === 'high' ? 100 : 90,
      kind: '爆款互动',
      title: '安排助理号/阑尾号互动',
      reason: alert.reason,
      action: alert.interactionNote || '顶高质量评论，回复咨询问题，把流量承接到咨询。',
      case: alert.case,
      video: alert.video,
      snapshot: alert.snapshot,
      alertId: alert.id
    });
  });
  (monitor.accounts || []).forEach((item) => {
    const caze = item.case;
    if (!caze?.id) return;
    if (item.activityTier === '失联暂停') return;
    if (item.dueCollection) {
      const interval = item.collectionPolicy?.intervalHours;
      const intervalText = interval == null ? '不采集' : interval === 0 ? '优先采集' : `${interval}小时采集周期到期`;
      actions.push({
        id: `collect-${caze.id}`,
        priority: item.latestSnapshot ? 80 : 85,
        kind: '账号采集',
        title: item.latestSnapshot ? intervalText : '首次采集账号数据',
        reason: item.latestSnapshot
          ? `${item.collectionPolicy?.reason || '采集周期到期'}｜上次采集：${item.lastCollectedAt}`
          : '这个账号还没有粉丝和作品数据',
        action: '系统会登记采集清单；主机端用已登录抖音的 Chrome 采集主页和作品数据后写入后台。',
        case: caze,
        latestSnapshot: item.latestSnapshot,
        topVideo: item.topVideo,
        activityTier: item.activityTier,
        postingStrategy: item.postingStrategy,
        collectionPolicy: item.collectionPolicy
      });
    }
    if (!item.activeViralAlerts?.length && item.postingStrategy?.intervalDays > 0 && item.topVideo?.latestSnapshot) {
      const plays = item.topVideo.latestSnapshot.plays || 0;
      const comments = item.topVideo.latestSnapshot.comments || 0;
      if (plays > 0 && plays < 2000 && comments < 20) {
        actions.push({
          id: `cold-${caze.id}`,
          priority: 45,
          kind: '偏冷补内容',
          title: '播放偏低，下一轮补爆款提权',
          reason: `最高播放 ${plays}，评论 ${comments}`,
          action: '下一条优先安排爆款提权或互动版内容，暂缓连续种草。',
          case: caze,
          latestSnapshot: item.latestSnapshot,
          topVideo: item.topVideo
        });
      }
    }
    if (!item.activeViralAlerts?.length && item.postingStrategy?.intervalDays > 0 && item.fanDelta != null && item.fanDelta >= 50) {
      actions.push({
        id: `growth-${caze.id}`,
        priority: 55,
        kind: '增长承接',
        title: '粉丝增长明显，安排承接互动',
        reason: `粉丝较初始 ${signedNumber(item.fanDelta)}`,
        action: '检查评论区咨询问题，安排助理号承接，并补一条答疑或复盘内容。',
        case: caze,
        latestSnapshot: item.latestSnapshot,
        topVideo: item.topVideo
      });
    }
  });
  return actions
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 40);
}

function createMonitorActionSlot(input = {}) {
  const caze = caseById(input.caseId);
  if (!caze) {
    const error = new Error('case not found');
    error.status = 404;
    throw error;
  }
  const kind = input.kind;
  const plans = {
    偏冷补内容: {
      contentKind: '爆款提权',
      title: '播放偏低，补一条爆款提权/互动版内容',
      goal: '账号策略动作：播放偏低，下一条补爆款提权或互动版内容，先把账号热度拉起来。'
    },
    增长承接: {
      contentKind: '素人种草',
      title: '粉丝增长明显，补一条答疑/复盘承接内容',
      goal: '账号策略动作：粉丝增长明显，下一条补答疑或复盘内容，承接评论区咨询问题。'
    }
  };
  const plan = plans[kind];
  if (!plan) {
    const error = new Error('unsupported monitor action kind');
    error.status = 400;
    throw error;
  }
  const today = new Date().toISOString().slice(0, 10);
  const postingStrategy = postingStrategyForCase(caze);
  if (caseIsPaused(caze) || Number(postingStrategy.intervalDays ?? 1) <= 0) {
    return {
      created: false,
      skipped: true,
      kind,
      title: plan.title,
      slot: null,
      reason: postingStrategy.reason || '账号已暂停或休眠，先不生成新的排期。'
    };
  }
  const existingStrategy = existingStrategySlot(caze, plan, today);
  if (existingStrategy) {
    return { created: false, kind, title: plan.title, slot: existingStrategy, reason: '已有同类账号策略排期，不重复生成。' };
  }
  const requestedDate = input.date || '';
  let date = requestedDate || nextOpenStrategyDate(caze, postingStrategy);
  if (!date) {
    return {
      created: false,
      skipped: true,
      kind,
      title: plan.title,
      slot: null,
      reason: '未来 45 天没有符合账号投放频率的空档，先不额外加任务。'
    };
  }
  if (!shouldCreateSlotForDate(caze, date, postingStrategy)) {
    return {
      created: false,
      skipped: true,
      kind,
      title: plan.title,
      slot: null,
      reason: postingStrategy.reason || '当前日期不在这个账号的投放频率内。'
    };
  }
  const existingOpenSlot = openSlotForDate(caze.id, date);
  if (existingOpenSlot) {
    return { created: false, skipped: true, kind, title: plan.title, slot: existingOpenSlot, reason: '当天已有排期，先不额外加任务。' };
  }
  const stage = STAGES.includes(input.stage) ? input.stage : caze.stage;
  const slot = createSlotForCase(caze, {
    date,
    timeWindow: input.timeWindow || '19:00-21:00',
    contentKind: plan.contentKind,
    goal: plan.goal,
    stage,
    status: '待生成'
  });
  return { created: true, kind, title: plan.title, slot, postingStrategy };
}

function truthy(value) {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value || '').trim().toLowerCase());
}

function chromeCollectionPayloadTemplate(caze) {
  return {
    caseId: caze.id,
    source: 'chrome-agent',
    collectedAt: '采集时填写 ISO 时间',
    account: {
      fans: null,
      following: null,
      totalLikes: null,
      totalWorks: null
    },
    videos: [
      {
        url: '作品链接',
        title: '作品标题/首句',
        publishTime: '发布时间',
        plays: null,
        likes: null,
        comments: null,
        shares: null,
        favorites: null
      }
    ],
    note: 'Chrome 登录态采集'
  };
}

function buildChromeCollectionText(queue) {
  const endpoint = `${networkSettings().localUrl}/api/douyin-monitor/ingest`;
  const lines = [
    `Chrome抖音采集清单｜${queue.generatedAt}`,
    `后台写入接口：POST ${endpoint}`,
    '',
    '采集方式：用已登录抖音的 Chrome 打开账号主页，读取账号粉丝/关注/获赞/作品数，并记录最近作品的播放、点赞、评论、转发、收藏。',
    '写入要求：主机端采集程序按 JSON 模板写入后台；工作人员不需要在网页里逐条填写。系统会自动记录初始粉丝、最新粉丝、作品数据和爆款提醒。',
    ''
  ];
  if (!queue.targets.length) {
    lines.push('当前没有到期账号。需要全量采集时，请用 includeFresh=1 生成清单。');
    return lines.join('\n');
  }
  queue.targets.forEach((target, index) => {
    lines.push(`${index + 1}. ${target.weixinNick}｜${target.caseCode}｜${target.project}`);
    lines.push(`抖音主页：${target.douyinUrl}`);
    lines.push(`上次采集：${target.lastCollectedAt || '未采集'}｜最新粉丝：${target.latestSnapshot?.fans ?? '未采集'}｜最高播放：${target.topVideo?.latestSnapshot?.plays ?? '未采集'}`);
    lines.push(`活跃度：${target.activityTier || '未判断'}｜采集优先级：${target.collectionPriority || 0}｜排期：${target.postingStrategy?.mode || '默认'}｜采集：${target.collectionPolicy?.intervalHours == null ? '不采集' : `${target.collectionPolicy.intervalHours}小时`}｜${target.collectionPolicy?.reason || ''}`);
    lines.push('写入JSON模板：');
    lines.push(JSON.stringify(target.ingestPayloadTemplate, null, 2));
    lines.push('');
  });
  return lines.join('\n');
}

function collectionPriorityFor(item = {}) {
  if (!item.case?.douyinUrl || item.collectionPolicy?.intervalHours == null) return 0;
  if (!item.latestSnapshot) return 100;
  if (item.activeViralAlerts?.length) return 98;
  if (item.activityTier === '起量') return 95;
  if (item.activityTier === '活跃') return 80;
  if (item.activityTier === '偏冷') return 45;
  if (item.activityTier === '观察') return 35;
  if (item.activityTier === '休眠') return 10;
  return 25;
}

function chromeCollectionQueue(options = {}) {
  const includeFresh = Boolean(options.includeFresh);
  const limit = Math.max(1, Math.min(Number(options.limit) || 50, 200));
  const caseIds = new Set((options.caseIds || []).filter(Boolean));
  const monitor = monitorData();
  const targets = monitor.accounts
    .filter((item) => item.case?.douyinUrl)
    .filter((item) => !caseIds.size || caseIds.has(item.case?.id))
    .filter((item) => item.collectionPolicy?.intervalHours != null)
    .filter((item) => includeFresh || item.dueCollection || item.collectionQueued)
    .sort((a, b) => {
      if (a.dueCollection !== b.dueCollection) return a.dueCollection ? -1 : 1;
      const byPriority = collectionPriorityFor(b) - collectionPriorityFor(a);
      if (byPriority) return byPriority;
      return String(a.lastCollectedAt || '').localeCompare(String(b.lastCollectedAt || ''));
    })
    .slice(0, limit)
    .map((item) => {
      const caze = item.case;
      return {
        caseId: caze.id,
        caseCode: caze.caseCode,
        weixinNick: caze.weixinNick,
        douyinId: caze.douyinId,
        douyinUrl: caze.douyinUrl,
        project: caze.project,
        dueCollection: item.dueCollection,
        lastCollectedAt: item.lastCollectedAt,
        initialSnapshot: item.initialSnapshot,
        latestSnapshot: item.latestSnapshot,
        fanDelta: item.fanDelta,
        topVideo: item.topVideo,
        activityTier: item.activityTier,
        collectionPriority: collectionPriorityFor(item),
        postingStrategy: item.postingStrategy,
        collectionPolicy: item.collectionPolicy,
        collectionQueued: item.collectionQueued,
        pendingCollectionRun: item.pendingCollectionRun,
        ingestEndpoint: '/api/douyin-monitor/ingest',
        ingestPayloadTemplate: chromeCollectionPayloadTemplate(caze)
      };
    });
  const queue = {
    generatedAt: now(),
    includeFresh,
    limit,
    count: targets.length,
    totals: monitor.totals,
    targets
  };
  return { ...queue, text: buildChromeCollectionText(queue) };
}

function registerChromeCollectionQueue(options = {}) {
  const queue = chromeCollectionQueue(options);
  const source = String(options.source || 'chrome-agent').trim() || 'chrome-agent';
  const toRegister = queue.targets.filter((target) => !target.collectionQueued);
  const registeredRuns = [];
  toRegister.forEach((target) => {
    const id = uid('collect');
    run(
      `INSERT INTO collection_runs
      (id, case_id, started_at, finished_at, status, source, note, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        target.caseId,
        queue.generatedAt,
        null,
        'waiting_chrome',
        source,
        '已生成 Chrome 采集清单，等待主机端用已登录抖音的 Chrome 打开主页并写入账号/作品数据',
        now(),
        now()
      ]
    );
    registeredRuns.push(rowCollectionRun(get('SELECT * FROM collection_runs WHERE id = ?', [id])));
  });
  return {
    ...queue,
    registeredCount: toRegister.length,
    createdCount: toRegister.length,
    runs: registeredRuns,
    skippedQueuedCount: queue.targets.length - toRegister.length,
    monitor: monitorData()
  };
}

function registerCaseCollectionQueue(caseIds = [], source = 'case-intake') {
  const ids = Array.from(new Set(caseIds.filter(Boolean)));
  if (!ids.length) return null;
  return registerChromeCollectionQueue({
    includeFresh: true,
    limit: ids.length,
    caseIds: ids,
    source
  });
}

function douyinCollectorStatus() {
  return {
    autoRun: DOUYIN_COLLECTOR_AUTO_RUN,
    supported: os.platform() === 'darwin',
    running: Boolean(douyinCollectorRun),
    limit: DOUYIN_COLLECTOR_LIMIT,
    waitMs: DOUYIN_COLLECTOR_WAIT_MS,
    cooldownMs: DOUYIN_COLLECTOR_COOLDOWN_MS,
    lastStartedAt: douyinCollectorLastStartedAt,
    lastFinishedAt: douyinCollectorLastFinishedAt,
    lastSource: douyinCollectorLastSource,
    lastResult: douyinCollectorLastResult,
    lastError: douyinCollectorLastError
  };
}

function requestDouyinCollectorRun(source = 'scheduled', queue = null) {
  const status = douyinCollectorStatus();
  const targets = queue?.targets || [];
  if (!status.autoRun) return { ...status, started: false, reason: '主机自动采集未开启。' };
  if (!status.supported) return { ...status, started: false, reason: '当前系统不是 macOS，不能自动控制主机浏览器。' };
  if (douyinCollectorRun) return { ...status, started: false, reason: '已有一轮浏览器采集正在执行。' };
  if (queue && !targets.length) return { ...status, started: false, reason: '当前没有等待浏览器采集的账号。' };
  if (douyinCollectorLastStartedAt && DOUYIN_COLLECTOR_COOLDOWN_MS > 0) {
    const elapsed = Date.now() - Date.parse(douyinCollectorLastStartedAt);
    if (elapsed >= 0 && elapsed < DOUYIN_COLLECTOR_COOLDOWN_MS) {
      return { ...status, started: false, reason: '距离上一轮自动采集太近，先合并到下一轮。' };
    }
  }
  douyinCollectorLastStartedAt = now();
  douyinCollectorLastFinishedAt = null;
  douyinCollectorLastSource = source;
  douyinCollectorLastResult = null;
  douyinCollectorLastError = null;
  douyinCollectorRun = (async () => {
    try {
      const { runCollector } = await import('../scripts/douyin-chrome-collector.js');
      const result = await runCollector({
        base: `${networkSettings().localUrl}/api`,
        limit: DOUYIN_COLLECTOR_LIMIT,
        waitMs: DOUYIN_COLLECTOR_WAIT_MS,
        register: false,
        includeFresh: false,
        dryRun: false,
        print: false
      });
      douyinCollectorLastResult = {
        count: result.count || 0,
        ingested: (result.results || []).filter((item) => item.status === 'ingested').length,
        skipped: (result.results || []).filter((item) => item.status === 'skipped').length,
        errors: (result.results || []).filter((item) => item.status === 'error').length
      };
      console.log(`Douyin Chrome collector finished: ${JSON.stringify(douyinCollectorLastResult)}`);
    } catch (error) {
      douyinCollectorLastError = error.message;
      console.error(`Douyin Chrome collector failed: ${error.message}`);
    } finally {
      douyinCollectorLastFinishedAt = now();
      douyinCollectorRun = null;
    }
  })();
  return { ...douyinCollectorStatus(), started: true, reason: `已启动主机浏览器自动采集：${source}` };
}

function agentWorkQueue() {
  const cases = all('SELECT * FROM cases ORDER BY created_at DESC').map(rowCase);
  const byCase = Object.fromEntries(cases.map((item) => [item.id, item]));
  const pendingViral = all('SELECT * FROM viral_templates ORDER BY created_at DESC')
    .map(rowViral)
    .filter(isPendingViralTemplate);
  const chromeQueue = chromeCollectionQueue({ limit: 20 });
  const imageTasks = all('SELECT * FROM image_tasks ORDER BY created_at DESC')
    .map(rowImageTask)
    .filter((task) => ['waiting_key', 'draft', 'timeout'].includes(task.status));
  const image = imageSettings();
  const viralItems = pendingViral.map((viral) => ({
    id: `viral-${viral.id}`,
    kind: '爆款分析',
    status: '待分析',
    priority: 100,
    title: viral.sourceLink ? '待分析爆款链接' : viral.title,
    action: '主机侧用浏览器/轻抖提取标题、正文、评论区和结构后写回分析结果。',
    endpoint: `/api/viral-templates/${viral.id}/analysis-result`,
    sourceLink: viral.sourceLink,
    viralTemplateId: viral.id,
    updatedAt: viral.updatedAt
  }));
  const collectionItems = chromeQueue.targets.map((target) => ({
    id: `collect-${target.caseId}`,
    kind: '抖音采集',
    status: target.collectionQueued ? '已排队' : '到期',
    priority: 70 + (target.collectionPriority || 0),
    title: `${target.weixinNick} 账号数据采集`,
    action: '主机后台会用已登录抖音的浏览器打开主页和作品，再把账号快照与作品数据写入后台。',
    endpoint: '/api/douyin-monitor/ingest',
    case: byCase[target.caseId] || null,
    douyinUrl: target.douyinUrl,
    lastCollectedAt: target.lastCollectedAt,
    activityTier: target.activityTier,
    collectionPolicy: target.collectionPolicy,
    ingestPayloadTemplate: target.ingestPayloadTemplate,
    updatedAt: target.pendingCollectionRun?.updatedAt || target.lastCollectedAt || chromeQueue.generatedAt
  }));
  const imageItems = imageTasks.map((task) => ({
    id: `image-${task.id}`,
    kind: '图片生成',
    status: task.status,
    priority: task.status === 'draft' && image.ready ? 85 : 35,
    title: `${task.purpose} 图片任务`,
    action: image.ready
      ? '图片接口已接入时，主机侧可调用生成接口生成图片并检查。'
      : '图片接口未接入时，系统只保留提示词和参考素材；接入 Image2 后再生成。',
    endpoint: `/api/image-tasks/${task.id}/generate`,
    case: byCase[task.caseId] || null,
    imageTaskId: task.id,
    purpose: task.purpose,
    outputDir: task.outputDir,
    updatedAt: task.updatedAt
  }));
  const items = [...viralItems, ...collectionItems, ...imageItems]
    .sort((a, b) => {
      const byPriority = (b.priority || 0) - (a.priority || 0);
      if (byPriority) return byPriority;
      return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    })
    .slice(0, 80);
  return {
    generatedAt: now(),
    counts: {
      total: items.length,
      viralAnalysis: viralItems.length,
      douyinCollection: collectionItems.length,
      imageWork: imageItems.length,
      imageWaitingKey: imageItems.filter((item) => item.status === 'waiting_key').length,
      imageReadyToGenerate: imageItems.filter((item) => item.status === 'draft' && image.ready).length
    },
    image: { ready: image.ready, missing: image.missing || '' },
    items
  };
}

async function enqueueDouyinCollection(source = 'manual') {
  const queue = registerChromeCollectionQueue({ limit: 200, source });
  return {
    ...queue,
    collector: requestDouyinCollectorRun(source, queue)
  };
}

function caseFromMonitorPayload(body = {}) {
  if (body.caseId) return caseById(body.caseId);
  const douyinUrl = String(body.douyinUrl || body.account?.douyinUrl || '').trim();
  const douyinId = String(body.douyinId || body.account?.douyinId || '').trim();
  if (douyinUrl) {
    const found = rowCase(get('SELECT * FROM cases WHERE douyin_url = ?', [douyinUrl]));
    if (found) return found;
  }
  if (douyinId) return rowCase(get('SELECT * FROM cases WHERE douyin_id = ?', [douyinId]));
  return null;
}

function ingestDouyinData(body = {}) {
  const caze = caseFromMonitorPayload(body);
  if (!caze) {
    const err = new Error('未找到匹配账号，请传 caseId、douyinUrl 或 douyinId');
    err.status = 404;
    throw err;
  }
  const collectedAt = String(body.collectedAt || body.collected_at || now());
  const source = String(body.source || 'chrome-agent');
  const account = body.account || {};
  const videos = Array.isArray(body.videos) ? body.videos : [];
  const accountHasData = ['fans', 'following', 'totalLikes', 'total_likes', 'totalWorks', 'total_works'].some((key) => account[key] !== undefined && account[key] !== '');
  let accountSnapshot = null;
  const videoRows = [];
  const videoSnapshots = [];
  const viralAlerts = [];

  run('BEGIN IMMEDIATE');
  try {
    if (accountHasData) {
      const id = uid('asnap');
      run(
        `INSERT INTO account_snapshots
        (id, case_id, collected_at, fans, following, total_likes, total_works, source, status, note, raw_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          caze.id,
          collectedAt,
          numberOrNull(account.fans),
          numberOrNull(account.following),
          numberOrNull(account.totalLikes ?? account.total_likes),
          numberOrNull(account.totalWorks ?? account.total_works),
          source,
          'collected',
          body.note || '',
          JSON.stringify(account),
          now()
        ]
      );
      accountSnapshot = rowAccountSnapshot(get('SELECT * FROM account_snapshots WHERE id = ?', [id]));
    }

    videos.forEach((item) => {
      const video = upsertDouyinVideo(caze.id, item);
      if (!video) return;
      const snapshot = insertVideoSnapshot(caze.id, video.id, item, collectedAt, source);
      const previous = snapshot ? previousSnapshotForVideo(video.id, snapshot.id) : null;
      const alert = snapshot ? upsertViralAlert(caze, video, snapshot, previous) : null;
      videoRows.push(video);
      if (snapshot) videoSnapshots.push(snapshot);
      if (alert) viralAlerts.push(alert);
    });

    run(
      `UPDATE collection_runs
      SET status = ?, finished_at = ?, note = ?, updated_at = ?
      WHERE case_id = ? AND status IN (${OPEN_COLLECTION_STATUSES.map(() => '?').join(', ')})`,
      ['completed', now(), body.note || '账号和作品数据已写入系统', now(), caze.id, ...OPEN_COLLECTION_STATUSES]
    );
    run(
      `INSERT INTO collection_runs
      (id, case_id, started_at, finished_at, status, source, note, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uid('collect'), caze.id, collectedAt, now(), 'completed', source, body.note || '账号和作品数据已写入系统', now(), now()]
    );
    run('COMMIT');
  } catch (error) {
    try {
      run('ROLLBACK');
    } catch {
      // Ignore rollback failures and report the ingest error.
    }
    throw error;
  }

  const scheduleMaintenance = reconcilePendingScheduleForCase(caze);

  return {
    case: caseById(caze.id),
    accountSnapshot,
    videos: videoRows,
    videoSnapshots,
    viralAlerts: viralAlerts.map((item) => joinedViralAlerts('va.id = ?', [item.id], 1)[0] || item),
    scheduleMaintenance,
    monitor: monitorData()
  };
}

function caseHealth(caze, caseSlots, caseAssets, metrics, today, monitor = {}) {
  const reasons = [];
  const actions = [];
  const futureSlots = caseSlots.filter((s) => s.date >= today).length;
  const recentGrass = caseSlots.filter((s) => s.contentKind === '素人种草' && s.date >= addDays(today, -7)).length;
  const recentViral = caseSlots.filter((s) => s.contentKind === '爆款提权' && s.date >= addDays(today, -7)).length;
  const gaps = materialGaps(caze.project, caseAssets);
  const requiredMissing = gaps.filter((gap) => gap.required && gap.count === 0).length;
  const sourceStatus = caseSourceMaterialStatus(caze, caseAssets);
  const latest = metrics[0];
  const prev = metrics[1];

  if (!String(caze.weixinNick || '').trim()) {
    reasons.push('缺少兼职微信昵称');
    actions.push('编辑案例，补齐兼职微信昵称');
  }
  if (!String(caze.douyinUrl || '').trim()) {
    reasons.push('缺少抖音链接');
    actions.push('编辑案例，补齐抖音主页或作品链接');
  }
  if (!String(caze.project || '').trim()) {
    reasons.push('缺少项目');
    actions.push('编辑案例，补齐项目');
  }
  if (!String(caze.sourceMaterialDir || '').trim()) {
    reasons.push('缺少共享原始素材路径');
    actions.push('编辑案例，填写共享盘/服务器里的原始素材目录');
  }
  if (monitor.activeViralAlerts?.length) {
    reasons.push('出现爆款作品');
    actions.push('安排助理号/阑尾号互动，优先顶评论、回复咨询问题并承接转化');
  }
  if (monitor.activityTier === '失联暂停') {
    reasons.push('失联暂停');
    actions.push('系统已暂停自动排期和采集；兼职恢复配合后在案例详情点恢复账号');
  }
  if (futureSlots === 0) {
    reasons.push('缺少排期');
    actions.push('补未来 7-30 天排期，起号期优先日常养号和爆款提权');
  }
  if (caseAssets.length === 0) {
    reasons.push('素材未扫描');
    actions.push(caze.sourceMaterialDir ? '先同步共享素材，再扫描并标记可用素材' : '填写共享原始素材路径，或把原始素材放入 00-原始素材 后扫描素材');
  }
  if (sourceStatus.status === '待同步') {
    reasons.push(`共享素材待同步 ${sourceStatus.unsyncedCount} 个`);
    actions.push('首页处理“待同步共享素材”，同步后检查素材分类并标记可用');
  }
  if (sourceStatus.status === '目录不可用') {
    reasons.push('共享原始素材目录不可用');
    actions.push('检查共享盘/服务器挂载路径，或编辑案例更新共享原始素材路径');
  }
  if (requiredMissing > 0) {
    reasons.push(`必补素材 ${requiredMissing} 项`);
    actions.push('优先处理必补素材缺口，缺口旁可创建图片/剪辑任务');
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
    actions.push('按人工标记状态优先处理，必要时由系统生成临时槽位');
  }

  const status = reasons.length === 0 ? '健康' : reasons.includes('播放下滑') ? '偏冷' : reasons[0];
  return { status, reasons, actions: Array.from(new Set(actions)), gaps };
}

function caseIntakeIssue(caze = {}) {
  const issues = [];
  if (!String(caze.weixinNick || '').trim()) issues.push('缺少兼职微信昵称');
  if (!String(caze.douyinUrl || '').trim()) issues.push('缺少抖音链接');
  if (!String(caze.project || '').trim()) issues.push('缺少项目');
  if (!String(caze.sourceMaterialDir || '').trim()) issues.push('缺少共享原始素材路径');
  if (!issues.length) return null;
  return {
    id: `intake-${caze.id}`,
    caseId: caze.id,
    status: '待补资料',
    issues,
    title: `${caze.weixinNick || '未命名账号'} 登记资料缺失`,
    detail: issues.join(' / '),
    action: '打开案例，点“编辑案例”，补齐微信、抖音主页、项目和共享原始素材路径。',
    case: caze
  };
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
  const metrics = all('SELECT * FROM metrics ORDER BY date DESC, created_at DESC').map(rowMetric);
  const monitor = monitorData(cases);
  const today = new Date().toISOString().slice(0, 10);
  const metricsByCase = cases.reduce((acc, caze) => {
    acc[caze.id] = metrics.filter((item) => item.caseId === caze.id);
    return acc;
  }, {});
  const caseRows = cases.map((caze) => {
    const caseSlots = slots.filter((item) => item.caseId === caze.id);
    const caseAssets = assets.filter((item) => item.caseId === caze.id);
    const caseMetrics = metricsByCase[caze.id] || [];
    const caseMonitor = monitorForCase(monitor, caze.id);
    const health = caseHealth(caze, caseSlots, caseAssets, caseMetrics, today, caseMonitor);
    const latest = caseMetrics[0] || null;
    const prev = caseMetrics[1] || null;
    return {
      ...caze,
      healthStatus: health.status,
      reasons: health.reasons,
      slots: caseSlots.length,
      readySlots: caseSlots.filter((item) => ['可交付', '已派发', '已完成'].includes(item.status)).length,
      completedSlots: caseSlots.filter((item) => item.status === '已完成').length,
      materialGaps: health.gaps.length,
      actions: health.actions,
      latestMetric: latest,
      initialSnapshot: caseMonitor.initialSnapshot || null,
      latestSnapshot: caseMonitor.latestSnapshot || null,
      fanDelta: caseMonitor.fanDelta ?? null,
      topVideo: caseMonitor.topVideo || null,
      dueCollection: Boolean(caseMonitor.dueCollection),
      activeViralAlerts: caseMonitor.activeViralAlerts || [],
      delta: latest && prev ? {
        fans: (latest.fans || 0) - (prev.fans || 0),
        plays: (latest.plays || 0) - (prev.plays || 0),
        likes: (latest.likes || 0) - (prev.likes || 0),
        comments: (latest.comments || 0) - (prev.comments || 0)
      } : null
    };
  });
  const topAccounts = caseRows
    .filter((item) => item.latestSnapshot || item.topVideo)
    .sort((a, b) => (b.topVideo?.latestSnapshot?.plays || b.latestSnapshot?.fans || 0) - (a.topVideo?.latestSnapshot?.plays || a.latestSnapshot?.fans || 0))
    .slice(0, 12);
  const needsAttention = caseRows
    .filter((item) => item.reasons.length > 0 || item.materialGaps > 0 || item.activeViralAlerts.length > 0)
    .sort((a, b) => ((b.activeViralAlerts.length * 4) + b.materialGaps + b.reasons.length) - ((a.activeViralAlerts.length * 4) + a.materialGaps + a.reasons.length))
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
      sent: slots.filter((item) => ['已派发', '已完成'].includes(item.status)).length,
      completed: slots.filter((item) => item.status === '已完成').length,
      metrics: metrics.length,
      accountSnapshots: monitor.totals.accountSnapshots,
      videos: monitor.totals.videos,
      videoSnapshots: monitor.totals.videoSnapshots,
      viralAlerts: monitor.totals.viralAlerts,
      dueCollection: monitor.totals.dueCollection,
      imageWaitingKey: imageTasks.filter((item) => item.status === 'waiting_key').length,
      clipPending: clipTasks.filter((item) => OPEN_CLIP_STATUSES.includes(item.status)).length
    },
    statusStats: groupCount(slots, (item) => item.status),
    contentKindStats: CONTENT_KINDS.map((kind) => ({
      kind,
      total: slots.filter((item) => item.contentKind === kind).length,
      pending: slots.filter((item) => item.contentKind === kind && ['待生成', '候选待选'].includes(item.status)).length,
      ready: slots.filter((item) => item.contentKind === kind && ['可交付', '已派发', '已完成'].includes(item.status)).length
    })),
    stageStats: STAGES.map((stage) => ({
      stage,
      slots: slots.filter((item) => item.stage === stage).length
    })),
    healthStats: groupCount(caseRows, (item) => item.healthStatus),
    topAccounts,
    needsAttention,
    monitor,
    recentCollections: [
      ...monitor.recentVideoSnapshots.map((item) => ({ ...item, type: '作品数据' })),
      ...monitor.recentAccountSnapshots.map((item) => ({ ...item, type: '账号快照' }))
    ]
      .sort((a, b) => String(b.collectedAt).localeCompare(String(a.collectedAt)))
      .slice(0, 20)
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
      sentWaitDone: withMeta.filter((item) => item.status === '已派发').length,
      completed: withMeta.filter((item) => item.status === '已完成').length
    }
  };
}

function dashboard() {
  const cases = all('SELECT * FROM cases ORDER BY created_at DESC').map(rowCase);
  const rollingSchedule = maintainRollingSchedule(cases);
  const slots = all('SELECT * FROM plan_slots ORDER BY date ASC, created_at ASC').map(rowSlot);
  const candidates = all('SELECT * FROM candidate_drafts ORDER BY created_at ASC').map(rowCandidate);
  const assets = all('SELECT * FROM assets ORDER BY created_at DESC').map(rowAsset);
  const viralTemplates = all('SELECT * FROM viral_templates ORDER BY created_at DESC').map(rowViral);
  const imageTasks = all('SELECT * FROM image_tasks ORDER BY created_at DESC').map(rowImageTask);
  const clipTasks = all('SELECT * FROM clip_tasks ORDER BY created_at DESC').map(rowClipTask);
  const monitor = monitorData(cases);
  const monitorActions = monitorActionQueue(monitor);
  const pausedCaseIds = new Set((monitor.accounts || [])
    .filter((item) => item.activityTier === '失联暂停' || item.lostContact?.active || caseIsPaused(item.case))
    .map((item) => item.case?.id)
    .filter(Boolean));
  const today = new Date().toISOString().slice(0, 10);
  const byCase = Object.fromEntries(cases.map((item) => [item.id, item]));
  const operatorStatuses = new Set(ACTIVE_OPERATOR_STATUSES);
  const dueSlots = slots.filter((s) => s.date <= today && operatorStatuses.has(s.status) && !pausedCaseIds.has(s.caseId));
  const dueCaseIds = new Set(dueSlots.map((slot) => slot.caseId));
  const materialSyncRows = cases
    .filter((caze) => !pausedCaseIds.has(caze.id))
    .map((caze) => {
      const caseAssets = assets.filter((asset) => asset.caseId === caze.id);
      return {
        ...caseSourceMaterialStatus(caze, caseAssets),
        case: caze
      };
    })
    .filter((item) => ['待同步', '目录不可用'].includes(item.status))
    .sort((a, b) => b.unsyncedCount - a.unsyncedCount)
    .slice(0, 30);
  const intakeIssueRows = cases
    .filter((caze) => !pausedCaseIds.has(caze.id))
    .map(caseIntakeIssue)
    .filter(Boolean)
    .slice(0, 30);
  const caseHealthRows = cases.map((caze) => {
    const caseSlots = slots.filter((s) => s.caseId === caze.id);
    const caseAssets = assets.filter((a) => a.caseId === caze.id);
    const caseMonitor = monitorForCase(monitor, caze.id);
    const health = caseHealth(caze, caseSlots, caseAssets, [], today, caseMonitor);
    const openGaps = health.gaps.filter((gap) => gap.status !== '已满足');
    return {
      ...caze,
      healthStatus: health.status,
      reasons: health.reasons,
      actions: health.actions,
      materialGaps: openGaps,
      dueCollection: Boolean(caseMonitor.dueCollection),
      activeViralAlerts: caseMonitor.activeViralAlerts || [],
      latestSnapshot: caseMonitor.latestSnapshot || null,
      topVideo: caseMonitor.topVideo || null,
      requiredGapCount: openGaps.filter((gap) => gap.status === '必补').length,
      optionalGapCount: openGaps.filter((gap) => gap.status === '可补').length
    };
  });
  const withCase = (slot) => {
    const slotCandidates = candidates.filter((item) => item.slotId === slot.id);
    return {
      ...slot,
      case: byCase[slot.caseId],
      candidateCount: slotCandidates.length,
      selectedCandidate: slotCandidates.find((item) => item.selected) || null
    };
  };
  const openImageTasks = imageTasks
    .filter((item) => OPEN_IMAGE_STATUSES.includes(item.status))
    .filter((item) => !pausedCaseIds.has(item.caseId));
  const openClipTasks = clipTasks
    .filter((item) => OPEN_CLIP_STATUSES.includes(item.status))
    .filter((item) => !pausedCaseIds.has(item.caseId));
  return {
    today,
    maintenance: { rollingSchedule },
    monitor,
    monitorActions,
    viralAlerts: monitor.viralAlerts,
    counts: {
      cases: cases.length,
      pendingGenerate: dueSlots.filter((s) => s.status === '待生成').length,
      pendingChoose: dueSlots.filter((s) => s.status === '候选待选').length,
      locked: dueSlots.filter((s) => s.status === '已锁定').length,
      readyDelivery: dueSlots.filter((s) => s.status === '可交付').length,
      sentWaitDone: dueSlots.filter((s) => s.status === '已派发').length,
      completed: dueSlots.filter((s) => s.status === '已完成').length,
      viralAlerts: monitor.totals.viralAlerts,
      monitorActions: monitorActions.length,
      monitoredAccounts: monitor.totals.monitoredAccounts,
      dueCollection: monitor.totals.dueCollection,
      pendingViral: viralTemplates.filter(isPendingViralTemplate).length,
      intakeIssues: intakeIssueRows.length,
      imageTasks: openImageTasks.length,
      imageWaitingKey: openImageTasks.filter((item) => item.status === 'waiting_key').length,
      clipTasks: openClipTasks.length,
      materialGaps: caseHealthRows.filter((item) => dueCaseIds.has(item.id)).reduce((sum, item) => sum + item.materialGaps.length, 0),
      requiredMaterialGaps: caseHealthRows.filter((item) => dueCaseIds.has(item.id)).reduce((sum, item) => sum + item.requiredGapCount, 0),
      materialSync: materialSyncRows.length,
      materialSyncFiles: materialSyncRows.reduce((sum, item) => sum + item.unsyncedCount, 0),
      blocked: dueSlots.filter((s) => s.status === '素材阻塞' || s.status === '异常').length
    },
    todaySlots: dueSlots.map(withCase),
    pendingGenerate: dueSlots.filter((s) => s.status === '待生成').slice(0, 30).map(withCase),
    pendingChoose: dueSlots.filter((s) => s.status === '候选待选').slice(0, 30).map(withCase),
    readyDelivery: dueSlots.filter((s) => s.status === '可交付').slice(0, 30).map(withCase),
    sentWaitDone: dueSlots.filter((s) => s.status === '已派发').slice(0, 60).map(withCase),
    imageTasks: openImageTasks
      .slice(0, 20)
      .map((item) => ({ ...item, case: byCase[item.caseId] || null })),
    clipTasks: openClipTasks
      .slice(0, 20)
      .map((item) => ({ ...item, case: byCase[item.caseId] || null })),
    pendingViralTemplates: viralTemplates.filter(isPendingViralTemplate).slice(0, 20),
    intakeIssues: intakeIssueRows,
    materialSync: materialSyncRows,
    abnormalCases: caseHealthRows
      .filter((caze) => !pausedCaseIds.has(caze.id))
      .filter((caze) => caze.reasons.length > 0 || caze.materialGaps.length > 0 || caze.activeViralAlerts.length > 0)
      .sort((a, b) => ((b.activeViralAlerts.length * 4) + b.requiredGapCount + b.materialGaps.length + b.reasons.length) - ((a.activeViralAlerts.length * 4) + a.requiredGapCount + a.materialGaps.length + a.reasons.length))
  };
}

function dashboardQueueHead(data = {}) {
  const items = [];
  (data.viralAlerts || []).forEach((alert) => {
    items.push({
      id: `alert-${alert.id}`,
      priority: alert.level === 'high' ? 120 : 110,
      kind: '爆款互动',
      alert
    });
  });
  (data.readyDelivery || []).forEach((slot) => {
    items.push({ id: `delivery-${slot.id}`, priority: 100, kind: '微信交付', slot });
  });
  (data.todaySlots || []).filter((slot) => slot.status === '已锁定').forEach((slot) => {
    items.push({ id: `locked-${slot.id}`, priority: 88, kind: '生成交付', slot });
  });
  (data.intakeIssues || []).forEach((row) => {
    items.push({ id: row.id, priority: 84, kind: '补登记', intakeIssue: row });
  });
  (data.pendingChoose || []).forEach((slot) => {
    items.push({ id: `choose-${slot.id}`, priority: 82, kind: '选候选', slot });
  });
  (data.todaySlots || []).filter((slot) => ['素材阻塞', '异常'].includes(slot.status)).forEach((slot) => {
    items.push({ id: `blocked-${slot.id}`, priority: slot.status === '异常' ? 79 : 78, kind: slot.status === '异常' ? '异常处理' : '补素材', slot });
  });
  (data.materialSync || []).forEach((row) => {
    items.push({ id: `sync-${row.caseId}`, priority: row.status === '目录不可用' ? 78 : 76, kind: '素材同步', materialSync: row });
  });
  (data.pendingGenerate || []).forEach((slot) => {
    items.push({ id: `generate-${slot.id}`, priority: 65, kind: '生成候选', slot });
  });
  (data.monitorActions || [])
    .filter((item) => item.kind !== '账号采集' && item.kind !== '爆款互动')
    .forEach((item) => {
      items.push({ id: `strategy-${item.id}`, priority: item.priority || 55, kind: item.kind, monitorAction: item });
    });
  (data.clipTasks || []).forEach((task) => {
    items.push({ id: `clip-${task.id}`, priority: 42, kind: '剪辑任务', clipTask: task });
  });
  return items.sort((a, b) => b.priority - a.priority)[0] || null;
}

const OPERATOR_FLOW = [
  ['待生成', '系统生成 3 条候选稿'],
  ['候选待选', '运营选择一条锁定'],
  ['已锁定', '系统生成微信交付内容'],
  ['素材阻塞', '补素材或创建图片/剪辑任务'],
  ['可交付', '复制文案和素材发微信'],
  ['已派发', '确认已发布后标记完成'],
  ['已完成', '任务已闭环']
];

function systemReadiness() {
  const dbPath = path.join(DATA_DIR, 'souren.sqlite');
  const image = imageSettings();
  const network = networkSettings();
  const collector = douyinCollectorStatus();
  const checks = [
    { key: 'local-web', label: '本地网页工作台', status: 'ready', detail: `http://127.0.0.1:${PORT}` },
    {
      key: 'lan-workbench',
      label: '局域网工作台',
      status: network.lanEnabled ? (network.accessCodeRequired ? 'ready' : 'warning') : 'waiting',
      detail: network.lanEnabled
        ? `${network.lanUrls[0] || `http://${LISTEN_HOST}:${PORT}`}｜${network.accessCodeRequired ? '访问码已开启' : '未设置访问码'}`
        : '当前只允许本机访问；需要给同局域网工作人员使用时，先在主机开启局域网访问和访问码'
    },
    { key: 'sqlite', label: '本地数据记录', status: fs.existsSync(dbPath) ? 'ready' : 'warning', detail: '账号、排期、交付状态可正常保存' },
    { key: 'material-root', label: '真实案例素材', status: fs.existsSync(MATERIAL_ROOT) ? 'ready' : 'warning', detail: '案例素材可扫描、同步和用于交付' },
    { key: 'case-library-root', label: '服务器案例库', status: fs.existsSync(CASE_LIBRARY_ROOT) ? 'ready' : 'warning', detail: '可扫描待分配案例目录' },
    { key: 'shared-material-root', label: '通用素材库', status: fs.existsSync(SHARED_MATERIAL_ROOT) ? 'ready' : 'warning', detail: '医院素材、套图素材和备用素材可复用' },
    { key: 'dashboard-flow', label: '今日中控台链路', status: 'ready', detail: '待生成、待选择、素材阻塞、可交付、已派发、已完成' },
    { key: 'case-defaults', label: '新建案例四项录入与自动排期', status: 'ready', detail: '微信昵称 + 抖音主页 + 项目 + 共享素材路径即可先建链路' },
    { key: 'delivery-package', label: '微信交付内容', status: 'ready', detail: '网页内复制文案、下载素材，并按素材顺序和完成确认闭环' },
    {
      key: 'douyin-monitor',
      label: '抖音账号数据监控',
      status: collector.autoRun && collector.supported ? 'ready' : 'waiting',
      detail: collector.autoRun && collector.supported
        ? `后台会自动启动主机浏览器采集，单轮最多 ${collector.limit} 个账号`
        : '已保留主机浏览器登录态采集清单；当前未自动启动主机浏览器采集'
    },
    { key: 'viral-alerts', label: '爆款作品提醒', status: 'ready', detail: '作品数据达到阈值后，首页提醒安排助理号/阑尾号互动' },
    { key: 'viral-analysis', label: '爆款链接分析', status: 'ready', detail: '工作人员只粘贴链接，分析完成后再批量生成同结构内容' },
    { key: 'image-api', label: '图片生成', status: image.ready ? 'ready' : 'waiting', detail: image.ready ? '已接入，可在图片任务里生成并下载' : `${image.missing || '未接入图片接口'}，图片任务仍可生成提示词` }
  ];
  return {
    summary: {
      ready: checks.filter((item) => item.status === 'ready').length,
      waiting: checks.filter((item) => item.status === 'waiting').length,
      warning: checks.filter((item) => item.status === 'warning').length,
      total: checks.length
    },
    checks
  };
}

app.get('/api/health', (_req, res) => {
  const image = imageSettings();
  res.json({
    ok: true,
    rootDir: ROOT_DIR,
    materialRoot: MATERIAL_ROOT,
    imageKeyReady: Boolean(image.apiKey),
    image: {
      ready: image.ready,
      apiUrlConfigured: image.apiUrlConfigured,
      apiUrlDefaulted: image.apiUrlDefaulted,
      model: image.model,
      size: image.size,
      missing: image.missing
    },
    network: networkSettings(),
    douyinCollector: douyinCollectorStatus(),
    readiness: systemReadiness().summary
  });
});

app.get('/api/dashboard', (_req, res) => {
  res.json(dashboard());
});

app.get('/api/readiness', (_req, res) => {
  res.json(systemReadiness());
});

app.get('/api/douyin-monitor', (_req, res) => {
  res.json(monitorData());
});

app.get('/api/douyin-monitor/chrome-queue', (req, res) => {
  res.json(chromeCollectionQueue({
    includeFresh: truthy(req.query.includeFresh),
    limit: req.query.limit
  }));
});

app.get('/api/agent-work', (_req, res) => {
  res.json(agentWorkQueue());
});

app.post('/api/douyin-monitor/chrome-queue', (req, res) => {
  try {
    res.json(registerChromeCollectionQueue({
      includeFresh: truthy(req.body?.includeFresh),
      limit: req.body?.limit
    }));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.post('/api/douyin-monitor/run', async (req, res) => {
  try {
    res.json(await enqueueDouyinCollection(req.body?.source || 'manual'));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.post('/api/douyin-monitor/ingest', (req, res) => {
  try {
    res.json(ingestDouyinData(req.body || {}));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.post('/api/douyin-monitor/actions/slot', (req, res) => {
  try {
    res.json(createMonitorActionSlot(req.body || {}));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.patch('/api/viral-alerts/:id', (req, res) => {
  const alert = rowViralAlert(get('SELECT * FROM viral_alerts WHERE id = ?', [req.params.id]));
  if (!alert) return res.status(404).json({ error: 'viral alert not found' });
  const body = req.body || {};
  try {
    if ((body.status || alert.status) === 'handled') requireQueueHeadForAlert(req, alert, '标记互动');
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message });
  }
  run(
    'UPDATE viral_alerts SET status = ?, interaction_note = ?, updated_at = ? WHERE id = ?',
    [
      body.status || alert.status,
      body.interactionNote ?? body.interaction_note ?? alert.interactionNote,
      now(),
      alert.id
    ]
  );
  const joined = joinedViralAlerts('va.id = ?', [alert.id], 1)[0];
  res.json(joined || rowViralAlert(get('SELECT * FROM viral_alerts WHERE id = ?', [alert.id])));
});

app.post('/api/dashboard/generate-today', async (_req, res) => {
  const queueHead = dashboardQueueHead(dashboard());
  let candidateCount = 0;
  if (!queueHead?.slot || queueHead.slot.status !== '待生成') {
    return res.json({
      slotCount: 0,
      candidateCount,
      slots: [],
      processedId: null,
      queueHead,
      reason: queueHead ? '当前队首不是待生成任务，不能越过队首批量生成。' : '今日队列已清空。'
    });
  }
  const current = slotById(queueHead.slot.id);
  const drafts = await generateCandidatesForSlot(current);
  if (drafts.length) candidateCount = drafts.length;
  const generated = candidateCount ? [slotById(current.id)] : [];
  res.json({ slotCount: generated.length, candidateCount, slots: generated, processedId: current.id, queueHead });
});

app.post('/api/dashboard/deliver-today', (_req, res) => {
  const queueHead = dashboardQueueHead(dashboard());
  const delivered = [];
  if (!queueHead?.slot || queueHead.slot.status !== '已锁定') {
    return res.json({
      deliveryCount: 0,
      deliveries: delivered,
      processedId: null,
      queueHead,
      reason: queueHead ? '当前队首不是已锁定任务，不能越过队首批量生成交付。' : '今日队列已清空。'
    });
  }
  const current = slotById(queueHead.slot.id);
  const result = createDeliveryForSlot(current);
  if (result && !result.blocked) delivered.push(result);
  res.json({ deliveryCount: delivered.length, deliveries: delivered, processedId: current.id, queueHead });
});

app.post('/api/dashboard/prepare-today', async (_req, res) => {
  const queueHead = dashboardQueueHead(dashboard());
  let generatedCount = 0;
  let selectedCount = 0;
  let deliveryCount = 0;
  const deliveries = [];
  if (!queueHead?.slot || !['待生成', '候选待选', '已锁定'].includes(queueHead.slot.status)) {
    return res.json({
      generatedCount,
      selectedCount,
      deliveryCount,
      deliveries,
      processedId: null,
      queueHead,
      reason: queueHead ? '当前队首不是准备类任务，不能越过队首批量推进。' : '今日队列已清空。'
    });
  }
  let current = slotById(queueHead.slot.id);
  if (current.status === '待生成') {
    const drafts = await generateCandidatesForSlot(current);
    if (drafts.length) generatedCount += 1;
    current = slotById(current.id);
  }
  if (current.status === '候选待选') {
    const selected = selectRecommendedCandidate(current.id);
    if (selected) selectedCount += 1;
    current = slotById(current.id);
  }
  if (current.status === '已锁定') {
    const result = createDeliveryForSlot(current);
    if (result && !result.blocked) {
      deliveries.push(result);
      deliveryCount += 1;
    }
  }
  res.json({
    generatedCount,
    selectedCount,
    deliveryCount,
    deliveries,
    processedId: current.id,
    queueHead
  });
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
  try {
    const body = req.body || {};
    const created = createCaseFromBody(body);
    const sync = syncCaseSourceMaterials(created);
    const slots = generateSlotsForCase(created, { days: 14 });
    const collectionQueue = registerCaseCollectionQueue([created.id], 'case-create');
    res.json({ ...created, sync, slotsCreated: slots.length, collectionQueue });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.post('/api/cases/bulk', (req, res) => {
  try {
    const body = req.body || {};
    const rows = Array.isArray(body.cases) ? body.cases : parseBulkCaseText(body.text);
    res.json(createBulkCases(rows));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.patch('/api/cases/:id', (req, res) => {
  try {
    const caze = caseById(req.params.id);
    if (!caze) return res.status(404).json({ error: 'case not found' });
    const body = req.body || {};
    const nextWeixinNick = String(body.weixinNick ?? body.weixin_nick ?? caze.weixinNick ?? '').trim();
    if (!nextWeixinNick) return res.status(400).json({ error: '必须填写兼职微信昵称' });
    const nextDouyinUrl = body.douyinUrl !== undefined || body.douyin_url !== undefined
      ? normalizeDouyinUrl(body.douyinUrl ?? body.douyin_url)
      : caze.douyinUrl;
    if (!nextDouyinUrl) return res.status(400).json({ error: '必须填写有效的抖音主页或作品链接' });
    const nextProject = String(body.project ?? caze.project ?? '').trim();
    if (!nextProject) return res.status(400).json({ error: '必须填写项目' });
    const nextSourceMaterialDir = body.sourceMaterialDir !== undefined || body.source_material_dir !== undefined
      ? normalizeSourceMaterialDir(body.sourceMaterialDir ?? body.source_material_dir)
      : caze.sourceMaterialDir;
    const nextHealthStatus = body.healthStatus ?? caze.healthStatus;
    run(
      `UPDATE cases SET weixin_nick=?, douyin_id=?, douyin_url=?, project=?, persona=?, source_material_dir=?, health_status=?, updated_at=? WHERE id=?`,
      [
        nextWeixinNick,
        douyinIdFromUrl(nextDouyinUrl),
        nextDouyinUrl,
        nextProject,
        JSON.stringify(caze.persona || {}),
        nextSourceMaterialDir,
        nextHealthStatus,
        now(),
        req.params.id
      ]
    );
    const updated = caseById(req.params.id);
    const pauseMaintenance = caseIsPaused(updated) ? pauseCaseWork(updated) : null;
    const collectionQueue = pauseMaintenance ? null : registerCaseCollectionQueue([updated.id], 'case-edit');
    writeCaseManifest(updated);
    res.json({ ...caseById(req.params.id), pauseMaintenance, collectionQueue });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.post('/api/cases/:id/resume', (req, res) => {
  try {
    res.json(resumeCaseAccount(req.params.id));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.delete('/api/cases/:id', (req, res) => {
  const caze = caseById(req.params.id);
  if (!caze) return res.status(404).json({ error: 'case not found' });
  try {
    const { removedDir } = removeCaseDirectory(caze);
    run('DELETE FROM cases WHERE id = ?', [caze.id]);
    res.json({ deleted: true, id: caze.id, removedDir, localCaseDir: caze.localCaseDir });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
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
  const metrics = all('SELECT * FROM metrics WHERE case_id = ? ORDER BY date DESC, created_at DESC', [caze.id]).map(rowMetric);
  const monitor = monitorData([caze]);
  const accountMonitor = monitorForCase(monitor, caze.id);
  const douyinVideos = all('SELECT * FROM douyin_videos WHERE case_id = ? ORDER BY updated_at DESC', [caze.id]).map(rowDouyinVideo);
  const latestVideoSnapshots = latestSnapshotsByVideo(all('SELECT * FROM video_snapshots WHERE case_id = ? ORDER BY collected_at DESC, created_at DESC', [caze.id]).map(rowVideoSnapshot));
  const videos = douyinVideos.map((video) => ({
    ...video,
    latestSnapshot: latestVideoSnapshots.get(video.id) || null,
    activeAlert: accountMonitor.activeViralAlerts?.find((alert) => alert.videoId === video.id) || null
  }));
  const health = caseHealth(caze, slots, assets, metrics, new Date().toISOString().slice(0, 10), accountMonitor);
  res.json({
    case: { ...caze, healthStatus: health.status },
    slots,
    candidates,
    assets,
    imageTasks,
    clipTasks,
    metrics,
    monitor: accountMonitor,
    videos,
    viralAlerts: accountMonitor.activeViralAlerts || [],
    materialGaps: health.gaps,
    healthReasons: health.reasons,
    healthActions: health.actions
  });
});

app.get('/api/config', (_req, res) => {
  const image = imageSettings();
  const caseLibrary = caseLibraryCandidates();
  res.json({
    imageKeyReady: Boolean(image.apiKey),
    image: {
      ready: image.ready,
      apiUrlConfigured: image.apiUrlConfigured,
      apiUrlDefaulted: image.apiUrlDefaulted,
      model: image.model,
      size: image.size,
      missing: image.missing
    },
    network: networkSettings(),
    douyinCollector: douyinCollectorStatus(),
    readiness: systemReadiness(),
    materialRoot: MATERIAL_ROOT,
    caseLibraryRoot: CASE_LIBRARY_ROOT,
    caseLibrary: {
      total: caseLibrary.length,
      unregistered: caseLibrary.filter((item) => !item.alreadyRegistered).length
    },
    sharedMaterialRoot: SHARED_MATERIAL_ROOT,
    sharedAssets: {
      total: all('SELECT id FROM shared_assets').length,
      byCategory: all('SELECT category, COUNT(*) AS count FROM shared_assets GROUP BY category ORDER BY category'),
      byUsage: all('SELECT usage, COUNT(*) AS count FROM shared_assets GROUP BY usage ORDER BY usage')
    }
  });
});

app.get('/api/case-library', (_req, res) => {
  res.json({
    root: CASE_LIBRARY_ROOT,
    candidates: caseLibraryCandidates()
  });
});

app.post('/api/case-library/register', (req, res) => {
  try {
    res.json(createCaseFromLibrary(req.body || {}));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.get('/api/shared-assets', (_req, res) => {
  res.json(all('SELECT * FROM shared_assets ORDER BY created_at DESC').map(rowSharedAsset));
});

app.post('/api/shared-assets/scan', (_req, res) => {
  res.json(scanSharedAssets());
});

app.patch('/api/shared-assets/:id', (req, res) => {
  const asset = rowSharedAsset(get('SELECT * FROM shared_assets WHERE id = ?', [req.params.id]));
  if (!asset) return res.status(404).json({ error: 'shared asset not found' });
  const body = req.body || {};
  run(
    'UPDATE shared_assets SET category = ?, source = ?, usage = ?, review_status = ? WHERE id = ?',
    [
      body.category ?? asset.category,
      body.source ?? asset.source,
      body.usage ?? asset.usage,
      body.reviewStatus ?? asset.reviewStatus,
      asset.id
    ]
  );
  res.json(rowSharedAsset(get('SELECT * FROM shared_assets WHERE id = ?', [asset.id])));
});

app.get('/api/cases/:id/material-intake-note', (req, res) => {
  const caze = caseById(req.params.id);
  if (!caze) return res.status(404).json({ error: 'case not found' });
  const assets = all('SELECT * FROM assets WHERE case_id = ? ORDER BY created_at DESC', [caze.id]).map(rowAsset);
  const gaps = materialGaps(caze.project, assets);
  res.json({ text: materialIntakeText(caze, gaps) });
});

app.post('/api/cases/:id/scan-assets', (req, res) => {
  const caze = caseById(req.params.id);
  if (!caze) return res.status(404).json({ error: 'case not found' });
  const inserted = scanCaseAssets(caze);
  res.json({ inserted, assets: all('SELECT * FROM assets WHERE case_id = ? ORDER BY created_at DESC', [caze.id]).map(rowAsset) });
});

app.post('/api/cases/:id/sync-source-materials', (req, res) => {
  try {
    const caze = caseById(req.params.id);
    if (!caze) return res.status(404).json({ error: 'case not found' });
    const result = syncCaseSourceMaterials(caze);
    res.json({
      ...result,
      assets: all('SELECT * FROM assets WHERE case_id = ? ORDER BY created_at DESC', [caze.id]).map(rowAsset)
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.post('/api/cases/:id/slots', (req, res) => {
  const caze = caseById(req.params.id);
  if (!caze) return res.status(404).json({ error: 'case not found' });
  const body = req.body || {};
  res.json(createSlotForCase(caze, body));
});

app.post('/api/slots/:id/generate-candidates', async (req, res) => {
  const slot = slotById(req.params.id);
  if (!slot) return res.status(404).json({ error: 'slot not found' });
  if (slot.selectedCandidateId || ['已锁定', '可交付', '已派发', '已完成'].includes(slot.status)) {
    return res.status(409).json({ error: '该槽位已锁定，不能重新生成候选' });
  }
  try {
    requireQueueHeadForSlot(req, slot, '生成候选');
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message });
  }
  res.json(await generateCandidatesForSlot(slot));
});

app.post('/api/candidates/:id/select', (req, res) => {
  const candidate = rowCandidate(get('SELECT * FROM candidate_drafts WHERE id = ?', [req.params.id]));
  if (!candidate) return res.status(404).json({ error: 'candidate not found' });
  const slot = slotById(candidate.slotId);
  if (!slot) return res.status(404).json({ error: 'slot not found' });
  if (!CANDIDATE_SELECT_STATUSES.includes(slot.status)) {
    return res.status(409).json({ error: '这个排期已经锁定或进入交付链路，不能再改候选' });
  }
  try {
    requireQueueHeadForSlot(req, slot, '选择候选');
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message });
  }
  run('UPDATE candidate_drafts SET selected = 0 WHERE slot_id = ?', [candidate.slotId]);
  run('UPDATE candidate_drafts SET selected = 1 WHERE id = ?', [candidate.id]);
  run('UPDATE plan_slots SET selected_candidate_id = ?, status = ?, updated_at = ? WHERE id = ?', [candidate.id, '已锁定', now(), candidate.slotId]);
  res.json({ slot: slotById(candidate.slotId), candidate: rowCandidate(get('SELECT * FROM candidate_drafts WHERE id = ?', [candidate.id])) });
});

app.patch('/api/slots/:id/status', (req, res) => {
  const slot = slotById(req.params.id);
  if (!slot) return res.status(404).json({ error: 'slot not found' });
  const status = String(req.body?.status || '').trim();
  if (!PLAN_SLOT_STATUSES.includes(status)) {
    return res.status(400).json({ error: `非法槽位状态：${status || '空值'}` });
  }
  if (!canPatchSlotStatus(slot, status)) {
    return res.status(409).json({ error: '这个排期已经进入交付链路，不能直接改成这个状态' });
  }
  try {
    const completingAlreadySent = status === '已完成' && slot.status === '已派发';
    if (['异常', '已派发'].includes(status) || (status === '已完成' && !completingAlreadySent)) {
      requireQueueHeadForSlot(req, slot, '改状态');
    }
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message });
  }
  if (status === '已派发') {
    const deliveryView = deliveryViewForSlot(slot);
    if (!deliveryView?.mediaFiles?.length) {
      return res.status(409).json({ error: '交付动作还没完成：本次可发送图片或视频' });
    }
    const guard = deliveryHandoffGuard(slot, req.body?.handoffDone || req.body?.deliveryChecklist, deliveryView);
    if (!guard.ok) {
      return res.status(409).json({ error: `交付动作还没完成：${guard.missing.map((item) => item.label).join('、')}` });
    }
  }
  run('UPDATE plan_slots SET status = ?, updated_at = ? WHERE id = ?', [status, now(), slot.id]);
  res.json(slotById(slot.id));
});

function fixedEditRecipe(slot = {}, caze = {}, candidate = {}) {
  const kind = slot.contentKind || '日常养号';
  const recipes = {
    '素人种草': [
      '1. 0-3秒：放阶段标题或核心问题，画面用人物/过程/当前状态素材。',
      '2. 3-10秒：按“开始状态 -> 过程细节”顺序切画面，不打乱时间线。',
      '3. 10-25秒：按口播字幕解释当下感受、恢复阶段或项目细节。',
      '4. 25-35秒：回到当前状态或一个细节画面，保留评论引导。',
      '5. 封面：人物或过程图 + 标题，标题不超过两行。'
    ],
    '日常养号': [
      '1. 0-2秒：生活画面先出现，标题只点出当天状态。',
      '2. 2-12秒：连续 3-5 个生活/城市/工作/穿搭素材，每个画面 2-3 秒。',
      '3. 12-25秒：字幕用碎碎念式记录，不额外加入医疗判断。',
      '4. 25-30秒：自然收尾，可以留一句轻互动。',
      '5. 封面：使用第一张清晰生活图 + 短标题。'
    ],
    '爆款提权': [
      '1. 0-2秒：先放爆款结构里的反差、清单或情绪钩子。',
      '2. 2-8秒：给第一层理由或场景，字幕和画面同步。',
      '3. 8-22秒：按“三段式/清单式/反差式”固定结构推进，不临时加新段落。',
      '4. 22-30秒：结尾留互动问题或承接句。',
      '5. 封面：标题优先，画面保持账号日常质感。'
    ]
  };
  const lines = recipes[kind] || recipes['日常养号'];
  return [
    '固定剪辑配方：',
    ...lines,
    '',
    '统一规则：',
    '1. 画面比例固定 9:16，建议时长 20-35 秒。',
    '2. 字幕固定白字深描边，底部安全区，不遮挡主体。',
    '3. 只替换素材和标题，不临时改结构、不临时加复杂特效。',
    '4. 口播/字幕优先使用本次锁定文案。',
    `5. 收件账号：${caze.weixinNick || '未命名兼职'}；标题：${candidate.title || '按任务标题'}。`
  ].join('\n');
}

function createDeliveryForSlot(slot) {
  if (!slot) return null;
  const caze = caseById(slot.caseId);
  const candidate = rowCandidate(get('SELECT * FROM candidate_drafts WHERE id = ?', [slot.selectedCandidateId]));
  if (!candidate) return null;
  const folder = `${slot.date}_${safeSegment(slot.stage)}_${safeSegment(slot.contentKind)}`;
  const deliveryDir = path.join(caze.localCaseDir, '03-交付给兼职', folder);
  fs.mkdirSync(deliveryDir, { recursive: true });
  const complianceHits = complianceHitsForCandidate(candidate);
  if (JSON.stringify(complianceHits) !== JSON.stringify(candidate.complianceHits || [])) {
    run('UPDATE candidate_drafts SET compliance_hits = ? WHERE id = ?', [JSON.stringify(complianceHits), candidate.id]);
  }
  if (complianceHits.length) {
    fs.writeFileSync(path.join(deliveryDir, '00-合规阻塞说明.txt'), [
      `案例：${caze.caseCode} / ${caze.weixinNick}`,
      `内容：${slot.date} ${slot.timeWindow || '全天'}｜${slot.contentKind}｜${slot.stage}`,
      `标题：${candidate.title}`,
      '',
      '当前不能标记为可交付：文案命中本地合规提示。',
      '',
      '命中内容：',
      formatComplianceHits(complianceHits),
      '',
      '下一步：',
      '1. 回到候选稿，重新生成或选择没有命中的版本',
      '2. 必要时人工改写标题和正文',
      '3. 再重新生成交付内容'
    ].join('\n'));
    run('UPDATE plan_slots SET status = ?, delivery_dir = ?, updated_at = ? WHERE id = ?', ['异常', deliveryDir, now(), slot.id]);
    return { blocked: true, reason: 'compliance_hits', complianceHits, deliveryDir, copiedAssets: [], slot: slotById(slot.id) };
  }
  const freelancerGuide = writeFreelancerGuide(caze);
  fs.writeFileSync(path.join(deliveryDir, '00-兼职须知.txt'), freelancerGuide);
  fs.writeFileSync(path.join(deliveryDir, '00-微信发送清单.txt'), [
    `发给：${caze.weixinNick || '未命名兼职'}`,
    `抖音：${douyinAccountText(caze)}`,
    `案例：${caze.caseCode}`,
    `内容：${slot.date} ${slot.timeWindow || '全天'}｜${slot.contentKind}｜${slot.stage}`,
    `标题：${candidate.title}`,
    '',
    '发送顺序：',
    '0. 第一次给这个兼职发内容时，先发送 00-兼职须知.txt',
    '1. 复制并发送 01-发给兼职文案.txt',
    '2. 复制并发送 02-抖音发布文案.txt',
    '3. 按 05-素材顺序清单.txt 的顺序，把图片或视频拖进微信发送',
    '4. 发完后在系统里标记「已派发」；确认发布完成后标记「已完成」',
    '',
    '完成口径：',
    '1. 兼职或剪辑人员确认已按要求发布/交付后，系统标记「已完成」',
    '2. 账号主页数据由系统按账号活跃度分层采集，不需要工作人员逐条填写'
  ].join('\n'));
  fs.writeFileSync(path.join(deliveryDir, '01-发给兼职文案.txt'), deliveryOperatorInstructionText(candidate.operatorInstruction, slot, caze));
  fs.writeFileSync(path.join(deliveryDir, '02-抖音发布文案.txt'), `${candidate.title}\n\n${candidate.publishText}`);
  const videoDelivery = isVideoDelivery(candidate.format);
  const editRecipe = fixedEditRecipe(slot, caze, candidate);
  if (videoDelivery) {
    fs.writeFileSync(path.join(deliveryDir, '03-口播字幕文案.txt'), [
      `标题：${candidate.title}`,
      '',
      candidate.publishText,
      '',
      '用途：可作为口播、字幕或剪辑旁白。'
    ].join('\n'));
    fs.writeFileSync(path.join(deliveryDir, '04-剪辑要求.txt'), [
      `案例：${caze.caseCode} / ${caze.weixinNick}`,
      `抖音：${douyinAccountText(caze)}`,
      `内容类型：${slot.contentKind}`,
      `建议比例：9:16`,
      `建议时长：20-35秒`,
      '',
      '剪辑要求：',
      editRecipe,
      '',
      '素材使用：',
      '1. 优先使用本次交付内容内视频素材，其次使用图片做轻动态。',
      '2. 封面图如需单独制作，直接随视频素材一起发给兼职。',
      '3. 剪辑或发布完成后，只需要在系统里标记「已完成」，不需要上传成片文件。'
    ].join('\n'));
  }
  const assets = deliveryAssetsForSlot(slot, caze, 9);
  const copied = [];
  assets.forEach((asset, index) => {
    if (!fs.existsSync(asset.path)) return;
    const ext = path.extname(asset.path);
    const label = asset.kind === '视频' ? '视频' : '图片';
    const fileIndex = videoDelivery ? index + 8 : index + 3;
    const fileName = `${String(fileIndex).padStart(2, '0')}-${label}${index + 1}${ext}`;
    fs.copyFileSync(asset.path, path.join(deliveryDir, fileName));
    copied.push({ order: index + 1, fileName, kind: asset.kind, stage: asset.stage, source: asset.source, originalPath: asset.path });
  });
  const assetLines = copied.length
    ? copied.map((item) => `${item.order}. ${item.fileName}｜${item.kind}｜${item.stage}｜${item.source}\n   原路径：${item.originalPath}`).join('\n')
    : '本次未复制素材，请先在案例详情扫描并标记可用素材，或创建图片/剪辑任务补齐。';
  if (!copied.length) {
    fs.writeFileSync(path.join(deliveryDir, '00-素材阻塞说明.txt'), [
      `案例：${caze.caseCode} / ${caze.weixinNick}`,
      `内容：${slot.date} ${slot.timeWindow || '全天'}｜${slot.contentKind}｜${slot.stage}`,
      `标题：${candidate.title}`,
      '',
      '当前不能标记为可交付：本次没有复制到任何可用素材。',
      '',
      '下一步：',
      caze.sourceMaterialDir ? '1. 把素材放入共享原始素材路径，并点击“同步共享素材”' : '1. 填写共享原始素材路径，或把图片/视频放入 00-原始素材 或 01-已筛选素材',
      '2. 回到系统点击“扫描素材”',
      '3. 把可用素材标记为“可用”',
      '4. 再重新生成交付内容'
    ].join('\n'));
    run('UPDATE plan_slots SET status = ?, delivery_dir = ?, updated_at = ? WHERE id = ?', ['素材阻塞', deliveryDir, now(), slot.id]);
    return { blocked: true, reason: 'missing_assets', deliveryDir, copiedAssets: copied, slot: slotById(slot.id) };
  }
  fs.writeFileSync(path.join(deliveryDir, '05-素材顺序清单.txt'), assetLines);
  fs.writeFileSync(path.join(deliveryDir, '06-发布要求.txt'), [
    `类型：${slot.contentKind}`,
    `形式：${candidate.format}`,
    `日期：${slot.date}`,
    `时间窗：${slot.timeWindow || ''}`,
    `发给：${caze.weixinNick || '未命名兼职'}`,
    `抖音：${douyinAccountText(caze)}`,
    `标题：${candidate.title}`,
    '',
    '发送给兼职顺序：',
    '0. 先看 00-微信发送清单.txt，确认收件人和账号',
    '1. 先发 01-发给兼职文案.txt',
    '2. 再发 02-抖音发布文案.txt',
    '3. 按 05-素材顺序清单.txt 的顺序发送图片或视频',
    '4. 发完并确认发布/交付完成后，在系统标记「已完成」',
    '',
    '素材顺序：',
    assetLines
  ].join('\n'));
  run('UPDATE plan_slots SET status = ?, delivery_dir = ?, updated_at = ? WHERE id = ?', ['可交付', deliveryDir, now(), slot.id]);
  return { deliveryDir, copiedAssets: copied, slot: slotById(slot.id) };
}

function readDeliveryText(deliveryDir, fileName) {
  const filePath = path.join(deliveryDir, fileName);
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf8');
}

function deliveryFileKind(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if (IMAGE_EXT.has(ext)) return '图片';
  if (VIDEO_EXT.has(ext)) return '视频';
  if (TEXT_EXT.has(ext)) return '文案';
  return '文件';
}

function deliveryMediaStepKey(file) {
  return `media:${file.path || file.url || file.name}`;
}

function deliveryRequiredHandoffSteps(view) {
  if (!view) return [];
  const texts = view.texts || {};
  const steps = [{ key: 'recipient', label: '收件微信确认' }];
  if (view.shouldSendFreelancerGuide && texts.freelancerGuide) steps.push({ key: 'guide', label: '兼职须知' });
  if (texts.operatorInstruction) steps.push({ key: 'operator', label: '发给兼职文案' });
  if (texts.publishText) steps.push({ key: 'publish', label: '抖音发布文案' });
  if (view.isVideo && texts.voiceover) steps.push({ key: 'voiceover', label: '口播/字幕文案' });
  if (view.isVideo && texts.editBrief) steps.push({ key: 'editBrief', label: '剪辑要求' });
  (view.mediaFiles || []).forEach((file, index) => {
    steps.push({ key: deliveryMediaStepKey(file), label: `${file.kind || '素材'}${index + 1}` });
  });
  return steps;
}

function deliveryHandoffGuard(slot, completed = [], deliveryView = null) {
  const view = deliveryView || deliveryViewForSlot(slot);
  if (!view || slot.status !== '可交付') return { ok: false, missing: [{ key: 'delivery', label: '交付内容' }] };
  if (!view.mediaFiles?.length) {
    return {
      ok: false,
      required: deliveryRequiredHandoffSteps(view),
      missing: [{ key: 'media', label: '本次可发送图片或视频' }]
    };
  }
  const required = deliveryRequiredHandoffSteps(view);
  const requiredKeys = required.map((item) => item.key);
  const completedKeys = [];
  (Array.isArray(completed) ? completed : []).map(String).forEach((key) => {
    if (requiredKeys.includes(key) && !completedKeys.includes(key)) completedKeys.push(key);
  });
  const outOfOrderIndex = completedKeys.findIndex((key, index) => key !== requiredKeys[index]);
  if (outOfOrderIndex !== -1) {
    const expected = required[outOfOrderIndex] || required[0];
    return {
      ok: false,
      required,
      missing: [{ key: expected?.key || 'sequence', label: `按发送顺序操作，先完成「${expected?.label || '第一步'}」` }]
    };
  }
  const completedSet = new Set(completedKeys);
  const missing = required.filter((item) => !completedSet.has(item.key));
  return { ok: missing.length === 0, required, missing };
}

function caseGuideAlreadySent(slot) {
  if (!slot) return false;
  if (['已派发', '已完成'].includes(slot.status)) return true;
  return Boolean(get(
    `SELECT id FROM plan_slots
    WHERE case_id = ? AND id != ? AND status IN ('已派发', '已完成')
    LIMIT 1`,
    [slot.caseId, slot.id]
  ));
}

function deliveryViewForSlot(slot) {
  if (!slot) return null;
  const caze = caseById(slot.caseId);
  const candidate = slot.selectedCandidateId
    ? rowCandidate(get('SELECT * FROM candidate_drafts WHERE id = ?', [slot.selectedCandidateId]))
    : null;
  const deliveryDir = slot.deliveryDir;
  if (!caze || !candidate || !deliveryDir || !fs.existsSync(deliveryDir)) return null;
  const files = fs.readdirSync(deliveryDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const full = path.join(deliveryDir, entry.name);
      const stat = fs.statSync(full);
      const kind = deliveryFileKind(entry.name);
      return {
        name: entry.name,
        path: full,
        url: fileUrl(full),
        kind,
        size: stat.size,
        updatedAt: stat.mtime.toISOString()
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  const mediaFiles = files.filter((item) => ['图片', '视频'].includes(item.kind));
  const videoDelivery = isVideoDelivery(candidate.format);
  const guideAlreadySent = caseGuideAlreadySent(slot);
  const shouldSendFreelancerGuide = slot.status === '可交付' && !guideAlreadySent;
  const freelancerGuide = readDeliveryText(deliveryDir, '00-兼职须知.txt') || freelancerGuideForCase(caze);
  return {
    slot,
    case: caze,
    candidate,
    deliveryDir,
    isVideo: videoDelivery,
    shouldSendFreelancerGuide,
    freelancerGuideAlreadySent: guideAlreadySent,
    texts: {
      freelancerGuide: shouldSendFreelancerGuide ? freelancerGuide : '',
      freelancerGuideNote: guideAlreadySent ? '兼职须知已在首次交付发送，后续不重复发。' : '',
      checklist: readDeliveryText(deliveryDir, '00-微信发送清单.txt'),
      operatorInstruction: deliveryOperatorInstructionText(readDeliveryText(deliveryDir, '01-发给兼职文案.txt'), slot, caze),
      publishText: readDeliveryText(deliveryDir, '02-抖音发布文案.txt'),
      voiceover: readDeliveryText(deliveryDir, '03-口播字幕文案.txt'),
      editBrief: readDeliveryText(deliveryDir, '04-剪辑要求.txt'),
      assetOrder: readDeliveryText(deliveryDir, '05-素材顺序清单.txt'),
      publishRules: readDeliveryText(deliveryDir, '06-发布要求.txt'),
      blockedNote: readDeliveryText(deliveryDir, '00-素材阻塞说明.txt'),
      complianceNote: readDeliveryText(deliveryDir, '00-合规阻塞说明.txt')
    },
    files,
    mediaFiles,
    editing: videoDelivery ? {
      sourceDir: caze.localCaseDir,
      deliveryDir,
      completionNote: '剪辑或发布完成后，在系统里标记「已完成」；不需要上传成片或放回本地目录。'
    } : null
  };
}

app.post('/api/slots/:id/delivery', (req, res) => {
  const slot = slotById(req.params.id);
  if (!slot) return res.status(404).json({ error: 'slot not found' });
  if (!DELIVERY_GENERATION_STATUSES.includes(slot.status) || !canGenerateDeliveryForSlot(slot)) {
    return res.status(409).json({ error: '这个排期已经生成交付或进入派发链路，不能重新生成交付内容' });
  }
  try {
    requireQueueHeadForSlot(req, slot, '生成交付');
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message });
  }
  const result = createDeliveryForSlot(slot);
  if (!result) return res.status(400).json({ error: 'select a candidate first' });
  res.json(result);
});

app.get('/api/slots/:id/delivery-view', (req, res) => {
  const slot = slotById(req.params.id);
  if (!slot) return res.status(404).json({ error: 'slot not found' });
  const view = deliveryViewForSlot(slot);
  if (!view) return res.status(404).json({ error: '还没有可查看的交付内容，请先生成交付内容' });
  res.json(view);
});

app.post('/api/image-tasks', (req, res) => {
  const body = req.body || {};
  const caze = caseById(body.caseId);
  if (!caze) return res.status(404).json({ error: 'case not found' });
  const slot = body.planSlotId ? slotById(body.planSlotId) : null;
  if (body.planSlotId && !slot) return res.status(404).json({ error: 'slot not found' });
  if (slot && slot.caseId !== caze.id) return res.status(400).json({ error: 'slot does not belong to this case' });
  const purpose = String(body.purpose || slot?.contentKind || '').trim();
  if (!purpose) return res.status(400).json({ error: '图片任务必须有明确用途' });
  const outputDir = path.join(caze.localCaseDir, '02-生成补充', safeSegment(purpose));
  fs.mkdirSync(outputDir, { recursive: true });
  const sourceMaterials = Array.isArray(body.sourceMaterials) ? body.sourceMaterials : imageSourceMaterialsFor(caze, slot, purpose);
  const prompt = body.prompt || imagePromptFor(caze, slot, purpose, sourceMaterials);
  const negativePrompt = body.negativePrompt || '过度精修，夸张效果，水印，低清晰度，错误文字，变形肢体，不符合账号人设的场景';
  const status = imageSettings().ready ? 'draft' : 'waiting_key';
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
  const task = rowImageTask(get('SELECT * FROM image_tasks WHERE id = ?', [id]));
  writeImageTaskBrief(task);
  res.json(task);
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

app.get('/api/image-tasks/:id/prompt', (req, res) => {
  const task = rowImageTask(get('SELECT * FROM image_tasks WHERE id = ?', [req.params.id]));
  if (!task) return res.status(404).json({ error: 'image task not found' });
  res.json({ text: imagePromptText(task) });
});

app.post('/api/image-tasks/:id/generate', async (req, res) => {
  const task = rowImageTask(get('SELECT * FROM image_tasks WHERE id = ?', [req.params.id]));
  if (!task) return res.status(404).json({ error: 'image task not found' });
  try {
    res.json(await generateImageFiles(task));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.post('/api/clip-tasks', (req, res) => {
  const body = req.body || {};
  const caze = caseById(body.caseId);
  if (!caze) return res.status(404).json({ error: 'case not found' });
  if (!body.planSlotId) return res.status(400).json({ error: '剪辑任务必须绑定具体排期' });
  const slot = slotById(body.planSlotId);
  if (!slot) return res.status(404).json({ error: 'slot not found' });
  if (slot && slot.caseId !== caze.id) return res.status(400).json({ error: 'slot does not belong to this case' });
  try {
    requireQueueHeadForSlot(req, slot, '创建剪辑任务');
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message });
  }
  const existing = rowClipTask(get('SELECT * FROM clip_tasks WHERE plan_slot_id = ? ORDER BY created_at ASC LIMIT 1', [slot.id]));
  if (existing) return res.json({ ...existing, alreadyExisting: true });
  const selected = slot?.selectedCandidateId ? rowCandidate(get('SELECT * FROM candidate_drafts WHERE id = ?', [slot.selectedCandidateId])) : null;
  const title = body.title || selected?.title || `${caze.weixinNick}剪辑任务`;
  const assets = all('SELECT * FROM assets WHERE case_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 8', [caze.id, '视频']).map(rowAsset);
  const clipContentKind = slot?.contentKind || body.contentKind || '日常养号';
  const editRecipe = fixedEditRecipe(slot || { contentKind: clipContentKind }, caze, selected || { title });
  const generatedBrief = [
    `剪辑任务：${title}`,
    `案例：${caze.caseCode} / ${caze.weixinNick}`,
    `抖音：${douyinAccountText(caze)}`,
    `阶段：${slot?.stage || caze.stage}`,
    `内容类型：${clipContentKind}`,
    `建议比例：9:16`,
    `建议时长：20-35秒`,
    '',
    '发布文案/口播参考：',
    selected ? `${selected.title}\n${selected.publishText}` : '暂无锁定候选，可先按素材做生活化短视频。',
    '',
    editRecipe,
    '',
    '可用视频素材：',
    assets.length ? assets.map((asset, index) => `${index + 1}. ${asset.path}`).join('\n') : '暂无已扫描视频素材，请先放入 00-原始素材 后扫描。',
    '',
    '交付要求：剪完或安排发布后，在系统标记「已完成」；不需要上传成片或把文件放回目录。'
  ].join('\n');
  const brief = body.brief ? `${String(body.brief).trim()}\n\n${editRecipe}` : generatedBrief;
  const id = uid('clip');
  run(
    `INSERT INTO clip_tasks
    (id, case_id, plan_slot_id, title, brief, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      caze.id,
      body.planSlotId,
      title,
      brief,
      body.status || 'waiting_edit',
      now(),
      now()
    ]
  );
  res.json({ ...rowClipTask(get('SELECT * FROM clip_tasks WHERE id = ?', [id])), alreadyExisting: false });
});

app.patch('/api/clip-tasks/:id', (req, res) => {
  const task = rowClipTask(get('SELECT * FROM clip_tasks WHERE id = ?', [req.params.id]));
  if (!task) return res.status(404).json({ error: 'clip task not found' });
  const body = req.body || {};
  const nextStatus = body.status ?? task.status;
  try {
    if (nextStatus !== task.status) requireQueueHeadForClipTask(req, task, '改状态');
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message });
  }
  if (nextStatus === 'completed' && task.status !== 'completed' && body.recipeConfirmed !== true) {
    return res.status(409).json({ error: '完成剪辑前必须先确认已看完固定剪辑配方' });
  }
  run(
    `UPDATE clip_tasks SET title = ?, brief = ?, status = ?, updated_at = ? WHERE id = ?`,
    [
      body.title ?? task.title,
      body.brief ?? task.brief,
      nextStatus,
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
  const sourceLink = String(body.sourceLink || '').trim();
  const rawText = String(body.rawText || '').trim();
  const hotStructure = String(body.hotStructure || '').trim();
  const title = String(body.title || '').trim();
  const category = String(body.category || '').trim();
  const rewritePolicy = String(body.rewritePolicy || '').trim();
  const hasAnalysis = Boolean(rawText || hotStructure);
  if (!sourceLink && !hasAnalysis) {
    return res.status(400).json({ error: '请先粘贴爆款视频链接，或由系统写入完整分析内容' });
  }
  const id = uid('viral');
  const linkOnly = Boolean(sourceLink) && !hasAnalysis;
  run(
    `INSERT INTO viral_templates
    (id, title, raw_text, source_link, category, hot_structure, suitable_personas, forbidden_personas, rewrite_policy, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      title || (linkOnly ? `待分析爆款链接 ${new Date().toISOString().slice(0, 10)}` : '未命名爆款模板'),
      rawText || (linkOnly ? '待分析：待提取原视频内容' : ''),
      sourceLink,
      category || (linkOnly ? '待分析' : '情绪'),
      hotStructure || (linkOnly ? '待分析后补充：标题、正文、爆点结构、适合人设和下一步建议' : '开头提出共鸣问题，中段列出3个细节，结尾引导评论'),
      JSON.stringify(body.suitablePersonas || []),
      JSON.stringify(body.forbiddenPersonas || []),
      rewritePolicy || (linkOnly ? '仅参考' : '结构模仿'),
      now(),
      now()
    ]
  );
  res.json(rowViral(get('SELECT * FROM viral_templates WHERE id = ?', [id])));
});

app.patch('/api/viral-templates/:id', (req, res) => {
  const viral = rowViral(get('SELECT * FROM viral_templates WHERE id = ?', [req.params.id]));
  if (!viral) return res.status(404).json({ error: 'viral template not found' });
  const body = req.body || {};
  run(
    `UPDATE viral_templates
    SET title = ?, raw_text = ?, source_link = ?, category = ?, hot_structure = ?, suitable_personas = ?, forbidden_personas = ?, rewrite_policy = ?, updated_at = ?
    WHERE id = ?`,
    [
      body.title ?? viral.title,
      body.rawText ?? viral.rawText,
      body.sourceLink ?? viral.sourceLink,
      body.category ?? viral.category,
      body.hotStructure ?? viral.hotStructure,
      JSON.stringify(body.suitablePersonas ?? viral.suitablePersonas),
      JSON.stringify(body.forbiddenPersonas ?? viral.forbiddenPersonas),
      body.rewritePolicy ?? viral.rewritePolicy,
      now(),
      viral.id
    ]
  );
  res.json(rowViral(get('SELECT * FROM viral_templates WHERE id = ?', [viral.id])));
});

app.get('/api/viral-templates/:id/analysis-task', (req, res) => {
  const viral = rowViral(get('SELECT * FROM viral_templates WHERE id = ?', [req.params.id]));
  if (!viral) return res.status(404).json({ error: 'viral template not found' });
  res.json({ text: viralAnalysisTaskText(viral) });
});

app.post('/api/viral-templates/:id/analysis-result', (req, res) => {
  const viral = rowViral(get('SELECT * FROM viral_templates WHERE id = ?', [req.params.id]));
  if (!viral) return res.status(404).json({ error: 'viral template not found' });
  let result;
  try {
    result = normalizeViralAnalysisResult(req.body || {});
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message });
  }
  run(
    `UPDATE viral_templates
    SET title = ?, raw_text = ?, category = ?, hot_structure = ?, suitable_personas = ?, forbidden_personas = ?, rewrite_policy = ?, updated_at = ?
    WHERE id = ?`,
    [
      result.title,
      result.rawText,
      result.category,
      result.hotStructure,
      JSON.stringify(result.suitablePersonas),
      JSON.stringify(result.forbiddenPersonas),
      result.rewritePolicy,
      now(),
      viral.id
    ]
  );
  res.json(rowViral(get('SELECT * FROM viral_templates WHERE id = ?', [viral.id])));
});

app.post('/api/viral-templates/:id/bulk-generate', (req, res) => {
  const viral = rowViral(get('SELECT * FROM viral_templates WHERE id = ?', [req.params.id]));
  if (!viral) return res.status(404).json({ error: 'viral template not found' });
  if (isPendingViralTemplate(viral)) {
    return res.status(409).json({ error: '这个爆款链接还没完成内容提取和结构分析，先不要批量生成' });
  }
  const body = req.body || {};
  const targetDate = body.date || new Date().toISOString().slice(0, 10);
  const cases = all('SELECT * FROM cases ORDER BY created_at ASC').map(rowCase);
  const created = [];
  const skipped = [];
  cases.forEach((caze) => {
    if (!viralSuitableForCase(viral, caze)) {
      skipped.push({ caseId: caze.id, weixinNick: caze.weixinNick, reason: '人设或项目不适合' });
      return;
    }
    const postingStrategy = postingStrategyForCase(caze);
    if (postingStrategy.intervalDays <= 0 || caseIsPaused(caze)) {
      skipped.push({ caseId: caze.id, weixinNick: caze.weixinNick, reason: postingStrategy.reason || '账号已暂停，不生成爆款任务' });
      return;
    }
    if (!shouldCreateSlotForDate(caze, targetDate, postingStrategy)) {
      skipped.push({ caseId: caze.id, weixinNick: caze.weixinNick, reason: postingStrategy.reason || '当前日期不在这个账号的投放频率内' });
      return;
    }
    const goal = `爆款提权：按「${viral.title}」做人设化改写`;
    const existing = rowSlot(get(
      'SELECT * FROM plan_slots WHERE case_id = ? AND date = ? AND content_kind = ? AND goal = ? LIMIT 1',
      [caze.id, targetDate, '爆款提权', goal]
    ));
    if (existing) {
      skipped.push({ caseId: caze.id, weixinNick: caze.weixinNick, reason: '已有同一天同爆款任务' });
      return;
    }
    const slot = createSlotForCase(caze, {
      date: targetDate,
      timeWindow: body.timeWindow || '19:00-21:00',
      contentKind: '爆款提权',
      stage: caze.stage,
      status: '候选待选',
      goal
    });
    ['稳妥版', '互动版', '爆款结构版'].forEach((variant) => createCandidate(slot, caze, variant, viral, null));
    created.push(slotById(slot.id));
  });
  res.json({ createdCount: created.length, skippedCount: skipped.length, slots: created, skipped });
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

app.use('/api', (_req, res) => res.status(404).json({ error: 'api not found' }));

app.use('/files', express.static(MATERIAL_ROOT));
app.use('/shared-files', express.static(SHARED_MATERIAL_ROOT));
app.use('/files', (_req, res) => res.status(404).json({ error: 'file not found' }));
app.use('/shared-files', (_req, res) => res.status(404).json({ error: 'file not found' }));

seedDefaultContentSeeds();

if (fs.existsSync(path.join(process.cwd(), 'dist'))) {
  app.use(express.static(path.join(process.cwd(), 'dist')));
  app.get('*splat', (_req, res) => res.sendFile(path.join(process.cwd(), 'dist', 'index.html')));
}

app.listen(PORT, LISTEN_HOST, () => {
  const network = networkSettings();
  console.log(`API running at ${network.localUrl}`);
  if (network.lanEnabled && network.lanUrls.length) {
    console.log(`LAN workbench: ${network.lanUrls.join(' / ')}`);
    console.log(`LAN access code: ${network.accessCodeRequired ? 'enabled' : 'not set'}`);
  }
  console.log(`Material root: ${MATERIAL_ROOT}`);
});

function runScheduledDouyinCollection(source) {
  enqueueDouyinCollection(source).catch((error) => {
    console.error(`Douyin monitor schedule failed: ${error.message}`);
  });
}

if (DOUYIN_COLLECTION_CHECK_INTERVAL_MS > 0) {
  const startupTimer = setTimeout(() => runScheduledDouyinCollection('startup'), 2000);
  startupTimer.unref?.();
  const timer = setInterval(() => runScheduledDouyinCollection('scheduled'), DOUYIN_COLLECTION_CHECK_INTERVAL_MS);
  timer.unref?.();
}
