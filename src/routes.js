// 识别接口（协议见 docs/protocol.md）：
// - WebSocket {prefix}/asr/stream：边说边出字。start → 二进制录音块 → end → final；一条连接可以连着识别多句；
// - POST {prefix}/asr?format=opus|pcm16：整段上传（ESP32 等设备最简单，也是断线时的兜底）。
// 同一套路由挂在 / 和 /api/app/v1 两个前缀下：路径和 AI为什么100 线上接口一致，客户端只改域名就能切换。
// 录音只在内存里识别，不落盘、不打日志。
import { createHash, timingSafeEqual } from 'node:crypto';
import { createDecoder, isFormat } from './audio.js';
import { available } from './engine.js';
import { httpError } from './errors.js';
import { AsrSession, MAX_SECONDS } from './session.js';

/** 多久收不到任何消息就断开 */
const IDLE_MS = 10_000;
/** 一句话从 start 起最长多久（录音最长 15 秒，留出网络慢的余量） */
const UTTERANCE_MS = 45_000;

const digest = (s) => createHash('sha256').update(String(s)).digest();
const bearer = (h) => (typeof h === 'string' && /^Bearer\s+/i.test(h) ? h.replace(/^Bearer\s+/i, '').trim() : '');

export function createRoutes(cfg) {
  const allowed = cfg.tokens.map(digest);
  /** 当前正在识别的句子数（全局上限 maxSessions） */
  let active = 0;
  const starts = new Map();

  /** 校验令牌，返回限流用的身份；没配令牌时按 IP */
  function identify(req, token) {
    if (!allowed.length) return `ip:${req.ip}`;
    const t = token || bearer(req.headers.authorization);
    const d = digest(t);
    if (!t || !allowed.some((a) => timingSafeEqual(a, d))) throw httpError(401, '未授权：缺少令牌或令牌不对');
    return `tok:${d.toString('hex').slice(0, 16)}`;
  }

  function tooFrequent(id, now = Date.now()) {
    const list = (starts.get(id) ?? []).filter((t) => now - t < 60_000);
    list.push(now);
    starts.set(id, list);
    if (starts.size > 10_000) starts.clear();
    return list.length > cfg.ratePerMin;
  }

  return async function asrRoutes(app) {
    app.get('/asr/stream', { websocket: true }, (socket, req) => {
      let who = null;
      let session = null;
      let decoder = null;
      let utteranceTimer;
      let idleTimer;
      let chain = Promise.resolve();
      let closed = false;

      const send = (m) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m));
      };
      const endUtterance = () => {
        if (session) active--;
        session?.cancel();
        session = null;
        decoder?.close();
        decoder = null;
        clearTimeout(utteranceTimer);
      };
      const fail = (code, message) => {
        endUtterance();
        send({ type: 'error', code, message });
        closed = true;
        socket.close(1000);
      };
      const touch = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => fail('timeout', '太久没有收到消息，已断开'), IDLE_MS);
      };

      const finish = async () => {
        const s = session;
        if (!s) return;
        session = null;
        active--;
        decoder?.close();
        decoder = null;
        clearTimeout(utteranceTimer);
        send({ type: 'final', ...(await s.finish()) });
      };

      const start = async (msg) => {
        if (session) return fail('bad_request', '上一句还没结束');
        if (!who) {
          // 原生客户端在握手时带 Authorization 头；浏览器 WebSocket 不能带头，放在 start 消息的 token 里
          try {
            who = identify(req, typeof msg.token === 'string' ? msg.token : '');
          } catch (e) {
            return fail('unauthorized', e.message);
          }
        }
        if (!available()) return fail('unavailable', '语音识别暂不可用');
        const format = msg.format ?? 'opus';
        if (!isFormat(format)) return fail('bad_request', 'format 只能是 opus 或 pcm16');
        if (format === 'pcm16' && msg.sampleRate !== undefined && msg.sampleRate !== 16000) return fail('bad_request', 'pcm16 只支持 16000 Hz 单声道');
        if (tooFrequent(who)) return fail('too_frequent', '说得太频繁了，请稍后再试');
        if (active >= cfg.maxSessions) return fail('busy', '识别的人太多了，请稍后再试');
        decoder = createDecoder(format);
        session = new AsrSession({ partialMs: cfg.partialMs, onPartial: (text) => send({ type: 'partial', text }) });
        active++;
        utteranceTimer = setTimeout(() => {
          chain = chain.then(finish);
        }, UTTERANCE_MS);
        send({ type: 'ready', maxSeconds: MAX_SECONDS, partialMs: cfg.partialMs });
      };

      const handle = async (data, isBinary) => {
        if (closed) return;
        if (isBinary) {
          if (!session || !decoder) return fail('bad_request', '请先发送 start');
          if (session.push(decoder.decode(data))) await finish();
          return;
        }
        let msg;
        try {
          msg = JSON.parse(data.toString('utf8'));
        } catch {
          return fail('bad_request', '消息不是 JSON');
        }
        if (msg?.type === 'start') return start(msg);
        if (msg?.type === 'end') return session ? finish() : undefined;
        if (msg?.type === 'cancel') return endUtterance();
        return fail('bad_request', `不认识的消息类型 ${String(msg?.type)}`);
      };

      touch();
      // 消息监听同步挂上，按到达顺序串行处理
      socket.on('message', (data, isBinary) => {
        touch();
        chain = chain
          .then(() => handle(data, isBinary))
          .catch((e) => {
            if (e?.statusCode === 400) fail('bad_request', e.message);
            else if (e?.statusCode === 503) fail('unavailable', '语音识别暂不可用');
            else {
              req.log.error({ err: String(e) }, 'asr stream failed');
              fail('internal', '识别出错了，请再试一次');
            }
          });
      });
      socket.on('close', () => {
        closed = true;
        clearTimeout(idleTimer);
        endUtterance();
      });
      socket.on('error', () => {});
    });

    // 整段上传：请求体是原始录音（格式同 WebSocket 的二进制消息）
    app.addContentTypeParser(['application/octet-stream', 'audio/opus', 'audio/pcm', 'audio/l16'], { parseAs: 'buffer', bodyLimit: 1024 * 1024 }, (_req, body, done) => done(null, body));
    app.post('/asr', { bodyLimit: 1024 * 1024 }, async (req) => {
      const id = identify(req);
      if (!available()) throw httpError(503, '语音识别暂不可用');
      const format = req.query?.format ?? 'opus';
      if (!isFormat(format)) throw httpError(400, 'format 只能是 opus 或 pcm16');
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw httpError(400, '请求体应为录音数据（Content-Type: application/octet-stream）');
      if (tooFrequent(id)) throw httpError(429, '说得太频繁了，请稍后再试');
      if (active >= cfg.maxSessions) throw httpError(503, '识别的人太多了，请稍后再试');
      const decoder = createDecoder(format);
      const session = new AsrSession();
      active++;
      try {
        session.push(decoder.decode(req.body));
        return await session.finish();
      } finally {
        decoder.close();
        active--;
      }
    });
  };
}
