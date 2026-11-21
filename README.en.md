# asr-server

English · **[中文](README.md)**

Offline Chinese speech recognition server for **push-to-talk**: partial results while you speak, the final result a few dozen milliseconds after you let go. No internet, no third-party APIs. Audio is recognized in memory and discarded.

It is the same recognition service [AI为什么100](https://aiwhy100.com) runs for its Android app and smart devices, tuned for kids asking "why" questions: it drops leading fillers (嗯, 我想问一下…), merges stuttered question words (为什么为什么 → 为什么) and appends a question mark. The engine is [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) + [SenseVoice](https://github.com/FunAudioLLM/SenseVoice) and handles Mandarin, Cantonese, English, Japanese and Korean.

- **Two ways in**: WebSocket streaming with partial results, or a one-shot HTTP upload (simplest for ESP32-class devices)
- **Two audio formats**: `pcm16` (16 kHz mono 16-bit, no encoder needed on the device) or `opus` (~24 kbps, for phones and poor networks)
- **Plain CPU**: ~0.1 s to recognize 5 s of audio (measured on Apple M-series, 2 threads); ~600 MB RAM for the model; prebuilt binaries for x86_64 and arm64 on Linux, macOS and Windows
- **Same protocol as the hosted AI为什么100 endpoint**: develop against your own server, switch to `api.aiwhy100.com` by changing the host

> Building a device that lets a kid press a button, ask a question and get a science cartoon a few minutes later? See **[device-why100](https://github.com/aiwhy100/device-why100)**: ESP32 firmware, Raspberry Pi examples, a self-hosted gateway and integration docs.

## Quick start

### Docker (recommended)

```bash
git clone https://github.com/aiwhy100/asr-server.git
cd asr-server
docker compose up -d
docker compose logs -f     # first start downloads the ~230 MB model; wait for「语音识别已就绪」(ready)
```

Open <http://localhost:8090>, hold the button and say something.

### Without Docker

Node.js 20+.

```bash
npm install
npm run download-model     # downloads to ~/.cache/asr-server and verifies sha256
npm start                  # http://localhost:8090
```

Set `ASR_MODEL_URL` to a mirror of the same `.tar.bz2` if GitHub downloads are slow (the sha256 is still verified).

### Try it

```bash
# a 16 kHz mono WAV (convert with: ffmpeg -i in.m4a -ac 1 -ar 16000 -c:a pcm_s16le q.wav)
python3 examples/upload.py q.wav                 # one-shot upload
node examples/stream-client.mjs q.wav            # streaming, prints partial results

# or plain curl with raw PCM (strip the 44-byte WAV header)
tail -c +45 q.wav > q.pcm
curl -s -H 'Content-Type: application/octet-stream' --data-binary @q.pcm 'http://localhost:8090/asr?format=pcm16'
# {"text":"为什么天上的星星会眨眼睛呀","question":"为什么天上的星星会眨眼睛呀？","audioMs":5088,"truncated":false}
```

## API

Full protocol: **[docs/protocol.en.md](docs/protocol.en.md)**. Every path is served both at `/` and under `/api/app/v1` (the latter matches the hosted service).

| Endpoint | Description |
|---|---|
| `POST /asr?format=pcm16\|opus` | One-shot upload. Body is the audio, max 1 MB / 15 s. Returns `{ text, question, audioMs, truncated }` |
| `WS /asr/stream` | Streaming: `start` → binary audio → `end` → `final`, with `partial` results in between |
| `GET /health` | `{ ok, asr, engine, auth }`; `asr: true` means ready |
| `GET /` | Browser demo page (`ASR_DEMO_PAGE=false` to disable) |

An empty `question` means nothing was heard; the device can say "I didn't catch that".

## Configuration

Environment variables (in Docker, the `environment` block of `docker-compose.yml`).

| Variable | Default | Description |
|---|---|---|
| `PORT` / `HOST` | `8090` / `0.0.0.0` | Listen port and address |
| `ASR_TOKENS` | empty | Comma-separated access tokens. When set, requests need `Authorization: Bearer <token>` (browser WebSockets send it as `token` in `start`). **Always set it on the public internet** |
| `ASR_MODEL_DIR` | `~/.cache/asr-server/<model>` | Must contain `model.int8.onnx` and `tokens.txt` (`/models/<model>` in Docker) |
| `ASR_MODEL_URL` | official GitHub release | Model download URL; point it at a mirror if needed |
| `ASR_LANGUAGE` | `zh` | `zh` / `yue` / `en` / `ja` / `ko` / `auto` |
| `ASR_THREADS` | `2` | CPU threads per recognition |
| `ASR_MAX_SESSIONS` | `20` | Concurrent utterances; beyond that `busy` / 503 |
| `ASR_PARTIAL_MS` | `400` | New audio needed before the next partial result |
| `ASR_RATE_PER_MIN` | `60` | Utterances per minute per token (per IP without tokens) |
| `TRUST_PROXY` | `false` | Set `true` behind nginx / Caddy so rate limits see real client IPs |
| `ASR_AUTO_DOWNLOAD` | `true` | Docker only: download the model on start if missing |

## Deploying publicly

1. Set `ASR_TOKENS` (long random strings, e.g. `openssl rand -hex 24`), one per device or client so a leaked one can be revoked alone.
2. Put an HTTPS reverse proxy in front and **allow WebSocket upgrades**. nginx:

   ```nginx
   location / {
     proxy_pass http://127.0.0.1:8090;
     proxy_http_version 1.1;
     proxy_set_header Upgrade $http_upgrade;
     proxy_set_header Connection "upgrade";
     proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
     proxy_read_timeout 60s;
     client_max_body_size 2m;
   }
   ```

   Caddy: `asr.example.com { reverse_proxy 127.0.0.1:8090 }`. Then set `TRUST_PROXY=true`.
3. Check: `curl https://asr.example.com/health` returns `"asr":true`.

**Capacity**: recognitions run one at a time from a single in-process queue. 5 s of audio takes ~0.1 s on 2 threads (Apple M-series; typical cloud CPUs are slower), so several utterances per second. Kids' questions are sporadic, so a few hundred online devices are usually fine. Scale out with more containers behind a load balancer.

## Clients

- **ESP32 / MCUs**: record 16 kHz 16-bit PCM, `POST /asr?format=pcm16` after release. Ready-made firmware: [device-why100](https://github.com/aiwhy100/device-why100).
- **Android**: `MediaCodec` Opus over the WebSocket, one-shot upload as fallback. See "Audio formats" in the protocol.
- **Browser**: `AudioWorklet` → `pcm16`, see [public/index.html](public/index.html).
- **Raspberry Pi / Python**: `arecord` + [examples/upload.py](examples/upload.py).

## Privacy

- Audio is recognized in memory and discarded immediately: no files, no audio in logs (logs contain only paths and timings).
- No network access except the one-time model download; no third-party services.
- If your product is for children, state how voice recordings are handled in your privacy policy and get parental consent.

## License

[Apache-2.0](LICENSE). The model is not in this repository; `scripts/download-model.sh` fetches it from the official sherpa-onnx releases. Read the [SenseVoice](https://github.com/FunAudioLLM/SenseVoice) model license before use. Third-party notices: [NOTICE](NOTICE).

Open-sourced by [AI为什么100](https://aiwhy100.com), which turns kids' "why" questions into animated science videos.
