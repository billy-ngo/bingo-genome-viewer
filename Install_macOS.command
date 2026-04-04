#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
#  BiNgo Genome Viewer — macOS / Linux installer
#  Double-click (or run) this file to install and launch.
# ──────────────────────────────────────────────────────────────

clear
echo ""
echo "  =========================================="
echo "    BiNgo Genome Viewer — Setup & Launch"
echo "  =========================================="
echo ""

# ── Locate Python 3 ───────────────────────────────────────────
PY=""
for cmd in python3 python; do
    if command -v "$cmd" &>/dev/null && "$cmd" -c "import sys; exit(0 if sys.version_info.major==3 else 1)" 2>/dev/null; then
        PY="$cmd"
        break
    fi
done

if [ -z "$PY" ]; then
    echo "  Python 3 was not found."
    echo ""
    echo "  Install from  https://www.python.org/downloads"
    [ -f /etc/debian_version ] && echo "    or:  sudo apt install python3 python3-venv"
    [ "$(uname)" = "Darwin" ]  && echo "    or:  brew install python3"
    echo ""
    read -n1 -s -p "  Press any key to exit..."
    exit 1
fi

PY_VER=$($PY -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
echo "  Found Python $PY_VER"
echo ""

# ── Check Python >= 3.10 ──────────────────────────────────────
if ! $PY -c "import sys; exit(0 if sys.version_info >= (3,10) else 1)" 2>/dev/null; then
    echo "  Python 3.10 or newer is required."
    echo "  Please update from  https://www.python.org/downloads"
    echo ""
    read -n1 -s -p "  Press any key to exit..."
    exit 1
fi

# ── Set up virtual environment ─────────────────────────────────
INSTALL_DIR="$HOME/.bingoviewer"
VENV="$INSTALL_DIR/venv"

# Recreate venv if Python version changed or venv is broken
if [ -d "$VENV" ]; then
    VENV_VER=$("$VENV/bin/python" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>/dev/null || echo "")
    if [ "$VENV_VER" != "$PY_VER" ]; then
        echo "  Recreating environment for Python $PY_VER..."
        echo ""
        rm -rf "$VENV"
    fi
fi

if [ ! -f "$VENV/bin/python" ]; then
    echo "  [1/3] Creating environment..."
    echo ""
    mkdir -p "$INSTALL_DIR"
    if ! $PY -m venv "$VENV"; then
        echo ""
        echo "  Failed to create virtual environment."
        [ -f /etc/debian_version ] && echo "  Try:  sudo apt install python3-venv"
        echo ""
        read -n1 -s -p "  Press any key to exit..."
        exit 1
    fi
else
    echo "  [1/3] Environment ready."
    echo ""
fi

# ── Install / upgrade BiNgo ────────────────────────────────────
echo "  [2/3] Installing BiNgo Genome Viewer..."
echo ""

"$VENV/bin/python" -m pip install --upgrade pip -q >/dev/null 2>&1

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/pyproject.toml" ]; then
    echo "  Installing from local source..."
    echo ""
    # Force reinstall the package itself so local changes always take effect,
    # then run again without --force to install/update dependencies normally
    "$VENV/bin/python" -m pip install --force-reinstall --no-deps "$SCRIPT_DIR" -q
    "$VENV/bin/python" -m pip install "$SCRIPT_DIR" -q
else
    echo "  Installing from PyPI..."
    echo ""
    "$VENV/bin/python" -m pip install --upgrade bingoviewer
fi

if [ $? -ne 0 ]; then
    echo ""
    echo "  Install failed."
    echo ""
    echo "  Possible fixes:"
    echo "    - Check your internet connection"
    echo "    - Delete  ~/.bingoviewer  and run this again"
    echo ""
    read -n1 -s -p "  Press any key to exit..."
    exit 1
fi

echo ""
echo "  Install complete."

# ── Shortcut prompt ────────────────────────────────────────────
echo ""
printf "  Create a desktop shortcut? [Y/n]: "
read -r SHORTCUT
# Portable lowercase check (works on macOS bash 3.x)
case "$SHORTCUT" in
    n|N) ;;
    *)
        "$VENV/bin/python" -m bingoviewer --install 2>/dev/null || \
            echo "  (Shortcut skipped — you can create one later with: bingo --install)"
        ;;
esac

# ── Launch ─────────────────────────────────────────────────────
echo ""
echo "  [3/3] Starting BiNgo Genome Viewer..."
echo ""
echo "  =========================================="
echo "    A browser window will open shortly."
echo "    The server runs in the background."
echo "    To stop: kill \$(cat ~/.bingoviewer/server.pid)"
echo "  =========================================="
echo ""

LOG_FILE="$INSTALL_DIR/server.log"
nohup "$VENV/bin/python" -m bingoviewer > "$LOG_FILE" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > "$INSTALL_DIR/server.pid"

echo "  Server started (PID: $SERVER_PID)"
echo "  Log: $LOG_FILE"
echo ""
echo "  You can close this window now."
sleep 2
