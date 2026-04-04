#!/usr/bin/env bash
# Double-click this file on macOS to launch BiNgo Genome Viewer
cd "$(dirname "$0")"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'

echo ""
echo -e "${BOLD}  BiNgo Genome Viewer${NC}"
echo "  ─────────────────────────────"
echo ""

# ── Check Python ─────────────────────────────────────────────────
if ! command -v python3 >/dev/null 2>&1; then
    echo -e "${RED}✘ Python 3 is not installed.${NC}"
    echo ""
    echo "  Install it from: https://www.python.org/downloads/"
    echo "  Or with Homebrew: brew install python3"
    echo ""
    echo -e "${YELLOW}Alternatively, if you have Python via another method:${NC}"
    echo "  pip install bingoviewer"
    echo "  bingo"
    echo ""
    echo "Press any key to close..."
    read -n1 -s
    exit 1
fi

# ── Check Node.js ────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    echo -e "${YELLOW}⚠  Node.js is not installed.${NC}"
    echo ""
    echo "  The from-source launcher requires Node.js for the frontend."
    echo "  You have two options:"
    echo ""
    echo -e "  ${BOLD}Option 1: Install Node.js${NC} (then re-run this file)"
    echo "    • Download from: https://nodejs.org/"
    echo "    • Or with Homebrew: brew install node"
    echo ""
    echo -e "  ${BOLD}Option 2: Use pip install instead${NC} (no Node.js needed)"
    echo "    Open Terminal and run:"
    echo ""
    echo -e "    ${GREEN}pip3 install bingoviewer${NC}"
    echo -e "    ${GREEN}bingo${NC}"
    echo ""
    echo "Press any key to close..."
    read -n1 -s
    exit 1
fi

# ── All prerequisites met — launch ───────────────────────────────
./launch.sh
status=$?

if [ $status -ne 0 ]; then
    echo ""
    echo -e "${RED}The viewer exited with an error.${NC}"
    echo "Press any key to close..."
    read -n1 -s
fi

exit $status
