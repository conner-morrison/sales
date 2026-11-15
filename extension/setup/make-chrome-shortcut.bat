<# : batch part -- runs the PowerShell below, which is this same file
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-Expression ([IO.File]::ReadAllText('%~f0'))"
pause
goto :EOF
#>

# LinkedIn Harvester: Chrome setup, once per computer.
#
# Adds --disable-backgrounding-occluded-windows to every Chrome shortcut -- taskbar,
# desktop, Start menu -- so Chrome opened the usual way keeps drawing a window that other
# windows cover. Without it Windows reports a covered window as hidden, LinkedIn's pages
# stop loading in it, and the extension waits until part of it shows.
#
# Also makes a "Chrome (Harvester)" desktop shortcut with the switch. Running it again is
# harmless: shortcuts that already have the switch are left alone.

$switch = "--disable-backgrounding-occluded-windows"
$shell = New-Object -ComObject WScript.Shell

$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $chrome) { Write-Host "Chrome was not found in the usual places. Nothing was changed."; return }

$places = @(
  [Environment]::GetFolderPath("Desktop"),
  [Environment]::GetFolderPath("CommonDesktopDirectory"),
  "$env:APPDATA\Microsoft\Windows\Start Menu",
  "$env:ProgramData\Microsoft\Windows\Start Menu",
  "$env:APPDATA\Microsoft\Internet Explorer\Quick Launch"
) | Where-Object { $_ -and (Test-Path $_) }

$changed = 0; $already = 0; $denied = @()
foreach ($file in Get-ChildItem -Path $places -Filter *.lnk -Recurse -ErrorAction SilentlyContinue) {
  $link = $shell.CreateShortcut($file.FullName)
  if ($link.TargetPath -notlike "*\chrome.exe") { continue }
  if ($link.Arguments -like "*$switch*") { $already++; continue }
  try {
    $link.Arguments = ("$($link.Arguments) $switch").Trim()
    $link.Save()
    $changed++
    Write-Host "Updated: $($file.FullName)"
  } catch {
    $denied += $file.FullName
  }
}

$own = Join-Path ([Environment]::GetFolderPath("Desktop")) "Chrome (Harvester).lnk"
if (-not (Test-Path $own)) {
  $link = $shell.CreateShortcut($own)
  $link.TargetPath = $chrome
  $link.Arguments = $switch
  $link.WorkingDirectory = Split-Path $chrome
  $link.IconLocation = "$chrome,0"
  $link.Description = "Chrome for LinkedIn Harvester: covered windows keep working"
  $link.Save()
  Write-Host "Made: $own"
}

Write-Host ""
Write-Host "Chrome shortcuts updated: $changed (already set: $already)."
if ($denied.Count) {
  Write-Host "Could not change these (they belong to all users; run this file as administrator to change them too):"
  $denied | ForEach-Object { Write-Host "  $_" }
  Write-Host "The 'Chrome (Harvester)' desktop shortcut works either way."
}
Write-Host ""
Write-Host "Last step: close Chrome completely -- every window, and its icon by the clock if"
Write-Host "there is one -- then open it again from a shortcut. chrome://restart is not enough."
