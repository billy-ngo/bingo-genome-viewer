# CLAUDE.md — BiNgo Genome Viewer

Guidance for Claude Code when working in this repository. Read this first;
it captures the conventions and invariants that are easy to get wrong.

## What this is

**BiNgo Genome Viewer** (PyPI package `BiNgoViewer`, CLI command `bingo`) is a
lightweight, browser-based genome viewer for reference genomes, coverage/signal
tracks, read alignments, variant calls, and feature annotations. It targets
fast interactive work on bacterial-scale genomes (~1–10 Mbp) from a laptop.

- **Backend:** FastAPI + Uvicorn, streaming binned data on demand.
- **Frontend:** React single-page app built with Vite (Axios for HTTP).
- **Author:** Billy M Ngo. **License:** Proprietary. **Repo:**
  https://github.com/billy-ngo/bingo-genome-viewer
- Current version: **2.12.1** (see `pyproject.toml`).

### Hard design constraint: pure Python, no compiled extensions

The backend deliberately uses **pure-Python readers** so the package installs
and runs on a bare Python install (Windows/macOS/Linux) with no build tools.
Dependencies are `fastapi`, `uvicorn`, `biopython`, `pyfaidx`, `bamnostic`,
`python-multipart` only. **Do not add `pysam`, `pyBigWig`, `cyvcf2`, or any
C-extension dependency.** Do not add new dependencies at all unless the
alternative is materially worse. (The BigWig parser and BAM reader are
hand-rolled / `bamnostic`-based for exactly this reason.)

## Repository layout

```
app/
  backend/        <-- DEVELOP BACKEND HERE (FastAPI + pure-Python readers)
    main.py, state.py, requirements.txt
    api/          data.py, genome.py, tracks.py
    readers/      annotation_reader, bam_reader, bigwig_reader,
                  genbank_reader, genome_reader, vcf_reader
  frontend/       <-- DEVELOP FRONTEND HERE (React + Vite)
    src/          App.jsx, main.jsx, api/client.js,
                  components/ (+ components/tracks/, components/ui/),
                  hooks/, store/ (React context stores)
  Dockerfile, docker-compose.yml
bingoviewer/      Pip-installable package shipped to PyPI
  cli.py          `bingo` entry point + self-update logic
  __init__.py     __version__
  server/         BYTE-IDENTICAL MIRROR of app/backend (source .py files)
  frontend_dist/  Pre-built React bundle (committed)
```

**Ignore the empty top-level `frontend/` directory** — it is a legacy stub with
no tracked files. The real frontend is `app/frontend/`. `Test data/` at the
root holds manual test files and is untracked.

## Critical invariant: keep the two backend trees in sync

`bingoviewer/server/*.py` must be a **byte-identical copy** of `app/backend/*.py`.
Develop in `app/backend/`, then propagate before committing:

```bash
# from repo root
cp -r app/backend/* bingoviewer/server/
diff -rq app/backend bingoviewer/server   # source .py files should match
```

(Expected non-source differences: `bingoviewer/server/__init__.py`,
`requirements.txt` living only in `app/backend`, and `__pycache__`. Only the
real `.py` sources must match.)

## Running

**Dev (two terminals):**
```bash
# backend — http://localhost:8000, API under /api/...
cd app/backend && python -m pip install -r requirements.txt
python -m uvicorn main:app --reload --port 8000

# frontend — http://localhost:5173, proxies /api/* to :8000, HMR on
cd app/frontend && npm install && npm run dev
```

**Packaged wheel (dogfood what users get):**
```bash
python -m pip install -e .
bingo            # serves built bundle + API on :8000, opens browser
```
Editable installs pick up `bingoviewer/cli.py` and `bingoviewer/server/`
changes immediately; frontend changes require a rebuild (below).

**Docker:** `cd app && docker compose up --build` → http://localhost:8000.

Prefer `python -m pip` / `python -m uvicorn` (binds to the active interpreter/venv).

## Building the frontend bundle

When a change touches `app/frontend/`, rebuild and **commit** the bundle so pip
installs pick it up:

```bash
cd app/frontend
npx vite build --outDir ../../bingoviewer/frontend_dist --emptyOutDir
```

## Testing

There is no automated test suite. Verify changes by driving the app against the
example files in `Test data/` (and via `bingo` in an editable install). The
reference genome used during development is *Southlakia epibionticum* ML1
(`Se.gb`, ~864 kbp circular bacterial genome, GenBank).

## Code conventions

**Python.** PEP 8, type hints on public signatures, small focused functions.
No new compiled-extension deps (see above).

**Concurrency (backend).** Every reader access path that touches a
non-thread-safe library (`bamnostic`, `pyfaidx`, the BigWig parser) must be
guarded by the per-track or genome lock: `app_state.track_lock(track_id)` /
`app_state.genome_lock` (both in `app/backend/state.py`). Do long-running work
(e.g. building a `GenomeReader`) **outside** the lock; only serialise the swap
or mutation.

**JavaScript / React.** Functional components with hooks only (no classes).
Keep render-time logic minimal; put expensive computation in `useMemo`.
**Save/restore round-trip invariant:** any new per-track UI property must be
added to *both* the defaults in `TrackContext.commitTrack`
(`app/frontend/src/store/TrackContext.jsx`) *and* to `collectSession`
(`app/frontend/src/components/ui/SessionManager.jsx`), or it won't survive
session export/restore.

### Track types (frontend)
`annotations`/`genome_annotations` → `AnnotationTrack`; `reads` → `ReadTrack`
(coverage when zoomed out, individual reads < 50 kbp); `coverage` →
`CoverageTrack`; `variants` → `VariantTrack`.

### Supported formats
Reference: FASTA, GenBank. Coverage/signal: BigWig, WIG, BedGraph (`.gz` ok).
Reads: BAM (`.bai` index required; **CRAM not supported**). Variants: VCF/BCF.
Annotations: BED, GTF, GFF2, GFF3, GenBank.

## Release workflow

Tagging `vX.Y.Z` triggers `.github/workflows/publish.yml`, which builds the
wheel and publishes to PyPI via trusted publishing. Before tagging, bump the
version in **all three** places and update the changelog:

1. `version` in `pyproject.toml`
2. `__version__` in `bingoviewer/__init__.py`
3. `APP_VERSION` in `app/frontend/src/App.jsx` (About dialog)
4. Add a `CHANGELOG.md` entry
5. Rebuild the frontend bundle into `bingoviewer/frontend_dist/`
6. Sync `app/backend/` → `bingoviewer/server/`, commit, then
   `git tag -a vX.Y.Z -m "..."` && `git push origin vX.Y.Z`
