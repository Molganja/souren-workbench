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
  path.join(APP_DIR, 'src', 'styles.css')
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
const smokeSource = fs.readFileSync(path.join(APP_DIR, 'scripts', 'e2e-smoke.js'), 'utf8');
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
  && mainSource.includes('/agent-work')
  && !mainSource.includes('主机侧工作清单')
  && smokeSource.includes('agent work queue missing pending viral analysis')
) ok('后台动作聚合爆款分析、Chrome采集和图片任务，默认折叠且不进入首页');
else fail('缺少折叠的系统后台，或仍保留主机侧工作清单旧口径');

if (serverSource.includes('DEFAULT_IMAGE_API_URL') && serverSource.includes("DEFAULT_IMAGE_MODEL = 'gpt-image-1'") && serverSource.includes('apiUrlDefaulted') && !serverSource.includes('IMAGE_API_KEY 和 IMAGE_API_URL') && !readmeSource.includes('同时填写 `IMAGE_API_KEY` 和 `IMAGE_API_URL`') && smokeSource.includes('image config should be ready with key only')) ok('图片接口只要求 IMAGE_API_KEY，接口地址仅作为可选覆盖');
else fail('图片接口仍要求同时填写 key 和 URL，或缺少 key-only 验收');

if (mainSource.includes('disabled={!ready}') && mainSource.includes('sourceLink: form.sourceLink.trim()') && serverSource.includes('请先粘贴爆款视频链接') && smokeSource.includes('blankViralRejected')) ok('空爆款链接不会生成假模板');
else fail('空爆款链接仍可能生成假模板');

if (!mainSource.includes('window.prompt') && mainSource.includes('LibraryCaseForm') && mainSource.includes('ViralBulkForm')) ok('案例登记和爆款生成不再使用浏览器临时输入框');
else fail('前台仍存在浏览器临时输入框，或缺少正式登记/生成弹窗');

if (!mainSource.includes('window.confirm') && mainSource.includes('DeleteCaseModal') && mainSource.includes('输入：删除')) ok('删除案例使用工作台内确认弹窗');
else fail('删除案例仍使用浏览器原生确认框，或缺少明确删除确认');

if (mainSource.includes('今日操作队列') && mainSource.includes('今日账号概览')) ok('首页保留操作队列和账号概览');
else fail('首页缺少操作队列或账号概览');

if (mainSource.includes('activePriority') && mainSource.includes('queueSummary') && mainSource.includes('后面还有')) ok('今日队列只开放队首任务操作');
else fail('今日队列缺少队首防呆状态');

if (mainSource.includes('focusMeta') && mainSource.includes('微信：') && mainSource.includes('抖音：') && mainSource.includes('项目：')) ok('队首任务直接显示当前收件账号');
else fail('队首任务缺少收件账号信息');

if (mainSource.includes('douyinDisplay') && !mainSource.includes('未填抖音号') && !mainSource.includes('抖音号<input')) ok('前台用抖音主页/作品链接作为主账号路由，不暴露旧抖音号手填口径');
else fail('前台仍把必填抖音链接显示成旧抖音号口径');

if (mainSource.includes('activeCaseId') && mainSource.includes('排到今日队列队首后打开') && mainSource.includes('isActiveQueueCase')) ok('首页账号概览和异常账号不能打开非队首账号');
else fail('首页仍可能从概览或异常账号绕过队首打开账号');

if (mainSource.includes('const accountGroups = groupQueueByAccount(priorityActions)') && !mainSource.includes('const accountGroups = groupTodayByAccount(data.todaySlots)') && mainSource.includes('actionCounts') && mainSource.includes('同账号动作') && mainSource.includes('个待处理账号')) ok('首页账号概览按操作队列聚合，不只看排期槽位');
else fail('首页账号概览仍可能只按今日排期显示，漏掉素材同步、剪辑或爆款互动');

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

if (!mainSource.includes('内容阶段比例') && !mainSource.includes('<h2>素材模板</h2>') && !serverSource.includes('stageRatios: STAGE_RATIOS') && !serverSource.includes('materialTemplates: MATERIAL_TEMPLATES')) ok('系统配置不暴露后台阶段比例和素材模板');
else fail('系统配置仍暴露后台阶段比例或素材模板');

