# BiNgo Genome Viewer

[![PyPI version](https://img.shields.io/pypi/v/bingoviewer)](https://pypi.org/project/bingoviewer/)
[![Python](https://img.shields.io/pypi/pyversions/bingoviewer)](https://pypi.org/project/bingoviewer/)
[![License](https://img.shields.io/badge/license-proprietary-blue)](#license)

A lightweight, browser-based genome viewer for visualising reference genomes,
coverage tracks, read alignments, variant calls, and feature annotations.
The frontend is a React single-page application; the backend is a FastAPI
server that streams binned data on demand. Designed for fast interactive
work on bacterial-scale genomes from a laptop, with no external services
or compiled C dependencies.

## Highlights

- **Single-command install.** `python -m pip install BiNgoViewer && bingo`
  launches the viewer in your default browser. The compiled frontend ships
  with the wheel — Node.js is not required at install time.
- **Pure-Python readers** for every supported format (no `pysam`, no
  `pyBigWig` C extensions). Works on Windows, macOS, and Linux without
  build tools.
- **Auto-cancelled fetches.** Pan/zoom requests are cancelled when
  superseded; transient backend failures retry silently with backoff;
  in-flight reads are serialised per-track to keep non-thread-safe file
  handles consistent.
- **Session export / restore.** Workspace state — viewport, track order,
  colours, scale, feature-type filters, strand visibility — round-trips
  through a single JSON file or auto-restores from `localStorage`.
- **SVG and PNG export** with grouped vector layers suitable for figure
  preparation.
- **Five built-in themes** (Dark, Light, Colorblind Friendly, Soft, High
  Contrast) plus a custom theme editor.

## Supported file formats

| Type | Formats | Notes |
|------|---------|-------|
| **Reference genome** | FASTA (`.fa`, `.fasta`), GenBank (`.gb`, `.gbk`, `.genbank`) | GenBank files contribute both reference sequence and a built-in annotation track. Multiple genome files can be merged with `Add chromosomes`. |
| **Coverage / signal** | BigWig (`.bw`, `.bigwig`), WIG (`.wig`, `.wig.gz`), BedGraph (`.bedgraph`, `.bedgraph.gz`, `.bdg`, `.bdg.gz`) | Compressed `.gz` variants are decompressed on the fly. WIG dialects (`fixedStep`, `variableStep`, headerless, 3-column forward/reverse) are auto-detected. BigWig parsing is pure-Python via R-tree traversal. |
| **Read alignments** | BAM (`.bam` + `.bai` index) | Index file required. Coverage is shown when zoomed out; individual reads with CIGAR-aware match / deletion / intron / insertion / soft-clip rendering appear within 50 kbp views. CRAM is not supported. |
| **Variants** | VCF (`.vcf`, `.vcf.gz`), BCF (`.bcf`) | Plain and gzip-compressed VCF; up to 10 000 variants per region returned. |
| **Feature annotations** | BED (`.bed`), GTF (`.gtf`), GFF2 (`.gff2`), GFF3 (`.gff3`), GenBank (`.gb`) | The ambiguous `.gff` extension is auto-detected as GFF2/GTF or GFF3 by inspecting `##gff-version` and the column-9 attribute style. |

## Installation

> Requires **Python 3.10 or newer**. Get it from [python.org](https://www.python.org/downloads/) if needed.

### pip (recommended)

```bash
python -m pip install BiNgoViewer
bingo
```

`python -m pip` (in preference to a bare `pip`) binds the install to the
interpreter you just invoked, including any active virtual environment.
On systems where only `python3` / `pip3` is on `PATH`, substitute
`python3 -m pip install BiNgoViewer`.

### Windows one-click

Double-click **`Install_Windows.bat`**. It creates a local virtual
environment, installs the package, and launches the viewer.

### macOS / Linux one-click

Double-click **`Install_macOS.command`** (or run it from a terminal). The
first time, you may need to mark it executable:

```bash
chmod +x Install_macOS.command
```

### Docker

```bash
cd app
docker compose up --build
```

Then open <http://localhost:8000>. The Dockerfile builds the frontend in
a Node stage and copies the bundle into a slim Python runtime.

## Command-line options

```
bingo                    Launch on default port 8000 and open the browser
bingo --port 9000        Use a different port
bingo --no-browser       Start the server without launching a browser
bingo --install          Create a desktop shortcut for the current user
bingo --update           Check PyPI and install a newer version if available
bingo --no-update        Skip the automatic update check at launch
bingo --version          Print the installed version and exit
```

The server auto-shuts down 30 seconds after the last browser tab closes.
You can also stop it with `Ctrl+C`.

## Using the viewer

1. **Load files.** Use the file picker, drop files anywhere in the window,
   or paste a local path (recommended for BAMs over 50 MB — the server
   reads directly from disk instead of uploading through the browser).
2. **Navigate.** Left-click drag to pan; scroll to zoom (anchored at the
   cursor). Use the chromosome scrubber along the top to jump anywhere on
   the current sequence. **Shift+scroll** scrolls vertically inside read
   pile-ups.
3. **Select a region.** Right-click drag to mark a region; a tooltip
   shows the selection length and per-track stats (mean coverage, variant
   count, feature count, read count). Click the highlighted band to
   dismiss; right-click it to recolour the underlying region.
4. **Zoom to a feature.** Double-click any annotation to centre it in the
   view with ~15 % flanking context.
5. **Tune tracks.** Open **Track Settings** to adjust height, colour,
   linear/log Y-axis, fixed Y range, bar width, peak outline tracing,
   strand visibility (BAM), strand colours, arrow style, nucleotide
   display, and per-feature-type visibility (GenBank/GFF). Multi-select
   to apply changes to several tracks at once; mixed values render as
   indeterminate checkboxes.
6. **Reorder.** Drag the grip handle on a track label.
7. **Export.** Save the current view as **SVG** (grouped layers, ready
   for vector editing) or **PNG**.
8. **Save / restore session.** Export the workspace to JSON, or rely on
   the autosave to `localStorage` for an exit-and-resume workflow.

## Performance characteristics

The viewer is built around a binned-coverage data model with overscan
caching and zoom-aware refetching, so it remains responsive on bacterial
genomes (single chromosome, ~1–10 Mbp) with several large coverage tracks
and BAMs loaded simultaneously. Indicative timings on a recent laptop:

| Workload | Time |
|----------|------|
| GenBank parse (1.8 MB) | ~200 ms |
| WIG parse (11 MB, point data) | ~340 ms |
| WIG parse (3 MB gzipped) | ~410 ms |
| Coverage query (full chromosome, 1000 bins, 11 MB WIG) | ~140 ms |
| Annotation query (full chromosome GFF3) | <1 ms |

These numbers reflect cold reads with no caching. Subsequent in-region
queries are served from an LRU cache and return in microseconds.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `python` not found | Install Python 3.10+ and tick **Add to PATH** during setup. On macOS/Linux, try `python3` instead of `python`. |
| `pip` not found / wrong Python | Use `python -m pip install BiNgoViewer` (or `python3 -m pip ...`). This binds to the interpreter you invoked, including the active venv, even when no `pip` shim exists on `PATH`. |
| Installed but `bingo` is not on `PATH` | Your Python's `Scripts/` (Windows) or `bin/` (Unix) directory is not exported. Activate your venv first, or run `python -m bingoviewer` directly. |
| "No matching distribution" | Your Python is older than 3.10. Check with `python --version`. |
| pip install still fails | Try `python -m pip install --user BiNgoViewer`, or create a clean venv: `python -m venv .venv && .venv/bin/pip install BiNgoViewer` (Windows: `.venv\Scripts\pip`). |
| Port 8000 in use | `bingo --port 9000` (any free port). |
| Browser doesn't open | Visit <http://localhost:8000> manually; the server will keep running. |
| Server won't stop | It auto-exits ~30 s after the last tab closes; `Ctrl+C` from the launching terminal also works. |
| BAM rejected | Ensure a `.bai` index sits alongside the BAM (named `reads.bam.bai` or `reads.bai`). CRAM is not supported. |
| Cloud-synced file errors | OneDrive / Dropbox files marked "online only" cannot be read. Pin them locally before loading. |

## API

When the server is running, FastAPI serves auto-generated OpenAPI
documentation:

- Swagger UI: <http://localhost:8000/docs>
- ReDoc: <http://localhost:8000/redoc>

The frontend talks to the same API; nothing in the UI is privileged.

## Project layout

```
.
├── README.md
├── CHANGELOG.md
├── CONTRIBUTING.md
├── pyproject.toml              # pip package definition
├── Install_Windows.bat         # One-click Windows installer
├── Install_macOS.command       # One-click macOS / Linux installer
├── bingoviewer/                # Installable Python package
│   ├── __init__.py             # __version__
│   ├── cli.py                  # `bingo` entry point
│   ├── server/                 # FastAPI backend (mirror of app/backend)
│   └── frontend_dist/          # Pre-built React bundle
└── app/
    ├── Dockerfile              # Container build
    ├── docker-compose.yml
    ├── backend/                # Backend source (FastAPI + readers)
    └── frontend/               # Frontend source (React + Vite)
```

`bingoviewer/server/` and `app/backend/` are kept byte-identical so a
single change set can serve both the development workflow and the
packaged release. See [CONTRIBUTING.md](CONTRIBUTING.md) for the sync
workflow.

## Citation

If you use this software in published research, please cite:

> Ngo, B. M. (2026). *BiNgo Genome Viewer* (v2.9) [Software].
> <https://github.com/billy-ngo/bingo-genome-viewer>

## Acknowledgements

### Software libraries

**Backend.** [FastAPI](https://fastapi.tiangolo.com/) (Ramírez, 2018);
[Uvicorn](https://www.uvicorn.org/);
[BioPython](https://biopython.org/) (Cock et al., *Bioinformatics* 25(11), 2009);
[pyfaidx](https://github.com/mdshw5/pyfaidx) (Shirley et al., *PeerJ PrePrints*, 2015);
[bamnostic](https://github.com/betteridiot/bamnostic) (Sherman & Mills, 2019).

**Frontend.** [React](https://react.dev/);
[Vite](https://vitejs.dev/);
[Axios](https://axios-http.com/).

### File-format specifications

- **SAM/BAM** — Li et al., *Bioinformatics* 25(16), 2009.
- **VCF** — Danecek et al., *Bioinformatics* 27(15), 2011.
- **BigWig / WIG** — Kent et al., *Bioinformatics* 26(17), 2010.
- **BED** — UCSC Genome Browser.
- **GFF3** — Sequence Ontology Project.
- **GTF** — Ensembl.
- **GenBank** — Benson et al., *Nucleic Acids Research* 41(D1), 2013.

### Inspiration

- **IGV** — Robinson et al., *Nature Biotechnology* 29(1), 2011.

### Pre-release testing

Amanda Antoch · Isaac Poarch · Otto Chipashvili · Jake Colautti.

## License

Proprietary. All rights reserved. Contact the author for licensing
inquiries.
