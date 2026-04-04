#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────
#  BiNgo Genome Viewer — macOS / Linux Installer
#  Double-click this file to install and launch.
# ──────────────────────────────────────────────────────────────────

clear
echo ""
echo "  =========================================="
echo "    BiNgo Genome Viewer — Setup & Launch"
echo "  =========================================="
echo ""

# ── Find Python 3 ──────────────────────────────────────────────

PYTHON=""

if command -v python3 &>/dev/null; then
    PYTHON=python3
elif command -v python &>/dev/null; then
    if python --version 2>&1 | grep -q "Python 3"; then
        PYTHON=python
    fi
fi

if [ -z "$PYTHON" ]; then
    echo "  Python 3 is not installed."
    echo ""
    echo "  Install Python from:"
    echo "    https://www.python.org/downloads/"
    echo ""
    echo "  Or with Homebrew:"
    echo "    brew install python3"
    echo ""
    echo "  After installing Python, double-click this file again."
    echo ""
    read -n1 -s -p "  Press any key to close..."
    exit 1
fi

echo "  Found $($PYTHON --version)"
echo ""

# ── Verify Python version >= 3.10 ─────────────────────────────

PY_VERSION=$($PYTHON -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>/dev/null)
PY_MAJOR=$($PYTHON -c "import sys; print(sys.version_info.major)" 2>/dev/null)
PY_MINOR=$($PYTHON -c "import sys; print(sys.version_info.minor)" 2>/dev/null)

if [ -z "$PY_MAJOR" ] || [ "$PY_MAJOR" -lt 3 ] || { [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -lt 10 ]; }; then
    echo "  ERROR: Python 3.10 or higher is required, but found $PY_VERSION."
    echo ""
    echo "  Install a newer Python from:"
    echo "    https://www.python.org/downloads/"
    echo ""
    read -n1 -s -p "  Press any key to close..."
    exit 1
fi

# ── Create virtual environment ─────────────────────────────────

INSTALL_DIR="$HOME/.bingoviewer"
VENV="$INSTALL_DIR/venv"

# Check if venv exists but is broken (python binary missing or not working)
if [ -d "$VENV" ]; then
    if ! "$VENV/bin/python" -c "import sys" 2>/dev/null; then
        echo "  Detected broken virtual environment. Recreating..."
        echo ""
        rm -rf "$VENV"
    fi
fi

if [ ! -f "$VENV/bin/python" ]; then
    echo "  [1/2] Setting up BiNgo Genome Viewer..."
    echo "        (first time only — this may take a minute)"
    echo ""
    mkdir -p "$INSTALL_DIR"
    $PYTHON -m venv "$VENV"
    if [ $? -ne 0 ]; then
        echo ""
        echo "  Could not create virtual environment."
        echo ""
        # On Debian/Ubuntu, python3-venv may not be installed
        if [ -f /etc/debian_version ]; then
            echo "  On Debian/Ubuntu, you may need to install the venv module:"
            echo "    sudo apt install python3-venv"
            echo ""
        fi
        echo "  Trying direct install..."
        $PYTHON -m pip install --user BiNgoViewer
        if [ $? -ne 0 ]; then
            echo ""
            echo "  Installation failed. Please check your Python installation."
            read -n1 -s -p "  Press any key to close..."
            exit 1
        fi
        echo ""
        echo "  Starting BiNgo Genome Viewer..."
        $PYTHON -m bingoviewer
        exit 0
    fi
else
    echo "  [1/2] Checking for updates..."
    echo ""
fi

# ── Install / update BiNgoViewer ───────────────────────────────

# Ensure pip is available in the venv (handles rare cases where ensurepip failed)
"$VENV/bin/python" -m ensurepip --default-pip >/dev/null 2>&1

"$VENV/bin/python" -m pip install --upgrade pip setuptools wheel -q >/dev/null 2>&1

# Install from local source if available, otherwise from PyPI
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/pyproject.toml" ]; then
    # Local source: always reinstall to pick up changes, skip dep reinstall
    "$VENV/bin/python" -m pip install --force-reinstall --no-deps "$SCRIPT_DIR" || \
        "$VENV/bin/python" -m pip install "$SCRIPT_DIR"
    # Ensure dependencies are satisfied (installs missing ones, skips existing)
    "$VENV/bin/python" -m pip install "$SCRIPT_DIR" >/dev/null 2>&1
else
    "$VENV/bin/python" -m pip install --upgrade BiNgoViewer
fi

if [ $? -ne 0 ]; then
    echo ""
    echo "  Installation failed."
    echo ""
    echo "  Possible fixes:"
    echo "    - Check your internet connection"
    echo "    - Try deleting ~/.bingoviewer and running this again"
    echo "    - Check file permissions"
    echo ""
    read -n1 -s -p "  Press any key to close..."
    exit 1
fi

echo ""
echo "  [2/2] Starting BiNgo Genome Viewer..."
echo ""
echo "  =========================================="
echo "    A browser window will open shortly."
echo "    The server runs in the background."
echo "    To stop it, run: kill \$(cat ~/.bingoviewer/server.pid)"
echo "  =========================================="
echo ""

# ── Launch in background and close the terminal ────────────────
LOG_FILE="$INSTALL_DIR/server.log"

nohup "$VENV/bin/python" -m bingoviewer > "$LOG_FILE" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > "$INSTALL_DIR/server.pid"

echo "  Server started (PID: $SERVER_PID)"
echo "  Log file: $LOG_FILE"
echo ""
echo "  You can close this window now."
echo ""

# Give the server a moment to start, then close
sleep 2
