@echo off
REM BG Studio - launch with a system tray icon (no console window).
REM Installs pystray + Pillow on first run if they aren't there, then hands
REM off to tray.pyw via pythonw (silent).
setlocal

set "DIR=%~dp0"
cd /d "%DIR%"

REM 1) Find a "console" Python for the dependency install step (so if pip
REM    prints anything the user can see it).
set "PYC="
where py >nul 2>&1 && set "PYC=py -3"
if not defined PYC where python >nul 2>&1 && set "PYC=python"
if not defined PYC (
  echo X Python 3 was not found.
  echo   Install it from https://www.python.org/downloads/
  echo   or run: winget install Python.Python.3.12
  pause
  exit /b 1
)

REM 2) Find the windowless Python (pythonw.exe) that corresponds to the
REM    console Python we just chose. Modern Windows ships a fake `pyw` on
REM    PATH that redirects to the Microsoft Store, so PATH-based lookups
REM    (`where pyw`) are unreliable — ask the real interpreter where it
REM    lives and swap python.exe -> pythonw.exe.
set "PYW="
for /f "usebackq delims=" %%p in (`%PYC% -c "import sys, os; e = sys.executable; wc = os.path.join(os.path.dirname(e), 'pythonw.exe'); print(wc if os.path.exists(wc) else '')"`) do set "PYW=%%p"
if not defined PYW (
  echo X pythonw.exe not found next to the console Python.
  echo   Reinstall Python 3 and make sure "py launcher" is included.
  pause
  exit /b 1
)

REM 3) Install pystray + Pillow if missing.
%PYC% -c "import pystray, PIL" 2>nul
if not errorlevel 1 goto :launch
echo Installing tray dependencies (pystray, Pillow) - one-time setup...
%PYC% -m pip install --user --quiet pystray Pillow
if errorlevel 1 (
  echo X Failed to install pystray/Pillow.
  echo   Try manually: %PYC% -m pip install pystray Pillow
  pause
  exit /b 1
)

:launch
REM 4) Launch the tray. `start ""` returns immediately; pythonw keeps the
REM    tray running in the background with no console.
start "" %PYW% "%DIR%tray.pyw"
endlocal
