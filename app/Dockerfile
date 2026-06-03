FROM node:24-bookworm-slim AS app

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.html vite.config.js ./
COPY src ./src
COPY server ./server
COPY scripts/douyin-chrome-collector.js ./scripts/douyin-chrome-collector.js

RUN npm run build

EXPOSE 5174

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5174/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--no-warnings", "server/index.js"]
