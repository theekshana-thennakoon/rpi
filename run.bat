@echo off
title Raspberry Pi VCT Web Controller
echo Starting Raspberry Pi Web Controller & Python Runner...
echo.
python -c "import flask, flask_cors, paramiko" 2>NUL
if errorlevel 1 (
    echo Installing missing requirements...
    pip install -r requirements.txt
)
start http://localhost:5000
python server.py
pause
