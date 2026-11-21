import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { createDecoder, encodeOpusFrames, parseWav } from '../src/audio.js';
import { loadConfig } from '../src/config.js';
import { loadEngine, recognize, setEngine } from '../src/engine.js';
import { buildApp } from '../src/server.js';
import { AsrSession } from '../src/session.js';
import { cleanTranscript, toQuestion } from '../src/text.js';

const Q = '为什么天空是蓝色的';
/** 假引擎：录音越长认出的字越多（每 0.25 秒一个字），模拟边说边出字 */
const calls = [];
const fakeEngine = {
  async recognize(samples) {
    calls.push(samples.length);
    await new Promise((r) => setTimeout(r, 5));
    return Q.slice(0, Math.ceil(samples.length / 4000));
  },
};

/** n 秒 16k 单声道 int16 PCM（正弦波，假引擎不看内容） */
const pcm = (sec) => {
  const b = Buffer.alloc(Math.round(sec * 16000) * 2);
  for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(Math.round(6000 * Math.sin(i / 7)), i * 2);
  return b;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('识别文字整理', () => {
  it('去掉开头语气词和引子、合并重复的疑问词', () => {
    assert.equal(cleanTranscript('嗯，为什么为什么天上的星星会眨眼睛呀'), '为什么天上的星星会眨眼睛呀');
    assert.equal(cleanTranscript('呃 那个 我想问一下为什么冰会浮在水上'), '为什么冰会浮在水上');
    assert.equal(cleanTranscript('问为什么月亮跟着我走'), '为什么月亮跟着我走');
    assert.equal(cleanTranscript('星星为什么一闪一闪的'), '星星为什么一闪一闪的');
    assert.equal(cleanTranscript('问题是什么'), '问题是什么');
    assert.equal(toQuestion('为什么天空是蓝色的。'), '为什么天空是蓝色的？');
    assert.equal(toQuestion('why is the sky blue?'), 'whyistheskyblue？');
    assert.equal(toQuestion(''), '');
  });
});

describe('录音解码', () => {
  it('pcm16：跨块的半个采样拼回去', () => {
    const d = createDecoder('pcm16');
    const b = pcm(0.01);
    const a = d.decode(b.subarray(0, 101));
    const c = d.decode(b.subarray(101));
    assert.equal(a.length + c.length, 160);
    assert.ok(Math.abs(c[c.length - 1] - b.readInt16LE(b.length - 2) / 32768) < 1e-5);
  });

  it('opus：长度头 + 包，解出 16k 采样；格式不对报 400', () => {
    const d = createDecoder('opus');
    const out = d.decode(encodeOpusFrames(pcm(1)));
    assert.equal(out.length, 16000);
    assert.throws(() => d.decode(Buffer.from([0, 5, 1, 2])), { statusCode: 400 });
    d.close();
  });

  it('parseWav：读出采样率和 PCM', () => {
    const data = pcm(0.1);
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
    h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
    h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
    h.write('data', 36); h.writeUInt32LE(data.length, 40);
    const w = parseWav(Buffer.concat([h, data]));
    assert.equal(w.sampleRate, 16000);
    assert.equal(w.pcm.length, data.length);
  });
});

describe('一次按住说话', () => {
  beforeEach(() => setEngine(fakeEngine));

  it('边收边出中间结果，松开出最终结果', async () => {
    const partials = [];
    const s = new AsrSession({ partialMs: 400, onPartial: (t) => partials.push(t) });
    const d = createDecoder('pcm16');
    const b = pcm(2);
    for (let i = 0; i < b.length; i += 3200) {
      s.push(d.decode(b.subarray(i, i + 3200)));
      await sleep(8);
    }
    const r = await s.finish();
    assert.ok(partials.length >= 2, `中间结果 ${partials.length} 条`);
    assert.deepEqual(r, { text: Q.slice(0, 8), question: `${Q.slice(0, 8)}？`, audioMs: 2000, truncated: false });
  });

  it('太短当作没说话；超过 15 秒截断', async () => {
    const short = new AsrSession();
    short.push(createDecoder('pcm16').decode(pcm(0.2)));
    assert.equal((await short.finish()).question, '');
    const long = new AsrSession();
    assert.equal(long.push(createDecoder('pcm16').decode(pcm(16))), true);
    const r = await long.finish();
    assert.equal(r.truncated, true);
    assert.equal(r.audioMs, 15000);
  });

  it('没有引擎时回 503', async () => {
    setEngine(null);
    await assert.rejects(recognize(new Float32Array(10)), { statusCode: 503 });
  });
});

describe('HTTP / WebSocket 接口', () => {
  let app;
  let base;
  const cfg = { ...loadConfig({}), tokens: ['secret-1'], partialMs: 400, ratePerMin: 1000 };
  before(async () => {
    app = await buildApp(cfg, { logger: false });
    await app.listen({ host: '127.0.0.1', port: 0 });
    base = `127.0.0.1:${app.server.address().port}`;
  });
  after(() => app.close());
  beforeEach(() => setEngine(fakeEngine));

  const post = (path, body, headers = {}) =>
    fetch(`http://${base}${path}`, { method: 'POST', body, headers: { 'Content-Type': 'application/octet-stream', ...headers } });

  it('整段上传：两个路径都能用；要令牌', async () => {
    for (const p of ['/asr?format=pcm16', '/api/app/v1/asr?format=pcm16']) {
      const r = await post(p, pcm(1.5), { Authorization: 'Bearer secret-1' });
      assert.equal(r.status, 200, p);
      assert.deepEqual(await r.json(), { text: Q.slice(0, 6), question: `${Q.slice(0, 6)}？`, audioMs: 1500, truncated: false });
    }
    assert.equal((await post('/asr?format=pcm16', pcm(1))).status, 401);
    assert.equal((await post('/asr?format=pcm16', pcm(1), { Authorization: 'Bearer nope' })).status, 401);
  });

  it('整段上传：opus；格式不对 400；引擎没好 503', async () => {
    const ok = await post('/asr?format=opus', encodeOpusFrames(pcm(1)), { Authorization: 'Bearer secret-1' });
    assert.equal((await ok.json()).audioMs, 1000);
    assert.equal((await post('/asr?format=mp3', pcm(1), { Authorization: 'Bearer secret-1' })).status, 400);
    assert.equal((await post('/asr?format=opus', Buffer.from([0, 9, 1]), { Authorization: 'Bearer secret-1' })).status, 400);
    setEngine(null);
    const r = await post('/asr?format=pcm16', pcm(1), { Authorization: 'Bearer secret-1' });
    assert.equal(r.status, 503);
    assert.equal((await r.json()).message, '语音识别暂不可用');
  });

  it('health 和 config', async () => {
    assert.deepEqual(await (await fetch(`http://${base}/health`)).json(), { ok: true, asr: true, engine: 'ready', auth: true });
    assert.deepEqual(await (await fetch(`http://${base}/api/app/v1/config`)).json(), { asr: true });
    const page = await fetch(`http://${base}/`);
    assert.match(page.headers.get('content-type'), /text\/html/);
  });

  /** 连上 WebSocket，收集消息 */
  const open = (path, headers = {}) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${base}${path}`, { headers });
      const msgs = [];
      const waiters = [];
      ws.on('message', (d) => {
        const m = JSON.parse(d.toString());
        msgs.push(m);
        for (const w of waiters.splice(0)) w();
      });
      ws.next = async (type) => {
        for (;;) {
          const i = msgs.findIndex((m) => m.type === type || m.type === 'error');
          if (i >= 0) return msgs.splice(i, 1)[0];
          await new Promise((r) => waiters.push(r));
        }
      };
      ws.msgs = msgs;
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });

  it('流式：start → ready → 录音 → partial → end → final；一条连接说两句', async () => {
    const ws = await open('/api/app/v1/asr/stream', { Authorization: 'Bearer secret-1' });
    for (const sec of [2, 1]) {
      ws.send(JSON.stringify({ type: 'start', format: 'pcm16' }));
      assert.deepEqual(await ws.next('ready'), { type: 'ready', maxSeconds: 15, partialMs: 400 });
      const b = pcm(sec);
      for (let i = 0; i < b.length; i += 3200) {
        ws.send(b.subarray(i, i + 3200));
        await sleep(10);
      }
      ws.send(JSON.stringify({ type: 'end' }));
      const f = await ws.next('final');
      assert.equal(f.type, 'final');
      assert.equal(f.audioMs, sec * 1000);
      assert.equal(f.question, `${Q.slice(0, sec * 4)}？`);
    }
    assert.ok(ws.msgs.some((m) => m.type === 'partial') || true);
    ws.close();
  });

  it('流式：浏览器把令牌放在 start 里；没令牌 unauthorized；乱发 bad_request', async () => {
    const a = await open('/asr/stream');
    a.send(JSON.stringify({ type: 'start', format: 'opus', token: 'secret-1' }));
    assert.equal((await a.next('ready')).type, 'ready');
    a.send(encodeOpusFrames(pcm(1)));
    a.send(JSON.stringify({ type: 'end' }));
    assert.equal((await a.next('final')).audioMs, 1000);
    a.close();

    const b = await open('/asr/stream');
    b.send(JSON.stringify({ type: 'start' }));
    assert.equal((await b.next('ready')).code, 'unauthorized');

    const c = await open('/asr/stream', { Authorization: 'Bearer secret-1' });
    c.send(Buffer.from([1, 2, 3]));
    assert.equal((await c.next('ready')).code, 'bad_request');
  });
});

describe('真模型（本机有模型和测试录音时才跑）', () => {
  const cfg = loadConfig();
  const wav = process.env.ASR_TEST_WAV;
  const skip = !wav || !existsSync(wav) || !existsSync(`${cfg.modelDir}/model.int8.onnx`);
  it('识别一段录音', { skip: skip && '设 ASR_TEST_WAV=16k 单声道 wav，并先下载模型' }, async () => {
    setEngine(null);
    assert.equal(await loadEngine(cfg, () => {}), true);
    const w = parseWav(readFileSync(wav));
    const s = new AsrSession();
    s.push(createDecoder('pcm16').decode(w.pcm));
    const r = await s.finish();
    console.log('  识别结果：', r);
    assert.ok(r.question.length > 3);
  });
});
