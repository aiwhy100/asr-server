# 识别协议

**[English](protocol.en.md)** · 中文

和 AI为什么100 线上的识别接口（`https://api.aiwhy100.com/api/app/v1/asr`）完全一样：设备可以先连自己的 asr-server 调试，再换成线上地址，只改域名和令牌。

下文的路径都同时可以加 `/api/app/v1` 前缀。

## 鉴权

服务器设了 `ASR_TOKENS` 时才需要：

- HTTP 和原生 WebSocket 客户端：请求头 `Authorization: Bearer <令牌>`；
- 浏览器 WebSocket 不能带头：把令牌放在 `start` 消息的 `token` 字段里。

令牌不对时，HTTP 回 401，WebSocket 回 `error` `unauthorized` 后断开。

## 音频格式

| `format` | 内容 | 码率 | 适合 |
|---|---|---|---|
| `pcm16` | 16kHz、单声道、16 位小端 PCM，裸数据（不要 WAV 头） | 256 kbps | ESP32 / 单片机、局域网、调试 |
| `opus` | 原始 Opus 包（不是 Ogg 文件），每个包前加 2 字节**大端**长度：`[len][packet][len][packet]…` | 16–24 kbps | 手机、弱网 |

**Opus 编码要求**：单声道，16kHz 或 48kHz 都行（服务器统一解成 16k），帧长 20ms，码率 16–24 kbps。一条 WebSocket 消息 / 一个请求体里只放完整的包。

- 安卓：`MediaCodec` 的 `audio/opus` 编码器（Android 10+），`BUFFER_FLAG_CODEC_CONFIG` 的输出（OpusHead 等）不要发，其余每个输出缓冲区就是一个包。
- 浏览器：WebCodecs `AudioEncoder({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 24000 })`，每个 `EncodedAudioChunk` 是一个包；不支持 WebCodecs 时用 `pcm16`。
- Node：`src/audio.js` 里的 `encodeOpusFrames()`。

## 整段上传：`POST /asr?format=pcm16|opus`

最简单的接法：松开按钮后把整段录音一次发过来。

```http
POST /asr?format=pcm16
Authorization: Bearer <令牌>
Content-Type: application/octet-stream

<录音数据>
```

- 最大 1 MB、15 秒（pcm16 15 秒约 480 KB）。超过 15 秒的部分丢掉，`truncated: true`。
- 返回 `200`：

  ```json
  { "text": "为什么天空是蓝色的", "question": "为什么天空是蓝色的？", "audioMs": 2100, "truncated": false }
  ```

  `text` 是去掉语气词后的识别文字；`question` 是规整好的问句，**空串表示没听清**（不足 0.3 秒或没识别出字）。

- 错误返回 `{ "statusCode", "error", "message" }`，`message` 是中文，可以直接给用户看：

  | 状态码 | 原因 |
  |---|---|
  | 400 | `format` 不对、请求体为空、Opus 数据格式不对 |
  | 401 | 令牌缺失或不对 |
  | 429 | 太频繁（每个令牌每分钟超过 `ASR_RATE_PER_MIN` 句） |
  | 503 | 模型没加载好，或同时识别的路数满了 |

## 流式：`WS /asr/stream`

边说边出字。一条连接可以连着说多句（`final` 之后再发 `start`）。

| 方向 | 消息 | 说明 |
|---|---|---|
| → | `{"type":"start","format":"pcm16"}` | 按下。`format` 默认 `opus`；浏览器加 `"token":"…"` |
| ← | `{"type":"ready","maxSeconds":15,"partialMs":400}` | 可以开始发录音 |
| → | 二进制消息 | 录音，建议每 100ms 发一条 |
| ← | `{"type":"partial","text":"为什么天空"}` | 中间结果，会变，只用来显示 |
| → | `{"type":"end"}` | 松开 |
| ← | `{"type":"final","text":"…","question":"…？","audioMs":2100,"truncated":false}` | 最终结果，字段同整段上传 |
| → | `{"type":"cancel"}` | 取消这一句（比如手指滑出按钮） |
| ← | `{"type":"error","code":"…","message":"…"}` | 出错，随后服务器断开连接 |

- 10 秒没有任何消息，服务器断开（`timeout`）。
- 录音满 15 秒，服务器自动结束并回 `final`（`truncated: true`）。
- 错误码：`unauthorized`、`unavailable`（模型没好）、`busy`（路数满了）、`too_frequent`、`bad_request`（客户端 bug）、`timeout`、`internal`。
- 线上 AI为什么100 还多一个 `replaced`：同一账号在另一台设备上开始说话，这一句被取消（连接保留）。自建的 asr-server 不会发这个。

**网络差时的降级**（客户端负责）：

1. 说话时显示本地的音量波形（不依赖网络），让孩子知道「在听」；
2. 发送缓冲积压（OkHttp `WebSocket.queueSize()` / 浏览器 `bufferedAmount` 超过约 2 秒录音）时，不再指望中间结果，照常发完、等 `final`；
3. 连接断了：把整段录音用 `POST /asr` 再传一次。

## 识别文字怎么整理的

见 `src/text.js`，只做保守的清理，不改问题的意思：

- 去掉开头的语气词：嗯、呃、啊、那个、就是、然后……
- 去掉提问引子：「我想问一下」「请问」「问」后面紧跟疑问词时；
- 合并结巴重复：「为什么为什么」→「为什么」；
- 去掉末尾的句号 / 感叹号，补一个中文问号。

## 其他接口

| 接口 | 返回 |
|---|---|
| `GET /health` | `{ "ok": true, "asr": true, "engine": "ready", "auth": true }`。`engine`：`off` / `loading` / `ready` / `error` |
| `GET /api/app/v1/config` | `{ "asr": true }`（和线上 `/config` 的这个字段一致，客户端据此决定显示「按住说话」还是打字） |
