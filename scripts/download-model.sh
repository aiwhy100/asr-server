#!/bin/sh
# 下载识别模型（sherpa-onnx 官方发布的 SenseVoice int8，约 230 MB）并校验 sha256。
#   sh scripts/download-model.sh [目标目录]
# 目标目录默认 ~/.cache/asr-server；也读 ASR_MODEL_ROOT。
# 国内下载 GitHub 慢时，设 ASR_MODEL_URL 换成同一个 tar.bz2 的镜像地址（sha256 不变，照样校验）。
set -eu

NAME=sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09
ROOT="${1:-${ASR_MODEL_ROOT:-$HOME/.cache/asr-server}}"
URL="${ASR_MODEL_URL:-https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/$NAME.tar.bz2}"
DIR="$ROOT/$NAME"

sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
ok() {
  [ -f "$DIR/model.int8.onnx" ] && [ -f "$DIR/tokens.txt" ] &&
    [ "$(sha "$DIR/model.int8.onnx")" = 12ca1a2ae7ecf3e0019ef2822307ee0b5cadc9196569e379b4c4026f8205276d ] &&
    [ "$(sha "$DIR/tokens.txt")" = f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc ]
}

if ok; then echo "模型已就绪：$DIR"; exit 0; fi

mkdir -p "$ROOT"
echo "下载 $NAME（约 230 MB）"
echo "  $URL"
rm -rf "$DIR" "$ROOT/.model.tar.bz2"
curl -fL --retry 3 --connect-timeout 20 -o "$ROOT/.model.tar.bz2" "$URL"
tar xjf "$ROOT/.model.tar.bz2" -C "$ROOT"
rm -f "$ROOT/.model.tar.bz2"

if ok; then
  echo "模型已就绪：$DIR"
  echo "启动时设 ASR_MODEL_DIR=$DIR（默认就是这个目录时不用设）"
else
  rm -rf "$DIR"
  echo "模型校验失败（sha256 对不上），已删除，请重试或换下载地址" >&2
  exit 1
fi
