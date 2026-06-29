/**
 * useCanvasInteraction.js — Click-drag panning, scroll-wheel zooming,
 * and right-click-drag region selection.
 *
 * Left-click drag: a 2-D "grab" — horizontal movement pans the genomic
 *   viewport; vertical movement scrolls the track list (when there are more
 *   tracks than fit on screen). Dragging up reveals tracks below; dragging
 *   down reveals tracks above.
 * Right-click drag: select a genomic region (stored in BrowserContext).
 *   After such a drag, the trailing `contextmenu` event (which the browser
 *   fires on mouseup of a right-button) is suppressed in the capture phase
 *   so the RegionColorEditor's "Edit region colors…" menu doesn't pop on
 *   top of the freshly-created selection — that menu's full-viewport scrim
 *   used to intercept hover and prevent the SelectionOverlay tooltip from
 *   appearing.
 * Scroll wheel: zoom in/out anchored at the cursor.
 */
import { useEffect, useRef } from 'react'
import { useBrowser } from '../store/BrowserContext'

const DRAG_MOVE_THRESHOLD_PX = 3  // movement >= this counts as a "drag", not a click

/** Walk up the DOM to the nearest ancestor that actually scrolls vertically
 *  (the track list). Returns null when nothing overflows, so a vertical drag
 *  is a no-op until there are more tracks than fit on screen. */
