@echo off
rem Start KANADE on this PC (opens http://localhost:8080)
cd /d "%~dp0"
start "" http://localhost:8080
python serve.py 8080
pause
