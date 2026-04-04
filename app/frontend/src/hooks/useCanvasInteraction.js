/**
 * useCanvasInteraction.js — Click-drag panning, scroll-wheel zooming,
 * and right-click-drag region selection.
 *
 * Left-click drag: pan the viewport.
 * Right-click drag: select a genomic region (stored in BrowserContext).
 * Scroll wheel: zoom in/out anchored at the cursor.
 */
import { useEffect, useRef } from 'react'
import { useBrowser } from '../store/BrowserContext'

export function useCanvasInteraction(containerRef) {
  const { region, zoom, navigateTo, setSelection, clearSelection } = useBrowser()
  const dragRef = useRef(null)
  const selectRef = useRef(null)
  const regionSnapshot = useRef(region)

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
        }
        return
      }

      // Left-click: begin pan
      if (e.button === 0) {
        clearSelection()
        dragRef.current = {
          x: e.clientX,
          startRegion: { ...r },
          containerWidth: canvas.offsetWidth || canvas.clientWidth || 1,
        }
      }
    }

    function onMouseMove(e) {
      // Region selection drag
      if (selectRef.current) {
        const s = selectRef.current
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
      const dx = e.clientX - dragRef.current.x
      const { chrom, start, end } = dragRef.current.startRegion
      const bpPerPixel = (end - start) / dragRef.current.containerWidth
      const bpDelta = -dx * bpPerPixel
      navigateTo(chrom, start + bpDelta, end + bpDelta)
    }

    function onMouseUp(e) {
      if (selectRef.current) {
        selectRef.current = null
        return
      }
      dragRef.current = null
    }

    function onContextMenu(e) {
      // Suppress the browser context menu on the track area
      e.preventDefault()
    }

    function onWheel(e) {
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

    return () => {
      canvas.removeEventListener('mousedown', onMouseDown)
      canvas.removeEventListener('contextmenu', onContextMenu)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      canvas.removeEventListener('wheel', onWheel)
    }
  }, [zoom, navigateTo, setSelection, clearSelection, containerRef])
}
