@echo off
setlocal EnableExtensions

pushd "%~dp0" >nul || (
  echo [ThreeBrowser Studio] Could not open the Studio folder.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 goto :missing_node

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)" >nul 2>nul
if errorlevel 1 goto :old_node

set "NEEDS_INSTALL="
if not exist "node_modules\@modelcontextprotocol\server\package.json" set "NEEDS_INSTALL=1"
if not exist "node_modules\acorn\package.json" set "NEEDS_INSTALL=1"
if not exist "node_modules\acorn-walk\package.json" set "NEEDS_INSTALL=1"
if not exist "node_modules\zod\package.json" set "NEEDS_INSTALL=1"

if defined NEEDS_INSTALL (
  where npm >nul 2>nul
  if errorlevel 1 goto :missing_npm
  echo [ThreeBrowser Studio] Installing locked npm dependencies for the first launch...
  call npm ci
  if errorlevel 1 goto :install_failed
)

echo [ThreeBrowser Studio] Starting native WebGPU Studio...
node "scripts\launch.mjs" %*
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo [ThreeBrowser Studio] Studio exited with code %EXIT_CODE%.
  echo Check that ThreeBrowser Runtime is built beside this folder or configured in .studio-local.json.
  pause
)

popd >nul
exit /b %EXIT_CODE%

:missing_node
echo [ThreeBrowser Studio] Node.js was not found. Install Node.js 24 or newer, then try again.
goto :failed

:old_node
echo [ThreeBrowser Studio] Node.js 24 or newer is required. Installed version:
node --version
goto :failed

:missing_npm
echo [ThreeBrowser Studio] npm was not found, so the required packages could not be installed.
goto :failed

:install_failed
echo [ThreeBrowser Studio] npm ci failed. Review the message above and try again.

:failed
popd >nul
pause
exit /b 1
