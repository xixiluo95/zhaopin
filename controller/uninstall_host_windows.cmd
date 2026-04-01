@echo off
setlocal

set "HOST_NAME=com.zhaopin.controller"
set "SCRIPT_DIR=%~dp0"
set "MANIFEST_FILE=%SCRIPT_DIR%com.zhaopin.controller.windows.json"
set "REG_KEY=HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%"

reg delete "%REG_KEY%" /f >nul 2>nul

if exist "%MANIFEST_FILE%" (
  del /f /q "%MANIFEST_FILE%"
)

echo Removed Windows Native Messaging host registration for %HOST_NAME%.