function findScrollParent(el) {
  let node = el && el.parentElement
  while (node) {
    const oy = getComputedStyle(node).overflowY
    if ((oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight + 1) {
      return node
    }
    node = node.parentElement
  }
  return null
}

export function useCanvasInteraction(containerRef) {
  const { region, zoom, navigateTo, setSelection, clearSelection } = useBrowser()
  const dragRef = useRef(null)
  const selectRef = useRef(null)
  const regionSnapshot = useRef(region)
  // True for one tick after a right-click drag completes — used by the
  // global capture-phase contextmenu handler below to swallow the
  // browser's auto-fired contextmenu so the region-colors menu doesn't
  // pop over the brand-new selection.
  const suppressNextContextMenuRef = useRef(false)

  // Keep snapshot current every render so onMouseDown always sees latest region
  regionSnapshot.current = region

  useEffect(() => {
    const canvas = containerRef.current
    if (!canvas) return

    function onMouseDown(e) {
      const r = regionSnapshot.current
      if (!r) return

      // Right-click: begin region selection
      if (e.button === 2) {
        e.preventDefault()
        const rect = canvas.getBoundingClientRect()
        const xFrac = (e.clientX - rect.left) / rect.width
        const bpPos = r.start + xFrac * (r.end - r.start)
        selectRef.current = {
          startX: e.clientX,
          startBp: bpPos,
          region: { ...r },
          containerWidth: rect.width,
          moved: false,
        }
        return
      }

      // Left-click: begin a 2-D grab (horizontal pan + vertical track scroll)
      if (e.button === 0) {
        // Don't hijack a press on a track's own scrollbar (e.g. the ReadTrack
        // pileup scrollbar marks its width via data-scrollbar). That control
        // handles the press itself.
        const tgt = e.target
        const sbw = tgt && tgt.dataset ? parseInt(tgt.dataset.scrollbar, 10) || 0 : 0
        if (sbw > 0) {
          const r2 = tgt.getBoundingClientRect()
          if (e.clientX >= r2.right - sbw - 2) return
        }
        clearSelection()
        const scrollParent = findScrollParent(canvas)
        dragRef.current = {
          x: e.clientX,
          y: e.clientY,
          startRegion: { ...r },
          containerWidth: canvas.offsetWidth || canvas.clientWidth || 1,
          scrollParent,
          startScrollTop: scrollParent ? scrollParent.scrollTop : 0,
        }
      }
    }

    function onMouseMove(e) {
      // Region selection drag
      if (selectRef.current) {
        const s = selectRef.current
        // Track whether the user actually moved the mouse during the
        // right-press — used to distinguish a drag-select from a
        // stationary right-click on the existing selection.
        if (!s.moved && Math.abs(e.clientX - s.startX) >= DRAG_MOVE_THRESHOLD_PX) {
          s.moved = true
        }
        const rect = canvas.getBoundingClientRect()
        const xFrac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
        const bpPos = s.region.start + xFrac * (s.region.end - s.region.start)
        const selStart = Math.min(s.startBp, bpPos)
        const selEnd = Math.max(s.startBp, bpPos)
        if (Math.abs(selEnd - selStart) >= 1) {
          setSelection({
            chrom: s.region.chrom,
            start: Math.floor(selStart),
            end: Math.ceil(selEnd),
          })
        }
        return
      }

      // Pan drag
      if (!dragRef.current) return
      const d = dragRef.current

      // Vertical: scroll the track list. "Grab" model — dragging up moves the
      // content up (scrollTop increases), revealing tracks below.
      if (d.scrollParent) {
        const dy = e.clientY - d.y
        d.scrollParent.scrollTop = d.startScrollTop - dy
      }

      // Horizontal: pan the genomic viewport.
      const dx = e.clientX - d.x
      const { chrom, start, end } = d.startRegion
      const bpPerPixel = (end - start) / d.containerWidth
      const bpDelta = -dx * bpPerPixel
      navigateTo(chrom, start + bpDelta, end + bpDelta)
    }

    function onMouseUp(e) {
      if (selectRef.current) {
        // If the user dragged with the right button (created/extended a
        // selection), suppress the contextmenu the browser is about to
        // fire so the RegionColorEditor's menu doesn't pop on top of the
        // brand-new selection and block hover. A stationary right-click
        // still opens the menu as expected.
        if (selectRef.current.moved) {
          suppressNextContextMenuRef.current = true
        }
        selectRef.current = null
        return
      }
      dragRef.current = null
    }

    function onContextMenu(e) {
      // Suppression of drag-selection contextmenus is handled in the
      // capture phase below; if we reach the bubble handler the user is
      // requesting the track context menu (right-click without a drag).
      e.preventDefault()
      // Dispatch event for RegionColorEditor to show reset option
      window.dispatchEvent(new CustomEvent('bingo-track-context', {
        detail: { x: e.clientX, y: e.clientY }
      }))
    }

    // Capture-phase document listener: this fires BEFORE the highlight
    // div's React onContextMenu in SelectionOverlay, so suppression here
    // also prevents that handler from dispatching 'bingo-region-context'.
    function onContextMenuCapture(e) {
      if (suppressNextContextMenuRef.current) {
        suppressNextContextMenuRef.current = false
        e.preventDefault()
        e.stopPropagation()
      }
    }

    function onWheel(e) {
      // Shift+wheel is reserved for vertical scrolling inside tracks
      // (e.g. ReadTrack pileup). Don't zoom; let the track-level handler
      // and React's synthetic onWheel run.
      if (e.shiftKey) return
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const anchorFraction = (e.clientX - rect.left) / rect.width
      const factor = e.deltaY > 0 ? 1.4 : 0.7
      zoom(factor, anchorFraction)
    }

    canvas.addEventListener('mousedown', onMouseDown)
    canvas.addEventListener('contextmenu', onContextMenu)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    // Capture phase, document-level — must run before any React bubble
    // handler on the highlight div in SelectionOverlay.
    document.addEventListener('contextmenu', onContextMenuCapture, true)

    return () => {
      canvas.removeEventListener('mousedown', onMouseDown)
      canvas.removeEventListener('contextmenu', onContextMenu)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      canvas.removeEventListener('wheel', onWheel)
      document.removeEventListener('contextmenu', onContextMenuCapture, true)
    }
  }, [zoom, navigateTo, setSelection, clearSelection, containerRef])
}
