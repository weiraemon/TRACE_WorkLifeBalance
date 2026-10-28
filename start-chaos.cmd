@echo off
setlocal
title CHAOS
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-chaos.ps1"
if errorlevel 1 pause
endlocal
