"""
Entry point for `python -m bingoviewer` and the `bingo` CLI command.

Starts the FastAPI server, serves the bundled frontend, and opens the browser.
"""

import sys
from bingoviewer.cli import main

if __name__ == "__main__":
    sys.exit(main())
