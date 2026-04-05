# Contributing to BiNgo Genome Viewer

Thank you for your interest in contributing to BiNgo Genome Viewer.

## Development Setup

### Prerequisites
- Python 3.10+
- Node.js 18+ (for frontend development only)

### Backend Development
```bash
cd app/backend
pip install -r requirements.txt
python -m uvicorn main:app --reload --port 8000
```

### Frontend Development
```bash
cd app/frontend
npm install
npm run dev
```
The dev server proxies API requests to `localhost:8000`.

### Building the Frontend Bundle
```bash
cd app/frontend
npx vite build --outDir ../../bingoviewer/frontend_dist --emptyOutDir
```

### Running the Packaged Version
```bash
pip install -e .
bingo
```

## Project Structure

- `bingoviewer/` — pip-installable package (Python backend + pre-built frontend)
- `app/backend/` — development copy of the backend (mirrors `bingoviewer/server/`)
- `app/frontend/` — React source code (built into `bingoviewer/frontend_dist/`)

**Important:** `bingoviewer/server/` and `app/backend/` must stay in sync. After editing backend files, copy them to both locations.

## Code Style

- Python: follow PEP 8, use type hints for function signatures
- JavaScript/React: functional components with hooks, no class components
- Keep functions focused and concise
- Avoid adding dependencies unless necessary

## Submitting Changes

1. Fork the repository
2. Create a feature branch from `master`
3. Make your changes
4. Rebuild the frontend bundle if you modified frontend code
5. Test locally with `bingo`
6. Submit a pull request

## Reporting Issues

Open an issue on GitHub with:
- Steps to reproduce
- Expected vs actual behavior
- File format and size (if related to file loading)
- Browser and OS version

## API Documentation

The FastAPI backend auto-generates OpenAPI documentation. When the server is running, visit:
- `http://localhost:8000/docs` — Swagger UI
- `http://localhost:8000/redoc` — ReDoc
