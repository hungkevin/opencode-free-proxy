@echo off
REM opencode-free-proxy 常駐啟動腳本（日常值守：只顯示警告以上）
cd /d C:\work\opencode-free-proxy
if not exist logs mkdir logs
set LOG_LEVEL=warn
set PROXY_PORT=6446
node server.mjs >> logs\proxy.log 2>&1
