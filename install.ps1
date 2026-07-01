<#
  BG Studio - installer for Windows (PowerShell).

  What it does (no admin required):
    * checks that Python 3 is available (offers to install via winget if missing)
    * creates a Start Menu shortcut "BG Studio"
    * optionally adds it to your Startup folder so it runs at login (-Autostart)

  Usage (run from this folder):
    powershell -ExecutionPolicy Bypass -File .\install.ps1
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -Autostart
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -Port 9001
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [int]$Port = 8899,
  [switch]$Autostart,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$StartMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$StartupDir = Join-Path $StartMenu 'Startup'
$Lnk = Join-Path $StartMenu 'BG Studio.lnk'
$UpdateLnk = Join-Path $StartMenu 'BG Studio - Update.lnk'
$StartupLnk = Join-Path $StartupDir 'BG Studio.lnk'
$StartBat = Join-Path $Dir 'start.bat'
$UpdateBat = Join-Path $Dir 'update.bat'

function New-Shortcut($Path, $Target, $TargetArgs, $Description, $Minimized) {
  $sh = New-Object -ComObject WScript.Shell
  $s = $sh.CreateShortcut($Path)
  $s.TargetPath = $Target
  $s.Arguments = $TargetArgs
  $s.WorkingDirectory = $Dir
  $s.Description = $Description
  $s.WindowStyle = if ($Minimized) { 7 } else { 1 }   # 7 = minimized
  $s.Save()
}

if ($Uninstall) {
  Write-Host "BG Studio: removing shortcuts (files in $Dir are left untouched)..."
  Remove-Item -Force -ErrorAction SilentlyContinue $Lnk, $UpdateLnk, $StartupLnk
  Write-Host "Done."
  return
}

Write-Host "BG Studio: installing from $Dir"

# 1) Python check.
$py = $null
foreach ($cand in 'py', 'python') {
  if (Get-Command $cand -ErrorAction SilentlyContinue) { $py = $cand; break }
}
if (-not $py) {
  Write-Warning "Python 3 was not found."
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    $ans = Read-Host "Install Python 3 now via winget? [Y/n]"
    if ($ans -eq '' -or $ans -match '^[Yy]') {
      winget install --id Python.Python.3.12 -e --source winget --accept-package-agreements --accept-source-agreements
      Write-Host "Python installed. Close and reopen PowerShell, then re-run this installer."
      return
    }
  }
  Write-Error "Install Python 3 from https://www.python.org/downloads/ (tick 'Add python.exe to PATH'), then re-run."
  return
}
Write-Host "  Python:   $py ($(& $py --version 2>&1))"

# 2) Start Menu shortcuts (launch + update).
New-Shortcut -Path $Lnk -Target $StartBat -TargetArgs "$Port" `
  -Description 'BG Studio - local meme generator + background remover' `
  -Minimized:$false
Write-Host "  Menu:     added 'BG Studio' to the Start Menu"

New-Shortcut -Path $UpdateLnk -Target $UpdateBat -TargetArgs '' `
  -Description 'Pull the latest BG Studio from GitHub' `
  -Minimized:$false
Write-Host "  Menu:     added 'BG Studio - Update' to the Start Menu"

# 3) Optional autostart (Startup folder shortcut, minimized).
if ($Autostart) {
  New-Shortcut -Path $StartupLnk -Target $StartBat -TargetArgs "$Port" `
    -Description 'BG Studio - local meme generator + background remover' `
    -Minimized:$true
  Write-Host "  Autostart: enabled - BG Studio will start at login (minimized)"
}

Write-Host ""
Write-Host "Done."
Write-Host "  Start it:   double-click 'BG Studio' in the Start Menu, or run start.bat"
Write-Host "              it opens http://localhost:$Port/"
Write-Host "  Update:     double-click 'BG Studio - Update' in the Start Menu, or run update.bat"
Write-Host "  Autostart:  .\install.ps1 -Autostart"
Write-Host "  Remove:     .\install.ps1 -Uninstall"
