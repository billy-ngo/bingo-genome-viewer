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

### Prerequisites

- **Python 3.10+** — [python.org/downloads](https://www.python.org/downloads/)
- **Node.js 18+** (LTS) — [nodejs.org](https://nodejs.org/)

### Windows

Double-click **`launch.bat`**. On first run it will install dependencies automatically, then open the viewer in your browser.

### macOS

Double-click **`Genomics Viewer.command`** (or run `./launch.sh` from a terminal). On first run it will create a virtual environment and install dependencies, then open the viewer in your browser.

### Linux

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
├── launch.bat                  # Windows launcher
├── launch.sh                   # macOS / Linux launcher
├── Genomics Viewer.command     # macOS double-click launcher
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
