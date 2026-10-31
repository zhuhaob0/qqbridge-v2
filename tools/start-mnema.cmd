@echo off
cd /d E:\Code\mnema
start "" /b "D:\dev_tools\Nodejs\node.exe" src\cli.js serve --port 8321 --db "%USERPROFILE%\mnema-data\mnema.db"
