@echo off
REM opencode-free-proxy 常駐啟動腳本（日常值守：只顯示警告以上）
REM 2026-10 起必須用 Bun 執行：上游免費層以 TLS 指紋擋掉 Node.js
REM （Node 會收到 429 FreeUsageLimitError）。bun 未安裝時請先執行：
REM   powershell -c "irm bun.sh/install.ps1 | iex"
cd /d C:\work\opencode-free-proxy
if not exist logs mkdir logs
set LOG_LEVEL=warn
set PROXY_PORT=6446
where bun >nul 2>nul
if %errorlevel%==0 (
  bun server.mjs >> logs\proxy.log 2>&1
) else if exist "%USERPROFILE%\.bun\bin\bun.exe" (
  "%USERPROFILE%\.bun\bin\bun.exe" server.mjs >> logs\proxy.log 2>&1
) else (
  echo [FATAL] 找不到 bun。上游以 TLS 指紋擋掉 Node.js，必須用 Bun 啟動。
  echo         安裝：powershell -c "irm bun.sh/install.ps1 | iex"
  exit /b 1
)
