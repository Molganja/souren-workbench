# 素人种草运营工作台 v1

本地网页工作台，用于管理兼职账号、三类内容排期、候选稿、素材扫描、微信交付包、Image 任务预留和抖音核对队列。

## 启动

```bash
cd /Users/licc/Desktop/素人系统/app
npm install
npm run dev
```

- 前端：`http://127.0.0.1:5173`
- 后端/API：`http://127.0.0.1:5174`

生产构建后也可以只跑后端：

```bash
npm run build
npm run start
```

打开：`http://127.0.0.1:5174`

## 本地数据

系统会自动创建：

```text
/Users/licc/Desktop/素人系统/data/souren.sqlite
/Users/licc/Desktop/素人系统/素材库/真实案例/
```

新建案例后，每个案例会自动生成：

```text
00-原始素材/
01-已筛选素材/
02-生成补充/
03-交付给兼职/
04-发布回收/
case.json
```

网页端只保存结构化数据和本地路径，大图片、视频和交付包都放在本地文件夹。

## Image / LLM Key

复制 `.env.example` 为 `.env` 后填写：

```env
IMAGE_API_KEY=
LLM_API_KEY=
```

当前 v1 会创建 Image 任务和 prompt。`IMAGE_API_KEY` 为空时，任务状态为 `waiting_key`，不会影响其他流程。

## 当前闭环

1. 新建案例并生成本地案例目录。
2. 把原始素材放进 `00-原始素材/`。
3. 点击扫描素材。
4. 生成 30 天排期槽位。
5. 对当天或近期槽位生成 3 条候选稿。
6. 选择一条并锁定。
7. 生成微信交付包。
8. 标记派发、兼职已汇报。
9. 打开抖音链接核对并回填状态。
