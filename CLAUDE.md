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
- Current version: **2.14.0** (see `pyproject.toml`).

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
    readers/      annotation_reader, bam_reader, bam_coverage (BAM depth
                  index), bam_records (raw BAI/BGZF scan for the read
                  view), bigwig_reader (BigWig/bedGraph/WIG),
                  genbank_reader, genome_reader, vcf_reader
  frontend/       <-- DEVELOP FRONTEND HERE (React + Vite)
    src/          App.jsx, main.jsx, api/client.js,
                  components/ (+ components/tracks/, components/ui/),
                  utils/ (coverageStats, fetchPlan, ruler, signalStats),
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
or mutation. The `/coverage` and `/reads` endpoints register each request with
`app_state.next_request(track_id)` and take the lock through
`app_state.lock_if_current(track_id, gen)`. A request that a newer one has
overtaken returns 409 instead of queueing; so does a read scan that noticed it
was superseded (`cancelled`). Queued stale requests used to hold worker
threads and starve every other endpoint. `/stats` does the same under its own
key per track and `slot` (`lock_if_current(..., gen_key=...)`), so stats and
coverage/read requests never cancel each other; the frontend sends one slot
per asker and page. Liveness endpoints (`/health`, `/api/heartbeat`) are
`async` so they never wait for the thread pool.

**Chromosome names (backend).** `AppState.resolve_track_chrom` maps a genome
chromosome to a BAM/BigWig contig through a cached `ChromMap`
(`_match_chromosomes` in `state.py`): name rules first, then unique
exact-length aliases that must cover most of the unmatched sequence. The
`.version` rule pairs only names whose base is unique on both sides
(`BamReader._resolve_chrom` checks the BAM side), and the alias coverage test
is judged per genome source file (`GenomeReader.chromosome_sources`). Change
the genome only through `load_genome` / `add_chromosomes`, which bump the
genome version that invalidates the cache. `/api/genome/add-chromosomes`
returns each track's new `target_chromosomes` and `compatibility` under
`tracks`, which the frontend applies with `updateTrack`. Those targets come
from `AppState.merged_target_chromosomes`, which starts from where the track
was shown (`remember_targets`, recorded by every track load and merge). It
never uses `get_target_chromosomes`' fallbacks (closest size, every
chromosome): non-BAM readers serve a lone contig under any name, so a
fallback would draw it on an added chromosome of another organism. A track
load records its targets only against the `genome_version` it computed them
for (`api/tracks.py` `_pairing` recomputes otherwise), and a merge also pairs
the tracks recorded since its `merge_snapshot`, so a load and a merge that
overlap still agree. `GenomeReader.chromosomes` lists each name once (the
first file's); `add_chromosomes_from` refuses a file that adds no new name.

**JavaScript / React.** Functional components with hooks only (no classes).
Keep render-time logic minimal; put expensive computation in `useMemo`.
**Save/restore round-trip invariant:** any new per-track UI property must be
added to *both* the defaults in `TrackContext.commitTrack`
(`app/frontend/src/store/TrackContext.jsx`) *and* to `collectSession` and the
restore mapping (`app/frontend/src/components/ui/SessionManager.jsx`), or it
won't survive session export/restore. If a default changes meaning, bump
`SESSION_VERSION` and migrate older sessions in the restore mapping.

### Coverage data and Y-axis scaling (keep these consistent)
- **Bin shape.** Every coverage reader (BigWig/bedGraph/WIG, BAM) returns bins
  with these fields:
  - `value`: the bp-weighted mean, plus `forward`/`reverse` for strand data;
  - `max` / `min`: the extremes, i.e. the positive-side max and negative-side
    min (for BAM, `min` is the minimum depth);
  - `cov`: covered bp;
  - `pending` (optional): not computed yet.

  Bin edges are integers (`start + int(i * bin_size)`), so every base falls in
  exactly one bin.
- **Bars and axis use one statistic.** Bars and the auto Y axis both go through
  `utils/coverageStats.js`. Its helpers are `binHigh`, `binLow` and
  `binExtremes`, and each track's `windowing` is `'max'` (the default; keeps
  peak heights) or `'mean'`. The auto axis is `computeAutoScale` in
  `hooks/useTrackData.js`. By default it fits the visible region; overlay and
  link groups share one axis, and members that are hidden or have no data on
  the chromosome don't count. SVG/PNG export (`components/ui/ExportImage.jsx`)
  must reproduce the screen exactly.
- **Fetch planning.** Coverage requests are planned by `utils/fetchPlan.js`:
  the range is clamped to the chromosome (a fixed-size last bin stays whole),
  and a fixed `track.binSize` gives genome-aligned bins, coarsened to at most
  5,000 per view.
- **BAM coverage.** BAM coverage comes from `readers/bam_coverage.py`, an exact
  per-base depth index built in a background thread at load time. It returns
  `pending` bins until it is ready, always with the state its snapshot was
  taken under (`coverage()` returns `(bins, state)`), so pending bins are only
  ever reported as 'building'. A malformed or cut-off record fails the build,
  and coverage falls back to the live pileup. Don't reintroduce per-request
  read counting; the only exception is `BamReader._live_coverage`, the bounded
  fallback for references too large for the index.
- **BAM read view.** `BamReader.get_reads` scans the `.bai` chunks itself
  (`readers/bam_records.py`, struct + zlib) and decodes only the reads it
  returns. It reports the exact `total` and samples evenly above 5,000 reads.
  Two record budgets bound a scan to about 3 s: `MAX_READS_SCANNED` for
  records starting in the view and `MAX_LEADING_SCANNED` for those left of
  it. When one runs out, `total_exact` is false and `scanned_to` marks how far
  the scan got: every overlapping read starting before it was found (`reads`
  is still an even sample of them above 5,000). `ReadTrack` shades the rest
  of the data's own range. Don't route it through
  bamnostic's `fetch()`, which judges overlap by sequence length and misses
  reads in sparse regions.
- **Exact numbers.** For tooltips and other exact figures, use
  `GET /api/tracks/{id}/stats` (`utils/signalStats.js`), never the displayed
  bins: those depend on zoom and windowing. Its cached rows are shared by
  every asker and carry no display name; label them from your own track.

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
