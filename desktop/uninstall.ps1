$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'AI Agent Token Bar.lnk'
if (Test-Path $lnk) { Remove-Item $lnk -Force; Write-Host "Removed autostart shortcut." }

$pidFile = Join-Path $dir 'injector.pid'
if (Test-Path $pidFile) {
  $p = Get-Content $pidFile
  Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  Write-Host "Stopped injector (pid $p)."
}
node --no-warnings (Join-Path $dir 'injector.js') --remove
Write-Host "Done."
