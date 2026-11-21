// 配置全部来自环境变量（见 README「配置」一节）。
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_MODEL = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09';

const int = (v, d) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};
const list = (v) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export function loadConfig(env = process.env) {
  return {
    host: env.HOST || '0.0.0.0',
    port: int(env.PORT, 8090),
    /** 模型目录：里面要有 model.int8.onnx 和 tokens.txt（scripts/download-model.sh 下载） */
    modelDir: env.ASR_MODEL_DIR || join(homedir(), '.cache', 'asr-server', DEFAULT_MODEL),
    /** 识别语言：zh / en / ja / ko / yue / auto */
    language: env.ASR_LANGUAGE || 'zh',
    /** 每次识别用几个 CPU 线程 */
    threads: int(env.ASR_THREADS, 2),
    /** 同时识别的路数上限，超出回 busy */
    maxSessions: int(env.ASR_MAX_SESSIONS, 20),
    /** 每攒够多少毫秒新录音出一次中间结果 */
    partialMs: int(env.ASR_PARTIAL_MS, 400),
    /** 每个令牌（没设令牌时每个 IP）每分钟最多识别几句 */
    ratePerMin: int(env.ASR_RATE_PER_MIN, 60),
    /** 访问令牌，逗号分隔；留空 = 不校验（只建议在局域网里这样用） */
    tokens: list(env.ASR_TOKENS),
    /** 跑在 nginx / Caddy 后面时设 true，限流才能拿到真实 IP */
    trustProxy: env.TRUST_PROXY === 'true',
    /** 首页的浏览器试用页；设 false 关掉 */
    demoPage: env.ASR_DEMO_PAGE !== 'false',
    logLevel: env.LOG_LEVEL || 'info',
  };
}
