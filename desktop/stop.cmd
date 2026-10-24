@echo off
cd /d "%~dp0"
if exist injector.pid (
  for /f %%p in (injector.pid) do taskkill /PID %%p /F >nul 2>&1
  del /f /q injector.pid >nul 2>&1
)
node --no-warnings "%~dp0injector.js" --remove
