@echo off
REM BG Studio - pull the latest from GitHub.
REM Delegates to tools\update.py so the CLI, the in-app button, and any
REM future updater surface all share one code path.
setlocal

set "DIR=%~dp0"
cd /d "%DIR%"

echo.
echo   BG Studio - checking for updates
echo     in:  %DIR%
echo.

set "PY="
where py >nul 2>&1 && set "PY=py -3"
if not defined PY where python >nul 2>&1 && set "PY=python"
if not defined PY (
  echo X Python 3 is required but was not found.
  echo   Install it from https://www.python.org/downloads/ ^(tick "Add to PATH"^),
  echo   or run: winget install Python.Python.3.12
  echo.
  pause
  exit /b 1
)

%PY% "%DIR%tools\update.py" "%DIR%"
set "RC=%errorlevel%"
echo.

if %RC% neq 0 (
  echo X Update failed. See the message above for details.
) else (
  echo Restart BG Studio to pick up any server-side changes.
)

echo.
pause
endlocal
