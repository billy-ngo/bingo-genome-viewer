# Changelog

All notable changes to BiNgo Genome Viewer are documented here.

## [2.9.1] - 2026-04-30

### Fixed
- Rapid zoom/pan no longer leaves tracks stuck on a "Network error" splash:
  - axios requests are now actually cancelled when superseded (the abort signal is wired through), preventing the request flood that was overwhelming the backend
  - transient failures (network drop, 5xx, 408, 429) silently retry up to 2 times with exponential backoff
  - on a final failure the last loaded data stays on screen — the canvas no longer blanks out — and the error is surfaced through the existing track warning badge instead of an in-canvas overlay
  - sticky errors automatically clear when the user changes chromosome
- Backend reader access is now serialized per-track via `threading.Lock`, fixing races in non-thread-safe libraries (bamnostic, pyfaidx, pyBigWig) that produced spurious 500s under concurrent zoom requests; tracks still fetch in parallel across each other
- Reader-level exceptions now return HTTP 503 (transient) instead of 500 so the frontend retry path engages

## [2.9.0] - 2026-04-30

### Added
- Read tracks: per-track forward/reverse strand visibility toggle (BAM); rows repack so hidden strand leaves no gaps; works across multi-track selection in Track Settings
- Read strand color pickers now have a swatch grid popover (single-click), with double-click for full OS color picker and hex input — same UX as elsewhere in the app

### Fixed
- Shift+scroll no longer triggers horizontal zoom — reserved for vertical scrolling inside read tracks as intended
- Read-track vertical scrollbar widened (10 → 14 px) and the track-height resize handle now leaves a gap on the right edge so scrollbar drags are no longer blocked by the resize zone

## [2.8.0] - 2026-04-27

### Added
- GenBank annotation tracks: per-type visibility toggles (CDS, gene, tRNA, rRNA, repeat_region, misc_feature, etc.)
- Backend exposes `feature_types` from GenBank files via `/api/genome/load`, `/load-path`, and `/add-chromosomes`
- Track Settings panel: new collapsible "Feature types" section with Show all / Hide all and indeterminate state for multi-track selections

## [1.9.4] - 2026-04-05

### Changed
- SVG export: background, bars, outline, and labels are now separate grouped elements for easy editing in vector editors

## [1.9.0] - 2026-04-05

### Added
- Smooth peak outline with adjustable smoothness slider (0–10)
- Outline color picker with real-time preview
- Fill bars toggle with inline color picker

## [1.8.0] - 2026-04-05

### Added
- Nucleotide-level read rendering with A/C/G/T coloring and mismatch highlighting
- Reference sequence fetched automatically when zoomed in
- "Show nucleotides when zoomed in" checkbox for read tracks
- Directional arrows respect "Pointed arrows" setting on reads

## [1.7.0] - 2026-04-05

### Added
- Local file path input for loading files directly from disk (no upload)
- BAM pairing dialog with dual file/path slots and large file warning
- Chromosome scrubber slider for fast navigation
- Double-click gene to zoom in with context
- Peak outline trace toggle for coverage tracks

### Fixed
- Logo cross-browser compatibility (unique gradient IDs, SVG stop-opacity)
- Drag on tracks no longer triggers file drop overlay

## [1.6.0] - 2026-04-04

### Added
- Selection highlight on ruler track
- Ruler supports pan/zoom interactions
- Y-axis scale labels with background pill (always readable)

## [1.5.0] - 2026-04-04

### Added
- Non-standard WIG format support (embedded headers, 3-column fwd/rev, headerless)
- Auto-detect BedGraph-format .wig files
- .bai files accepted in file picker and drag-and-drop

### Fixed
- Chromosome name matching across all readers (chr-prefix stripping, case-insensitive)
- WIG bin averaging (was summing without dividing by count)

## [1.4.0] - 2026-04-04

### Added
- CIGAR-aware read rendering (match, deletion, intron skip, insertion markers)
- Upload progress bars with byte counter
- Gapless coverage bins (floating-point boundaries)
- Zoom-aware data refetching with 1-second debounce

### Fixed
- Bar width scaling at high zoom (capped to 1px per nucleotide)
- Missing genome chunks on zoom-out (data never cleared during refetch)

## [1.3.0] - 2026-04-04

### Added
- Right-click drag region selection with hover tooltip and stats
- Exit warning guard (Return / Save & Exit / Exit Without Saving)
- Robust session save/restore (parallel track loading, validation)
- BAM index (.bai) upload pairing and validation
- Auto-update check on launch with PyPI version comparison
- Desktop shortcut installer with icon

### Fixed
- Windows socket error (WinError 64) via SelectorEventLoop
- Install scripts: batch errorlevel handling, macOS portability
- Frontend bundle rebuilt with all features

## [1.0.0] - 2026-04-04

### Initial Release
- GenBank and FASTA genome support
- BAM read alignment viewing
- BigWig, WIG, BedGraph coverage tracks
- VCF variant display
- BED, GTF, GFF annotation tracks
- 5 built-in themes + custom theme support
- Session save/restore
- SVG and PNG export
