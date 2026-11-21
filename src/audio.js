// 上传的录音 → 16kHz 单声道 float 采样。
// - pcm16：16kHz 单声道 16 位小端 PCM，原样拼接（约 256 kbps，局域网 / ESP32 用这个最简单）；
// - opus：原始 Opus 包（不是 Ogg 文件），每个包前加 2 字节大端长度：[len][packet][len][packet]…；
//   编码端采样率随意（16k / 48k 都行），统一解成 16k 单声道。约 16–24 kbps，手机 / 弱网用这个。
//   一条 WebSocket 消息 / 一个请求体里只放完整的包。
import OpusScript from 'opusscript';
import { httpError } from './errors.js';

export const SAMPLE_RATE = 16000;
export const FORMATS = ['pcm16', 'opus'];
export const isFormat = (v) => FORMATS.includes(v);

function int16ToFloat(buf, offset = 0, bytes = buf.length - offset) {
  const n = bytes >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(offset + i * 2) / 32768;
  return out;
}

class Pcm16Decoder {
  /** 上一块剩下的半个采样（单字节） */
  carry = null;
  decode(buf) {
    const b = this.carry ? Buffer.concat([this.carry, buf]) : buf;
    this.carry = b.length % 2 ? b.subarray(b.length - 1) : null;
    return int16ToFloat(b, 0, b.length - (b.length % 2));
  }
  close() {}
}

class OpusDecoder {
  d = new OpusScript(SAMPLE_RATE, 1, OpusScript.Application.VOIP);
  decode(buf) {
    if (!this.d) throw httpError(400, '解码器已关闭');
    const parts = [];
    let off = 0;
    while (off < buf.length) {
      if (off + 2 > buf.length) throw httpError(400, 'Opus 数据格式不对：长度头不完整');
      const len = buf.readUInt16BE(off);
      off += 2;
      if (!len || len > OpusScript.MAX_PACKET_SIZE || off + len > buf.length) throw httpError(400, 'Opus 数据格式不对：包长度不对');
      let pcm;
      try {
        pcm = this.d.decode(buf.subarray(off, off + len));
      } catch {
        throw httpError(400, 'Opus 数据格式不对：解码失败');
      }
      parts.push(int16ToFloat(pcm));
      off += len;
    }
    if (parts.length === 1) return parts[0];
    const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
  close() {
    this.d?.delete();
    this.d = null;
  }
}

/** @param {'pcm16'|'opus'} format */
export function createDecoder(format) {
  return format === 'opus' ? new OpusDecoder() : new Pcm16Decoder();
}

/** 客户端示例 / 测试用：16k 单声道 int16 PCM → 带长度头的 Opus 包序列（20ms 一包） */
export function encodeOpusFrames(pcm, bitrate = 24000) {
  const e = new OpusScript(SAMPLE_RATE, 1, OpusScript.Application.VOIP);
  e.setBitrate(bitrate);
  const frame = (SAMPLE_RATE / 50) * 2; // 20ms 的字节数
  const out = [];
  try {
    for (let i = 0; i < pcm.length; i += frame) {
      let chunk = pcm.subarray(i, i + frame);
      if (chunk.length < frame) chunk = Buffer.concat([chunk, Buffer.alloc(frame - chunk.length)]);
      const p = e.encode(chunk, SAMPLE_RATE / 50);
      const head = Buffer.alloc(2);
      head.writeUInt16BE(p.length);
      out.push(head, Buffer.from(p));
    }
  } finally {
    e.delete();
  }
  return Buffer.concat(out);
}

/** 读 16 位 PCM 的 WAV（只认 RIFF/WAVE + fmt + data），返回 { sampleRate, channels, pcm } */
export function parseWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('不是 WAV 文件');
  let off = 12;
  let fmt = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, off + 8 + size);
    if (id === 'fmt ') fmt = { format: body.readUInt16LE(0), channels: body.readUInt16LE(2), sampleRate: body.readUInt32LE(4), bits: body.readUInt16LE(14) };
    if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.bits !== 16) throw new Error('只支持 16 位 PCM WAV');
      return { sampleRate: fmt.sampleRate, channels: fmt.channels, pcm: body };
    }
    off += 8 + size + (size & 1);
  }
  throw new Error('WAV 里没有 data 块');
}
