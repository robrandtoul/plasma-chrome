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
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        dragCounterRef.current = 0
        setIsPageDragOver(false)
      }
    }

    window.addEventListener('dragenter', handleDragEnter)
    window.addEventListener('dragleave', handleDragLeave)
    window.addEventListener('dragover', handleDragOver)
    window.addEventListener('drop', handleDrop)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('dragenter', handleDragEnter)
      window.removeEventListener('dragleave', handleDragLeave)
      window.removeEventListener('dragover', handleDragOver)
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
      e.stopPropagation() // prevent the window drop from also handling these files
      setIsZoneDragOver(false)
      dragCounterRef.current = 0
      setIsPageDragOver(false)
      const files = Array.from(e.dataTransfer.files)
      if (files.length > 0) onFilesRef.current(files)
    },
  }

  return { isZoneDragOver, isPageDragOver, zoneProps }
}