if (mainSource.includes('系统验收清单') && mainSource.includes('readinessChecks') && mainSource.includes('readinessStatusLabel')) ok('系统配置展示简短验收清单');
else fail('系统配置缺少 SOP 要求的验收清单');

const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
if (pkg.scripts?.['client:verify']?.includes('client:mac') && pkg.scripts?.['client:verify']?.includes('client:package:check')) ok('客户端可一条命令打包并启动验收');
else fail('客户端缺少一条命令打包验收脚本');

if (mainSource.includes('今天发完了') && !mainSource.includes('今天没有必须处理的动作')) ok('今日队列清空后有明确完工状态');
else fail('今日队列清空状态仍不明确');

if (serverSource.includes('ACTIVE_OPERATOR_STATUSES') && serverSource.includes("'已派发', '异常'") && !serverSource.includes("ACTIVE_OPERATOR_STATUSES = ['待生成', '候选待选', '已锁定', '素材阻塞', '可交付', '已派发', '已完成'")) ok('已完成任务不再留在今日操作队列');
else fail('已完成任务仍可能留在今日操作队列');

if (serverSource.includes('固定剪辑配方') && serverSource.includes('不临时改结构')) ok('视频交付和剪辑任务内置固定剪辑配方');
else fail('缺少固定剪辑配方');

if (!mainSource.includes('成片保存到') && !mainSource.includes('封面保存到') && !serverSource.includes('07-成片回收说明') && !serverSource.includes('final.mp4 放回') && serverSource.includes('不需要上传成片')) ok('视频剪辑完成后只标记完成，不要求上传成片');
else fail('视频剪辑仍要求上传成片或保存到本地目录');

const retiredReturnDir = '04-' + '发布回收';
const retiredReturnLabel = '发布' + '回收';
if (![serverSource, dbSource, readmeSource].some((source) => source.includes(retiredReturnDir) || source.includes(retiredReturnLabel))) ok('新案例不再创建旧回收目录');
else fail('仍保留旧回收目录');

if (!mainSource.includes('打开剪辑目录') && !mainSource.includes('task.outputDir') && !mainSource.includes('clipTask.outputDir') && !serverSource.includes('剪辑任务单.txt') && serverSource.includes("const outputDir = '';")) ok('剪辑任务只在网页内展示，不生成本地任务单或打开目录');
else fail('剪辑任务仍暴露本地目录或任务单');

if (!mainSource.includes('等回传') && !serverSource.includes('回传要求') && !serverSource.includes('sentWaitReport') && mainSource.includes('待完成') && serverSource.includes('sentWaitDone')) ok('已派发任务统一为待完成确认口径');
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

if (serverSource.includes('async function enqueueDouyinCollection') && serverSource.includes('return registerChromeCollectionQueue({ limit: 200, source })') && serverSource.includes('const toRegister = queue.targets.filter((target) => !target.collectionQueued)') && smokeSource.includes('monitor run duplicated already waiting Chrome collection tasks')) ok('定时/手动采集登记复用活跃度队列，不会重复排队已等待 Chrome 的账号');
else fail('定时/手动采集登记仍可能绕过队列去重复创建 Chrome 采集单');

if (
  mainSource.includes('<h3>采集状态</h3>')
  && mainSource.includes('systemBackstage')
  && mainSource.includes('/douyin-monitor/chrome-queue?limit=10')
  && mainSource.includes('登记到期采集清单')
  && !mainSource.includes('后台采集状态')
  && !mainSource.includes('采集回填入口')
) ok('采集状态只放在折叠系统后台，不回到首页手工回填');
else fail('采集状态缺少折叠后台入口，或前台仍保留手工回填旧口径');

if (!mainSource.includes('打开抖音主页') && !mainSource.includes('target="_blank">打开主页</a>')) ok('前台不要求工作人员手动打开抖音主页');
else fail('前台仍暴露手动打开抖音主页入口');

