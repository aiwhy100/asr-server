#!/usr/bin/env node
// asr-server：离线中文语音识别服务（sherpa-onnx + SenseVoice）。
//   npm run download-model   下载模型（约 230 MB，校验 sha256）
//   npm start                启动，默认 http://0.0.0.0:8090
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { loadConfig } from './config.js';
import { available, engineStatus, loadEngine } from './engine.js';
import { createRoutes } from './routes.js';

const DEMO = fileURLToPath(new URL('../public/index.html', import.meta.url));

export async function buildApp(cfg = loadConfig(), { logger = { level: cfg.logLevel } } = {}) {
  const app = Fastify({ logger, trustProxy: cfg.trustProxy, bodyLimit: 1024 * 1024 });
  // 单条 WebSocket 消息上限 256KB（100ms 录音 pcm16 约 3KB）
  await app.register(websocket, { options: { maxPayload: 256 * 1024 } });

  app.setErrorHandler((err, req, reply) => {
    const statusCode = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (statusCode >= 500) req.log.error({ err: String(err) }, 'request failed');
    reply.code(statusCode).send({ statusCode, error: 'HttpError', message: statusCode === 500 ? '服务器出错了' : err.message });
  });

  const routes = createRoutes(cfg);
  await app.register(routes);
  // 和 AI为什么100 线上接口同路径：https://api.aiwhy100.com/api/app/v1/asr
  await app.register(routes, { prefix: '/api/app/v1' });

  const status = () => ({ ok: true, asr: available(), engine: engineStatus().state, auth: cfg.tokens.length > 0 });
  app.get('/health', async () => status());
  app.get('/api/app/v1/config', async () => ({ asr: available() }));

  if (cfg.demoPage) {
    const page = readFileSync(DEMO, 'utf8');
    app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').send(page));
  }
  return app;
}

async function main() {
  const cfg = loadConfig();
  const app = await buildApp(cfg);
  await app.listen({ host: cfg.host, port: cfg.port });
  app.log.info(cfg.tokens.length ? `已开启令牌校验（${cfg.tokens.length} 个令牌）` : '没有设置 ASR_TOKENS：任何人都能调用，只建议在局域网里这样用');
  await loadEngine(cfg, (m) => app.log.info(m));
  const stop = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === (await import('node:fs')).realpathSync(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
