# BiNgo Genome Viewer

A lightweight, browser-based genomics viewer for visualizing genomes, coverage tracks, read alignments, variants, and annotations. Built as a modern alternative to IGV.

## Supported File Formats

| Type | Formats |
|------|---------|
| **Genome** | GenBank (`.gb`, `.gbk`), FASTA (`.fasta`, `.fa`) |
| **Coverage** | BigWig (`.bw`), WIG (`.wig`), BedGraph (`.bedgraph`, `.bdg`) |
| **Reads** | BAM (`.bam` + `.bai` index) |
| **Variants** | VCF (`.vcf`, `.vcf.gz`) |
| **Annotations** | BED (`.bed`), GFF (`.gff`, `.gff3`), GTF (`.gtf`), GenBank (`.gb`) |

## Quick Start

### Install with pip (recommended)

No Node.js required — the frontend is pre-built and bundled.

```bash
pip install BiNgoViewer
bingo
```

This installs the `bingo` command, starts the server, and opens the viewer in your browser. Options:

```bash
bingo --port 9000        # use a custom port
bingo --no-browser       # start without opening the browser
python -m bingoviewer    # alternative way to launch
```

### Windows (from source)

Requires Python 3.10+ and Node.js 18+.

Double-click **`launch.bat`**. On first run it will install dependencies automatically, then open the viewer in your browser.

### macOS (from source)

Requires Python 3.10+ and Node.js 18+.

Double-click **`BiNgo Genome Viewer.command`** (or run `./launch.sh` from a terminal). On first run it will create a virtual environment and install dependencies, then open the viewer in your browser.

> **Permission denied?** If macOS says the file can't be opened, run this once in Terminal from the project folder:
> ```bash
> chmod +x launch.sh "BiNgo Genome Viewer.command"
> ```

### Linux (from source)

Requires Python 3.10+ and Node.js 18+.

```bash
chmod +x launch.sh
./launch.sh
```

### Docker

```bash
cd app
docker-compose up --build
```

Then open [http://localhost:8000](http://localhost:8000).

## Usage

1. **Load a genome** — Drag and drop a FASTA or GenBank file into the file loader at the top
2. **Add tracks** — Drag and drop any supported track files (BAM, BigWig, WIG, VCF, BED, GFF, etc.)
3. **Navigate** — Click and drag on tracks to pan; scroll wheel to zoom; use the coordinate bar to jump to a region
4. **Track settings** — Click the gear icon to adjust height, color, scale, and bar width for tracks
5. **Reorder tracks** — Drag the grip handle (`≡`) on any track label to reorder
6. **Export** — Click Export to save the current view as SVG or PNG
7. **Save session** — Click Save Session to store your current workspace; restore it later or export as a JSON file

## Project Structure

```
├── pyproject.toml              # pip package definition
├── bingoviewer/                # Installable Python package
│   ├── cli.py                  # `bingo` CLI entry point
│   ├── server/                 # FastAPI backend (bundled)
│   └── frontend_dist/          # Pre-built React frontend
├── launch.bat                  # Windows launcher (from source)
├── launch.sh                   # macOS / Linux launcher (from source)
├── BiNgo Genome Viewer.command # macOS double-click launcher
└── app/                        # Application source code
    ├── backend/                # Python (FastAPI) REST API
    ├── frontend/               # React (Vite) user interface
    ├── Dockerfile              # Docker build
    └── docker-compose.yml      # Docker Compose config
```

## Citation

If you use this software in your research, please cite:

> Ngo, B. (2026). BiNgo Genome Viewer (v1.0.0) [Software].

## License

All rights reserved. Contact the author for licensing inquiries.
