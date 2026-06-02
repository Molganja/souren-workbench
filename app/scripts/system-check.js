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

const nonDeliveryCopyLabels = ['复制补素材说明', '复制分析任务', '复制任务单', '复制图片提示词'];
const leakedCopyLabels = nonDeliveryCopyLabels.filter((label) => mainSource.includes(label));
if (leakedCopyLabels.length) fail(`非交付复制按钮仍存在：${leakedCopyLabels.join('、')}`);
else ok('复制入口只保留在交付内容弹窗');

if (mainSource.includes('今日操作队列') && mainSource.includes('今日账号概览')) ok('首页保留操作队列和账号概览');
else fail('首页缺少操作队列或账号概览');

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
