#!/usr/bin/env node
// 流式识别示例：把一个 WAV 当成实时录音，每 100ms 发一块，打印中间结果和最终结果。
//   node examples/stream-client.mjs q.wav [ws://127.0.0.1:8090/asr/stream] [令牌]
// WAV 要求：16kHz、单声道、16 位（ffmpeg -i in.m4a -ac 1 -ar 16000 -c:a pcm_s16le q.wav）
import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import { parseWav } from '../src/audio.js';

const [file, url = 'ws://127.0.0.1:8090/asr/stream', token = process.env.ASR_TOKEN] = process.argv.slice(2);
if (!file) {
  console.error('用法：node examples/stream-client.mjs q.wav [ws://host:8090/asr/stream] [令牌]');
  process.exit(1);
}
const wav = parseWav(readFileSync(file));
if (wav.sampleRate !== 16000 || wav.channels !== 1) {
  console.error(`需要 16kHz 单声道，当前 ${wav.sampleRate}Hz ${wav.channels} 声道`);
  process.exit(1);
}

const ws = new WebSocket(url, token ? { headers: { Authorization: `Bearer ${token}` } } : {});
const t0 = Date.now();
let releasedAt = 0;
ws.on('open', () => ws.send(JSON.stringify({ type: 'start', format: 'pcm16' })));
ws.on('message', async (data) => {
  const m = JSON.parse(data.toString());
  if (m.type === 'ready') {
    // 按真实速度发：100ms 录音 = 3200 字节
    for (let i = 0; i < wav.pcm.length; i += 3200) {
      ws.send(wav.pcm.subarray(i, i + 3200));
      await new Promise((r) => setTimeout(r, 100));
    }
    releasedAt = Date.now();
    ws.send(JSON.stringify({ type: 'end' }));
  } else if (m.type === 'partial') {
    console.log(`${String(Date.now() - t0).padStart(5)}ms  中间结果：${m.text}`);
  } else if (m.type === 'final') {
    console.log(`${String(Date.now() - t0).padStart(5)}ms  最终结果：${m.question || '（没听清）'}  松开后 ${Date.now() - releasedAt}ms`);
    ws.close();
  } else if (m.type === 'error') {
    console.error(`出错：${m.code} ${m.message}`);
    ws.close();
    process.exitCode = 1;
  }
});
ws.on('error', (e) => {
  console.error(`连不上 ${url}：${e.message}`);
  process.exitCode = 1;
});
