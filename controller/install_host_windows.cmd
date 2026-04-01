@echo off
setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
set "HOST_NAME=com.zhaopin.controller"
set "EXTENSION_ID=%~1"
set "TEMPLATE_FILE=%SCRIPT_DIR%com.zhaopin.controller.template.json"
set "HOST_PATH=%SCRIPT_DIR%run_host.cmd"
set "MANIFEST_FILE=%SCRIPT_DIR%com.zhaopin.controller.windows.json"
set "REG_KEY=HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%"

if "%EXTENSION_ID%"=="" (
  echo Usage: controller\install_host_windows.cmd ^<extension-id^>
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found in PATH.
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$template = Get-Content -Raw '%TEMPLATE_FILE%';" ^
  "$hostPath = [System.IO.Path]::GetFullPath('%HOST_PATH%').Replace('\','\\');" ^
  "$content = $template.Replace('__HOST_PATH__', $hostPath).Replace('__EXTENSION_ID__', '%EXTENSION_ID%');" ^
  "Set-Content -Path '%MANIFEST_FILE%' -Value $content -Encoding UTF8;"

if errorlevel 1 (
  echo Failed to generate manifest file.
  exit /b 1
)

reg add "%REG_KEY%" /ve /t REG_SZ /d "%MANIFEST_FILE%" /f >nul
if errorlevel 1 (
  echo Failed to register Native Messaging host in registry.
  exit /b 1
)

echo Installed Windows Native Messaging host:
echo   %MANIFEST_FILE%
echo Registered key:
echo   %REG_KEY%
echo.
echo Next steps:
echo   1. Reload the Chrome extension
echo   2. Open dashboard.html and let it auto-wake Controller
