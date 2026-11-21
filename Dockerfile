# asr-server：首次启动自动下载模型到 /models（挂卷保存，之后不再下载）
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl bzip2 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
COPY scripts ./scripts

RUN mkdir -p /models && chown node:node /models
ENV NODE_ENV=production \
    PORT=8090 \
    ASR_MODEL_ROOT=/models \
    ASR_MODEL_DIR=/models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09
VOLUME /models
EXPOSE 8090
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=300s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8090)+'/health').then(r=>r.json()).then(h=>process.exit(h.asr?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["sh", "scripts/docker-entrypoint.sh"]
