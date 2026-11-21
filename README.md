# asr-server

**[English](README.en.md)** · 中文

离线中文语音识别服务：**按住说话，边说边出字，松开后几十毫秒出结果**。不联网、不调第三方，录音只在内存里识别，识别完就丢。

它是 [AI为什么100](https://aiwhy100.com) 给安卓 App 和智能硬件用的同一套识别服务，专门为「孩子问为什么」调过：会去掉开头的「嗯」「我想问一下」，合并结巴重复的「为什么为什么」，末尾补问号。识别引擎是 [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) + [SenseVoice](https://github.com/FunAudioLLM/SenseVoice)，支持普通话、粤语、英语、日语、韩语。

- **两种接法**：WebSocket 流式（边说边出字），或者 HTTP 整段上传（ESP32 这类设备最简单）
- **两种音频格式**：`pcm16`（16kHz 单声道 16 位，设备端不用编码）或 `opus`（约 24 kbps，手机 / 弱网用）
- **普通 CPU 就够**：5 秒录音识别约 0.1 秒（Apple M 系列 2 线程实测）；模型常驻约 600 MB 内存；Linux / macOS / Windows 的 x86_64 和 arm64 都有预编译包（树莓派 4/5 这类 arm64 板子理论上能跑，我们还没实测）
- **和 AI为什么100 线上接口同协议**：设备先连自己的 asr-server 调试，换成 `api.aiwhy100.com` 只改域名

> 要做「孩子按一下就能问问题、几分钟后收到科普动画」的硬件？看 **[device-why100](https://github.com/aiwhy100/device-why100)**：ESP32 固件、树莓派示例、自建网关和接入文档都在那里。

## 快速开始

### 用 Docker（推荐）

```bash
git clone https://github.com/aiwhy100/asr-server.git
cd asr-server
docker compose up -d
docker compose logs -f     # 第一次启动会下载约 230 MB 模型，看到「语音识别已就绪」就好了
```

浏览器打开 <http://localhost:8090>，按住按钮说一句话试试。

### 不用 Docker

需要 Node.js 20 以上。

```bash
npm install
npm run download-model     # 下载模型到 ~/.cache/asr-server，并校验 sha256
npm start                  # http://localhost:8090
```

国内下载 GitHub 慢的话，先设一个镜像地址（同一个文件，照样校验 sha256）：

```bash
ASR_MODEL_URL=https://<镜像>/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2 npm run download-model
```

### 试一下

```bash
# 录一段 16kHz 单声道 WAV（Mac 上可以用 ffmpeg 转：ffmpeg -i in.m4a -ac 1 -ar 16000 -c:a pcm_s16le q.wav）
python3 examples/upload.py q.wav                 # 整段上传
node examples/stream-client.mjs q.wav            # 流式，打印中间结果

# 或者直接用 curl 传裸 PCM（WAV 去掉 44 字节文件头）
tail -c +45 q.wav > q.pcm
curl -s -H 'Content-Type: application/octet-stream' --data-binary @q.pcm 'http://localhost:8090/asr?format=pcm16'
# {"text":"为什么天上的星星会眨眼睛呀","question":"为什么天上的星星会眨眼睛呀？","audioMs":5088,"truncated":false}
```

## 接口

完整协议见 **[docs/protocol.md](docs/protocol.md)**。下面每个路径都同时挂在 `/` 和 `/api/app/v1` 下（后者和 AI为什么100 线上一致）。

| 接口 | 说明 |
|---|---|
| `POST /asr?format=pcm16\|opus` | 整段上传。请求体是录音，最大 1 MB、15 秒。返回 `{ text, question, audioMs, truncated }` |
| `WS /asr/stream` | 流式：`start` → 二进制录音块 → `end` → `final`，期间推 `partial` 中间结果 |
| `GET /health` | `{ ok, asr, engine, auth }`：`asr: true` 表示可以识别 |
| `GET /` | 浏览器试用页（`ASR_DEMO_PAGE=false` 关掉） |

`question` 是整理好的问句；为空串表示没听清（不足 0.3 秒或没识别出字），设备可以提示「没听清，再说一遍」。

## 配置

都是环境变量，Docker 里写在 `docker-compose.yml` 的 `environment`。

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `8090` / `0.0.0.0` | 监听端口和地址 |
| `ASR_TOKENS` | 空 | 访问令牌，逗号分隔。设了以后请求要带 `Authorization: Bearer <令牌>`（浏览器 WebSocket 放在 `start` 消息的 `token` 里）。**放到公网上一定要设**；只在局域网用可以留空 |
| `ASR_MODEL_DIR` | `~/.cache/asr-server/<模型名>` | 模型目录，里面要有 `model.int8.onnx` 和 `tokens.txt`（Docker 里是 `/models/<模型名>`） |
| `ASR_MODEL_URL` | GitHub 官方地址 | 下载模型用的地址，可以换成镜像 |
| `ASR_LANGUAGE` | `zh` | `zh` / `yue` / `en` / `ja` / `ko` / `auto` |
| `ASR_THREADS` | `2` | 每次识别用几个 CPU 线程 |
| `ASR_MAX_SESSIONS` | `20` | 同时识别的路数上限，超出回 `busy` / 503 |
| `ASR_PARTIAL_MS` | `400` | 每攒多少毫秒新录音推一次中间结果 |
| `ASR_RATE_PER_MIN` | `60` | 每个令牌（没设令牌时每个 IP）每分钟最多识别几句 |
| `TRUST_PROXY` | `false` | 跑在 nginx / Caddy 后面时设 `true`，限流才能拿到真实 IP |
| `ASR_AUTO_DOWNLOAD` | `true` | 仅 Docker：模型不在时自动下载 |

## 部署到公网

1. 设 `ASR_TOKENS`（随机长字符串，比如 `openssl rand -hex 24`），每个设备 / 客户端一个，泄露了删掉那一个就行。
2. 前面加 HTTPS 反向代理，**记得放行 WebSocket**。nginx：

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

   Caddy 一行：`asr.example.com { reverse_proxy 127.0.0.1:8090 }`（WebSocket 自动支持）。然后设 `TRUST_PROXY=true`。
3. 检查：`curl https://asr.example.com/health` 返回 `"asr":true`。

**容量估算**：识别在进程里排一个队，一次一段。实测 5 秒录音用 2 个线程约 0.1 秒（Apple M 系列；普通云服务器 CPU 会慢一些），也就是每秒能识别好几句。孩子问问题是零星的，几百台设备同时在线一般够用。需要更多就开多个容器，前面做负载均衡。

## 客户端怎么接

- **ESP32 / 单片机**：录 16kHz 16 位 PCM，松开后整段 `POST /asr?format=pcm16`，最省事。现成固件见 [device-why100](https://github.com/aiwhy100/device-why100)。
- **安卓**：`MediaCodec` 编 Opus，WebSocket 流式；断线时整段上传兜底。见 [docs/protocol.md](docs/protocol.md)「Opus 格式」一节。
- **浏览器**：`AudioWorklet` 取 16k 采样发 `pcm16`，参考 [public/index.html](public/index.html)。
- **树莓派 / Python**：`arecord` 录音，[examples/upload.py](examples/upload.py)。

## 隐私

- 录音只在内存里识别，识别完立刻丢弃；不写文件、不打日志（日志里只有请求路径和耗时）。
- 不联网（除了第一次下载模型），不调任何第三方服务。
- 面向儿童的产品上线前，请在你们的隐私政策里写明录音的处理方式，并取得家长同意。

## 常见问题

**`/health` 里 `asr: false`？** 模型没下载好。`engine` 字段是 `error` 时看启动日志里的原因，一般是模型目录不对或下载被中断（重新 `npm run download-model`）。

**识别结果是繁体 / 英文？** 设 `ASR_LANGUAGE=zh`（默认就是）。孩子说粤语时设 `yue` 或 `auto`。

**内存不够？** 模型常驻约 600 MB，1 GB 内存的机器建议同时关掉别的服务；树莓派建议 2 GB 内存以上、64 位系统（还没实测，欢迎反馈）。

## 许可

[Apache-2.0](LICENSE)。识别模型不在本仓库里，由 `scripts/download-model.sh` 从 sherpa-onnx 官方发布页下载，使用前请阅读 [SenseVoice](https://github.com/FunAudioLLM/SenseVoice) 的模型许可。第三方组件见 [NOTICE](NOTICE)。

由 [AI为什么100](https://aiwhy100.com) 开源：把孩子的「为什么」做成科普动画视频。
