import fs from 'node:fs';
import path from 'node:path';

const APP_DIR = path.resolve(import.meta.dirname, '..');
const ROOT_DIR = path.resolve(APP_DIR, '..');
const required = [
  path.join(APP_DIR, 'package.json'),
  path.join(APP_DIR, 'server', 'index.js'),
  path.join(APP_DIR, 'server', 'db.js'),
  path.join(APP_DIR, 'electron', 'main.cjs'),
  path.join(APP_DIR, 'src', 'main.jsx'),
  path.join(APP_DIR, 'src', 'styles.css'),
  path.join(APP_DIR, 'scripts', 'douyin-chrome-collector.js')
];

function ok(message) {
  console.log(`OK ${message}`);
}

function warn(message) {
  console.log(`WARN ${message}`);
}

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
}

const major = Number(process.versions.node.split('.')[0]);
if (major >= 24) ok(`Node.js ${process.versions.node}`);
else fail(`Node.js ${process.versions.node}，需要 24+ 以使用 node:sqlite`);

try {
  await import('node:sqlite');
  ok('node:sqlite 可用');
} catch (error) {
  fail(`node:sqlite 不可用：${error.message}`);
}

required.forEach((file) => {
  if (fs.existsSync(file)) ok(`存在 ${path.relative(ROOT_DIR, file)}`);
  else fail(`缺少 ${path.relative(ROOT_DIR, file)}`);
});

