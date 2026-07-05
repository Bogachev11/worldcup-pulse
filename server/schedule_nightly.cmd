@echo off
REM schedule_nightly.cmd - register the World Cup Pulse nightly job with Windows
REM Task Scheduler, running daily at 04:30 local. Uses schtasks (no admin needed
REM for a task in the current user's context). Re-run to update; /F overwrites.
REM
REM Run this once (double-click or from a terminal):
REM     server\schedule_nightly.cmd
REM
REM Verify afterwards:   schtasks /Query /TN "WorldCupPulse Nightly" /V /FO LIST

schtasks /Create ^
  /TN "WorldCupPulse Nightly" ^
  /TR "'D:\Sync\projects\20260620_worldcup_pulse\server\nightly_task.cmd'" ^
  /SC DAILY ^
  /ST 04:30 ^
  /F

if %ERRORLEVEL%==0 (
  echo.
  echo Registered "WorldCupPulse Nightly" - runs daily at 04:30 local.
) else (
  echo.
  echo schtasks registration FAILED with code %ERRORLEVEL%.
)
