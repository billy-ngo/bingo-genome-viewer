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

:: ── Verify Python version >= 3.10 ─────────────────────────────
for /f "tokens=2 delims= " %%A in ('!PYTHON! --version 2^>^&1') do set "PYVER=%%A"
for /f "tokens=1,2 delims=." %%M in ("!PYVER!") do (
    set "PYMAJOR=%%M"
    set "PYMINOR=%%N"
)
:: Convert to number for comparison (e.g. 3.10 -> 310)
set /a "PYNUM=!PYMAJOR!*100+!PYMINOR!"
if !PYNUM! LSS 310 (
    echo   ERROR: Python 3.10 or higher is required, but found !PYVER!.
    echo.
    echo   Please download a newer Python from:
    echo     https://www.python.org/downloads/
    echo.
    pause
    exit /b 1
)

:: ── Create virtual environment ─────────────────────────────────
set "INSTALL_DIR=%USERPROFILE%\.bingoviewer"
set "VENV=!INSTALL_DIR!\venv"

:: Check if venv exists but is broken or was built with a different Python version
if exist "!VENV!" (
    set "VENV_OK=0"
    "!VENV!\Scripts\python.exe" -c "import sys; assert sys.version_info[:2]==(int(sys.argv[1]),int(sys.argv[2]))" !PYMAJOR! !PYMINOR! >nul 2>nul
    if not errorlevel 1 set "VENV_OK=1"
    if "!VENV_OK!"=="0" (
        echo   Virtual environment needs to be recreated for Python !PYVER!...
        echo.
        rmdir /s /q "!VENV!" >nul 2>nul
    )
)

if not exist "!VENV!\Scripts\python.exe" (
    echo   [1/2] Setting up BiNgo Genome Viewer...
    echo         ^(first time only - this may take a minute^)
    echo.
    !PYTHON! -m venv "!VENV!"
    if errorlevel 1 (
        echo.
        echo   Could not create virtual environment.
        echo   Trying direct install...
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

:: Ensure pip is available in the venv (handles rare cases where ensurepip failed)
"!VENV!\Scripts\python.exe" -m ensurepip --default-pip >nul 2>nul

"!VENV!\Scripts\python.exe" -m pip install --upgrade pip setuptools wheel -q >nul 2>nul

:: Install from local source if available, otherwise from PyPI
:: Use %~dp0 which includes trailing backslash, so "%~dp0." gives the directory
if exist "%~dp0pyproject.toml" (
    :: Local source: always reinstall to pick up changes, skip dep reinstall
    "!VENV!\Scripts\python.exe" -m pip install --force-reinstall --no-deps "%~dp0."
    if errorlevel 1 (
        :: Fallback: try without --force-reinstall for older pip versions
        "!VENV!\Scripts\python.exe" -m pip install "%~dp0."
    )
    :: Ensure dependencies are satisfied (installs missing ones, skips existing)
    "!VENV!\Scripts\python.exe" -m pip install "%~dp0." >nul 2>nul
) else (
    "!VENV!\Scripts\python.exe" -m pip install --upgrade BiNgoViewer
)

if errorlevel 1 (
    echo.
    echo   Installation failed.
    echo.
    echo   Possible fixes:
    echo     - Check your internet connection
    echo     - Try deleting %INSTALL_DIR% and running this again
    echo     - Run as Administrator if you see permission errors
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
