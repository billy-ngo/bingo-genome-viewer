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

py -3 --version >nul 2>nul
if !errorlevel! EQU 0 (
    set "PY=py -3"
    goto :found_py
)

python --version >nul 2>nul
if !errorlevel! EQU 0 (
    set "PY=python"
    goto :found_py
)

python3 --version >nul 2>nul
if !errorlevel! EQU 0 (
    set "PY=python3"
    goto :found_py
)

echo   Python 3 was not found.
echo.
echo   Download it from  https://www.python.org/downloads
echo.
echo   IMPORTANT: check  [x] Add Python to PATH  during setup.
echo.
pause
exit /b 1

:found_py
for /f "delims=" %%V in ('!PY! --version 2^>^&1') do echo   Found %%V
echo.

:: ── Check Python ^>= 3.10 ────────────────────────────────────
set "PYOK="
for /f %%N in ('!PY! -c "import sys; print(1 if sys.version_info>=(3,10) else 0)" 2^>nul') do set "PYOK=%%N"
if "!PYOK!" NEQ "1" (
    echo   Python 3.10 or newer is required.
    echo   Please update from  https://www.python.org/downloads
    echo.
    pause
    exit /b 1
)

:: ── Set up virtual environment ────────────────────────────────
set "INSTALLDIR=%USERPROFILE%\.bingoviewer"
set "VENV=!INSTALLDIR!\venv"

:: Check if existing venv is broken or built with different Python
if exist "!VENV!\Scripts\python.exe" (
    "!VENV!\Scripts\python.exe" -c "import sys" >nul 2>nul
    if !errorlevel! NEQ 0 (
        echo   Existing environment is broken, recreating...
        echo.
        rmdir /s /q "!VENV!" >nul 2>nul
        goto :create_venv
    )
    :: Compare Python versions
    set "SYS_VER="
    set "VENV_VER="
    for /f %%A in ('!PY! -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"') do set "SYS_VER=%%A"
    for /f %%A in ('"!VENV!\Scripts\python.exe" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"') do set "VENV_VER=%%A"
    if "!SYS_VER!" NEQ "!VENV_VER!" (
        echo   Recreating environment for Python !SYS_VER! ...
        echo.
        rmdir /s /q "!VENV!" >nul 2>nul
    )
)

:create_venv
if not exist "!VENV!\Scripts\python.exe" (
    echo   [1/3] Creating environment...
    echo.
    if not exist "!INSTALLDIR!" mkdir "!INSTALLDIR!"
    !PY! -m venv "!VENV!"
    if !errorlevel! NEQ 0 (
        echo   Failed to create virtual environment.
        echo.
        pause
        exit /b 1
    )
) else (
    echo   [1/3] Environment ready.
    echo.
)

:: ── Install / upgrade BiNgo ───────────────────────────────────
echo   [2/3] Installing BiNgo Genome Viewer...
echo.

"!VENV!\Scripts\python.exe" -m pip install --upgrade pip -q >nul 2>nul

:: Install from local source if pyproject.toml is beside this script
set "SRC=%~dp0"
if exist "!SRC!pyproject.toml" (
    echo   Installing from local source...
    echo.
    :: Force reinstall the package itself so local changes always take effect,
    :: then run again without --force to install/update dependencies normally
    "!VENV!\Scripts\python.exe" -m pip install --force-reinstall --no-deps "!SRC!." -q
    "!VENV!\Scripts\python.exe" -m pip install "!SRC!." -q
) else (
    echo   Installing from PyPI...
    echo.
    "!VENV!\Scripts\python.exe" -m pip install --upgrade bingoviewer
)
if !errorlevel! NEQ 0 (
    echo.
    echo   Install failed.
    echo.
    echo   Possible fixes:
    echo     - Check your internet connection
    echo     - Delete  !INSTALLDIR!  and double-click this file again
    echo.
    pause
    exit /b 1
)

echo.
echo   Install complete.

:: ── Shortcut prompt ───────────────────────────────────────────
echo.
set "SHORTCUT=Y"
set /p "SHORTCUT=  Create a desktop shortcut? [Y/n]: "
if /i "!SHORTCUT!" EQU "n" goto :launch

echo.
"!VENV!\Scripts\python.exe" -m bingoviewer --install 2>nul
if !errorlevel! NEQ 0 (
    echo   ^(Shortcut skipped - you can create one later with: bingo --install^)
)

:: ── Launch ────────────────────────────────────────────────────
:launch
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
