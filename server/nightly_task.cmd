@echo off
REM nightly_task.cmd - Windows Task Scheduler wrapper for World Cup Pulse nightly.
REM Runs server/nightly.sh under git-bash. All logging happens inside nightly.sh
REM (server\nightly.log). Exit code is always 0 so the scheduler shows success
REM even when an individual harvest stage fails (nightly.sh is fail-soft).

set "BASH=C:\Program Files\Git\bin\bash.exe"
set "PROJ=D:\Sync\projects\20260620_worldcup_pulse"

if not exist "%BASH%" (
  echo git-bash not found at "%BASH%" 1>&2
  exit /b 0
)

"%BASH%" -lc "cd '/d/Sync/projects/20260620_worldcup_pulse' && sh server/nightly.sh"
exit /b 0
