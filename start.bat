@echo off
cd /d "%~dp0"
echo ============================================
echo   SCARFACE OSINT WEB - Plateforme OSINT
echo ============================================
echo.
echo [1/3] Installation des dependances...
pip install -r requirements.txt
echo.
echo [2/3] Demarrage du serveur...
echo.
echo Acces local : http://127.0.0.1:5000
echo Admin       : admin / admin123
echo Telegram    : @Scarface_OSINT_Bot
echo.
echo ============================================
python app.py
pause
