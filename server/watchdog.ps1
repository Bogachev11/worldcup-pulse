# World Cup Pulse — server watchdog.
# Ensures the persistent dev server on :5280 is always up. Health-checks first so
# it never spawns a duplicate. Registered as a per-minute Scheduled Task so the
# server survives session ends, crashes, and accidental kills — see register_watchdog.ps1.
$ErrorActionPreference = 'SilentlyContinue'
$port = 5280
$proj = 'D:\Sync\projects\20260620_worldcup_pulse'
$node = 'C:\Program Files\nodejs\node.exe'

# If it already answers, do nothing (prevents duplicate instances fighting for the port).
try {
  $r = Invoke-WebRequest "http://localhost:$port/stage10.html?id=1953888" -UseBasicParsing -TimeoutSec 4
  if ($r.StatusCode -eq 200) { exit 0 }
} catch { }

# Not up → start it, detached and hidden, with PORT set.
$env:PORT = "$port"
Start-Process -FilePath $node -ArgumentList 'server/index.js' -WorkingDirectory $proj -WindowStyle Hidden