if (serverSource.includes('兼职须知') && serverSource.includes('固定发布说明') && serverSource.includes('话题只用文案里已有的') && serverSource.includes('话题只用抖音发布文案里已有的') && mainSource.includes('兼职须知（首次发送）')) ok('交付内容内置固定发布说明和兼职须知');
else fail('缺少固定发布说明或兼职须知');

if (serverSource.includes('caseGuideAlreadySent') && serverSource.includes('shouldSendFreelancerGuide') && mainSource.includes('showFreelancerGuide') && mainSource.includes('freelancerGuideNote')) ok('兼职须知只在首次交付时显示，后续不重复复制');
else fail('兼职须知仍可能在后续交付里重复显示');

if (mainSource.includes('当前只发给') && mainSource.includes('deliverySteps') && mainSource.includes('发完微信后标记已派发')) ok('交付弹窗按单账号固定步骤防呆');
else fail('交付弹窗缺少单账号固定步骤');

if (mainSource.includes('复制口播/字幕文案') && mainSource.includes('复制剪辑要求') && mainSource.includes('固定剪辑配方，剪辑只替换素材和标题') && styleSource.includes('repeat(auto-fit, minmax(150px, 1fr))')) ok('视频交付顶部步骤和实际剪辑门禁一致');
else fail('视频交付顶部步骤没有覆盖口播、剪辑要求或步骤布局过窄');

if (mainSource.includes('deliveryRequiredSteps') && mainSource.includes('handoffReady') && mainSource.includes('missingHandoffSteps') && mainSource.includes('disabled={!handoffReady}') && mainSource.includes('handoffGuard')) ok('交付弹窗未完成复制下载步骤前不能标记派发');
else fail('交付弹窗仍可跳过复制下载步骤直接标记派发');

if (mainSource.includes("key: 'recipient'") && mainSource.includes('确认只发给这个微信') && mainSource.includes('RecipientConfirmPanel') && serverSource.includes("key: 'recipient'") && smokeSource.includes("key !== 'recipient'")) ok('交付必须先确认收件微信，前端和后端都不能跳过');
else fail('交付仍可能跳过收件微信确认');

if (mainSource.includes('nextHandoffStep') && mainSource.includes('handoffStepEnabled') && mainSource.includes('先完成前一步') && serverSource.includes('outOfOrderIndex') && serverSource.includes('按发送顺序操作')) ok('交付动作必须按顺序完成');
else fail('交付动作仍可能不按顺序完成');

if (!mainSource.includes('completeKey="rules"') && !serverSource.includes("steps.push({ key: 'rules'")) ok('发布要求不再作为额外复制步骤');
else fail('发布要求仍被当成必须复制步骤');

if (serverSource.includes('deliveryHandoffGuard') && serverSource.includes("requireQueueHeadForSlot(req, slot, '改状态')") && serverSource.includes('这条不是今日操作队列队首') && serverSource.includes("['异常', '已派发', '已完成'].includes(status)") && serverSource.includes('交付动作还没完成') && mainSource.includes('handoffDone: Array.from(handoffDone)')) ok('后端派发状态接口也要求队首和交付步骤完成清单');
else fail('后端状态接口仍可能绕过交付步骤门禁');

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

if (serverSource.includes('alreadyExisting') && serverSource.includes('SELECT * FROM clip_tasks WHERE plan_slot_id = ?') && mainSource.includes('existingClipTask') && mainSource.includes('剪辑任务已建')) ok('同一排期不会重复创建剪辑任务');
else fail('同一排期仍可能重复创建剪辑任务');

if (mainSource.includes('ClipTaskModal') && mainSource.includes('我已看完固定配方') && mainSource.includes('recipeConfirmed: true') && !mainSource.includes('CLIP_ACTIONS') && serverSource.includes('完成剪辑前必须先确认已看完固定剪辑配方') && smokeSource.includes('clipCompletedWithoutRecipeRejected')) ok('剪辑任务必须先查看完整固定配方才能标记完成');
else fail('剪辑任务仍可能不看配方直接标记完成');

