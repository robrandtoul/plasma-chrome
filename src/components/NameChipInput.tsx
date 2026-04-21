// Chip input for the "Names on this order" field on the new- and
// edit-version forms. Backs the proof_versions.names text[] column.
//
// Behaviour:
//   * Empty list is valid — submit isn't blocked.
//   * Enter or comma commits the current buffer as a chip; the
//     string is run through titleCase on commit so HS-casing
//     ("ALICE SMITH") comes out tidy. The designer can always
//     re-edit the chip to override.
//   * Backspace in an empty buffer removes the last chip.
//   * Click a chip to edit in place. Enter or blur commits.
//     Escape cancels and restores the previous value.
//   * No reorder UI in this version — keeps scope tight. The
//     designer can remove and re-type.
//
// The parent owns the names[] state; this component just renders
// a controlled view of it.

import { useRef, useState, type KeyboardEvent } from 'react'
import { titleCase } from '../lib/titleCase'

interface Props {
  names: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  ariaLabel?: string
}

export default function NameChipInput({
  names,
  onChange,
  placeholder = 'Press Enter after each name',
  ariaLabel = 'Names',
}: Props) {
  const [buffer, setBuffer] = useState('')
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [editingDraft, setEditingDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const editRef = useRef<HTMLInputElement>(null)

  function commitBuffer() {
    const trimmed = buffer.trim()
    if (!trimmed) return
    onChange([...names, titleCase(trimmed)])
    setBuffer('')
  }

  function handleBufferKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      commitBuffer()
      return
    }
    if (e.key === 'Backspace' && buffer === '' && names.length > 0) {
      e.preventDefault()
      onChange(names.slice(0, -1))
    }
  }

  function removeAt(i: number) {
    onChange([...names.slice(0, i), ...names.slice(i + 1)])
  }

  function startEditing(i: number) {
    setEditingIndex(i)
    setEditingDraft(names[i])
    // Focus on next frame so the ref is mounted.
    requestAnimationFrame(() => editRef.current?.focus())
  }

  function commitEdit() {
    if (editingIndex == null) return
    const trimmed = editingDraft.trim()
    if (!trimmed) {
      // Clearing a chip via edit removes it.
      removeAt(editingIndex)
    } else {
      const next = [...names]
      // Respect the designer's explicit casing on edit — only apply
      // titleCase when the commit is identical to the original
      // (e.g. they clicked in and pressed Enter without changing
      // anything) so a deliberate "PhD" or "MacLeod" doesn't get
      // squashed.
      next[editingIndex] = trimmed === names[editingIndex] ? names[editingIndex] : trimmed
      onChange(next)
    }
    setEditingIndex(null)
    setEditingDraft('')
  }

  function cancelEdit() {
    setEditingIndex(null)
    setEditingDraft('')
  }

  return (
    <div
      onClick={() => { if (editingIndex == null) inputRef.current?.focus() }}
      className="flex min-h-[2.5rem] cursor-text flex-wrap items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm focus-within:border-gray-900 focus-within:ring-1 focus-within:ring-gray-900"
      role="group"
      aria-label={ariaLabel}
    >
      {names.map((name, i) => {
        if (editingIndex === i) {
          return (
            <input
              key={i}
              ref={editRef}
              type="text"
              value={editingDraft}
              onChange={(e) => setEditingDraft(e.target.value)}
              onBlur={commitEdit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commitEdit() }
                if (e.key === 'Escape') { e.preventDefault(); cancelEdit() }
              }}
              className="min-w-[6rem] rounded border border-gray-300 bg-white px-1.5 py-0.5 text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
            />
          )
        }
        return (
          <span
            key={i}
            className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-sm text-gray-700 hover:bg-gray-200"
          >
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); startEditing(i) }}
              className="focus:outline-none"
              title="Click to edit"
            >
              {name}
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); removeAt(i) }}
              aria-label={`Remove ${name}`}
              className="text-gray-400 hover:text-gray-700"
            >
              ×
            </button>
          </span>
        )
      })}
      <input
        ref={inputRef}
        type="text"
        value={buffer}
        onChange={(e) => setBuffer(e.target.value)}
        onKeyDown={handleBufferKey}
        onBlur={commitBuffer}
        placeholder={names.length === 0 ? placeholder : ''}
        className="min-w-[10rem] flex-1 border-0 bg-transparent px-1 py-0.5 text-sm focus:outline-none focus:ring-0"
      />
    </div>
  )
}
