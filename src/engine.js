// 识别引擎：sherpa-onnx + SenseVoice（int8），本机 CPU 识别，不联网、不调第三方。
// - 识别走 decodeAsync（libuv 线程池），不阻塞事件循环；全进程排一个队，一次识别一段，
//   最终结果（松开后）插到中间结果前面；队列忙的时候中间结果由会话自己跳过（见 session.js）。
// - 录音只在内存里，识别完就丢，不落盘、不打日志。
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { httpError } from './errors.js';
import { SAMPLE_RATE } from './audio.js';

export const MODEL_FILES = ['model.int8.onnx', 'tokens.txt'];

/** @type {{ recognize(samples: Float32Array): Promise<string> } | null} */
let engine = null;
/** @type {'off'|'loading'|'ready'|'error'} */
let state = 'off';
let detail = '';

/** 测试注入假引擎；传 null 复位 */
export function setEngine(e) {
  engine = e;
  state = e ? 'ready' : 'off';
  detail = '';
  queue.length = 0;
  running = false;
}

export const available = () => state === 'ready' && engine !== null;
export const engineStatus = () => ({ state, detail });

export const modelMissing = (dir) => MODEL_FILES.filter((f) => !existsSync(join(dir, f)));

/** 加载模型（约 0.5–2 秒），结果写日志；失败不抛错，接口回 503 */
export async function loadEngine({ modelDir, threads, language }, log = console.log) {
  const missing = modelMissing(modelDir);
  if (missing.length) {
    state = 'error';
    detail = `模型目录 ${modelDir} 缺 ${missing.join('、')}，先运行 npm run download-model`;
    log(`语音识别未启用：${detail}`);
    return false;
  }
  state = 'loading';
  const t = Date.now();
  try {
    const { default: sherpa } = await import('sherpa-onnx-node');
    const r = await sherpa.OfflineRecognizer.createAsync({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        senseVoice: { model: join(modelDir, 'model.int8.onnx'), language, useInverseTextNormalization: 1 },
        tokens: join(modelDir, 'tokens.txt'),
        numThreads: Math.max(1, threads),
        provider: 'cpu',
        debug: 0,
      },
    });
    engine = {
      async recognize(samples) {
        const s = r.createStream();
        s.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
        await r.decodeAsync(s);
        return r.getResult(s).text.trim();
      },
    };
    state = 'ready';
    detail = `${modelDir}，${threads} 线程，语言 ${language}`;
    log(`语音识别已就绪（加载 ${Date.now() - t}ms，${detail}）`);
    return true;
  } catch (e) {
    state = 'error';
    detail = `加载失败：${e?.message || String(e)}`.slice(0, 300);
    log(`语音识别${detail}`);
    return false;
  }
}

const queue = [];
let running = false;

/** 排队中 + 正在识别的段数（会话据此决定要不要跳过中间结果） */
export const queueDepth = () => queue.length + (running ? 1 : 0);

/** 识别一段 16k 单声道 float 采样；final=true 插队到中间结果前面 */
export function recognize(samples, { final = false } = {}) {
  if (!engine) return Promise.reject(httpError(503, '语音识别暂不可用'));
  return new Promise((resolve, reject) => {
    const job = { samples, final, resolve, reject };
    const i = final ? queue.findIndex((j) => !j.final) : -1;
    if (i >= 0) queue.splice(i, 0, job);
    else queue.push(job);
    void pump();
  });
}

async function pump() {
  if (running) return;
  const job = queue.shift();
  if (!job) return;
  running = true;
  try {
    if (!engine) throw httpError(503, '语音识别暂不可用');
    job.resolve(await engine.recognize(job.samples));
  } catch (e) {
    job.reject(e);
  } finally {
    running = false;
    void pump();
  }
}
