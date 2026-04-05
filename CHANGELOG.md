# Changelog

All notable changes to BiNgo Genome Viewer are documented here.

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
