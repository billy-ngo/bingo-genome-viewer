#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
#  BiNgo Genome Viewer — cross-platform launcher (macOS / Linux)
# ──────────────────────────────────────────────────────────────────────
set -e
cd "$(dirname "$0")"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC}  $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# ── Check prerequisites ──────────────────────────────────────────────

command -v python3 >/dev/null 2>&1 || error "Python 3 is required. Install from https://www.python.org/downloads/ or 'brew install python3'"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    warn "Node.js is not installed (required for from-source mode)."
    info "Install from https://nodejs.org/ or 'brew install node'"
    info ""
    info "Or skip Node.js entirely — use pip install instead:"
    info "  pip3 install bingoviewer"
    info "  bingo"
    exit 1
fi

PYTHON=python3
PIP="$PYTHON -m pip"

info "Python: $($PYTHON --version)"
info "Node:   $(node --version)"

# ── First-run setup ──────────────────────────────────────────────────

if [ ! -f .installed_unix ]; then
    info "First-time setup — installing dependencies..."

    # Python virtual environment
    if [ ! -d .venv ]; then
        info "Creating Python virtual environment..."
        $PYTHON -m venv .venv
    fi

    # Activate venv
    source .venv/bin/activate

    info "Installing Python dependencies..."
    pip install --upgrade pip -q
    pip install -r app/backend/requirements.txt -q

    info "Installing frontend dependencies..."
    cd app/frontend && npm install && cd ../..

    touch .installed_unix
    info "Setup complete!"
else
    source .venv/bin/activate
fi

# ── Launch servers ───────────────────────────────────────────────────

cleanup() {
    info "Shutting down..."
    [ -n "$BACKEND_PID" ]  && kill "$BACKEND_PID"  2>/dev/null
    [ -n "$FRONTEND_PID" ] && kill "$FRONTEND_PID" 2>/dev/null
    wait 2>/dev/null
    info "Done."
}
trap cleanup EXIT INT TERM

info "Starting backend (port 8000)..."
cd app/backend
python -m uvicorn main:app --host 0.0.0.0 --port 8000 &
BACKEND_PID=$!
cd ../..

info "Starting frontend (port 5173)..."
cd app/frontend
npm run dev &
FRONTEND_PID=$!
cd ../..

sleep 3

# ── Open browser ─────────────────────────────────────────────────────
URL="http://localhost:5173"
info "Opening $URL"

if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL" 2>/dev/null
elif command -v open >/dev/null 2>&1; then
    open "$URL"
else
    warn "Could not auto-open browser. Navigate to $URL manually."
fi

info "Press Ctrl+C to stop both servers."
wait
