@echo off
setlocal enabledelayedexpansion
title BiNgo Genome Viewer
echo.
echo   ==========================================
echo     BiNgo Genome Viewer - Setup ^& Launch
echo   ==========================================
echo.

:: ── Locate Python 3 ───────────────────────────────────────────
set "PY="
for %%C in ("py -3" "python" "python3") do (
    if not defined PY (
        %%~C --version >nul 2>nul
        if not errorlevel 1 set "PY=%%~C"
    )
)
if not defined PY (
    echo   Python 3 was not found.
    echo.
    echo   Download it from  https://www.python.org/downloads
    echo.
    echo   IMPORTANT: check  [x] Add Python to PATH  during setup.
    echo.
    pause
    exit /b 1
)
for /f "delims=" %%V in ('!PY! --version 2^>^&1') do echo   Found %%V
echo.

:: ── Check Python >= 3.10 ─────────────────────────────────────
for /f %%N in ('!PY! -c "import sys; print(1 if sys.version_info >= (3,10) else 0)"') do set "OK=%%N"
if "!OK!" NEQ "1" (
    echo   Python 3.10 or newer is required.
    echo   Please update from  https://www.python.org/downloads
    echo.
    pause
    exit /b 1
)

:: ── Set up virtual environment ────────────────────────────────
set "VENV=%USERPROFILE%\.bingoviewer\venv"

:: Recreate venv if Python version changed or venv is broken
if exist "!VENV!\Scripts\python.exe" (
    set "MATCH=0"
    "!VENV!\Scripts\python.exe" -c "import sys; v=sys.version_info; exit(0 if f'{v.major}.{v.minor}'==sys.argv[1] else 1)" ^
        2>nul && set "MATCH=1"
    for /f %%V in ('!PY! -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"') do (
        "!VENV!\Scripts\python.exe" -c "import sys; exit(0 if f'{sys.version_info.major}.{sys.version_info.minor}'=='%%V' else 1)" >nul 2>nul
        if errorlevel 1 (
            echo   Recreating environment for Python %%V ...
            echo.
            rmdir /s /q "!VENV!" >nul 2>nul
        )
    )
)

if not exist "!VENV!\Scripts\python.exe" (
    echo   [1/3] Creating environment...
    !PY! -m venv "!VENV!"
    if errorlevel 1 (
        echo   Failed to create virtual environment.
        pause
        exit /b 1
    )
)

:: ── Install / upgrade BiNgo ───────────────────────────────────
echo   [2/3] Installing BiNgo Genome Viewer...
echo.

"!VENV!\Scripts\python.exe" -m pip install --upgrade pip -q >nul 2>nul

if exist "%~dp0pyproject.toml" (
    "!VENV!\Scripts\python.exe" -m pip install --upgrade "%~dp0."
) else (
    "!VENV!\Scripts\python.exe" -m pip install --upgrade bingoviewer
)

if errorlevel 1 (
    echo.
    echo   Install failed.  Check your internet connection,
    echo   or delete  %USERPROFILE%\.bingoviewer  and retry.
    echo.
    pause
    exit /b 1
)

:: ── Shortcut prompt ───────────────────────────────────────────
echo.
set /p "SHORTCUT=  Create a desktop shortcut? [Y/n]: "
if /i "!SHORTCUT!" NEQ "n" (
    "!VENV!\Scripts\python.exe" -m bingoviewer --install 2>nul
    if errorlevel 1 (
        echo   ^(Shortcut creation skipped — you can retry later with: bingo --install^)
    )
)

:: ── Launch ────────────────────────────────────────────────────
echo.
echo   [3/3] Starting BiNgo Genome Viewer...
echo.
echo   ==========================================
echo     A browser window will open shortly.
echo     Close this window to stop the server.
echo   ==========================================
echo.

if exist "!VENV!\Scripts\pythonw.exe" (
    start "" "!VENV!\Scripts\pythonw.exe" -m bingoviewer
) else (
    start /min "" "!VENV!\Scripts\python.exe" -m bingoviewer
)