if (mainSource.includes('先打开完整剪辑要求并确认看完配方') && readmeSource.includes('打开完整要求并确认看完配方') && !readmeSource.includes('可在首页查看并标记状态')) ok('剪辑任务前台和文档不再保留直接标记旧口径');
else fail('剪辑任务仍有直接查看标记的旧口径');

if (serverSource.includes('剪辑任务必须绑定具体排期') && mainSource.includes('来自具体排期') && !mainSource.includes('新建剪辑任务') && !mainSource.includes('临时剪辑任务')) ok('剪辑任务只能从具体排期创建');
else fail('剪辑任务仍存在临时建单入口');

if (serverSource.includes('图片任务必须有明确用途') && mainSource.includes('来自素材缺口') && !mainSource.includes('新建图片任务') && !serverSource.includes("slot?.contentKind || '日常养号'")) ok('图片任务只能从素材缺口或明确用途创建');
else fail('图片任务仍存在泛化入口或默认用途');

const oldDeletedDirMarker = '_' + 'deleted';
if (serverSource.includes('fs.rmSync(target, { recursive: true, force: true })') && !serverSource.includes('DELETED_CASE_ROOT') && !serverSource.includes(oldDeletedDirMarker) && mainSource.includes('本地案例素材目录也会同步删除')) ok('删除案例会同步删除本地案例目录');
else fail('删除案例仍会保留本地目录');

if (mainSource.includes('新建时只填四项') && !mainSource.includes('RANDOM_CASE_PROFILES') && !mainSource.includes('randomCaseDefaults') && !mainSource.includes('随机换一组') && mainSource.includes("!form.weixinNick.trim() || !form.douyinUrl.trim() || !form.sourceMaterialDir.trim()")) ok('新建案例前端只保留四项录入，并要求微信、抖音和共享素材路径');
else fail('新建案例仍暴露随机人设选择或允许缺少微信名');

if (serverSource.includes('必须填写兼职微信昵称') && serverSource.includes('必须填写有效的抖音主页或作品链接') && serverSource.includes('必须填写共享原始素材路径') && serverSource.includes('共享原始素材路径不存在或不是目录') && serverSource.includes('normalizeDouyinUrl') && serverSource.includes('normalizeSourceMaterialDir') && !serverSource.includes('body.weixinNick || `${persona.city}') && !serverSource.includes('input.weixinNick || input.weixin_nick || candidate.suggestedWeixinNick')) ok('后端不再随机生成兼职微信名，也不允许缺少抖音链接或共享素材路径');
else fail('后端仍可能随机生成兼职微信名或允许缺少抖音链接/共享素材路径');

if (serverSource.includes("const sync = syncCaseSourceMaterials(created)") && serverSource.includes('res.json({ ...created, sync, slotsCreated: slots.length })') && smokeSource.includes('case create did not automatically sync shared source material') && smokeSource.includes('case create allowed missing shared source directory') && mainSource.includes('案例已创建：同步素材')) ok('普通新建案例会校验共享目录并自动同步一次素材');
else fail('普通新建案例仍可能只建账号不校验/不同步共享素材');

if (serverSource.includes('function prepareBulkCaseRows') && serverSource.includes('function createBulkCases') && serverSource.includes('seenSources.has(sourceMaterialDir)') && serverSource.includes('const sync = syncCaseSourceMaterials(created)') && !serverSource.includes('const created = rows.map((row) => createCaseFromBody(row))') && smokeSource.includes('bulk import created partial cases before failing validation') && mainSource.includes('批量导入完成：账号')) ok('批量导入会整批预检并自动同步素材，不会半导入');
else fail('批量导入仍可能逐条创建、半失败半成功或不自动同步素材');

const staleOperatorDocs = [
  '先复制这个账号的清单',
  '回到系统补分析结果',
  '底部折叠的「后台采集状态」',
  '远端代码写权限未配置',
  '如果本机没有写权限',
  '待爆款分析链接只保留打开原链接和补分析结果',
  '适合/禁用关键词 -> 对应输入框',
  '填写完成后再点“给可投放账号生成爆款候选”'
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
