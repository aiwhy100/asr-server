// 一次「按住说话」：不断收录音，每攒够 partialMs 新录音就把整段重新识别一次推中间结果
// （SenseVoice 不是流式模型，但整段重识别 3 秒录音只要几十毫秒，这样准确率和整段识别一样）；
// 松开时完整识别一次出最终结果。
// - 最长 15 秒，超出的部分丢掉并标 truncated（调用方据此自动结束）；
// - 识别队列忙（排队 > 2 段）或上一个中间结果还没出来时跳过这次中间结果，不影响最终结果。
import { SAMPLE_RATE } from './audio.js';
import { queueDepth, recognize } from './engine.js';
import { cleanTranscript, toQuestion } from './text.js';

export const MAX_SECONDS = 15;
/** 短于这个长度当作没说话（误触） */
const MIN_MS = 300;

export class AsrSession {
  buf = new Float32Array(SAMPLE_RATE * MAX_SECONDS);
  n = 0;
  lastPartialAt = 0;
  partialBusy = false;
  lastPartial = '';
  done = false;
  truncated = false;

  /** @param {{ partialMs?: number, onPartial?: (text: string) => void }} [opts] */
  constructor(opts = {}) {
    this.opts = opts;
    this.step = opts.partialMs && opts.onPartial ? Math.max(1, Math.round((SAMPLE_RATE * opts.partialMs) / 1000)) : Number.POSITIVE_INFINITY;
  }

  get audioMs() {
    return Math.round((this.n * 1000) / SAMPLE_RATE);
  }

  /** 收一段录音；返回 true 表示已到 15 秒上限，应当结束 */
  push(samples) {
    if (this.done) return false;
    const room = this.buf.length - this.n;
    if (samples.length > room) this.truncated = true;
    const take = Math.min(room, samples.length);
    this.buf.set(samples.subarray(0, take), this.n);
    this.n += take;
    if (!this.partialBusy && this.n - this.lastPartialAt >= this.step && queueDepth() <= 2) this.partial();
    return this.n >= this.buf.length;
  }

  partial() {
    this.partialBusy = true;
    this.lastPartialAt = this.n;
    recognize(this.buf.slice(0, this.n))
      .then((raw) => {
        const text = cleanTranscript(raw);
        if (!this.done && text && text !== this.lastPartial) {
          this.lastPartial = text;
          this.opts.onPartial?.(text);
        }
      })
      .catch(() => {
        /* 中间结果失败不要紧，最终结果会再识别 */
      })
      .finally(() => {
        this.partialBusy = false;
      });
  }

  /** @returns {Promise<{ text: string, question: string, audioMs: number, truncated: boolean }>} */
  async finish() {
    this.done = true;
    const audioMs = this.audioMs;
    if (audioMs < MIN_MS) return { text: '', question: '', audioMs, truncated: false };
    const text = cleanTranscript(await recognize(this.buf.slice(0, this.n), { final: true }));
    return { text, question: toQuestion(text), audioMs, truncated: this.truncated };
  }

  cancel() {
    this.done = true;
  }
}