const mainSource = fs.readFileSync(path.join(APP_DIR, 'src', 'main.jsx'), 'utf8');
const styleSource = fs.readFileSync(path.join(APP_DIR, 'src', 'styles.css'), 'utf8');
const dbSource = fs.readFileSync(path.join(APP_DIR, 'server', 'db.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(APP_DIR, 'server', 'index.js'), 'utf8');
const packageSource = fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8');
const envExampleSource = fs.readFileSync(path.join(APP_DIR, '.env.example'), 'utf8');
const smokeSource = fs.readFileSync(path.join(APP_DIR, 'scripts', 'e2e-smoke.js'), 'utf8');
const collectorSource = fs.readFileSync(path.join(APP_DIR, 'scripts', 'douyin-chrome-collector.js'), 'utf8');
const readmeSource = [
  fs.readFileSync(path.join(ROOT_DIR, 'README.md'), 'utf8'),
  fs.readFileSync(path.join(APP_DIR, 'README.md'), 'utf8')
].join('\n');
const sopSource = fs.readFileSync(path.join(ROOT_DIR, '日常运营SOP.md'), 'utf8');
const duplicateDashboardLabels = ['新手今日顺序', '今日链路复盘', '今天全部任务', '可微信交付', '待选择候选', '待生成候选稿', '今天先处理'];
const leakedLabels = duplicateDashboardLabels.filter((label) => mainSource.includes(label));
if (leakedLabels.length) fail(`首页仍包含重复任务区块：${leakedLabels.join('、')}`);
else ok('首页任务入口已收敛为单一操作队列');

if (!mainSource.includes('一键准备今日交付') && !mainSource.includes('/dashboard/prepare-today')) ok('首页不暴露批量准备入口');
else fail('首页仍有绕过队首的一键批量准备入口');

const nonDeliveryCopyLabels = ['复制补素材说明', '复制分析任务', '复制任务单', '复制图片提示词'];
const leakedCopyLabels = nonDeliveryCopyLabels.filter((label) => mainSource.includes(label));
if (leakedCopyLabels.length) fail(`非交付复制按钮仍存在：${leakedCopyLabels.join('、')}`);
else ok('复制入口只保留在交付内容弹窗');

const localPathOpenLabels = ['打开目录', '打开根目录', '打开素材目录', '打开共享目录', '打开素材'];
const leakedLocalPathOpenLabels = localPathOpenLabels.filter((label) => mainSource.includes(label));
if (
  !leakedLocalPathOpenLabels.length &&
  !mainSource.includes('/open-path') &&
  !serverSource.includes("app.post('/api/open-path'") &&
  !serverSource.includes('canOpenLocalPaths') &&
  !serverSource.includes('openLocalPath')
) ok('前台和后端不再提供打开本地目录入口');
else fail(`仍保留打开本地目录入口：${leakedLocalPathOpenLabels.join('、') || '后端残留'}`);

const viralAnalysisFields = ['补分析结果', '编辑分析', '原视频内容', '适合人设关键词', '禁用人设关键词', '保存分析'];
const leakedViralAnalysisFields = viralAnalysisFields.filter((label) => mainSource.includes(label));
if (!mainSource.includes('onEdit={(item)') && !mainSource.includes('editingViral') && !leakedViralAnalysisFields.length && mainSource.includes('等待系统分析')) ok('爆款链接前台只收链接，不要求工作人员填写分析字段');
else fail(`爆款链接前台仍暴露分析字段：${leakedViralAnalysisFields.join('、') || '编辑入口'}`);

if (serverSource.includes('/api/viral-templates/:id/analysis-result') && serverSource.includes('normalizeViralAnalysisResult') && serverSource.includes('爆款分析结果缺少') && smokeSource.includes('viral analysis result accepted incomplete payload') && smokeSource.includes('/analysis-result')) ok('爆款链接有后台分析写回接口，且不接受半分析结果');
else fail('爆款链接缺少专用分析写回接口，或未验证半分析结果会被拒绝');

if (
  serverSource.includes("app.get('/api/agent-work'")
  && serverSource.includes('function agentWorkQueue')
  && mainSource.includes('className="panel systemBackstage"')
  && mainSource.includes('<h2>系统后台</h2>')
  && mainSource.includes('<h2>素材保存位置</h2>')
  && mainSource.includes('/agent-work')
  && !mainSource.includes('主机侧工作清单')
  && !mainSource.includes('{item.endpoint}')
  && !mainSource.includes('<h2>本地素材根目录</h2>')
  && smokeSource.includes('agent work queue missing pending viral analysis')
) ok('后台动作聚合爆款分析、采集和图片任务，默认折叠且不暴露技术接口或独立本地目录面板');
else fail('缺少折叠的系统后台，或仍暴露技术接口/本地目录旧口径');

if (serverSource.includes('DEFAULT_IMAGE_API_URL') && serverSource.includes("DEFAULT_IMAGE_MODEL = 'gpt-image-1'") && serverSource.includes('apiUrlDefaulted') && !serverSource.includes('IMAGE_API_KEY 和 IMAGE_API_URL') && !readmeSource.includes('同时填写 `IMAGE_API_KEY` 和 `IMAGE_API_URL`') && smokeSource.includes('image config should be ready with key only')) ok('图片接口只要求 IMAGE_API_KEY，接口地址仅作为可选覆盖');
else fail('图片接口仍要求同时填写 key 和 URL，或缺少 key-only 验收');

if (mainSource.includes('disabled={!ready}') && mainSource.includes('sourceLink: form.sourceLink.trim()') && serverSource.includes('请先粘贴爆款视频链接') && smokeSource.includes('blankViralRejected')) ok('空爆款链接不会生成假模板');
else fail('空爆款链接仍可能生成假模板');

if (!mainSource.includes('window.prompt') && mainSource.includes('LibraryCaseForm') && mainSource.includes('ViralBulkForm')) ok('案例登记和爆款生成不再使用浏览器临时输入框');
else fail('前台仍存在浏览器临时输入框，或缺少正式登记/生成弹窗');

if (
  !mainSource.includes('window.confirm')
  && mainSource.includes('DeleteCaseModal')
  && mainSource.includes('const deletePhrase = `删除 ${deleteName}`')
  && mainSource.includes("confirmText.trim() === deletePhrase")
  && mainSource.includes('placeholder={`输入：${deletePhrase}`}')
) ok('删除案例必须输入删除加微信昵称，使用工作台内确认弹窗');
else fail('删除案例仍使用浏览器原生确认框，或缺少绑定账号的明确删除确认');

if (
  mainSource.includes('今日操作队列') &&
  mainSource.includes('后续账号预览') &&
  mainSource.includes('accountOverviewDetails') &&
  !mainSource.includes('今日账号概览')
) ok('首页只默认展开队首动作，后续账号改为折叠预览');
else fail('首页仍可能默认铺开后续账号，分散当前队首处理');

if (
  mainSource.includes('className="accountOverviewDetails abnormalDetails"') &&
  mainSource.includes('只做提醒，不抢当前队首') &&
  styleSource.includes('.accountOverviewDetails .caseGrid') &&
  styleSource.includes('.accountOverviewDetails:not([open]) > .caseGrid') &&
  !mainSource.includes('<div className="sectionHead">\n          <h2>异常账号</h2>')
) ok('异常账号默认折叠成提醒，不在首页铺开抢当前任务');
else fail('异常账号仍可能默认铺开，分散工作人员处理当前队首');

if (mainSource.includes('>运行状态</button>') && !mainSource.includes('>系统配置</button>')) ok('前台导航不再显示系统配置入口');
else fail('前台导航仍暴露系统配置旧口径');

if (mainSource.includes('activePriority') && mainSource.includes('queueSummary') && mainSource.includes('只做这一条') && mainSource.includes('后面已锁住')) ok('今日队列只开放队首任务操作');
else fail('今日队列缺少队首防呆状态');

if (
  serverSource.includes('function dashboardPriorityActions')
  && serverSource.includes('priorityActions,')
  && serverSource.includes('queueHead: priorityActions[0] || null')
  && serverSource.includes('return Array.isArray(data.priorityActions) ? data.priorityActions[0] || null : null')
  && mainSource.includes('const priorityActions = data.priorityActions || []')
  && mainSource.includes('dashboard?.queueHead || dashboard?.priorityActions?.[0]')
  && !mainSource.includes('function buildPriorityActions')
  && !mainSource.includes('function firstPriorityAction')
  && !mainSource.includes('function monitorActionClass')
) ok('今日队列由后端单一真源排序，前端不再重复拼队列');
else fail('今日队列前后端仍可能各自排序，导致队首不一致');

if (
  serverSource.includes("pendingGenerate: dueSlots.filter((s) => s.status === '待生成').map(withCase)")
  && serverSource.includes("readyDelivery: dueSlots.filter((s) => s.status === '可交付').map(withCase)")
  && serverSource.includes('imageTasks: openImageTasks\n      .map')
  && serverSource.includes('clipTasks: openClipTasks\n      .map')
  && !serverSource.includes("pendingGenerate: dueSlots.filter((s) => s.status === '待生成').slice")
  && !serverSource.includes("readyDelivery: dueSlots.filter((s) => s.status === '可交付').slice")
  && smokeSource.includes('dashboard ready delivery queue was truncated before 35 items')
) ok('今日操作队列不按 20/30 条截断，可覆盖上百账号');
else fail('今日操作队列仍可能被服务端截断，管理上百账号时会漏任务');

if (
  serverSource.includes('function localDate(value = new Date())')
  && serverSource.includes('return localDate(d);')
  && mainSource.includes('function formatLocalDate(value = new Date())')
  && mainSource.includes('return formatLocalDate();')
  && !serverSource.includes('toISOString().slice(0, 10)')
  && !mainSource.includes('toISOString().slice(0, 10)')
  && smokeSource.includes('dashboard today should use local date')
) ok('今日日期使用本机本地日期，不用 UTC 日期切片');
else fail('今日日期仍可能按 UTC 计算，晚上会错到明天');

if (mainSource.includes('focusMeta') && mainSource.includes('微信：') && mainSource.includes('抖音：') && mainSource.includes('项目：')) ok('队首任务直接显示当前收件账号');
else fail('队首任务缺少收件账号信息');

if (
  mainSource.includes('douyinDisplay') &&
  mainSource.includes("return douyinUrl || '未填抖音链接'") &&
  serverSource.includes('function douyinAccountText') &&
  serverSource.includes("return douyinUrl || '未填抖音链接'") &&
  !mainSource.includes('未填抖音号') &&
  !mainSource.includes('抖音号<input') &&
  !mainSource.includes('return `${douyinId} / ${douyinUrl}`') &&
  !serverSource.includes('return `${douyinId} / ${douyinUrl}`')
) ok('前台和交付文本只显示抖音链接，不展示派生抖音号');
else fail('前台仍把必填抖音链接显示成旧抖音号口径');

if (mainSource.includes('activeCaseId') && mainSource.includes('排到今日队列队首后打开') && mainSource.includes('isActiveQueueCase')) ok('后续账号预览和异常账号不能打开非队首账号');
else fail('首页仍可能从后续预览或异常账号绕过队首打开账号');

if (mainSource.includes('const accountGroups = groupQueueByAccount(priorityActions)') && !mainSource.includes('const accountGroups = groupTodayByAccount(data.todaySlots)') && mainSource.includes('actionCounts') && mainSource.includes('同账号动作') && mainSource.includes('个待处理账号')) ok('后续账号预览按操作队列聚合，不只看排期槽位');
else fail('后续账号预览仍可能只按今日排期显示，漏掉素材同步、剪辑或爆款互动');

if (
  mainSource.includes('function ReviewView({ data })') &&
  mainSource.includes('具体处理回到今日操作队列') &&
  mainSource.includes('className="metricName"') &&
  !mainSource.includes('<ReviewView data={review} onOpenCase={openCase} />') &&
  readmeSource.includes('数据复盘只看趋势和表现') &&
  sopSource.includes('「数据复盘」只用于看趋势')
) ok('数据复盘页只读，不再提供打开案例的执行入口');
else fail('数据复盘页仍可能绕过今日队列打开案例或文档未说明只读边界');

if (
  mainSource.includes('function ScheduleView({ data })') &&
  mainSource.includes('这里只看安排，不做执行') &&
  mainSource.includes('function ScheduleRow({ slot })') &&
  mainSource.includes('回今日操作队列处理') &&
  !mainSource.includes('<ScheduleView data={schedule} onOpenCase={openCase}') &&
  !mainSource.includes('<ScheduleRow key={slot.id} slot={slot} onOpenCase=') &&
  !mainSource.includes('function ScheduleRow({ slot, onOpenCase') &&
  readmeSource.includes('排期规划只看未来安排') &&
  sopSource.includes('排期规划」只用于看安排')
) ok('排期规划页只读，不再提供生成、交付或打开案例入口');
else fail('排期规划页仍可能绕过今日队列执行任务或文档未说明只读边界');

if (serverSource.includes('function caseIntakeIssue') && serverSource.includes('intakeIssues: intakeIssueRows') && serverSource.includes("kind: '补登记'") && serverSource.includes('缺少抖音链接') && serverSource.includes('缺少项目') && serverSource.includes('缺少共享原始素材路径') && serverSource.includes('点“补资料”直接填写缺失项') && mainSource.includes('item.intakeIssue') && smokeSource.includes('legacy missing account did not enter intake issue queue') && smokeSource.includes("intakeIssue.issues.includes('缺少项目')")) ok('旧账号缺抖音、项目或共享素材路径会进入补登记队列');
else fail('缺登记资料的旧账号仍可能躲在异常列表之外，不进入首页队列');

if (
  serverSource.includes('intakeBlockedCaseIds')
  && serverSource.includes('caseHasCompleteIntake')
  && serverSource.includes('const dueSlots = allDueSlots.filter((s) => caseHasCompleteIntake(s.caseId))')
  && serverSource.includes('caseIsIntakeBlocked')
  && smokeSource.includes('intake issue should gate other queue actions for same account')
  && smokeSource.includes('intake issue ready delivery leaked into dashboard delivery queue')
) ok('补登记是账号级前置门禁，资料缺失账号不会同时交付、生成或剪辑');
else fail('资料缺失账号仍可能带着交付、生成或剪辑动作进入首页队列');

if (
  mainSource.includes('caseEditRequest')
  && mainSource.includes("onOpenCase(item.case.id, { edit: true, returnToDashboard: true })")
  && mainSource.includes('editRequest?.token')
  && mainSource.includes('onAfterEditSaved?.({ returnToDashboard })')
  && mainSource.includes("setView('dashboard')")
  && serverSource.includes('点“补资料”直接填写缺失项')
  && mainSource.includes('点补资料直接补齐缺失登记项')
  && smokeSource.includes('intake issue queue still tells staff to use the old edit flow')
  && !serverSource.includes('打开案例，点“编辑案例”')
) ok('队首补资料直接打开编辑弹窗，保存后回到首页队列');
else fail('补登记仍需要先打开案例再手动找编辑入口，或保存后不能回到首页队列');

if (serverSource.includes('dashboardQueueHead') && serverSource.includes('当前队首不是准备类任务') && !serverSource.includes('for (const slot of dueSlots)')) ok('后台准备接口也只处理当前队首');
else fail('后台准备接口仍可能批量推进今日队列');

if (serverSource.includes('当前队首不是待生成任务，不能越过队首批量生成') && serverSource.includes('当前队首不是已锁定任务，不能越过队首批量生成交付') && !serverSource.includes('SELECT * FROM plan_slots WHERE date <= ? AND status = ? ORDER BY date ASC, created_at ASC') && !serverSource.includes('SELECT * FROM plan_slots WHERE date <= ? AND status = ? AND selected_candidate_id IS NOT NULL ORDER BY date ASC, created_at ASC')) ok('后台生成和交付接口也只处理当前队首');
else fail('后台生成或交付接口仍可能越过队首批量处理');

if (mainSource.includes('activeQueueMatchesSlot') && mainSource.includes('activeQueueMatchesClip') && mainSource.includes('activeQueueMatchesAlert') && mainSource.includes('排到今日队列队首后处理') && mainSource.includes('这条不是今日操作队列的当前任务') && mainSource.includes("copyAllowed = view.slot.status === '可交付' && isActiveQueueSlot") && serverSource.includes('requireQueueHeadForSlot') && serverSource.includes('requireQueueHeadForAlert') && serverSource.includes('requireQueueHeadForClipTask') && smokeSource.includes('non-head slot was allowed to generate candidates') && smokeSource.includes('non-head slot was allowed to generate delivery')) ok('二级页面和后端接口都不能绕过今日队首执行交付、剪辑和爆款互动动作');
else fail('排期规划、案例详情或后端接口仍可能绕过今日队首处理任务');

if (mainSource.includes('activeQueueMatchesCaseMaterial') && mainSource.includes('canRunMaterialActions') && mainSource.includes('素材动作排到今日队列队首后处理') && !mainSource.includes('>同步共享素材</button>\n          <button onClick')) ok('案例详情素材同步和扫描也受队首限制');
else fail('案例详情仍可能绕过今日队首执行素材同步或扫描');

if (mainSource.includes('素材标记排到今日队列队首后处理') && mainSource.includes('素材缺口排到今日队列队首后处理') && mainSource.includes('图片任务排到今日队列队首后处理') && mainSource.includes('canRunMaterialActions && REVIEW_ACTIONS')) ok('素材标记、缺口建图和图片审核也受队首限制');
else fail('案例详情仍可能绕过今日队首执行素材标记、缺口建图或图片审核');

if (
  !mainSource.includes('重 roll') &&
  !mainSource.includes('标记待审核') &&
  !mainSource.includes('标记通过') &&
  !mainSource.includes('标记驳回') &&
  !mainSource.includes('待审核') &&
  !mainSource.includes('已通过') &&
  !mainSource.includes('已驳回') &&
  !serverSource.includes('标记待审核') &&
  !serverSource.includes('已通过') &&
  !serverSource.includes('已驳回') &&
  !mainSource.includes('待确认</button>') &&
  !mainSource.includes('等确认</button>') &&
  !mainSource.includes('退回处理') &&
  !mainSource.includes('需要重剪') &&
  !mainSource.includes('已按配方完成') &&
  mainSource.includes('重新生成候选') &&
  mainSource.includes('暂缓这条') &&
  mainSource.includes('待检查') &&
  mainSource.includes('剪辑已完成')
) ok('候选、图片和剪辑使用日常话术，不暴露技术口径');
else fail('候选、图片或剪辑仍有重 roll、审核、驳回等技术口径');

if (!mainSource.includes('内容阶段比例') && !mainSource.includes('<h2>素材模板</h2>') && !serverSource.includes('stageRatios: STAGE_RATIOS') && !serverSource.includes('materialTemplates: MATERIAL_TEMPLATES')) ok('运行状态不暴露后台阶段比例和素材模板');
else fail('运行状态仍暴露后台阶段比例或素材模板');

if (mainSource.includes('系统验收清单') && mainSource.includes('readinessChecks') && mainSource.includes('readinessStatusLabel')) ok('运行状态展示简短验收清单');
else fail('运行状态缺少 SOP 要求的验收清单');

if (
  mainSource.includes('通用素材校准')
  && mainSource.includes('只在自动分类不准时展开')
  && mainSource.includes('不用于发送给兼职')
  && mainSource.includes('fileDisplayName(asset.path)')
  && !mainSource.includes('通用素材管理')
  && !mainSource.includes("asset.url && <a className=\"button\" href={asset.url} download")
  && !mainSource.includes("'下载素材'")
  && !mainSource.includes('compactActions')
  && readmeSource.includes('通用素材校准')
  && sopSource.includes('通用素材校准')
  && !readmeSource.includes('网页内预览、下载')
  && !sopSource.includes('通用素材管理')
) ok('通用素材只作为折叠校准区，不提供非交付下载入口或完整路径');
else fail('通用素材仍可能在前台默认展开、暴露下载入口、完整路径或旧管理口径');

if (
  !mainSource.includes('SOUREN_ACCESS_CODE') &&
  !mainSource.includes('SOUREN_HOST') &&
  !mainSource.includes('等待Key') &&
  !mainSource.includes('等待Chrome') &&
  !serverSource.includes('设置 SOUREN_HOST=0.0.0.0 后可') &&
  !serverSource.includes('默认使用 Chrome 登录态采集清单') &&
  mainSource.includes('开放局域网前请先设置访问码') &&
  mainSource.includes('等密钥') &&
  serverSource.includes('开启局域网访问和访问码') &&
  serverSource.includes('主机浏览器登录态采集清单')
) ok('运行状态前台不暴露英文环境变量、Key 或 Chrome 状态口径');
else fail('运行状态前台仍暴露英文环境变量、Key 或 Chrome 状态口径');

if (
  mainSource.includes('开启局域网访问') &&
  mainSource.includes('关闭局域网访问') &&
  mainSource.includes("request('/network/lan-access'") &&
  mainSource.includes('访问码：{lanSetup.accessCode}') &&
  mainSource.includes('只允许本机使用') &&
  serverSource.includes("app.post('/api/network/lan-access'") &&
  serverSource.includes('localControlOnly(req, res)') &&
  serverSource.includes('writeRuntimeEnvUpdates') &&
  serverSource.includes("action === 'disable'") &&
  serverSource.includes("SOUREN_HOST: '127.0.0.1'") &&
  serverSource.includes('SOUREN_ENV_PATH') &&
  fs.readFileSync(path.join(APP_DIR, 'electron', 'main.cjs'), 'utf8').includes('SOUREN_ENV_PATH') &&
  smokeSource.includes('LAN enable did not write generated access code') &&
  smokeSource.includes('LAN disable did not restore local host')
) ok('本机运行状态可一键开启或关闭局域网访问配置，重启后给工作人员使用');
else fail('局域网访问仍需要工作人员手改配置，或缺少本机专用开关保护');

const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
if (pkg.scripts?.['client:verify']?.includes('client:mac') && pkg.scripts?.['client:verify']?.includes('client:package:check')) ok('客户端可一条命令打包并启动验收');
else fail('客户端缺少一条命令打包验收脚本');

if (
  mainSource.includes('今天发完了，剩下只等对方回复，不算漏发。') &&
  mainSource.includes('当前微信：{activeItem.case.weixinNick}') &&
  mainSource.includes('后面已锁住 {queuedItems.length} 条') &&
  mainSource.includes('不用提前检查，也不能跳做') &&
  !mainSource.includes('summarizeQueuedKinds') &&
  !mainSource.includes('今天没有必须处理的动作')
) ok('今日队列清空后有明确完工状态，队首只聚焦当前微信');
else fail('今日队列清空状态仍不明确');

if (serverSource.includes('ACTIVE_OPERATOR_STATUSES') && serverSource.includes("'已派发', '异常'") && !serverSource.includes("ACTIVE_OPERATOR_STATUSES = ['待生成', '候选待选', '已锁定', '素材阻塞', '可交付', '已派发', '已完成'")) ok('已完成任务不再留在今日操作队列');
else fail('已完成任务仍可能留在今日操作队列');

if (
  serverSource.includes('剪辑填空卡') &&
  serverSource.includes('只换这些空') &&
  serverSource.includes('镜头固定模板') &&
  serverSource.includes('不临时改结构') &&
  mainSource.includes('function ClipFillCard') &&
  mainSource.includes('结构不重新想') &&
  smokeSource.includes('clip brief missing fill-in recipe card')
) ok('视频交付和剪辑任务内置固定剪辑填空卡');
else fail('缺少固定剪辑配方');

if (!mainSource.includes('成片保存到') && !mainSource.includes('封面保存到') && !serverSource.includes('07-成片回收说明') && !serverSource.includes('final.mp4 放回') && serverSource.includes('不需要上传成片')) ok('视频剪辑完成后只标记完成，不要求上传成片');
else fail('视频剪辑仍要求上传成片或保存到本地目录');

const retiredReturnDir = '04-' + '发布回收';
const retiredReturnLabel = '发布' + '回收';
if (![serverSource, dbSource, readmeSource].some((source) => source.includes(retiredReturnDir) || source.includes(retiredReturnLabel))) ok('新案例不再创建旧回收目录');
else fail('仍保留旧回收目录');

const clipTaskSchema = dbSource.match(/CREATE TABLE IF NOT EXISTS clip_tasks \([\\s\\S]*?\);/)?.[0] || '';
if (
  !mainSource.includes('打开剪辑目录') &&
  !mainSource.includes('task.outputDir') &&
  !mainSource.includes('clipTask.outputDir') &&
  !serverSource.includes('剪辑任务单.txt') &&
  !serverSource.includes("const outputDir = '';") &&
  !serverSource.includes('final_video_path') &&
  !clipTaskSchema.includes('output_dir') &&
  !clipTaskSchema.includes('final_video_path')
) ok('剪辑任务只在网页内展示，不保留本地输出字段、任务单或打开目录');
else fail('剪辑任务仍保留本地输出字段、目录或任务单');

if (!mainSource.includes('等回传') && !serverSource.includes('回传要求') && !serverSource.includes('sentWaitReport') && mainSource.includes('等待兼职确认') && serverSource.includes('sentWaitDone')) ok('已派发任务统一为等待确认口径');
else fail('已派发任务仍保留回传口径或旧计数字段');

if (serverSource.includes('autoPauseLostContactCases') && serverSource.includes('失联暂停') && serverSource.includes('不进入采集队列') && !mainSource.includes('确认暂停') && smokeSource.includes('lost account should not ask staff to confirm pause')) ok('失联账号自动暂停排期和采集，不再占用首页队列');
else fail('失联账号仍可能要求工作人员确认暂停，或缺少自动暂停验收');

if (serverSource.includes("joinedViralAlerts('va.status = ?', ['active'], 30)") && serverSource.includes('!caseIsPaused(byCase[alert.caseId])')) ok('暂停账号的爆款提醒不会回到今日队列');
else fail('暂停账号的爆款提醒仍可能进入今日队列');

if (serverSource.includes('/api/cases/:id/resume') && serverSource.includes('已取消') && mainSource.includes('恢复账号')) ok('失联暂停账号支持一键恢复');
else fail('缺少失联暂停账号恢复闭环');

if (serverSource.includes('pauseCaseWork') && serverSource.includes('PAUSE_CANCEL_SLOT_STATUSES') && serverSource.includes("status = ?, finished_at = ?, note = ?, updated_at = ?") && smokeSource.includes('auto-paused lost account still has active slots')) ok('自动暂停会撤下未完成排期和等待中的采集单');
else fail('自动暂停仍可能只隐藏账号，不撤下旧任务或采集单');

if (serverSource.includes('这个爆款链接还没完成内容提取和结构分析') && serverSource.includes('已有同一天同爆款任务') && serverSource.includes('viralSuitableForCase') && serverSource.includes('shouldCreateSlotForDate(caze, targetDate, postingStrategy)') && !mainSource.includes("kind: '爆款分析'")) ok('爆款批量生成只进入可投放账号且不占用今日队列');
else fail('爆款批量生成仍可能制造无效任务或占用今日队列');

if (serverSource.includes('nextOpenStrategyDate') && serverSource.includes('existingStrategySlot') && serverSource.includes('账号已暂停或休眠，先不生成新的排期') && serverSource.includes('当天已有排期，先不额外加任务')) ok('账号策略动作按投放频率找空档，不给暂停或休眠账号造任务');
else fail('账号策略动作仍可能给暂停、休眠或已有排期账号制造新任务');

if (serverSource.includes('reconcilePendingScheduleForCase') && serverSource.includes('scheduleMaintenance') && serverSource.includes('prunePendingSlotsForStrategy(current, postingStrategy') && serverSource.includes('cancelPreparedSlotsForStrategy(current, postingStrategy') && smokeSource.includes('sleeping ingest did not cancel prepared unsent slots')) ok('采集写入后会按账号策略裁剪未来待生成任务并撤下未派发旧任务');
else fail('采集写入后仍可能留下旧的未来待生成或已准备未派发任务');

if (serverSource.includes('collectionPriorityFor') && serverSource.includes("item.activityTier === '起量'") && serverSource.includes("item.activityTier === '休眠'") && serverSource.includes('collectionPriorityFor(b) - collectionPriorityFor(a)') && serverSource.includes('item.collectionPolicy?.intervalHours != null')) ok('Chrome采集清单按活跃度优先，不按账号数硬跑');
else fail('Chrome采集清单缺少活跃度优先排序');

if (serverSource.includes('async function enqueueDouyinCollection') && serverSource.includes('const queue = registerChromeCollectionQueue({ limit: 200, source })') && serverSource.includes('const toRegister = queue.targets.filter((target) => !target.collectionQueued)') && serverSource.includes("setTimeout(() => runScheduledDouyinCollection('startup')") && serverSource.includes("setInterval(() => runScheduledDouyinCollection('scheduled')") && smokeSource.includes('monitor run duplicated already waiting Chrome collection tasks')) ok('启动和定时采集登记复用活跃度队列，不会重复排队已等待 Chrome 的账号');
else fail('启动或定时采集登记仍可能缺失，或绕过队列重复创建 Chrome 采集单');

if (
  serverSource.includes('function requestDouyinCollectorRun')
  && serverSource.includes("import('../scripts/douyin-chrome-collector.js')")
  && serverSource.includes('requestDouyinCollectorRun(source, queue)')
  && serverSource.includes('DOUYIN_COLLECTOR_AUTO_RUN')
  && collectorSource.includes('export async function runCollector')
  && mainSource.includes('Metric label="抖音采集"')
  && mainSource.includes('主机上自动启动已登录浏览器采集')
  && readmeSource.includes('后端默认会自动启动主机上已登录抖音的 Chrome')
) ok('到期采集会触发主机 Chrome 自动执行器，不只停留在等待队列');
else fail('到期采集仍可能只自动排队，未自动启动主机 Chrome 执行器');

if (
  serverSource.includes('function placeholderDouyinReason')
  && serverSource.includes('ALLOW_PLACEHOLDER_DOUYIN_COLLECTION')
  && serverSource.includes('function cancelBlockedDouyinCollectionRuns')
  && serverSource.includes('canceledBlockedCollectionRuns')
  && serverSource.includes('演示或测试抖音链接只用于界面验收，不进入自动采集队列')
  && smokeSource.includes('placeholder Douyin URL should not register Chrome collection')
  && smokeSource.includes('placeholder Douyin URL leaked into Chrome collection queue')
  && smokeSource.includes('placeholder legacy collection run not canceled')
) ok('演示或测试抖音链接不会进入自动采集队列');
else fail('演示或测试抖音链接仍可能触发自动采集');

if (
  serverSource.includes('function registerCaseCollectionQueue')
  && serverSource.includes('caseIds: ids')
  && serverSource.includes("registerCaseCollectionQueue([created.id], 'case-create')")
  && serverSource.includes("registerCaseCollectionQueue(cases.map((item) => item.id), 'case-bulk-create')")
  && serverSource.includes("registerCaseCollectionQueue([created.id], 'case-library-register')")
  && serverSource.includes("registerCaseCollectionQueue([updated.id], 'case-edit')")
  && serverSource.includes("registerCaseCollectionQueue([updated.id], 'case-resume')")
  && smokeSource.includes('case create did not immediately queue Chrome collection')
  && smokeSource.includes('bulk import did not immediately queue Chrome collection')
  && smokeSource.includes('case edit did not leave restored account queued for Chrome collection')
  && smokeSource.includes('case library register did not immediately queue Chrome collection')
  && smokeSource.includes('resume did not immediately queue Chrome collection')
) ok('新建、批量、案例库登记、补登记编辑和恢复账号都会自动排队采集');
else fail('案例录入或恢复后仍可能只显示到期采集，未立即生成等待 Chrome 采集单');

if (
  packageSource.includes('collect:douyin')
  && packageSource.includes('collect:douyin:self-test')
  && packageSource.includes('scripts/douyin-chrome-collector.js')
  && !packageSource.includes('!scripts/**/*')
  && collectorSource.includes('readChromePage')
  && collectorSource.includes('Google Chrome')
  && collectorSource.includes('/douyin-monitor/chrome-queue')
  && collectorSource.includes('/douyin-monitor/ingest')
  && collectorSource.includes('页面没有解析到粉丝、作品或互动数据，未写回')
  && collectorSource.includes('OK Douyin Chrome collector self-test')
) ok('主机侧 Chrome 抖音采集执行器已接入，并带自测和不伪造数据保护');
else fail('缺少可运行的主机侧 Chrome 抖音采集执行器，或执行器可能伪造采集数据');

if (
  envExampleSource.includes('SOUREN_CASE_LIBRARY_ROOT=')
  && envExampleSource.includes('SOUREN_SHARED_MATERIAL_ROOT=')
  && envExampleSource.includes('DOUYIN_COLLECTION_CHECK_INTERVAL_MS=')
  && envExampleSource.includes('DOUYIN_COLLECTOR_AUTO_RUN=')
  && envExampleSource.includes('DOUYIN_COLLECTOR_LIMIT=')
  && envExampleSource.includes('DOUYIN_COLLECTOR_WAIT_MS=')
  && envExampleSource.includes('DOUYIN_COLLECTOR_COOLDOWN_MS=')
  && envExampleSource.includes('IMAGE_API_KEY=')
) ok('.env.example 覆盖共享目录、采集间隔和图片接口关键配置');
else fail('.env.example 缺少共享目录、采集间隔或图片接口关键配置');

if (
  mainSource.includes('<h3>采集状态</h3>')
  && mainSource.includes('systemBackstage')
  && mainSource.includes('/douyin-monitor/chrome-queue?limit=10')
  && mainSource.includes('系统会按账号活跃度自动排队采集任务')
  && mainSource.includes('后台自动排队，每分钟刷新状态')
  && !mainSource.includes('登记到期采集清单')
  && !mainSource.includes('刷新采集状态')
  && !mainSource.includes('后台采集状态')
  && !mainSource.includes('采集回填入口')
) ok('采集状态只放在折叠系统后台，前台不提供手动登记或回填入口');
else fail('采集状态缺少折叠后台入口，或前台仍保留手动登记/回填旧口径');

if (!mainSource.includes('打开抖音主页') && !mainSource.includes('target="_blank">打开主页</a>')) ok('前台不要求工作人员手动打开抖音主页');
else fail('前台仍暴露手动打开抖音主页入口');

const externalLinkCount = (mainSource.match(/target="_blank"/g) || []).length;
if (
  externalLinkCount === 2 &&
  mainSource.includes('打开互动作品') &&
  mainSource.includes('isActiveQueueAlert && alert.video?.url') &&
  !mainSource.includes('>打开作品</a>') &&
  !mainSource.includes('打开原链接') &&
  !mainSource.includes('<span>动作</span>') &&
  !mainSource.includes('video.url ? <a') &&
  mainSource.includes('videoMetricHeader')
) ok('抖音作品外链只保留在爆款互动队首动作里，作品数据和爆款链接库不再提供手动打开入口');
else fail('前台仍可能在非队首场景打开抖音作品或爆款原链接');

if (serverSource.includes('兼职须知') && serverSource.includes('固定发布说明') && serverSource.includes('话题只用文案里已有的') && serverSource.includes('话题只用抖音发布文案里已有的') && mainSource.includes('兼职须知（首次发送）')) ok('交付内容内置固定发布说明和兼职须知');
else fail('缺少固定发布说明或兼职须知');

if (
  serverSource.includes('sanitizeOperatorInstruction') &&
  serverSource.includes("line.trim().startsWith('系统动作：')") &&
  !serverSource.includes('工作人员发完微信后标记“已派发”') &&
  smokeSource.includes('operator text should not include internal system action') &&
  smokeSource.includes('delivery view should not expose internal system action')
) ok('发给兼职文案不暴露系统内部状态动作');
else fail('发给兼职文案仍可能夹带系统内部状态动作');

if (serverSource.includes('caseGuideAlreadySent') && serverSource.includes('shouldSendFreelancerGuide') && mainSource.includes('showFreelancerGuide') && mainSource.includes('freelancerGuideNote')) ok('兼职须知只在首次交付时显示，后续不重复复制');
else fail('兼职须知仍可能在后续交付里重复显示');

if (mainSource.includes('当前只发给') && mainSource.includes('deliverySteps') && mainSource.includes('发完微信后标记已派发')) ok('交付弹窗按单账号固定步骤防呆');
else fail('交付弹窗缺少单账号固定步骤');

if (mainSource.includes('复制口播/字幕文案') && mainSource.includes('复制剪辑要求') && mainSource.includes('固定剪辑配方，剪辑只替换素材和标题') && styleSource.includes('repeat(auto-fit, minmax(150px, 1fr))')) ok('视频交付顶部步骤和实际剪辑门禁一致');
else fail('视频交付顶部步骤没有覆盖口播、剪辑要求或步骤布局过窄');

if (!mainSource.includes('下载源素材') && !mainSource.includes('可用源素材') && !mainSource.includes('view.sourceAssets') && !serverSource.includes('sourceAssets,')) ok('视频交付不再暴露第二套源素材入口');
else fail('视频交付仍暴露源素材下载区，容易和本次视频素材重复');

if (mainSource.includes('deliveryRequiredSteps') && mainSource.includes('handoffReady') && mainSource.includes('missingHandoffSteps') && mainSource.includes('disabled={!handoffReady}') && mainSource.includes('handoffGuard')) ok('交付弹窗未完成复制下载步骤前不能标记派发');
else fail('交付弹窗仍可跳过复制下载步骤直接标记派发');

if (
  mainSource.includes('const missingMedia = mediaFiles.length === 0')
  && mainSource.includes('还差：本次可发送图片或视频')
  && serverSource.includes("label: '本次可发送图片或视频'")
  && smokeSource.includes('ready delivery without media was allowed to dispatch')
) ok('交付派发要求至少有一个可发送素材');
else fail('交付派发仍可能在没有图片或视频素材时被标记已派发');

if (mainSource.includes("key: 'recipient'") && mainSource.includes('确认只发给这个微信') && mainSource.includes('RecipientConfirmPanel') && serverSource.includes("key: 'recipient'") && smokeSource.includes("key !== 'recipient'")) ok('交付必须先确认收件微信，前端和后端都不能跳过');
else fail('交付仍可能跳过收件微信确认');

if (mainSource.includes('nextHandoffStep') && mainSource.includes('handoffStepEnabled') && mainSource.includes('先完成前一步') && serverSource.includes('outOfOrderIndex') && serverSource.includes('按发送顺序操作')) ok('交付动作必须按顺序完成');
else fail('交付动作仍可能不按顺序完成');

if (!mainSource.includes('completeKey="rules"') && !serverSource.includes("steps.push({ key: 'rules'")) ok('发布要求不再作为额外复制步骤');
else fail('发布要求仍被当成必须复制步骤');

if (serverSource.includes('deliveryHandoffGuard') && serverSource.includes("requireQueueHeadForSlot(req, slot, '改状态')") && serverSource.includes('这条不是今日操作队列队首') && serverSource.includes("['异常', '已派发'].includes(status)") && serverSource.includes("status === '已完成' && !completingAlreadySent") && serverSource.includes('交付动作还没完成') && mainSource.includes('handoffDone: Array.from(handoffDone)')) ok('后端派发状态接口也要求队首和交付步骤完成清单');
else fail('后端状态接口仍可能绕过交付步骤门禁');

if (serverSource.includes('sentWaitDone: dueSlots.filter') && !serverSource.includes('items.push({ id: `sent-${slot.id}`') && mainSource.includes('WaitingConfirmSection') && mainSource.includes('waitingDetails') && mainSource.includes('收到对方完成回复后再展开收尾') && mainSource.includes('不阻塞今日队列') && mainSource.includes('completionAllowed') && styleSource.includes('.waitingDetails[open] summary::after') && smokeSource.includes('sent slot should move to non-blocking wait confirmation list')) ok('已派发任务进入折叠等待确认区，不再阻塞今日操作队列');
else fail('已派发任务仍可能留在今日操作队列，导致当天没有明确完工状态');

const oldDeliveryConfirmLabel = '核' + '对发给兼职文案';
if (mainSource.includes("copyAllowed = view.slot.status === '可交付'") && mainSource.includes('交付内容只读，避免重复发给同一个兼职') && mainSource.includes('确认发给兼职文案') && !mainSource.includes(oldDeliveryConfirmLabel)) ok('已派发交付内容只读，避免重复发送');
else fail('已派发交付内容仍可能继续复制重发');

if (mainSource.includes('allowDownload={copyAllowed}') && mainSource.includes('function MediaCard({ file, label, allowDownload = true, completeKey') && mainSource.includes('只读预览')) ok('已派发交付素材只读，避免重复下载重发');
else fail('已派发交付素材仍可能下载重发');

if (mainSource.includes('已用微信发送') && !mainSource.includes('>标记派发</button>') && !mainSource.includes('>已微信发送</button>')) ok('派发确认只保留在交付弹窗内');
else fail('列表页仍有绕过交付弹窗的派发按钮');

if (!mainSource.includes('markCompleted') && mainSource.includes('打开交付内容，确认完成后标记完成') && mainSource.includes("view.slot.status === '已派发'")) ok('完成确认只保留在交付弹窗内');
else fail('列表页仍有绕过交付弹窗的完成按钮');

if (serverSource.includes('canGenerateDeliveryForSlot') && serverSource.includes('CANDIDATE_SELECT_STATUSES') && serverSource.includes('不能再改候选') && mainSource.includes('canGenerateDelivery') && mainSource.includes('lockedNote')) ok('交付后禁止重生成交付或改候选');
else fail('交付后仍可能重生成交付或改候选');

if (serverSource.includes('canPatchSlotStatus') && serverSource.includes("nextStatus === '异常'") && mainSource.includes('canMarkException') && mainSource.includes("['待生成', '候选待选', '已锁定', '素材阻塞'].includes(slot.status)")) ok('交付链路状态不能被异常按钮打回');
else fail('交付链路仍可能被直接改成异常');

if (
  serverSource.includes('const nextSourceMaterialDir')
  && serverSource.includes('normalizeSourceMaterialDir(body.sourceMaterialDir')
  && serverSource.includes('existingSourceCase')
  && smokeSource.includes('case edit allowed a missing shared source directory')
  && smokeSource.includes('case edit allowed a shared source directory already bound to another account')
) ok('编辑案例时明确提交共享素材路径会校验目录并拒绝重复绑定');
else fail('编辑案例仍可能保存不存在或已绑定到其他账号的共享素材路径');

if (
  serverSource.includes('const nextWeixinNick') &&
  serverSource.includes('const nextProject') &&
  serverSource.includes('douyinIdFromUrl(nextDouyinUrl)') &&
  serverSource.includes('JSON.stringify(caze.persona || {})') &&
  !serverSource.includes('body.douyinId ?? caze.douyinId') &&
  !serverSource.includes("body.douyinId || ''") &&
  !serverSource.includes('JSON.stringify(body.persona ?? caze.persona)') &&
  smokeSource.includes('case edit allowed blank WeChat nickname') &&
  smokeSource.includes('case edit allowed blank project') &&
  smokeSource.includes('case edit accepted manual Douyin id') &&
  smokeSource.includes('case edit accepted hidden persona patch')
) ok('编辑案例后端只接受四个必要字段，不再吃旧人设或手填抖音号');
else fail('编辑案例后端仍可能接受空微信、空项目、旧人设或手填抖音号');

if (serverSource.includes('alreadyExisting') && serverSource.includes('SELECT * FROM clip_tasks WHERE plan_slot_id = ?') && mainSource.includes('existingClipTask') && mainSource.includes('剪辑任务已建')) ok('同一排期不会重复创建剪辑任务');
else fail('同一排期仍可能重复创建剪辑任务');

if (
  mainSource.includes('ClipTaskModal') &&
  mainSource.includes('我已看完固定配方') &&
  mainSource.includes('recipeConfirmed: true') &&
  !mainSource.includes('CLIP_ACTIONS') &&
  !mainSource.includes("patchClipStatus('review')") &&
  !mainSource.includes("patchClipStatus('rejected')") &&
  serverSource.includes('完成剪辑前必须先确认已看完固定剪辑配方') &&
  serverSource.includes("OPEN_CLIP_STATUSES = ['waiting_edit', 'draft']") &&
  serverSource.includes('剪辑任务只需要标记已完成') &&
  dbSource.includes("WHERE status IN ('review', 'rejected')") &&
  smokeSource.includes('clipCompletedWithoutRecipeRejected') &&
  smokeSource.includes('clip task allowed a waiting-confirm status') &&
  smokeSource.includes('clip task allowed a rework status instead of staying pending')
) ok('剪辑任务必须先查看完整固定配方才能标记完成，且不再制造中间确认状态');
else fail('剪辑任务仍可能不看配方直接标记完成');

if ((mainSource.includes('先打开完整剪辑要求并确认看完配方') || serverSource.includes('先打开完整剪辑要求并确认看完配方')) && readmeSource.includes('打开完整要求并确认看完配方') && !readmeSource.includes('可在首页查看并标记状态')) ok('剪辑任务前台和文档不再保留直接标记旧口径');
else fail('剪辑任务仍有直接查看标记的旧口径');

if (serverSource.includes('剪辑任务必须绑定具体排期') && mainSource.includes('来自具体排期') && !mainSource.includes('新建剪辑任务') && !mainSource.includes('临时剪辑任务')) ok('剪辑任务只能从具体排期创建');
else fail('剪辑任务仍存在临时建单入口');

if (serverSource.includes('图片任务必须有明确用途') && mainSource.includes('来自素材缺口') && !mainSource.includes('新建图片任务') && !serverSource.includes("slot?.contentKind || '日常养号'")) ok('图片任务只能从素材缺口或明确用途创建');
else fail('图片任务仍存在泛化入口或默认用途');

const oldDeletedDirMarker = '_' + 'deleted';
if (serverSource.includes('fs.rmSync(target, { recursive: true, force: true })') && !serverSource.includes('DELETED_CASE_ROOT') && !serverSource.includes(oldDeletedDirMarker) && mainSource.includes('本地素材副本也会同步删除')) ok('删除案例会同步删除本地案例目录');
else fail('删除案例仍会保留本地目录');

if (
  mainSource.includes('新建时只填四项')
  && mainSource.includes('caseFormMissingRequired')
  && !mainSource.includes('disabled={isCreate &&')
  && !mainSource.includes('RANDOM_CASE_PROFILES')
  && !mainSource.includes('randomCaseDefaults')
  && !mainSource.includes('随机换一组')
  && !mainSource.includes('douyinId: initial')
  && mainSource.includes("!form.weixinNick.trim() || !form.douyinUrl.trim() || !form.project.trim() || !form.sourceMaterialDir.trim()")
  && mainSource.includes('选择服务器案例目录')
  && mainSource.includes("request('/case-library')")
  && mainSource.includes('useSourceCandidate')
  && mainSource.includes('已绑定其他账号的目录不能重复使用')
) ok('新建和编辑案例前端只保留四项录入，并可从服务器案例目录选择共享素材路径');
else fail('新建案例仍暴露随机人设选择或允许缺少微信名');

if (
  !mainSource.includes('搜索微信昵称 / 抖音链接 / 案例编号 / 项目 / 人设') &&
  !mainSource.includes('本地案例素材目录') &&
  !mainSource.includes('素材目录：') &&
  !mainSource.includes('不适合的人设') &&
  mainSource.includes('共享原始素材：')
) ok('日常案例页不展示内部人设或本地素材副本路径');
else fail('日常案例页仍暴露内部人设或本地素材副本路径');

if (
  mainSource.includes('编辑时只改账号必需信息') &&
  !mainSource.includes('人设和阶段由系统内部维护') &&
  !mainSource.includes('编辑时只改对接必需信息') &&
  !mainSource.includes('updatePersona') &&
  !mainSource.includes('<label>城市') &&
  !mainSource.includes('<label>年龄') &&
  !mainSource.includes('<label>职业') &&
  !mainSource.includes('<label>语气') &&
  !mainSource.includes('动机故事')
) ok('编辑案例前端也只保留微信、抖音、项目和共享素材路径');
else fail('编辑案例仍暴露城市、年龄、职业、语气或动机等内部人设字段');

if (serverSource.includes('必须填写兼职微信昵称') && serverSource.includes('必须填写有效的抖音主页或作品链接') && serverSource.includes('必须填写项目') && serverSource.includes('必须填写共享原始素材路径') && serverSource.includes('共享原始素材路径不存在或不是目录') && serverSource.includes('normalizeDouyinUrl') && serverSource.includes('douyinIdFromUrl(douyinUrl)') && serverSource.includes('normalizeSourceMaterialDir') && smokeSource.includes('case create allowed missing project') && !serverSource.includes('body.weixinNick || `${persona.city}') && !serverSource.includes('input.weixinNick || input.weixin_nick || candidate.suggestedWeixinNick')) ok('后端不再随机生成兼职微信名，也不允许缺少抖音链接、项目或共享素材路径');
else fail('后端仍可能随机生成兼职微信名或允许缺少抖音链接/共享素材路径');

if (serverSource.includes("const sync = syncCaseSourceMaterials(created)") && serverSource.includes('res.json({ ...created, sync, slotsCreated: slots.length, collectionQueue })') && smokeSource.includes('case create did not automatically sync shared source material') && smokeSource.includes('case create allowed missing shared source directory') && mainSource.includes('案例已创建：同步素材')) ok('普通新建案例会校验共享目录并自动同步一次素材');
else fail('普通新建案例仍可能只建账号不校验/不同步共享素材');

if (serverSource.includes('function prepareBulkCaseRows') && serverSource.includes('function createBulkCases') && serverSource.includes('seenSources.has(sourceMaterialDir)') && serverSource.includes('第 ${line} 行缺少项目') && !serverSource.includes("project: project || '吸脂'") && !serverSource.includes("project: row.project || '吸脂'") && serverSource.includes('const sync = syncCaseSourceMaterials(created)') && !serverSource.includes('const created = rows.map((row) => createCaseFromBody(row))') && smokeSource.includes('bulk import created partial cases before failing validation') && smokeSource.includes('bulk import allowed a row with missing project') && mainSource.includes('批量导入完成：账号')) ok('批量导入会整批预检四项并自动同步素材，不会半导入');
else fail('批量导入仍可能逐条创建、半失败半成功或不自动同步素材');

const staleOperatorDocs = [
  '先复制这个账号的清单',
  '回到系统补分析结果',
  '底部折叠的「后台采集状态」',
  '远端代码写权限未配置',
  '如果本机没有写权限',
  '待爆款分析链接只保留打开原链接和补分析结果',
  '适合/禁用关键词 -> 对应输入框',
  '填写完成后再点“给可投放账号生成爆款候选”',
  '本地案例素材目录',
  '账号人设',
  '人设关键词',
  '填人设'
];
const leakedOperatorDocs = staleOperatorDocs.filter((label) => [readmeSource, sopSource].some((source) => source.includes(label)));
if (!leakedOperatorDocs.length) ok('SOP 和 README 不再保留手工分析、手工采集或远端权限旧口径');
else fail(`SOP/README 仍有旧口径：${leakedOperatorDocs.join('、')}`);

const dataDir = path.join(ROOT_DIR, 'data');
const materialDir = path.join(ROOT_DIR, '素材库', '真实案例');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(materialDir, { recursive: true });
ok(`数据目录可写 ${dataDir}`);
ok(`素材目录可写 ${materialDir}`);

if (fs.existsSync(path.join(APP_DIR, '.env'))) ok('已存在 .env');
else warn('未创建 .env；图片接口会保持未接入，但系统仍可运行');

if (fs.existsSync(path.join(APP_DIR, 'node_modules'))) ok('node_modules 已安装');
else warn('node_modules 不存在；启动脚本会自动 npm install');

if (process.exitCode) process.exit(process.exitCode);
