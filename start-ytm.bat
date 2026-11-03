@echo off
rem Запуск YT Music Desktop
cd /d "%~dp0"
start "" "%~dp0node_modules\electron\dist\electron.exe" .
