# Changelog

All notable user-facing changes to BiNgo Genome Viewer are recorded here.
Internal refactors are summarised at a level a user can act on; the full
commit history is on GitHub.

The project follows [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`.

## [2.9.10] — 2026-06-18

### Fixed
- **BAM reads now work at all.** The reader fetched the chromosome list with a
  call (`header.get("SQ")`) that the bundled bamnostic library does not
  support — it raised on every BAM, so coverage and read tracks silently
  failed to render. Chromosomes are now read from bamnostic's authoritative
  reference table (`references`/`lengths`), with fallbacks for other versions.
  Verified end-to-end: a real BAM now returns its reads and coverage.
- **Clear, actionable errors instead of cryptic tracebacks** for every bad-BAM
  case: a missing, empty, or corrupt `.bai` index; a corrupt or truncated BAM;
  and a BAM with no reference sequences. Each now tells the user what to do
  (e.g. "Create one with: samtools index …") rather than leaking an internal
  "unpack requires a buffer of 8 bytes" / "Wrong BAI magic header" message.
- **Corrupt coverage is no longer shown as valid.** A decode error part-way
  through a coverage scan used to be swallowed, leaving a flat/partial track
  that looked real. Such errors now surface as a clear "update failed" warning.
- **Wrong-contig data fixed.** A single-contig BAM previously served its one
  contig's reads under *any* chromosome name requested. Chromosome-name
  matching is now exact (with sensible `chr1`/`1` and accession-version
  fallbacks) and never silently substitutes a different contig.

### Added
- **Load a BAM whose `.bai` lives in a different folder** (or has a
  non-standard name) by supplying the index path explicitly — previously the
  typed index path was ignored and the load failed unless the `.bai` sat right
  next to the `.bam`.
- A BAM uploaded without an index is now rejected up front with a clear
  message, and the orphaned upload is cleaned up instead of lingering in the
  temp directory.

### Changed
- CRAM and SAM are now rejected with a clear "convert to an indexed BAM"
  message instead of being routed to a reader that cannot read them (which
  produced an opaque low-level error, and for CRAM wrongly demanded a `.bai`).

## [2.9.9] — 2026-05-19

### Fixed
- Removed tracks no longer "ghost" into exported images or inflate their
  dimensions. A multi-path audit found and closed every way a deleted track
  could still contribute to an SVG/PNG export:
  - **Track removal is now immediate and unconditional.** Deleting a track
    previously waited for the backend to confirm, and a failed delete
    (a stale id after the server auto-restarted, a transient 5xx, or a
    dropped connection) silently left the row in place — still counted in
    the export height. The row now disappears from the UI the instant you
    click ✕, with backend cleanup done best-effort in the background.
  - **Deleting a genome-annotation track now sticks.** Annotation tracks are
    hidden rather than deleted so they can re-appear when you switch to a
    chromosome that has annotations. A deliberate removal was being undone by
    that same auto-restore on the next navigation. Removals are now
    remembered (and persisted in saved sessions); re-loading the genome
    brings the annotations back as before.
  - **PNG/JPG export composites each track by identity.** The raster exporter
    matched on-screen canvases to tracks by position, so deselecting a track
    in the export dialog shifted every later track to the wrong image. Each
    track is now matched to its own canvas, so deselecting or reordering
    composites correctly.
  - The backend `DELETE /api/tracks/{id}` is now idempotent (a missing id
    returns success, not 404), and per-track data caches are cleared on
    removal so stale data can't resurface and memory doesn't grow across
    add/remove cycles.

## [2.9.8] — 2026-05-10

### Added
- ``bingo --close-window`` (Windows): closes the launching command-prompt
  window automatically when the server shuts down. Useful when launching
  ``bingo`` directly from cmd / PowerShell — you no longer need to type
  ``exit`` after closing the browser.
- The Windows desktop-shortcut launcher (``launch_bingo.bat``) and the
  "Launch BiNgo now?" prompt in ``Install_Windows.bat`` both pass
  ``--close-window`` automatically, so the minimised launcher window
  vanishes when the user closes their browser.

### Safety
- The terminal close is guarded by a parent-process-name check. We only
  ever terminate a process named ``cmd.exe``, ``powershell.exe``,
  ``pwsh.exe``, or ``conhost.exe``. Launches from VS Code's integrated
  terminal, JetBrains terminals, SSH sessions, Git Bash, or any other
  parent are left alone — ``--close-window`` is a no-op in those
  environments.
- Also no-op when the process has no attached console (e.g.
  ``pythonw`` shortcut launches) and on macOS / Linux.
- The close runs from inside the auto-shutdown watchdog (``os._exit``
  skips ``atexit``), so closing the browser reliably terminates the
  shell window — not just on graceful Ctrl-C exits.

## [2.9.7] — 2026-05-10

### Fixed
- Region-properties tooltip now appears when hovering a selection that was
  just created via right-click drag or via double-click on a gene. Two
  underlying problems were addressed:
  - The browser fires a `contextmenu` on the mouseup of a right-click drag,
    which used to immediately open `RegionColorEditor`'s context menu on
    top of the brand-new highlight. That menu renders a full-viewport
    scrim at `zIndex: 10001` which intercepted every subsequent mousemove,
    preventing the hover from ever reaching the highlight. We now detect
    whether the right-press actually moved (≥ 3 px) and, if so, swallow
    the trailing `contextmenu` event in the capture phase — so the
    selection sticks, the menu does not pop, and hover works. A
    stationary right-click on an existing selection still opens the menu
    as before.
  - After a double-click on a gene, the cursor is usually already inside
    the new highlight, so the user has no mousemove to fire and the
    tooltip never appears. The selection tooltip now auto-displays for
    ~3.5 s whenever the selection changes, anchored just below the
    highlight; hovering after that point continues to track the cursor as
    usual.
- Defensive `zIndex: 5` on the highlight div so it wins hit-testing for
  hover even in browsers where a future stacking-context change could
  push the canvas above it.

## [2.9.6] — 2026-05-10

### Fixed (auto-shutdown reliability)
- The server now exits reliably when the user closes their browser. Five
  problems with the previous heartbeat-only mechanism are addressed:
  - **Tab close is detected immediately.** The frontend sends a
    `navigator.sendBeacon` POST to `/api/tab-closing` on `pagehide` and
    `beforeunload`. The server drops that tab from its active set
    instantly instead of waiting the full heartbeat timeout. Closing the
    last tab now stops the server in ~15 s instead of ~30 s.
  - **Multiple tabs are tracked individually.** Each tab generates a UUID
    on load and includes it in every heartbeat. Closing one tab no
    longer requires a 30 s wait to confirm the others are still alive,
    and the server can distinguish "one tab is gone" from "all tabs are
    gone".
  - **Hidden tabs no longer cause false shutdowns.** Browsers throttle
    `setInterval` to roughly one fire per minute in tabs that have been
    hidden for 5+ minutes. The heartbeat timeout was bumped from 30 s
    to 90 s so a throttled hidden tab still counts as alive, and the
    frontend now also pings immediately on `visibilitychange` so a tab
    coming back to the foreground is recognised without delay.
  - **Server no longer runs forever if the frontend never connects.**
    The previous watchdog short-circuited until the first heartbeat
    arrived. A 60 s startup grace now triggers shutdown when no UI ever
    appears (browser launch dismissed, headless invocation, etc.).
  - **Page reloads no longer race the watchdog.** A 15 s close grace
    absorbs the brief gap between `pagehide` of the old page and the
    first heartbeat from the reloaded one.
- Verified end-to-end with an integration test that runs the live
  uvicorn server through each scenario (alive while heartbeating, fast
  exit on explicit close, startup-grace exit, multi-tab survival, exit
  after closing the last of several tabs).

## [2.9.5] — 2026-05-01

### Documentation
- README rewritten for clarity and tone: corrected file-format table to
  include the gzip variants and the GFF3-via-`.gff` auto-detection;
  removed a duplicate Usage step; added performance characteristics with
  measured timings on real test data; updated the citation to the
  current major version.
- `CONTRIBUTING.md` reorganised: explicit `app/backend/` ↔
  `bingoviewer/server/` sync workflow, frontend bundle build with the
  exact `vite` invocation, release-tagging checklist, and code-style
  notes that reflect the actual concurrency and serialisation rules
  the codebase enforces.
- `CHANGELOG.md` polished for publication-ready presentation: verbose
  internal commentary in 2.9.x entries condensed to user-facing
  language; consistent semantic-version headings throughout.
- New `LICENSE` file matching the proprietary declaration in
  `pyproject.toml`. The README badge now resolves.

## [2.9.4] — 2026-05-01

### Fixed
- **GFF3 files with the `.gff` extension parse correctly.** Many real-world
  GFF3 outputs (NCBI annotwriter, Geneious) ship with `.gff`; the previous
  factory routed them to the GTF parser, which silently failed to extract
  gene names or attributes. The reader now sniffs `##gff-version` and the
  attribute style of the first data line and dispatches accordingly.
- **Compressed track files load.** `.vcf.gz`, `.wig.gz`, `.bedgraph.gz`,
  and `.bdg.gz` now round-trip through both the file picker and the
  drag-and-drop overlay; the readers decompress transparently.

### Performance
- **BigWig coverage queries scale with the index, not the genome.**
  Previously the reader expanded each BedGraph block into one `(pos, value)`
  tuple per base pair, allocating up to a million tuples per query on
  dense BigWigs. The new implementation distributes block contributions
  to bin accumulators directly. Same numerical output; queries that were
  seconds long now complete in milliseconds.

## [2.9.3] — 2026-05-01

### Fixed
- Session save/restore now preserves feature-type filters and read-strand
  visibility. These per-track settings (added in 2.8.0 and 2.9.0) had
  been silently dropped on export and on autosave.
- Eliminated a window where, after a transient backend failure during
  rapid pan/zoom, a retry could overwrite freshly fetched data with
  stale results. Retries now share an `AbortController` captured at the
  start of the fetch.
- Reloading a genome or track while requests are in flight no longer
  exposes a half-initialised reader. Reader construction happens outside
  the lock; only the swap is serialised.

## [2.9.2] — 2026-04-30

### Changed
- Install instructions recommend `python -m pip install BiNgoViewer`
  instead of bare `pip install`. The `-m pip` form binds to the
  interpreter you invoked, including the active virtualenv, and works
  on systems where only `python3` / `pip3` is on `PATH`.
- The README troubleshooting table now covers the `pip` versus `pip3`
  versus `python -m pip` distinction, the "installs but `bingo` not on
  `PATH`" case, and a clean-venv one-liner.
- `bingo --update` failures now print the exact
  `<sys.executable> -m pip install --upgrade BiNgoViewer` command, so
  the recovery instruction is always correct for the user's environment.

## [2.9.1] — 2026-04-30

### Fixed
- Rapid zoom and pan no longer leave tracks stranded on a "Network
  error" splash. Three improvements combine:
  - Superseded fetches are genuinely cancelled (the abort signal is
    wired through to axios), so the request queue stops piling up.
  - Transient failures (network drop, HTTP 5xx, 408, 429) silently
    retry up to twice with exponential backoff.
  - On a final failure the last loaded data stays on screen and the
    error surfaces through the existing track warning badge instead of
    blanking the canvas. Sticky errors clear automatically when the
    user changes chromosome.
- Backend reader access is serialised per-track to keep non-thread-safe
  libraries (bamnostic, pyfaidx, the BigWig parser) consistent under
  concurrent load. Tracks still fetch in parallel with each other.
- Reader-level exceptions now return HTTP 503 (transient), engaging the
  frontend retry path.

## [2.9.0] — 2026-04-30

### Added
- **Per-track strand visibility for BAM tracks.** Toggle forward and
  reverse reads independently from Track Settings; rows repack so a
  hidden strand leaves no gaps. Multi-track selection works as
  expected, with indeterminate checkboxes for mixed selections.
- **Swatch grid color picker** for read strand colors, alongside the
  existing hex input and double-click OS color picker.

### Fixed
- `Shift`+scroll now scrolls vertically inside read pile-ups (it had
  been hijacked by the horizontal-zoom handler).
- Read-track scrollbar widened to 14 px and the bottom track-resize
  handle now leaves a gap on the right edge, so scrollbar drags are no
  longer caught by the resize zone.

## [2.8.0] — 2026-04-27

### Added
- **Per-feature-type visibility toggles** for GenBank annotation tracks.
  Hide / show CDS, gene, tRNA, rRNA, repeat_region, misc_feature, etc.
  individually, with bulk Show all / Hide all. Available in Track
  Settings; works across multi-track selection.
- The genome-load API now reports the set of feature types present in
  the file so the UI can populate the toggle list immediately.

## [2.7.x] — 2026-04

### Highlights
- Region color editor: highlight bands and per-region bar recolouring,
  with a colour palette picker.
- Optimised region-overlay rendering for tracks with many overlays.

### Fixed
- Windows shortcut launcher (now via VBScript) avoids the
  `pythonw`-under-Windows console crash and handles Unicode in the
  region editor.

## [2.0.0 – 2.6.x] — 2026-04

A series of feature releases focused on session management, the help
tour, exit safeguards, theming, multi-track editing, and the desktop
shortcut installer. Highlights:

- Exit guard: prompts to save before closing if there are unsaved
  changes.
- Session manager: parallel track loading with validation; autosave to
  `localStorage`; export/import as JSON.
- Theme settings: five built-in themes plus a custom-theme editor.
- Track Settings: bulk multi-track editing for height, colour, scale,
  bar width, and outline trace.
- Track-genome compatibility validation on upload.
- "Show only chromosome-relevant tracks" when switching genomes.

## [1.9.0 – 1.9.4] — 2026-04-05

### Added
- Smooth peak outline trace with adjustable smoothness (0–10) and a
  dedicated outline-color picker.
- Fill-bars toggle with an inline colour picker.
- SVG exports group background, bars, outlines, and labels separately
  for easier editing in vector tools.

## [1.8.0] — 2026-04-05

### Added
- **Nucleotide-level read rendering** with A / C / G / T colouring and
  mismatch highlighting; reference sequence is fetched automatically
  when zoomed in. New "Show nucleotides when zoomed in" checkbox on
  read tracks.
- Directional arrow style respects the "Pointed arrows" setting on
  reads.

## [1.7.0] — 2026-04-05

### Added
- **Local file path input** for loading files directly from disk
  without uploading through the browser. Recommended for BAMs over 50 MB.
- BAM pairing dialog with dual file/path slots and a large-file warning.
- **Chromosome scrubber** along the top of the viewport for fast
  navigation across the genome.
- Double-click any annotation to centre it in the view with flanking
  context.

### Fixed
- Cross-browser logo rendering (unique gradient IDs, SVG stop-opacity).
- File-drop overlay no longer triggers when dragging within a track.

## [1.6.0] — 2026-04-04

### Added
- Selection highlight on the ruler track.
- Pan / zoom interactions on the ruler.
- Y-axis labels gain a translucent pill so they stay readable over data.

## [1.5.0] — 2026-04-04

### Added
- Non-standard WIG variants supported: embedded headers, three-column
  forward/reverse, and headerless files.
- Auto-detection of BedGraph-format files with a `.wig` extension.
- `.bai` index files accepted in the file picker and via drag-and-drop.

### Fixed
- Chromosome name matching across all readers (chr-prefix stripping,
  case-insensitive).
- WIG bin averaging — sums were not being divided by their counts.

## [1.4.0] — 2026-04-04

### Added
- **CIGAR-aware read rendering**: match, deletion, intron skip,
  insertion markers.
- Upload progress bars with byte counters.
- Gapless coverage bins (floating-point boundaries).
- Zoom-aware data refetching with a 1-second debounce.

### Fixed
- Bar width scaling at high zoom (capped to 1 px per nucleotide).
- Missing genome chunks on zoom-out (data is no longer cleared during
  refetch).

## [1.3.0] — 2026-04-04

### Added
- **Right-click drag region selection** with a hover tooltip showing
  per-track stats.
- Exit guard with Return / Save & Exit / Exit Without Saving.
- Robust session save/restore with parallel track loading and
  validation.
- BAM index (.bai) upload pairing and validation.
- Auto-update check on launch with PyPI version comparison.
- Desktop shortcut installer with custom icon.

### Fixed
- Windows socket error (WinError 64) via `SelectorEventLoop`.
- Install-script reliability on Windows (errorlevel handling) and
  macOS (portable shebang).

## [1.0.0] — 2026-04-04

### Initial release
- GenBank and FASTA reference genome support.
- BAM read alignment viewing.
- BigWig, WIG, and BedGraph coverage tracks.
- VCF variant display.
- BED, GTF, and GFF annotation tracks.
- Five built-in themes plus custom theme support.
- Session save / restore.
- SVG and PNG export.
