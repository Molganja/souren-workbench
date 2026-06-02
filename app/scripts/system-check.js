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

if (mainSource.includes('今日操作队列') && mainSource.includes('今日账号概览')) ok('首页保留操作队列和账号概览');
else fail('首页缺少操作队列或账号概览');

if (mainSource.includes('activePriority') && mainSource.includes('queueSummary') && mainSource.includes('后面还有')) ok('今日队列只开放队首任务操作');
else fail('今日队列缺少队首防呆状态');

const serverSource = fs.readFileSync(path.join(APP_DIR, 'server', 'index.js'), 'utf8');
if (serverSource.includes('dashboardQueueHead') && serverSource.includes('当前队首不是准备类任务') && !serverSource.includes('for (const slot of dueSlots)')) ok('后台准备接口也只处理当前队首');
else fail('后台准备接口仍可能批量推进今日队列');

if (mainSource.includes('activeQueueMatchesSlot') && mainSource.includes('activeQueueMatchesClip') && mainSource.includes('activeQueueMatchesAlert') && mainSource.includes('排到今日队列队首后处理') && mainSource.includes('这条不是今日操作队列的当前任务') && mainSource.includes("copyAllowed = view.slot.status === '可交付' && isActiveQueueSlot")) ok('二级页面不能绕过今日队首执行交付、剪辑和爆款互动动作');
else fail('排期规划或案例详情仍可能绕过今日队首处理任务');

if (mainSource.includes('今天发完了') && !mainSource.includes('今天没有必须处理的动作')) ok('今日队列清空后有明确完工状态');
else fail('今日队列清空状态仍不明确');

if (serverSource.includes('固定剪辑配方') && serverSource.includes('不临时改结构')) ok('视频交付和剪辑任务内置固定剪辑配方');
else fail('缺少固定剪辑配方');

if (serverSource.includes('失联处理') && serverSource.includes('失联暂停') && serverSource.includes('不进入采集队列')) ok('失联账号会暂停排期和采集');
else fail('缺少失联账号暂停逻辑');

if (serverSource.includes('/api/cases/:id/resume') && serverSource.includes('已取消') && mainSource.includes('恢复账号')) ok('失联暂停账号支持一键恢复');
else fail('缺少失联暂停账号恢复闭环');

if (serverSource.includes('给可投放账号生成爆款候选') && serverSource.includes('已有同一天同爆款任务') && !mainSource.includes("kind: '爆款分析'")) ok('爆款批量生成只进入可投放账号且不占用今日队列');
else fail('爆款批量生成仍可能制造无效任务或占用今日队列');

if (serverSource.includes('兼职须知') && serverSource.includes('固定发布说明') && mainSource.includes('兼职须知（首次发送）')) ok('交付内容内置固定发布说明和兼职须知');
else fail('缺少固定发布说明或兼职须知');

if (mainSource.includes('当前只发给') && mainSource.includes('deliverySteps') && mainSource.includes('发完微信后标记已派发')) ok('交付弹窗按单账号固定步骤防呆');
else fail('交付弹窗缺少单账号固定步骤');

if (mainSource.includes("copyAllowed = view.slot.status === '可交付'") && mainSource.includes('交付内容只读，避免重复发给同一个兼职') && mainSource.includes('核对发给兼职文案')) ok('已派发交付内容只读，避免重复发送');
else fail('已派发交付内容仍可能继续复制重发');

if (mainSource.includes('已用微信发送') && !mainSource.includes('>标记派发</button>') && !mainSource.includes('>已微信发送</button>')) ok('派发确认只保留在交付弹窗内');
else fail('列表页仍有绕过交付弹窗的派发按钮');

if (!mainSource.includes('markCompleted') && mainSource.includes('打开交付内容，核对后标记完成') && mainSource.includes("view.slot.status === '已派发'")) ok('完成确认只保留在交付弹窗内');
else fail('列表页仍有绕过交付弹窗的完成按钮');

if (serverSource.includes('canGenerateDeliveryForSlot') && serverSource.includes('CANDIDATE_SELECT_STATUSES') && serverSource.includes('不能再改候选') && mainSource.includes('canGenerateDelivery') && mainSource.includes('lockedNote')) ok('交付后禁止重生成交付或改候选');
else fail('交付后仍可能重生成交付或改候选');

if (serverSource.includes('canPatchSlotStatus') && serverSource.includes("nextStatus === '异常'") && mainSource.includes('canMarkException') && mainSource.includes("['待生成', '候选待选', '已锁定', '素材阻塞'].includes(slot.status)")) ok('交付链路状态不能被异常按钮打回');
else fail('交付链路仍可能被直接改成异常');

if (serverSource.includes('alreadyExisting') && serverSource.includes('SELECT * FROM clip_tasks WHERE plan_slot_id = ?') && mainSource.includes('existingClipTask') && mainSource.includes('剪辑任务已建')) ok('同一排期不会重复创建剪辑任务');
else fail('同一排期仍可能重复创建剪辑任务');

if (serverSource.includes('剪辑任务必须绑定具体排期') && mainSource.includes('来自具体排期') && !mainSource.includes('新建剪辑任务') && !mainSource.includes('临时剪辑任务')) ok('剪辑任务只能从具体排期创建');
else fail('剪辑任务仍存在临时建单入口');

if (serverSource.includes('图片任务必须有明确用途') && mainSource.includes('来自素材缺口') && !mainSource.includes('新建图片任务') && !serverSource.includes("slot?.contentKind || '日常养号'")) ok('图片任务只能从素材缺口或明确用途创建');
else fail('图片任务仍存在泛化入口或默认用途');

const oldDeletedDirMarker = '_' + 'deleted';
if (serverSource.includes('fs.rmSync(target, { recursive: true, force: true })') && !serverSource.includes('DELETED_CASE_ROOT') && !serverSource.includes(oldDeletedDirMarker) && mainSource.includes('本地案例素材目录也不会保留')) ok('删除案例会同步删除本地案例目录');
else fail('删除案例仍会保留本地目录');

if (mainSource.includes('新建时只填四项') && !mainSource.includes('RANDOM_CASE_PROFILES') && !mainSource.includes('randomCaseDefaults') && !mainSource.includes('随机换一组') && mainSource.includes("disabled={isCreate && !form.weixinNick.trim()}")) ok('新建案例前端只保留四项录入');
else fail('新建案例仍暴露随机人设选择或允许缺少微信名');

if (serverSource.includes('必须填写兼职微信昵称') && !serverSource.includes('body.weixinNick || `${persona.city}') && !serverSource.includes('input.weixinNick || input.weixin_nick || candidate.suggestedWeixinNick')) ok('后端不再随机生成兼职微信名');
else fail('后端仍可能随机生成兼职微信名');

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
