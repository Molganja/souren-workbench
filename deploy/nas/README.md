# NAS 部署说明

目标：让 NAS 24 小时运行主系统，Mac 继续负责抖音 Chrome 采集并写回 NAS。

## 运行边界

- NAS 跑：网页工作台、Express API、SQLite、案例素材、通用素材、服务器案例库。
- Mac 跑：`scripts/douyin-chrome-collector.js`，因为当前采集器依赖 macOS Google Chrome + AppleScript。
- NAS 不跑：Chrome 自动采集器，所以 `DOUYIN_COLLECTOR_AUTO_RUN=0`。

## NAS 上部署

1. 把仓库放到 NAS 的共享目录，例如 `共享NAS/souren-workbench`。
2. 复制环境文件：

```bash
cp deploy/nas/souren.nas.env.example deploy/nas/souren.nas.env
```

3. 编辑 `deploy/nas/souren.nas.env`：

```bash
SOUREN_ACCESS_CODE=你的6位访问码
IMAGE_API_KEY=后续选定图片 API 后再填
```

4. 在 UGOS Pro 的 Docker / Container Manager 里使用 `docker-compose.nas.yml` 启动，或在 SSH 里运行：

```bash
docker compose -f docker-compose.nas.yml up -d --build
```

5. 打开：

```text
http://192.168.1.70:5174
```

数据会写入仓库旁边的 `souren-runtime/`，里面包含：

- `data/souren.sqlite`
- `素材库/真实案例`
- `素材库/通用素材`
- `素材库/服务器案例库`

## Mac 采集写回 NAS

Mac 保留当前仓库，用已登录抖音的 Google Chrome 采集。运行：

```bash
cd /Users/licc/Desktop/素人系统/app
SOUREN_API_BASE=http://192.168.1.70:5174/api \
SOUREN_API_ACCESS_CODE=你的6位访问码 \
/Users/licc/.local/bin/node --no-warnings scripts/douyin-chrome-collector.js --register --limit 10 --wait-ms 6000
```

如果页面能访问但采集写回失败，先检查 NAS 端访问码是否和 `SOUREN_API_ACCESS_CODE` 一致。
