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

# ── Create virtual environment ─────────────────────────────────

INSTALL_DIR="$HOME/.bingoviewer"
VENV="$INSTALL_DIR/venv"

if [ ! -f "$VENV/bin/python" ]; then
    echo "  [1/2] Setting up BiNgo Genome Viewer..."
    echo "        (first time only — this may take a minute)"
    echo ""
    mkdir -p "$INSTALL_DIR"
    $PYTHON -m venv "$VENV"
    if [ $? -ne 0 ]; then
        echo ""
        echo "  Could not create environment. Trying direct install..."
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

"$VENV/bin/python" -m pip install --upgrade pip setuptools wheel -q >/dev/null 2>&1

# Install from local source if available, otherwise from PyPI
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/pyproject.toml" ]; then
    "$VENV/bin/python" -m pip install --upgrade "$SCRIPT_DIR"
else
    "$VENV/bin/python" -m pip install --upgrade BiNgoViewer
fi

if [ $? -ne 0 ]; then
    echo ""
    echo "  Installation failed."
    echo "  Check your internet connection and try again."
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
