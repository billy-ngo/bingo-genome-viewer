@echo off
setlocal enabledelayedexpansion
set ROOT=%~dp0

:: ── First-run setup ───────────────────────────────────────────────────────────
if not exist "%ROOT%.installed" (
    echo ============================================
    echo   BiNgo Genome Viewer - Setting up (one time^)
    echo ============================================
    echo.

    :: Check Python
    where python >nul 2>&1
    if errorlevel 1 (
        echo Python not found. Installing via winget...
        winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements
        if errorlevel 1 (
            echo ERROR: Could not install Python automatically.
            echo Please install from https://www.python.org/downloads/
            echo Check "Add Python to PATH" during install, then run this file again.
            pause & exit /b 1
        )
        echo Python installed. Please close this window and run launch.bat again.
        pause & exit /b 0
    )
    echo [OK] Python found.

    :: Check Node / npm
    where npm >nul 2>&1
    if errorlevel 1 (
        echo Node.js not found. Installing via winget...
        winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
        if errorlevel 1 (
            echo ERROR: Could not install Node.js automatically.
            echo Please install from https://nodejs.org  (LTS version^)
            pause & exit /b 1
        )
        echo Node.js installed. Please close this window and run launch.bat again.
        pause & exit /b 0
    )
    echo [OK] Node.js found.

    echo.
    echo Installing backend packages...
    cd /d "%ROOT%app\backend"
    python -m pip install -r requirements.txt
    if errorlevel 1 ( echo ERROR: Backend package install failed. & pause & exit /b 1 )
    echo [OK] Backend packages installed.

    echo.
    echo Installing frontend packages...
    cd /d "%ROOT%app\frontend"
    npm install
    if errorlevel 1 ( echo ERROR: Frontend package install failed. & pause & exit /b 1 )
    echo [OK] Frontend packages installed.

    echo. > "%ROOT%.installed"
    echo.
    echo ============================================
    echo   Setup complete!
    echo ============================================
    echo.
)

:: ── Launch ────────────────────────────────────────────────────────────────────
echo Starting BiNgo Genome Viewer...

start "BiNgo Genome Viewer - Backend" /min cmd /k "cd /d "%ROOT%app\backend" && python -m uvicorn main:app --host 0.0.0.0 --port 8000"
timeout /t 3 /nobreak >nul
start "BiNgo Genome Viewer - Frontend" /min cmd /k "cd /d "%ROOT%app\frontend" && npm run dev"
timeout /t 4 /nobreak >nul
start "" http://localhost:5173
