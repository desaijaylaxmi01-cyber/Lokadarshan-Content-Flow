@echo off
setlocal
cd /d "%~dp0"
title Newsdesk
echo.
echo  ==============================
echo   Newsdesk - starting up
echo  ==============================
echo.

where node >nul 2>nul
if errorlevel 1 goto install_node

for /f "tokens=1 delims=v." %%v in ('node -v') do set NODEMAJOR=%%v
if %NODEMAJOR% LSS 22 goto old_node

where ffmpeg >nul 2>nul
if errorlevel 1 goto install_ffmpeg

if not exist node_modules (
  echo First run: installing app components. This takes a minute...
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 goto npm_failed
)

if not exist .env (
  > .env echo ANTHROPIC_API_KEY=
  >> .env echo PORT=3000
)

rem Open the browser once the app has had a few seconds to start.
start "" /min cmd /c "timeout /t 4 /nobreak >nul & start http://localhost:3000"
node src\server.js
echo.
echo Newsdesk has stopped.
pause
exit /b

:install_node
echo Node.js is not installed. Installing Node.js and ffmpeg now...
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
winget install -e --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements
goto reopen

:old_node
echo Your Node.js is too old. Version 22 or newer is needed. Updating now...
winget upgrade -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
goto reopen

:install_ffmpeg
echo ffmpeg is not installed. It is needed to compress videos and make screenshots. Installing now...
winget install -e --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements
goto reopen

:npm_failed
echo.
echo Installing app components failed. Check the internet connection and try again.
pause
exit /b

:reopen
echo.
echo Done. Close this window and double-click start-windows.bat again.
echo If winget is missing, install "App Installer" from the Microsoft Store first.
pause
exit /b
