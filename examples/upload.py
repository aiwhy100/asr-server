#!/usr/bin/env python3
"""整段上传示例（只用标准库）：把一个 WAV 发给 asr-server，打印识别出的问题。

    python3 examples/upload.py q.wav [http://127.0.0.1:8090] [令牌]

WAV 要求：16kHz、单声道、16 位。树莓派上可以直接录一段：
    arecord -f S16_LE -r 16000 -c 1 -d 5 q.wav
"""
import json
import os
import sys
import urllib.error
import urllib.request
import wave


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    path = sys.argv[1]
    base = (sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:8090").rstrip("/")
    token = sys.argv[3] if len(sys.argv) > 3 else os.environ.get("ASR_TOKEN", "")

    with wave.open(path, "rb") as w:
        if w.getframerate() != 16000 or w.getnchannels() != 1 or w.getsampwidth() != 2:
            print("需要 16kHz、单声道、16 位的 WAV", file=sys.stderr)
            return 1
        pcm = w.readframes(w.getnframes())

    req = urllib.request.Request(f"{base}/asr?format=pcm16", data=pcm, method="POST")
    req.add_header("Content-Type", "application/octet-stream")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            r = json.load(resp)
    except urllib.error.HTTPError as e:
        print(f"出错 {e.code}：{json.load(e).get('message')}", file=sys.stderr)
        return 1
    print(r["question"] or "（没听清）", f"（录音 {r['audioMs'] / 1000:.1f} 秒）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
