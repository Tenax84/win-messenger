@echo off
setlocal
cd /d "%~dp0"

echo === Messenger telepito keszitese ===

where npm >nul 2>nul
if errorlevel 1 (
    echo HIBA: az npm nem talalhato. Telepitsd a Node.js-t: https://nodejs.org
    pause
    exit /b 1
)

if not exist node_modules (
    echo Fuggosegek telepitese...
    call npm install
    if errorlevel 1 goto :hiba
)

for /f "delims=" %%v in ('node -p "require('./package.json').version"') do set VERSION=%%v
set "INSTALLER=dist\Messenger Setup %VERSION%.exe"

rem A futo Messenger zarolhatja a fajlokat telepites kozben
taskkill /im Messenger.exe /f >nul 2>nul

echo Build (verzio: %VERSION%)...
call npm run build
if errorlevel 1 goto :hiba

if not exist "%INSTALLER%" (
    echo HIBA: a telepito nem talalhato: %INSTALLER%
    pause
    exit /b 1
)

echo Telepito inditasa: %INSTALLER%
start "" "%INSTALLER%"
exit /b 0

:hiba
echo HIBA: a build nem sikerult.
pause
exit /b 1
