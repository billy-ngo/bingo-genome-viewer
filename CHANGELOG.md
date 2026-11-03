# Changelog

All notable user-facing changes to BiNgo Genome Viewer are recorded here.
Internal refactors are summarised at a level a user can act on; the full
commit history is on GitHub.

The project follows [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`.

## [2.14.0] — 2026-11-03

### Fixed — Y-axis (scale bar) accuracy
- **The zoomed-out Y axis no longer understates the data.** Zoomed out, each
  bar summarises many bases, and it used to show their *mean*, which flattens
  narrow peaks. For example, a ChIP track peaking at 30.9 had an axis of about 7
  at whole-genome zoom, but 0–30 after zooming into a gene. Bars now show the
  **maximum** of each bin by default, so a peak keeps its true height at every
  zoom and the whole-genome axis is never below a zoomed-in one. The old
  behaviour is available as Track Settings → **Windowing → Mean**.
- **The auto Y axis fits the visible region by default.** It was fitted to the
  whole fetched range (the view plus 50% on each side), so a peak just
  off-screen could set the scale and flatten what you see. Untick "Fit to
  visible region" for the old behaviour.
- **No more dropped signal at kilobase zoom.** Bins with fractional widths could
  silently drop data, so a tall Tn-seq insertion site could vanish at 1 kb zoom
  and reappear after a 1 bp pan. BigWig, bedGraph and WIG now use integer bin
  edges.
- **WIG files with repeated positions** (the same position and span) are
  summed instead of averaged; two entries at one position no longer halve the
  value.
- **Infinite or NaN values.** A WIG, bedGraph or BigWig containing `inf`,
  `-inf` or `nan` (for example a log ratio that hit log(0)) no longer fails to
  draw, or empties the tooltips, wherever such a value is in view. These
  values are skipped.
- **BAM coverage is exact.** The old computation had several bugs:
  - it counted reads that crossed internal 50 kb chunk boundaries twice, giving
    false plateaus up to 2× that moved as you panned;
  - it stopped counting after 500,000 reads;
  - it counted deletions, introns, duplicates and QC-fail reads;
  - it failed for views near a contig end and for contigs with no reads.

  A BAM track now builds an exact per-base coverage index in the background
  when it is loaded; a 370 MB BAM takes about 12 s. Until the index is ready,
  the part already computed is shown (for coordinate-sorted BAMs) and the rest
  is shaded as pending. As in IGV, depth counts aligned bases (CIGAR
  `M`/`=`/`X`) and skips unmapped, QC-fail and duplicate reads. Ultra-long
  reads whose CIGAR is stored in the `CG` tag are counted along their real
  alignment. References over 32 Mbp, too large for the index, get exact
  coverage computed per view for up to 500,000 reads; past that point the view
  is shaded as pending. A BAM that turns out to be truncated or corrupt (for
  example a record with an impossible size) is reported as such instead of
  being drawn with wrong coverage.
- **The read view of deep BAMs covers the whole window, and is faster.** At
  ≤ 50 kb zoom it used to stop after the first 5,000 reads, which left most of
  the view empty. Now every read is shown when 5,000 or fewer overlap the
  window. Beyond that, 5,000 are sampled evenly across it and a warning gives
  the exact total. A 50 kb view of a 370 MB ChIP-seq BAM loads in about 0.5 s
  instead of about 3 s. These reads are now shown at their true extent:
  - reads that start far left of the view;
  - alignments stored without a sequence, such as secondary alignments;
  - ultra-long reads with a `CG`-tag CIGAR.

  Unmapped mates placed at a position are hidden, as in IGV. A view too deep
  to scan within a few seconds (over a million reads, or a very deep stretch
  just left of it) is drawn as far as the scan got. The rest is shaded, instead
  of the view looking empty. The warning says where the scan stopped and how
  many reads it found, and whether those drawn are an even sample of them.
- **Read pileup scrolling.** Shift+scroll no longer logs browser console
  errors, a pileup that fits no longer scrolls its top row out of view, and
  scrolling to the end puts the last row at the bottom edge. Dragging the
  scrollbar thumb follows the pointer; it used to stop partway down.
- **Linked and overlaid tracks:**
  - hidden members, and members with no data on the current chromosome, no
    longer set the shared axis;
  - "Link scales across selected tracks" creates a new link group each time
    instead of one global group;
  - an overlay member whose file covers another chromosome is no longer drawn
    at this chromosome's coordinates;
  - an overlay row's selection tooltip describes a member that is actually
    drawn.
- **The split (+/−) layout** for signed data is decided once per chromosome, so
  it no longer flips while you pan.
- **Numbers and labels:**
  - axis labels keep their precision (e.g. 0.0792, not 0.1);
  - ruler tick labels stay distinct at every zoom (they used to repeat on
    Mb-scale chromosomes);
  - variant markers sit on the centre of their base.
- **SVG/PNG export** uses exactly the on-screen axis, layout and windowing. It
  leaves out overlay members that are hidden, unticked under Include tracks,
  or have no data on the chromosome. BAM coverage that is still being computed
  is shaded in the export as on screen, and the Export dialog lists the tracks
  whose data is incomplete.
- **Exact tooltip statistics.** The selected-region tooltip shows the true
  mean, max and sum of the signal (forward/reverse for strand data). It used to
  show an "Avg cov" that changed with the zoom level. The gene tooltip's
  "Track signal in feature" is exact too. The numbers are fetched once a
  selection stops changing, or once the pointer rests on a gene, so dragging
  and sweeping stay responsive.
- **Data handling:**
  - switching chromosome never draws the previous chromosome's data or axis;
  - panning back into an already loaded range during a slow request no longer
    leaves half the view blank;
  - a BAM track shows reads in every view of 50 kb or less. A small zoom in from
    the coverage view used to leave it on coverage, and a small zoom within
    the read view kept the previous view's reads and counts.
- **Fixed Y scale:**
  - values below 1 are accepted;
  - unticking Auto keeps each track's current axis instead of jumping to 100.
    Tracks not on screen (hidden, on another chromosome or not loaded yet)
    keep Auto, and Track Settings says so;
  - a selection that mixes auto and fixed tracks shows as mixed instead of
    "Auto";
  - the clipping warning judges what is drawn. A track drawn only as a
    smoothed curve (Smooth fill, or Peak outline without bars) warns "Curve
    clipped" when the curve is cut, and no longer warns about bars it does not
    draw.
- **Contig naming.**
  - A BigWig or BAM contig whose name differs from the genome's chromosome
    only by a `chr` prefix, letter case or a `.version` suffix now counts as a
    match. Such tracks used to be reported as mismatched. The `.version` rule
    applies only where it is unambiguous, so `supercont1.15` is never drawn
    with the data of `supercont1.1`, as BAM tracks used to be.
  - A contig named differently altogether is matched by exact length when
    that length is unique on both sides and the matches account for most of
    the unmatched sequence. An example is a GenBank LOCUS name versus the
    accession `CP124550.1`. Such tracks used to stay blank. A notice names
    the pairs matched this way, and the load response lists them.
  - Unrelated assemblies that merely share a contig length are not matched.
    This is judged for each genome file separately, so merging an unrelated
    assembly with **Add as Chromosome** cannot undo a match.
  - After **Add as Chromosome**, loaded tracks keep the chromosomes they were
    shown on. They also show on the added chromosomes they pair with by name or
    exact length; they used to stay hidden there.
  - A BAM or BigWig track whose data now pairs with other chromosomes moves
    there, and a notice says so. An example is an added accession taking over
    from a GenBank LOCUS name.
  - A track left without any matching chromosome is named in a warning.
    Starting another merge, from the Load Files panel or by dropping a file on
    the page, clears the notices and warnings of the previous one.
  - A track that finishes loading while chromosomes are being added is paired
    with the merged genome. When genome and track files are dropped together,
    the Add as Chromosome prompt waits until the tracks are loaded.
  - A chromosome name already in the genome is listed once. The sequence that
    a merged file has under that name is ignored, as it always was (the first
    file's is the one shown), and a file that adds no new chromosome, such as
    the same file twice, is refused with a message. The chromosome menu used to
    list such a name twice.
  - Tracks loaded by file path get the same compatibility check as uploads.

### Fixed — nucleotide strip
- The reference sequence strip no longer drops out while you scroll at base
  level. There were four causes:
  - each drag lengthened the view by about 1 bp until it crossed the letter
    threshold;
  - the strip was hidden in intergenic stretches;
  - responses could arrive out of order;
  - abandoned BAM read requests piled up on the server and delayed the
    sequence requests.

  The server now drops a request as soon as a newer one for the same track
  arrives.

### Fixed — genome files
- An uploaded genome keeps its file name. Since 2.12.1 the header, the
  annotation track and messages showed it with an 8-character prefix (for
  example `e1e78f0c_Se`).
- Adding a GenBank file to a FASTA genome shows the GenBank file's
  annotations. The annotation track used to say "Track not found".
- Genome search no longer finds genes in a merged GenBank record that the
  genome does not show because its name was already taken. The feature-type
  filter no longer lists types that only such records have.
- Dropping two genome files on the page when no genome is loaded loads the
  first and asks what to do with the others, as Load Files does. The others
  used to be ignored without a message.
- A file with no sequences, such as a FASTA file saved as `.gb`, is refused
  with a message that says so, whether loaded as the genome or added to it. A
  rejected upload is deleted from the server's upload folder, and its message
  names the file instead of the upload's path.
- Status messages after loading or adding files no longer disappear early
  because an earlier message's timer ran out.

### Added
- **Bin size** (Track Settings). **Auto** is the default (about one bin per
  pixel) and shows the bin size currently drawn. You can also choose a fixed
  size from 1 bp to 10 kb, or a custom size. Fixed bins align to the genome.
  If a size would need more than 5,000 bins at the current zoom, it is
  coarsened and the panel says so.
- **Windowing** (Track Settings): Max (default, keeps peak heights) or Mean.
- `GET /api/tracks/{id}/stats` returns the exact mean, max, min, sum and
  covered bp of a coverage/read track over a region.
  - `complete` is false while a BAM's coverage index is still building.
  - `truncated` is set when no exact answer is possible.
  - An optional `slot` names the asker. A newer request in the same slot makes
    an older one that is still waiting answer 409.

### Changed
- `GET /api/tracks/{id}/reads` reports the exact number of overlapping reads
  in `total`, with `truncated` when the reads returned are a sample. When a
  view is too deep to scan in full, `total_exact` is false and `scanned_to`
  gives the position the scan reached. Every overlapping read starting before
  it was found; `total` counts them, and above 5,000 `reads` is an even
  sample.
  `/coverage` and `/reads` answer 409 to a request that a newer one for the
  same track has superseded.
- `POST /api/genome/add-chromosomes` also returns `tracks`. For each loaded
  track it gives the target chromosomes after the merge (where the track was
  shown, plus the added chromosomes it pairs with) and its compatibility with
  the merged genome. It answers 400 for a file that adds no new chromosome.
- Sessions are saved as version 3, which adds bin size, windowing and
  link-group ids. Older sessions restore with fit-to-visible auto scale on.
- The health and heartbeat endpoints answer even while track requests are
  busy, so the idle-shutdown watchdog cannot stop a busy session.

## [2.13.0] — 2026-07-28

### Added
- **Smooth fill for coverage tracks.** When the peak outline is enabled, a new
  **Smooth fill** option (Track Settings → Peak outline) fills the area under the
  smoothed outline curve with a single flat colour instead of drawing bars — an
  area-chart style view of the signal. It honours the **Smoothness** setting, so
  the fill follows the same smoothed curve as the outline stroke drawn on top,
  and it replaces the bars while active. Works for BigWig/WIG/bedGraph coverage
  tracks and the zoomed-out coverage view of read (BAM) tracks, including
  forward/reverse split tracks, overlay groups, and SVG/PNG export. The setting
  round-trips through session save/restore.

## [2.12.1] — 2026-06-29

### Fixed
- **Coverage binning is now consistent and correct across formats.** BedGraph
  and WIG coverage is weighted by base-pair overlap (matching the BigWig
  reader), so the same signal rendered as `.bedgraph`, `.wig`, or `.bw` now
  produces the same bin heights instead of subtly different ones.
- **WIG `span` is honored.** A `span=N` entry now spreads its value across every
  base pair (and bin) it covers, rather than being credited to a single point.
- **Out-of-order WIG files no longer render wrong coverage.** The "already
  sorted?" shortcut only compared the first and last position, so a file with
  any interior disorder was left unsorted and could drop or misplace data. All
  parallel arrays are now sorted together with a real monotonicity check.
- **Forward/reverse (3-column) WIG now renders the reverse strand below the
  axis** as intended, instead of summing both strands into one positive bar.
- **Chromosome-name matching no longer mangles contig names.** Matching stripped
  *every* occurrence of "chr" (so `scaffold_chr2` broke); it now strips only a
  leading `chr` prefix, matching the BAM reader.

### Changed
- Requires **Python 3.10+** (the package metadata previously claimed 3.9, but the
  code has always used 3.10-only syntax and could not import on 3.9).
- Uploaded files are saved under unique names, so two same-named uploads (e.g.
  two `reads.bam`) no longer overwrite each other.
- Dropping a genome-format file and choosing "Add as Track" now runs the same
  genome-compatibility check as every other load path.
- Minor internal cleanups: BAM contig list cached (was recomputed per request),
  a single tab-close beacon, and corrected/accurate code comments and README.

## [2.12.0] — 2026-06-29

### Added
- **Overlay coverage tracks.** Two or more coverage tracks (BigWig, WIG,
  bedGraph) can now be stacked into a single shared row for direct comparison.
  Select them in Track Settings and click **"Overlay these N tracks"** (and
  **"Separate overlay"** to undo). In the merged row's label area, a legend gives
  each track:
  - a **color** swatch,
  - a **transparency** slider (per-track opacity), and
  - **▲ / ▼ hierarchy** controls (which track draws on top), plus show/hide and
    remove-from-overlay.

  All overlaid tracks automatically share one Y axis so the profiles are
  directly comparable, and the group drags, resizes, and exports (SVG and PNG)
  as a single row. Overlay groups are saved with your session.

## [2.11.3] — 2026-06-29

### Fixed
- **SVG exports no longer carry a large empty area below the image.** Every
  track group shared one clip path whose rectangle was the full document height;
  because that clip was evaluated inside each track's own (shifted) coordinate
  system, the lower tracks' clip regions extended far below the artwork — up to
  nearly twice the real height. On-screen viewers ignored the overflow, but
  Adobe Illustrator (and other editors that size the artboard to clip geometry)
  imported the SVG much taller than expected, with empty space below. Each track
  now gets its own clip sized to that track, so the exported SVG's bounds match
  the visible content exactly.

## [2.11.2] — 2026-06-29

### Fixed
- **SVG image export now matches the screen when "Fit to visible region" (or
  "Link scales") is on.** The vector export re-rendered coverage/read tracks
  from the fetched data range, so bar heights and the Y-axis label used the
  whole-fetch maximum instead of the visible/linked auto-scale shown on screen —
  the exported picture didn't match what you saw. The export now applies the
  same auto-scale the live tracks use, so the heights and axis label agree.
- The SVG export also now honors per-track customizations it previously ignored:
  region bar-recoloring and persistent region highlight overlays
  (Region Colors), hidden GenBank feature types, and numbered peak labels. The
  PNG export likewise paints region highlight overlays, which live in a separate
  layer and were missing from the rasterized image.
- A zoomed-in read pileup no longer exports as a blank track in SVG — the
  per-read view (which isn't practical to vectorize faithfully) is embedded as
  an image so the exported track matches the screen.

## [2.11.1] — 2026-06-29

### Fixed
- Numeric text boxes are now actually typeable. The Track Height, Y‑scale
  (+Ymax/−Ymax), Bar width, and Export width fields previously validated and
  clamped on every keystroke against their controlled value, which silently
  reverted intermediate input — you couldn't clear the box, couldn't type "5"
  on the way to "50", and out‑of‑range or partial entries jumped back. They now
  accept free typing (including a partial decimal like "60."), apply valid
  in‑range values live, and clamp to the allowed range only when you click away
  or press Enter.
- The region color hex fields (highlight/bar color) had the same problem — they
  only accepted a complete valid hex per keystroke, so they couldn't be edited
  by typing. They now allow free editing and commit on a valid hex or on blur.

## [2.11.0] — 2026-06-29

### Added
- **"Fit to visible region" Y-scale toggle** (Track Settings, coverage/read
  tracks, under Y Scale → Auto). When on, a track's Y axis auto-fits to just
  the data currently in view and re-fits every time you pan left/right — not
  only when you zoom. Off (the default) keeps the existing behavior of scaling
  to the fetched region.
- **Linked auto-scales are now dynamic.** "Link scales across selected tracks"
  is now a persistent toggle (rather than a one-time snapshot): linked
  coverage/read tracks continuously share one Y axis, and when combined with
  "Fit to visible region" they share a scale that re-fits the visible region as
  you pan. Both settings are saved with your session. (To set a fixed shared
  scale instead, turn Auto off and enter a Y max — it applies to all selected
  tracks.)

## [2.10.3] — 2026-06-27

### Added
- Left-click drag is now a 2-D "grab": horizontal movement pans the genomic
  view (as before) and vertical movement scrolls the track list when there are
  more tracks than fit on screen. Dragging up reveals tracks below; dragging
  down reveals tracks above. Vertical drag is a no-op when everything already
  fits. A drag that starts on a read track's own pileup scrollbar is left to
  that scrollbar, so the two don't fight.

## [2.10.2] — 2026-06-27

### Fixed
- Peak ranking now handles QuEST/MACS peak BEDs that interleave wide **peak**
  rows (named `1`, `2`, `3`… = the rank) with narrow **summit** rows
  (`P1`, `P2`…). Previously every row — including the 4 bp summits — was
  ranked by enrichment, which pushed each peak's displayed rank out of step
  (peak `2` showed as rank 3, peak `3` as rank 5, …). When a file is already
  numbered in its name column, that number is now used directly as the rank,
  and auxiliary rows like the summits are left unranked so they don't shift
  the peak numbers. Files that carry only an enrichment score (no rank in the
  name) are still ranked by enrichment as before.

### Added
- BED `itemRgb` (column 9) is now honored, so a file's own per-feature colors
  render as written — e.g. QuEST peaks in blue and summits in red — both
  on screen and in SVG/PNG export.

## [2.10.1] — 2026-06-27

### Fixed
- Tracks are no longer clipped at the bottom when many are loaded at once
  (most visible on BigWig/coverage tracks, whose bars sit at the bottom). The
  track list is a vertical flexbox, and the track rows lacked `flex-shrink: 0`,
  so once the tracks overflowed the viewport the browser *compressed* each row
  below its set height — cutting off the bottom of every track — instead of
  letting the list scroll. Rows, the ruler, and the placeholder track now keep
  their full height and the list scrolls as intended. (The auto-fit height
  added in 2.9.11 made this more noticeable by increasing total height.)

## [2.10.0] — 2026-06-26

### Added
- **Gene/feature search.** A magnifying-glass button next to the chromosome
  scrubber opens a search box that finds genes and features by name, gene,
  `locus_tag`, or product across the loaded genome's annotations and every
  uploaded GFF/GTF/BED track. Results show type and location; click one (or
  press Enter / arrow keys) to jump straight to it with the feature framed and
  selected. Backend endpoint: `GET /api/genome/search?q=…`.
- **Ranked peak annotations.** Upload a `.gff` (or `.bed`) of ChIP peaks and
  each peak is drawn across its full width and labeled with its **enrichment
  rank**. Ranking is computed automatically: peaks are ordered by enrichment
  (the GFF score column, or an `enrichment=` / `fold_enrichment=` /
  `signalValue=` attribute) and numbered 1 (most enriched) … N; a file that is
  already pre-ranked (numeric feature name) is honored as-is. Plain gene/CDS
  annotations are never ranked.
- **Rank labels over coverage tracks.** Peak rank numbers also float above the
  matching positions on your signal/coverage tracks, so you can see which peak
  ranks where in the data. Labels are collision-aware — when peaks are close or
  you zoom out, the most-enriched peak's label wins so the view stays readable.
  Hovering a peak shows its rank and enrichment value.

## [2.9.11] — 2026-06-18

### Added
- **Automatic track height.** Read and annotation tracks now grow automatically
  to show all of their stacked rows, so you no longer have to drag each track
  taller to reveal hidden reads or genes when several tracks are open. The
  height fits the content, never shrinks below the track's default, and is
  capped at 500 px (deeper pileups keep the scrollbar). It recomputes as you
  zoom/pan and reverts to the default when a read track is showing coverage.
- A manual resize (dragging the track's bottom edge) or setting a height in
  Track Settings turns auto-fit off for that track, so your chosen height
  sticks. Track Settings has a new **Auto height — "Fit to show all rows"**
  toggle to turn it back on. The setting is saved with your session.

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
