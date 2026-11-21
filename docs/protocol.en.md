# Protocol

English · **[中文](protocol.md)**

Identical to the hosted AI为什么100 speech endpoint (`https://api.aiwhy100.com/api/app/v1/asr`): develop against your own asr-server, then switch to the hosted one by changing only the host and token.

Every path below also works with an `/api/app/v1` prefix.

## Authentication

Only when the server has `ASR_TOKENS` set:

- HTTP and native WebSocket clients: `Authorization: Bearer <token>`;
- Browser WebSockets cannot set headers: put the token in the `token` field of the `start` message.

A bad token gets HTTP 401, or a WebSocket `error` `unauthorized` followed by a close.

## Audio formats

| `format` | Payload | Bitrate | For |
|---|---|---|---|
| `pcm16` | 16 kHz, mono, 16-bit little-endian PCM, raw (no WAV header) | 256 kbps | ESP32 / MCUs, LAN, debugging |
| `opus` | Raw Opus packets (not Ogg), each prefixed by a 2-byte **big-endian** length: `[len][packet][len][packet]…` | 16–24 kbps | Phones, poor networks |

**Opus encoder settings**: mono, 16 kHz or 48 kHz (decoded to 16 kHz on the server), 20 ms frames, 16–24 kbps. Only whole packets in one WebSocket message / request body.

- Android: `MediaCodec` `audio/opus` encoder (Android 10+). Skip `BUFFER_FLAG_CODEC_CONFIG` output (OpusHead); every other output buffer is one packet.
- Browser: WebCodecs `AudioEncoder({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 24000 })`; each `EncodedAudioChunk` is one packet. Fall back to `pcm16` without WebCodecs.
- Node: `encodeOpusFrames()` in `src/audio.js`.

## One-shot upload: `POST /asr?format=pcm16|opus`

The simplest integration: send the whole recording after the button is released.

```http
POST /asr?format=pcm16
Authorization: Bearer <token>
Content-Type: application/octet-stream

<audio bytes>
```

- Max 1 MB and 15 s (15 s of pcm16 ≈ 480 KB). Audio beyond 15 s is dropped and `truncated` is `true`.
- `200` response:

  ```json
  { "text": "为什么天空是蓝色的", "question": "为什么天空是蓝色的？", "audioMs": 2100, "truncated": false }
  ```

  `text` is the transcript with filler words removed; `question` is the normalized question. **An empty `question` means nothing was heard** (under 0.3 s or no words recognized).

- Errors return `{ "statusCode", "error", "message" }`; `message` is user-facing Chinese:

  | Status | Cause |
  |---|---|
  | 400 | Bad `format`, empty body, malformed Opus |
  | 401 | Missing or wrong token |
  | 429 | Too many requests (over `ASR_RATE_PER_MIN` per token per minute) |
  | 503 | Model not loaded, or all recognition slots busy |

## Streaming: `WS /asr/stream`

Partial results while the user is still talking. One connection can carry many utterances (send `start` again after `final`).

| Direction | Message | Notes |
|---|---|---|
| → | `{"type":"start","format":"pcm16"}` | Button down. `format` defaults to `opus`; browsers add `"token":"…"` |
| ← | `{"type":"ready","maxSeconds":15,"partialMs":400}` | Start sending audio |
| → | binary messages | Audio, ideally one message per 100 ms |
| ← | `{"type":"partial","text":"为什么天空"}` | Partial result, may change; display only |
| → | `{"type":"end"}` | Button up |
| ← | `{"type":"final","text":"…","question":"…？","audioMs":2100,"truncated":false}` | Final result, same fields as the upload |
| → | `{"type":"cancel"}` | Cancel this utterance |
| ← | `{"type":"error","code":"…","message":"…"}` | Error; the server then closes the connection |

- The server closes the connection after 10 s without any message (`timeout`).
- At 15 s of audio the server ends the utterance itself and sends `final` with `truncated: true`.
- Error codes: `unauthorized`, `unavailable` (model not ready), `busy`, `too_frequent`, `bad_request` (client bug), `timeout`, `internal`.
- The hosted AI为什么100 endpoint may also send `replaced` (the same account started talking on another device; the connection stays open). Self-hosted asr-server never sends it.

**Degrading on poor networks** (client side):

1. Show a local volume meter while recording so the child knows it is listening;
2. If the send buffer backs up (OkHttp `WebSocket.queueSize()` / browser `bufferedAmount` above ~2 s of audio), stop expecting partials, finish sending and wait for `final`;
3. If the connection drops, upload the whole recording again with `POST /asr`.

## Transcript cleanup

See `src/text.js`. Conservative; never changes the meaning:

- Leading fillers removed (嗯, 呃, 啊, 那个, 就是, 然后…);
- Leading "I want to ask" phrases removed (我想问一下, 请问, 问) when followed by a question word;
- Stuttered question words merged: 为什么为什么 → 为什么;
- Trailing period / exclamation removed, Chinese question mark appended.

## Other endpoints

| Endpoint | Response |
|---|---|
| `GET /health` | `{ "ok": true, "asr": true, "engine": "ready", "auth": true }`. `engine`: `off` / `loading` / `ready` / `error` |
| `GET /api/app/v1/config` | `{ "asr": true }` (same field as the hosted `/config`) |
