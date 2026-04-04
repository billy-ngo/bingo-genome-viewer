@echo off
setlocal enabledelayedexpansion
title BiNgo Genome Viewer
echo.
echo   ==========================================
echo     BiNgo Genome Viewer - Setup ^& Launch
echo   ==========================================
echo.

:: ── Find Python 3 ──────────────────────────────────────────────
set "PYTHON="

py -3 --version >nul 2>nul
if not errorlevel 1 (
    set "PYTHON=py -3"
    goto :found_python
)

python --version >nul 2>nul
if not errorlevel 1 (
    set "PYTHON=python"
    goto :found_python
)

python3 --version >nul 2>nul
if not errorlevel 1 (
    set "PYTHON=python3"
    goto :found_python
)

echo   Python 3 is not installed.
echo.
echo   Please download Python from:
echo.
echo     https://www.python.org/downloads/
echo.
echo   IMPORTANT: On the first install screen, check the box:
echo.
echo     [x] Add Python to PATH
echo.
echo   After installing Python, double-click this file again.
echo.
pause
exit /b 1

:found_python
for /f "delims=" %%V in ('!PYTHON! --version 2^>^&1') do echo   Found %%V
echo.

:: ── Create virtual environment ─────────────────────────────────
set "VENV=%USERPROFILE%\.bingoviewer\venv"

if not exist "!VENV!\Scripts\python.exe" (
    echo   [1/2] Setting up BiNgo Genome Viewer...
    echo         ^(first time only - this may take a minute^)
    echo.
    !PYTHON! -m venv "!VENV!"
    if errorlevel 1 (
        echo.
        echo   Could not create environment. Trying direct install...
        !PYTHON! -m pip install --user BiNgoViewer
        if errorlevel 1 (
            echo.
            echo   Installation failed. Please check your Python installation.
            pause
            exit /b 1
        )
        echo.
        echo   Starting BiNgo Genome Viewer...
        !PYTHON! -m bingoviewer
        pause
        exit /b 0
    )
) else (
    echo   [1/2] Checking for updates...
    echo.
)

:: ── Install / update BiNgoViewer ───────────────────────────────
"!VENV!\Scripts\python.exe" -m pip install --upgrade pip setuptools wheel -q >nul 2>nul

:: Install from local source if available, otherwise from PyPI
if exist "%~dp0pyproject.toml" (
    "!VENV!\Scripts\python.exe" -m pip install --upgrade "%~dp0."
) else (
    "!VENV!\Scripts\python.exe" -m pip install --upgrade BiNgoViewer
)

if errorlevel 1 (
    echo.
    echo   Installation failed.
    echo   Check your internet connection and try again.
    echo.
    pause
    exit /b 1
)

echo.
echo   [2/2] Starting BiNgo Genome Viewer...
echo.
echo   ==========================================
echo     A browser window will open shortly.
echo     This window will close automatically.
echo   ==========================================
echo.

:: ── Launch with hidden console ─────────────────────────────────
:: Use pythonw.exe (no console window) if available, otherwise fall back
if exist "!VENV!\Scripts\pythonw.exe" (
    start "" "!VENV!\Scripts\pythonw.exe" -m bingoviewer
) else (
    start /min "" "!VENV!\Scripts\python.exe" -m bingoviewer
)
