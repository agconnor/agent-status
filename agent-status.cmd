@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"

where node >nul 2>&1
if %ERRORLEVEL%==0 (
  node "%SCRIPT_DIR%\index.js" %*
  exit /b %ERRORLEVEL%
)

if exist "%ProgramFiles%\nodejs\node.exe" (
  "%ProgramFiles%\nodejs\node.exe" "%SCRIPT_DIR%\index.js" %*
  exit /b %ERRORLEVEL%
)

echo [agent-status] node not found >&2
exit /b 1
