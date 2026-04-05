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

> **Requires Python 3.10 or newer.** Download from [python.org](https://www.python.org/downloads/) if needed.

### Install with pip (recommended)

No Node.js required — the frontend is pre-built and bundled.

```bash
pip install BiNgoViewer
bingo
```

Options:

```bash
bingo --port 9000        # use a custom port
bingo --no-browser       # start without opening the browser
bingo --install          # create a desktop shortcut
```

### Windows (one-click)

Double-click **`Install_Windows.bat`**. It will install Python dependencies into a local environment and launch the viewer. No command line needed.

### macOS / Linux (one-click)

Double-click **`Install_macOS.command`** (or run it from a terminal). It will create a virtual environment, install dependencies, and launch the viewer.

> **Permission denied?** Run once in Terminal:
> ```bash
> chmod +x Install_macOS.command
> ```

### Docker

No Python or Node.js required — everything runs inside the container.

```bash
cd app
docker compose up --build
```

Then open [http://localhost:8000](http://localhost:8000).

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `python` not found | Install Python 3.10+ and check **Add to PATH** during setup |
| pip install fails | Try `pip install --user BiNgoViewer` or use a virtual environment |
| Port 8000 in use | Run `bingo --port 9000` (or any free port) |
| Browser doesn't open | Visit `http://localhost:8000` manually |
| Server won't stop | The server auto-exits when you close all browser tabs; or press `Ctrl+C` |

## Usage

1. **Load files** — Use the file picker or drag and drop. Genome and track files are auto-classified by extension.
2. **Navigate** — Click and drag on tracks to pan; scroll wheel to zoom; use the coordinate bar to jump to a region.
3. **Track settings** — Click the gear icon to adjust height, color, scale, and bar width.
4. **Reorder tracks** — Drag the grip handle on any track label.
5. **Export** — Save the current view as SVG or PNG.
6. **Save session** — Store your workspace and restore it later.

## Project Structure

```
├── Install_Windows.bat         # Windows installer (double-click)
├── Install_macOS.command       # macOS / Linux installer (double-click)
├── README.md
├── pyproject.toml              # pip package definition
├── bingoviewer/                # Installable Python package
│   ├── cli.py                  # `bingo` CLI entry point
│   ├── server/                 # FastAPI backend (bundled)
│   └── frontend_dist/          # Pre-built React frontend
└── app/                        # Application source code
    ├── backend/                # Python (FastAPI) REST API
    └── frontend/               # React (Vite) user interface
```

## Citation

If you use this software in your research, please cite:

> Ngo, B.M. (2026). BiNgo Genome Viewer (v1.8.2) [Software].

## References & Acknowledgments

<details>
<summary>Click to expand</summary>

### Software Dependencies

**Backend**
- **FastAPI** — Ramírez, S. (2018). FastAPI: A modern, fast web framework for building APIs with Python. https://fastapi.tiangolo.com/
- **Uvicorn** — Encode OSS. ASGI server implementation for Python. https://www.uvicorn.org/
- **BioPython** — Cock, P.J.A. et al. (2009). Biopython: freely available Python tools for computational molecular biology and bioinformatics. *Bioinformatics*, 25(11), 1422–1423.
- **pyfaidx** — Shirley, M.D. et al. (2015). Efficient "pythonic" access to FASTA files using pyfaidx. *PeerJ PrePrints*, 3:e1196.
- **bamnostic** — Sherman, M.A. & Mills, R.E. (2019). BAMnostic: a pure Python, OS-agnostic Binary Alignment Map (BAM) file parser and random access tool.

**Frontend**
- **React** — Meta Platforms, Inc. A JavaScript library for building user interfaces. https://react.dev/
- **Vite** — You, E. (2020). Next generation frontend tooling. https://vitejs.dev/
- **Axios** — HTTP client for the browser and Node.js. https://axios-http.com/

### File Format Specifications

- **SAM/BAM** — Li, H. et al. (2009). The Sequence Alignment/Map format and SAMtools. *Bioinformatics*, 25(16), 2078–2079.
- **VCF** — Danecek, P. et al. (2011). The variant call format and VCFtools. *Bioinformatics*, 27(15), 2156–2158.
- **BigWig/WIG** — Kent, W.J. et al. (2010). BigWig and BigBed: enabling browsing of large distributed datasets. *Bioinformatics*, 26(17), 2204–2207.
- **BED** — UCSC Genome Browser, University of California, Santa Cruz.
- **GFF3** — Sequence Ontology Project. Generic Feature Format Version 3.
- **GTF** — Ensembl genome database project.
- **GenBank** — Benson, D.A. et al. (2013). GenBank. *Nucleic Acids Research*, 41(D1), D36–D42.

### Inspiration

- **IGV** — Robinson, J.T. et al. (2011). Integrative Genomics Viewer. *Nature Biotechnology*, 29(1), 24–26.

### Acknowledgments

Early version testing and feedback:
- Amanda Antoch
- Isaac Poarch
- Otto Chipashvili
- Jake Colautti

</details>

## License

All rights reserved. Contact the author for licensing inquiries.
