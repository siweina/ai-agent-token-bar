@echo off
chcp 65001 >nul
setlocal

echo ==========================================================
echo   恢复 Antigravity 智能体面板的会话列表
echo   （面板只显示"摘要索引"里的会话；此脚本把索引里
echo     缺失的真实会话补回去）
echo ==========================================================
echo.

if not exist "F:\Antigravity IDE\Antigravity IDE.exe" (
  echo [错误] 找不到 F:\Antigravity IDE\Antigravity IDE.exe
  echo         如果你的安装目录不同，请修改本文件里的路径。
  echo.
  pause
  exit /b 1
)

echo [1/3] 关闭 Antigravity IDE（必须先关，否则会被它覆盖）...
taskkill /IM "Antigravity IDE.exe" >nul 2>&1
timeout /t 14 /nobreak >nul
taskkill /IM "Antigravity IDE.exe" /F /T >nul 2>&1
timeout /t 4 /nobreak >nul

echo [2/3] 扫描会话库并补齐索引 ...
echo.
node "%~dp0restore-conversation-list.js" --apply --prune
if errorlevel 1 (
  echo.
  echo [错误] 脚本执行失败。需要 Node ^>= 22.5（内置 node:sqlite）。
  echo         当前版本：
  node -v
  echo.
  pause
  exit /b 1
)

echo.
echo [3/3] 重新启动 Antigravity IDE ...
start "" "F:\Antigravity IDE\Antigravity IDE.exe"
echo.
echo ==========================================================
echo   完成。回到 IDE 里点智能体面板右上角的"时钟"图标，
echo   即可看到全部会话（列表默认折叠，点 "Show N more" 展开）。
echo ==========================================================
timeout /t 8 /nobreak >nul
endlocal
