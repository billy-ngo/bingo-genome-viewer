/**
 * useCanvasInteraction.js — Click-drag panning and scroll-wheel zooming.
 *
 * Attaches mouse/wheel listeners to a canvas container ref.
 * Uses absolute positioning (not incremental pan) to avoid stale-closure drift.
 */
import { useEffect, useRef } from 'react'
import { useBrowser } from '../store/BrowserContext'

export function useCanvasInteraction(containerRef) {
  const { region, zoom, navigateTo } = useBrowser()
  const dragRef = useRef(null)
  const regionSnapshot = useRef(region)

  // Keep snapshot current every render so onMouseDown always sees latest region
  regionSnapshot.current = region

  useEffect(() => {
    const canvas = containerRef.current
    if (!canvas) return

    function onMouseDown(e) {
      const r = regionSnapshot.current
      if (!r) return
      dragRef.current = {
        x: e.clientX,
        startRegion: { ...r },
        containerWidth: canvas.offsetWidth || canvas.clientWidth || 1,
      }
    }

    function onMouseMove(e) {
      if (!dragRef.current) return
      const dx = e.clientX - dragRef.current.x
      const { chrom, start, end } = dragRef.current.startRegion
      const bpPerPixel = (end - start) / dragRef.current.containerWidth
      const bpDelta = -dx * bpPerPixel
      navigateTo(chrom, start + bpDelta, end + bpDelta)
    }

    function onMouseUp() { dragRef.current = null }

    function onWheel(e) {
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const anchorFraction = (e.clientX - rect.left) / rect.width
      const factor = e.deltaY > 0 ? 1.4 : 0.7
      zoom(factor, anchorFraction)
    }

    canvas.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })

    return () => {
      canvas.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      canvas.removeEventListener('wheel', onWheel)
    }
  }, [zoom, navigateTo, containerRef])
}
