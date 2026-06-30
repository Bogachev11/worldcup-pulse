# World Cup Pulse — server SUPERVISOR (admin-free, self-healing).
# Runs as a detached hidden process. Every few seconds it health-checks the dev
# server on :5280 and restarts it if it's down — so the server effectively never
# stays dead (survives crashes, accidental kills, agent churn). A Startup-folder
# shortcut (see install) relaunches THIS supervisor at every logon, so it also
# survives reboots. No admin / no Scheduled Task required.
$ErrorActionPreference = 'SilentlyContinue'
$port = 5280
$proj = 'D:\Sync\projects\20260620_worldcup_pulse'
$node = 'C:\Program Files\nodejs\node.exe'
$url  = "http://localhost:$port/stage10.html?id=1953888"

while ($true) {
  $up = $false
  try { if ((Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) { $up = $true } } catch { }
  if (-not $up) {
    $env:PORT = "$port"
    Start-Process -FilePath $node -ArgumentList 'server/index.js' -WorkingDirectory $proj -WindowStyle Hidden
    Start-Sleep -Seconds 2
  }
  Start-Sleep -Seconds 5
}
