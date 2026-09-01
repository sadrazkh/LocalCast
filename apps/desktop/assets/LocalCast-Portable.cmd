@echo off
rem Runs LocalCast in portable mode from the folder this file sits in.
rem
rem Without it, the unpacked build behaves like an installed one: it works, but its database,
rem paired devices and tailnet identity go to %APPDATA% and stay on this machine. Copy the
rem folder to another PC or a USB stick and you would start again from an empty library.
rem
rem With LOCALCAST_PORTABLE=1 the app keeps all of that in LocalCast-data beside the
rem executable, so the folder is the whole installation and travels intact.
setlocal
set "LOCALCAST_PORTABLE=1"
start "" "%~dp0LocalCast.exe" %*
endlocal
