<#
  BG Studio - installer for Windows (PowerShell).

  DO NOT "Run as administrator". This installer is per-user by design: it writes
  only to your own Start Menu and profile, so it needs no admin rights at all -
  and elevating actively breaks it, because %APPDATA% and %USERPROFILE% then
  resolve to the *administrator* account and your shortcuts land in the wrong
  profile. The script warns and asks for confirmation if it detects elevation.

  What it does (no admin required):
    * checks that Python 3 is available (offers to install via winget if missing)
    * creates a Start Menu shortcut "BG Studio"
    * optionally adds it to your Startup folder so it runs at login (-Autostart)

  Easiest way to run it: double-click install.bat.

  Or from a NORMAL (non-admin) PowerShell in this folder:
    powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Autostart
    powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Port 9001
    powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall

  The -ExecutionPolicy Bypass applies to that one process only - it changes
  nothing machine-wide, which is why it needs no admin rights.
#>
[CmdletBinding()]
param(
  [int]$Port = 8899,
  [switch]$Autostart,
  [switch]$Uninstall,
  # Skip the "you are running as admin" confirmation (for unattended installs
  # that genuinely intend to install into the elevated account's profile).
  [switch]$AllowElevated
)

$ErrorActionPreference = 'Stop'
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$StartMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$StartupDir = Join-Path $StartMenu 'Startup'
$Lnk = Join-Path $StartMenu 'BG Studio.lnk'
$TrayLnk = Join-Path $StartMenu 'BG Studio (Tray).lnk'
$UpdateLnk = Join-Path $StartMenu 'BG Studio - Update.lnk'
$StartupLnk = Join-Path $StartupDir 'BG Studio.lnk'
$StartBat = Join-Path $Dir 'start.bat'
$StartTrayBat = Join-Path $Dir 'start-tray.bat'
$UpdateBat = Join-Path $Dir 'update.bat'

$Icon = Join-Path $Dir 'favicon.ico'

# ---------------------------------------------------------------------------
# Preflight - the two things that actually stop people installing.
# ---------------------------------------------------------------------------

# 1) Elevation. Not required, and harmful: every path below is per-user, so an
#    elevated run installs BG Studio into the administrator's profile instead of
#    the user's. Warn loudly with the real paths rather than silently doing it.
function Test-Elevated {
  try {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
      [Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch { return $false }
}

if ((Test-Elevated) -and -not $AllowElevated) {
  Write-Warning "This PowerShell is running as Administrator."
  Write-Host ""
  Write-Host "  BG Studio installs per-user and needs NO admin rights. Elevating"
  Write-Host "  changes where everything lands - into the admin account, not yours:"
  Write-Host ""
  Write-Host "    Start Menu:  $StartMenu"
  Write-Host "    Profile:     $env:USERPROFILE"
  Write-Host ""
  Write-Host "  If those don't show YOUR username, close this window and instead"
  Write-Host "  double-click install.bat, or run in a normal PowerShell:"
  Write-Host ""
  Write-Host "    powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1"
  Write-Host ""
  $ans = Read-Host "Install into the paths shown above anyway? [y/N]"
  if ($ans -notmatch '^[Yy]') { Write-Host "Cancelled - nothing was changed."; return }
}

# 2) Mark of the Web. Files extracted from a ZIP downloaded in a browser are
#    tagged as remote, and RemoteSigned then refuses to run them - which is the
#    usual reason people conclude they need admin. Clearing the tag is a
#    per-user operation and needs no elevation.
try {
  Get-ChildItem -Path $Dir -Filter '*.ps1' -ErrorAction Stop |
    Unblock-File -ErrorAction SilentlyContinue
} catch { }

function New-Shortcut($Path, $Target, $TargetArgs, $Description, $Minimized) {
  $sh = New-Object -ComObject WScript.Shell
  $s = $sh.CreateShortcut($Path)
  $s.TargetPath = $Target
  $s.Arguments = $TargetArgs
  $s.WorkingDirectory = $Dir
  $s.Description = $Description
  $s.WindowStyle = if ($Minimized) { 7 } else { 1 }   # 7 = minimized
  # Only set IconLocation if favicon.ico shipped with this checkout.
  if (Test-Path $Icon) { $s.IconLocation = $Icon }
  $s.Save()
}

if ($Uninstall) {
  Write-Host "BG Studio: removing shortcuts (files in $Dir are left untouched)..."
  Remove-Item -Force -ErrorAction SilentlyContinue $Lnk, $TrayLnk, $UpdateLnk, $StartupLnk
  Write-Host "Done."
  return
}

Write-Host "BG Studio: installing from $Dir"
Write-Host "  policy:   $(Get-ExecutionPolicy) (this run is unaffected when launched via install.bat)"

# 1) Python check.
$py = $null
foreach ($cand in 'py', 'python') {
  if (Get-Command $cand -ErrorAction SilentlyContinue) { $py = $cand; break }
}
if (-not $py) {
  Write-Warning "Python 3 was not found."
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host "  (This is the ONLY step that can raise a UAC prompt - it's Windows"
    Write-Host "   installing Python, not BG Studio. Decline it and install Python"
    Write-Host "   yourself from python.org if you'd rather not.)"
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

New-Shortcut -Path $TrayLnk -Target $StartTrayBat -TargetArgs '' `
  -Description 'BG Studio - runs in the system tray (notification area)' `
  -Minimized:$true
Write-Host "  Menu:     added 'BG Studio (Tray)' to the Start Menu"

New-Shortcut -Path $UpdateLnk -Target $UpdateBat -TargetArgs '' `
  -Description 'Pull the latest BG Studio from GitHub' `
  -Minimized:$false
Write-Host "  Menu:     added 'BG Studio - Update' to the Start Menu"

# 3) Optional autostart. With -Autostart we prefer the tray runner so BG
#    Studio launches silently to the notification area on login — no
#    always-open browser tab, no console window.
if ($Autostart) {
  New-Shortcut -Path $StartupLnk -Target $StartTrayBat -TargetArgs '' `
    -Description 'BG Studio - starts to the system tray at login' `
    -Minimized:$true
  Write-Host "  Autostart: enabled - BG Studio (Tray) will start at login"
}

Write-Host ""
Write-Host "Done."
Write-Host "  Start it:   double-click 'BG Studio' in the Start Menu, or run start.bat"
Write-Host "              (opens http://localhost:$Port/ in your browser)"
Write-Host "  Tray:       'BG Studio (Tray)' runs it silently to the notification area"
Write-Host "              (installs pystray+Pillow on first run, no console window)"
Write-Host "  Update:     'BG Studio - Update' in the Start Menu, or update.bat"
Write-Host "  Autostart:  .\install.ps1 -Autostart   (uses the tray runner)"
Write-Host "  Remove:     .\install.ps1 -Uninstall"
