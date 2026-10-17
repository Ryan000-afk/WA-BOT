@echo off
echo ========================================================
echo Membuka Microsoft Edge dengan mode Debugging...
echo ========================================================
taskkill /F /IM msedge.exe >nul 2>&1
timeout /t 1 >nul
start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222 "https://www.instagram.com/direct/inbox/"
echo Edge berhasil dibuka dengan Instagram Direct!
