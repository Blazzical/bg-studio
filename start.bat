@echo off
REM BG Studio - local launcher (Windows).
REM Serves this folder over HTTP (a secure context: localhost) and opens the browser.
setlocal

set "PORT=%~1"
if "%PORT%"=="" set "PORT=8899"
set "DIR=%~dp0"
set "URL=http://localhost:%PORT%/"

REM Find a Python: prefer the py launcher, fall back to python on PATH.
REM (Use && so each set runs at runtime, avoiding the %errorlevel%-in-block trap.)
set "PY="
where py >nul 2>&1 && set "PY=py -3"
if not defined PY where python >nul 2>&1 && set "PY=python"
if not defined PY (
  echo X Python 3 is required but was not found.
  echo   Install it from https://www.python.org/downloads/ ^(tick "Add to PATH"^),
  echo   or run: winget install Python.Python.3.12
  pause
  exit /b 1
)

echo.
echo   BG Studio
echo     serving:  %DIR%
echo     open:     %URL%
echo     (close this window or press Ctrl-C to stop)
echo.

REM Open the browser, then run the server in the foreground.
start "" "%URL%"
%PY% "%DIR%serve.py" %PORT%

endlocal
