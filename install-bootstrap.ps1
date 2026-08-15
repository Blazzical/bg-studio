<#
  BG Studio - one-liner bootstrap installer for Windows.

  What it does:
    * downloads the latest bg-studio tarball from GitHub (no git required)
    * extracts to a target directory (default: $env:USERPROFILE\bg-studio)
    * runs install.ps1 to add the Start Menu shortcut

  Run it in a NORMAL PowerShell window - NOT "Run as administrator". Everything
  installs per-user ($env:USERPROFILE + your own Start Menu), so admin rights are
  not needed, and elevating would install BG Studio into the administrator's
  profile instead of yours.

  Usage (from PowerShell, no clone required):
    iwr -useb https://raw.githubusercontent.com/Blazzical/bg-studio/main/install-bootstrap.ps1 | iex

  Piping to iex runs the code in memory, so the execution policy never applies -
  there is nothing to unblock and no Set-ExecutionPolicy to run.

  With options (invoke the script directly instead of piping):
    iwr -useb https://.../install-bootstrap.ps1 -OutFile bs.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File bs.ps1 -Dir 'C:\Tools\bg-studio' -Autostart
#>
[CmdletBinding()]
param(
  [string]$Dir = (Join-Path $env:USERPROFILE 'bg-studio'),
  [switch]$Autostart,
  # Skip the "you are running as admin" confirmation (unattended installs).
  [switch]$AllowElevated
)

$ErrorActionPreference = 'Stop'
$TarballUrl = 'https://api.github.com/repos/Blazzical/bg-studio/tarball/main'

Write-Host "BG Studio bootstrap"
Write-Host "  target:  $Dir"
Write-Host ""

# Elevation check - see the header. Admin isn't required, and it silently sends
# the install to the wrong profile, so confirm before proceeding.
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
  Write-Host "  BG Studio needs NO admin rights. Elevated, it would install to the"
  Write-Host "  administrator's account rather than yours:"
  Write-Host ""
  Write-Host "    Install dir: $Dir"
  Write-Host "    Start Menu:  $(Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs')"
  Write-Host ""
  Write-Host "  If those don't show YOUR username, close this window and re-run the"
  Write-Host "  one-liner in a normal (non-admin) PowerShell."
  Write-Host ""
  $ans = Read-Host "Install into the paths shown above anyway? [y/N]"
  if ($ans -notmatch '^[Yy]') { Write-Host "Cancelled - nothing was changed."; return }
}

# 1) Ensure Python is available (needed to run the tarball updater in the
#    normal installer, and to serve the app). Offer winget install if missing.
$py = $null
foreach ($cand in 'py', 'python') {
  if (Get-Command $cand -ErrorAction SilentlyContinue) { $py = $cand; break }
}
if (-not $py) {
  Write-Warning "Python 3 was not found."
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    $ans = Read-Host "Install Python 3 now via winget? [Y/n]"
    if ($ans -eq '' -or $ans -match '^[Yy]') {
      winget install --id Python.Python.3.12 -e --source winget `
        --accept-package-agreements --accept-source-agreements
      Write-Host "Python installed. Close and reopen PowerShell, then re-run this bootstrap."
      return
    }
  }
  Write-Error "Install Python 3 from https://www.python.org/downloads/ (tick 'Add python.exe to PATH'), then re-run."
  return
}
Write-Host "  Python:  $py ($(& $py --version 2>&1))"

# 2) Download the tarball.
$tmp = New-Item -ItemType Directory -Force -Path (Join-Path $env:TEMP ("bgs-bootstrap-" + [Guid]::NewGuid().ToString('N').Substring(0,8)))
$tarballPath = Join-Path $tmp 'bg-studio.tar.gz'
Write-Host "  download: $TarballUrl"
try {
  Invoke-WebRequest -UseBasicParsing -Uri $TarballUrl -OutFile $tarballPath
} catch {
  Write-Error "Download failed: $($_.Exception.Message)"
  return
}

# 3) Extract via Python's tarfile (avoids depending on tar.exe on older Windows).
Write-Host "  extract: $Dir"
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$py3 = if ($py -eq 'py') { 'py -3' } else { $py }
$extractScript = @"
import os, sys, tarfile
src = r'''$tarballPath'''
dst = r'''$Dir'''
os.makedirs(dst, exist_ok=True)
with tarfile.open(src, 'r:gz') as t:
    members = t.getmembers()
    if not members:
        print('empty tarball', file=sys.stderr); sys.exit(1)
    # GitHub tarballs wrap in Blazzical-bg-studio-<sha>/ — strip that prefix.
    prefix = members[0].name.split('/', 1)[0] + '/'
    for m in members:
        if not m.name.startswith(prefix): continue
        m.name = m.name[len(prefix):]
        if not m.name: continue
        t.extract(m, dst)
print('ok')
"@
$extractScript | & $py -
if ($LASTEXITCODE -ne 0) { Write-Error "Extract failed."; return }

# 4) Run the normal installer from the extracted tree.
$installer = Join-Path $Dir 'install.ps1'
if (-not (Test-Path $installer)) { Write-Error "install.ps1 not found in extracted tree at $Dir"; return }
Write-Host ""
Write-Host "  Handing off to install.ps1..."
Write-Host ""
$installArgs = @()
if ($Autostart) { $installArgs += '-Autostart' }
# We already asked about elevation above; don't ask a second time.
if (Test-Elevated) { $installArgs += '-AllowElevated' }
& powershell -NoProfile -ExecutionPolicy Bypass -File $installer @installArgs

# Best-effort cleanup of the download temp dir.
try { Remove-Item -Recurse -Force $tmp } catch {}
