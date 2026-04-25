import { useEffect, useRef, useState } from 'react'

// True only for drags originating outside the browser (desktop → window).
// Internal thumbnail-reorder drags use HTML types, not 'Files'.
function hasFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false
  return Array.from(dt.types).includes('Files')
}

interface Options {
  onFiles: (files: File[]) => void
}

export function useImageFileDrop({ onFiles }: Options) {
  const [isZoneDragOver, setIsZoneDragOver] = useState(false)
  const [isPageDragOver, setIsPageDragOver] = useState(false)

  // dragenter/leave fire for each nested element; count so the overlay only
  // disappears when the drag truly leaves the window.
  const dragCounterRef = useRef(0)

  // Always call the latest onFiles without re-binding the window listeners.
  const onFilesRef = useRef(onFiles)
  useEffect(() => { onFilesRef.current = onFiles }, [onFiles])

  useEffect(() => {
    function handleDragEnter(e: DragEvent) {
      if (!hasFiles(e.dataTransfer)) return
      dragCounterRef.current++
      if (dragCounterRef.current === 1) setIsPageDragOver(true)
    }
    function handleDragLeave(e: DragEvent) {
      if (!hasFiles(e.dataTransfer)) return
      dragCounterRef.current = Math.max(0, dragCounterRef.current - 1)
      if (dragCounterRef.current === 0) setIsPageDragOver(false)
    }
    function handleDragOver(e: DragEvent) {
      if (!hasFiles(e.dataTransfer)) return
      e.preventDefault() // allow drop
    }
    function handleDrop(e: DragEvent) {
      if (!hasFiles(e.dataTransfer)) return
      e.preventDefault()
      dragCounterRef.current = 0
      setIsPageDragOver(false)
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (files.length > 0) onFilesRef.current(files)
    }
    // Capture-phase drop listener. Mirrors handleDrop's state
    // resets but does NOT call onFiles. Capture fires before any
    // descendant's bubble-phase handler runs, so cell-level drop
    // targets that call e.nativeEvent.stopPropagation() (CarryCard,
    // EmptySlot — added in 05c77f1 to avoid double-routing into
    // addFilesBatch) cannot prevent the page-level state from
    // clearing. Without this, the page overlay and the section
    // drop zone's drag-over styling stayed active indefinitely
    // after a cell-intercepted drop, because the bubble-phase
    // listener never received the event.
    function handleDropCapture(e: DragEvent) {
      if (!hasFiles(e.dataTransfer)) return
      dragCounterRef.current = 0
      setIsPageDragOver(false)
      // Defensive: in normal flow zoneProps.onDragLeave clears
      // isZoneDragOver before a cell drop lands, but a missed
      // leave (e.g. fast cursor crossings, browser quirks) would
      // leave the zone styled drag-over until the next drag.
      // Capture-phase reset closes that gap too.
      setIsZoneDragOver(false)
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        dragCounterRef.current = 0
        setIsPageDragOver(false)
      }
    }

    window.addEventListener('dragenter', handleDragEnter)
    window.addEventListener('dragleave', handleDragLeave)
    window.addEventListener('dragover', handleDragOver)
    window.addEventListener('drop', handleDropCapture, true)
    window.addEventListener('drop', handleDrop)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('dragenter', handleDragEnter)
      window.removeEventListener('dragleave', handleDragLeave)
      window.removeEventListener('dragover', handleDragOver)
      window.removeEventListener('drop', handleDropCapture, true)
      window.removeEventListener('drop', handleDrop)
      window.removeEventListener('keydown', handleKey)
    }
  }, [])

  const zoneProps = {
    onDragEnter(e: React.DragEvent) {
      if (!hasFiles(e.dataTransfer)) return
      e.preventDefault()
      setIsZoneDragOver(true)
    },
    onDragOver(e: React.DragEvent) {
      if (!hasFiles(e.dataTransfer)) return
      e.preventDefault()
    },
    onDragLeave(e: React.DragEvent) {
      if (!hasFiles(e.dataTransfer)) return
      setIsZoneDragOver(false)
    },
    onDrop(e: React.DragEvent) {
      if (!hasFiles(e.dataTransfer)) return
      e.preventDefault()
      // Stop native bubble so the window-level bubble-phase
      // handleDrop does not also fire and double-route into
      // onFiles (which would call addFilesBatch a second time
      // after this zone handler already did). Same shape as the
      // CarryCard / EmptySlot drop handlers in 05c77f1.
      // Synthetic stopPropagation kept alongside for React-tree
      // safety; the native one is what stops the window listener.
      e.stopPropagation()
      e.nativeEvent.stopPropagation()
      setIsZoneDragOver(false)
      dragCounterRef.current = 0
      setIsPageDragOver(false)
      const files = Array.from(e.dataTransfer.files)
      if (files.length > 0) onFilesRef.current(files)
    },
  }

  return { isZoneDragOver, isPageDragOver, zoneProps }
}
