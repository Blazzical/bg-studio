@echo off
REM ---------------------------------------------------------------------------
REM BG Studio - installer, double-click entry point.
REM
REM Do NOT right-click "Run as administrator". BG Studio installs per-user and
REM elevating puts the Start Menu shortcuts in the administrator's profile
REM instead of yours. Just double-click this file.
REM
REM -ExecutionPolicy Bypass applies to this single PowerShell process only. It
REM changes nothing machine-wide, which is exactly why it needs no admin rights
REM and why you never have to run Set-ExecutionPolicy.
REM ---------------------------------------------------------------------------
setlocal
set "HERE=%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%install.ps1" %*
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
  echo Install did not complete cleanly ^(exit code %RC%^) - see the messages above.
) else (
  echo Launch BG Studio from the Start Menu, or run start.bat in this folder.
)
echo.
pause
endlocal
