#!/bin/zsh
set -euo pipefail

APP_DIR="/Users/licc/Desktop/素人系统/app"
NODE_BIN="/Users/licc/.local/bin/node"
LOG_DIR="/Users/licc/Desktop/素人系统/logs"
NAS_API_BASE="${SOUREN_API_BASE:-http://192.168.1.70:5174/api}"
NAS_ACCESS_CODE="${SOUREN_API_ACCESS_CODE:-}"

if [[ -z "${NAS_ACCESS_CODE}" ]]; then
  NAS_ACCESS_CODE=$(/usr/bin/osascript <<'APPLESCRIPT'
try
  set dlg to display dialog "输入 NAS 工作台访问码" default answer "" buttons {"取消", "开始采集"} default button "开始采集" with hidden answer
  return text returned of dlg
on error
  return "__CANCELLED__"
end try
APPLESCRIPT
)
  if [[ "${NAS_ACCESS_CODE}" == "__CANCELLED__" || -z "${NAS_ACCESS_CODE}" ]]; then
    exit 0
  fi
fi

mkdir -p "${LOG_DIR}"
cd "${APP_DIR}"

{
  echo "==== $(date '+%Y-%m-%d %H:%M:%S') NAS Douyin collector ===="
  "${NODE_BIN}" --no-warnings scripts/douyin-chrome-collector.js \
    --base "${NAS_API_BASE}" \
    --access-code "${NAS_ACCESS_CODE}" \
    --register \
    --limit "${SOUREN_COLLECTOR_LIMIT:-10}" \
    --wait-ms "${SOUREN_COLLECTOR_WAIT_MS:-6000}"
} >> "${LOG_DIR}/douyin-collector-nas.log" 2>&1
