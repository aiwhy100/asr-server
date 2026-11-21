#!/bin/sh
# 容器入口：模型不在就先下载（ASR_AUTO_DOWNLOAD=false 关掉，自己把模型挂进 /models），再启动服务
set -e
if [ "${ASR_AUTO_DOWNLOAD:-true}" != "false" ] && [ ! -f "$ASR_MODEL_DIR/model.int8.onnx" ]; then
  sh /app/scripts/download-model.sh "${ASR_MODEL_ROOT:-/models}" || echo "模型下载失败：服务照常启动，识别接口回 503；设 ASR_MODEL_URL 换下载地址后重启" >&2
fi
exec node /app/src/server.js
