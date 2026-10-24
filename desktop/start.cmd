@echo off
cd /d "%~dp0"
start "AI Agent Token Bar" /min node --no-warnings "%~dp0injector.js"
