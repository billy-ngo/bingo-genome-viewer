# Contributing to BiNgo Genome Viewer

Thank you for your interest in the project. This document describes how
to set up a development environment, the layout of the source tree, and
the conventions used in the codebase.

## Prerequisites

- **Python 3.10 or newer** (matches the runtime requirement of the
  package).
- **Node.js 18+** for working on the frontend or producing a new bundle.
  Not required if you are only changing backend code.

## Repository layout

```
bingoviewer/      Pip-installable package shipped to PyPI
  cli.py          `bingo` entry point and self-update logic
  server/         FastAPI backend (mirror of app/backend)
  frontend_dist/  Pre-built React bundle (committed)
app/
  backend/        Backend source — develop here
  frontend/       Frontend source — develop here
  Dockerfile      Container build
```

`bingoviewer/server/` is a byte-identical copy of `app/backend/`. Edits
in either place must be propagated; the [keeping the package in
sync](#keeping-the-package-in-sync) section below explains how.

## Backend development

```bash
cd app/backend
python -m pip install -r requirements.txt
python -m uvicorn main:app --reload --port 8000
```

`python -m pip` (rather than bare `pip`) ensures the install lands in the
interpreter you are using, including any active virtual environment.
Use `python3 -m pip` on systems where only `python3` is on `PATH`.

The backend serves the API at `/api/...` and, when a built frontend is
present at `app/frontend/dist/` or `bingoviewer/frontend_dist/`, also
serves the static bundle at `/`. With `--reload`, edits to backend
modules trigger an automatic restart.

## Frontend development

```bash
cd app/frontend
npm install
npm run dev
```

The Vite dev server runs on port 5173 and proxies `/api/*` requests to
`http://localhost:8000`. Run the backend in another terminal as above.
Hot-module reload is enabled.

## Building the frontend bundle

When you ship a change that touches `app/frontend/`, rebuild the bundle
and commit it so that pip installations pick it up:

```bash
cd app/frontend
npx vite build --outDir ../../bingoviewer/frontend_dist --emptyOutDir
```

The build emits a hashed `assets/index-<hash>.js` and a matching
`index.html` directly into the package directory.

## Keeping the package in sync

`bingoviewer/server/` is a verbatim copy of `app/backend/`. After
editing backend files, propagate the change:

```bash
# From the repository root
cp -r app/backend/* bingoviewer/server/
diff -rq app/backend bingoviewer/server   # should print nothing
```

A pre-release sanity check:

```bash
python -c "import ast; ast.parse(open('bingoviewer/server/state.py').read())"
```

CI runs the test build (`python -m build`) on every tagged release; a
mismatch between the two trees will surface there if not caught locally.

## Running the packaged version

To dogfood the wheel that users will install:

```bash
python -m pip install -e .
bingo
```

Editable installs (`-e`) pick up changes to `bingoviewer/cli.py` and
`bingoviewer/server/` immediately. Frontend changes still require a
fresh build into `bingoviewer/frontend_dist/`.

## Code style

- **Python.** PEP 8, type hints on public function signatures, prefer
  small focused functions over long ones. No new compiled-extension
  dependencies (the project intentionally stays pure Python so it works
  on bare Windows installs).
- **JavaScript / React.** Functional components with hooks; no class
  components. Keep render-time logic minimal; expensive computation
  belongs in `useMemo`. New per-track UI properties must be added to
  `TrackContext.commitTrack` defaults *and* to
  `SessionManager.collectSession` so they round-trip through save/restore.
- **Concurrency on the backend.** Every reader access path that hits a
  non-thread-safe library (`bamnostic`, `pyfaidx`, the BigWig parser)
  must be guarded by the per-track or genome lock from
  `app_state.track_lock(...)` / `app_state.genome_lock`. Long-running
  work (e.g. building a `GenomeReader`) should happen *outside* the
  lock; only the swap or mutation needs serialising.
- **Avoid adding dependencies** unless the alternative is materially
  worse. Each one is a step away from "works on a fresh Python install".

## Submitting changes

1. Fork the repository.
2. Create a feature branch from `master`.
3. Implement the change. If it touches the frontend, rebuild the bundle
   into `bingoviewer/frontend_dist/`.
4. Run the test suite locally (currently exercised through the example
   files under `Test data/` and through `bingo` in editable mode).
5. Open a pull request. Include a short rationale, a description of the
   user-visible effect, and any test files or steps a reviewer can use
   to reproduce the change.

## Reporting issues

Open an issue on GitHub with:

- A clear title and a reproduction recipe.
- Expected versus observed behaviour.
- The file format, size, and (if shareable) a minimal example file.
- The viewer version (`bingo --version`) and your operating system.
- Any `~/.bingoviewer/update.log` entries if the issue involves the
  self-updater.

## Release workflow

Tagged versions (`v*`) trigger the GitHub Actions workflow at
`.github/workflows/publish.yml`, which builds the wheel and uploads it
to PyPI via trusted publishing. Before tagging:

1. Bump `version` in `pyproject.toml`.
2. Bump `__version__` in `bingoviewer/__init__.py`.
3. Bump `APP_VERSION` in `app/frontend/src/App.jsx` (used in the About
   dialog).
4. Add an entry to `CHANGELOG.md` under a new heading.
5. Rebuild the frontend bundle (above).
6. Commit, then `git tag -a vX.Y.Z -m "..."` and `git push origin vX.Y.Z`.

The PyPI publish job typically completes within a minute of the tag
push.
