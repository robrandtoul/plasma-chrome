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
    const cased = titleCase(trimmed)
    // Case-insensitive dedupe. If the designer retypes an existing
    // name (whatever casing), silently drop the add and clear the
    // buffer — no error flash, feels like "already there." Matches
    // the titleCase commit convention so "otto" after "Otto" is
    // still considered a dup.
    const exists = names.some((n) => n.toLowerCase() === cased.toLowerCase())
    if (!exists) {
      onChange([...names, cased])
    }
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
      // Case-insensitive dedupe against other chips (excluding
      // the one being edited). If the edited value collides with
      // another chip, drop the duplicate by removing this chip —
      // the target already exists.
      const idx = editingIndex
      const collides = names.some((n, i) => i !== idx && n.toLowerCase() === trimmed.toLowerCase())
      if (collides) {
        removeAt(idx)
      } else {
        const next = [...names]
        // Respect the designer's explicit casing on edit — only
        // apply titleCase when the commit is identical to the
        // original (e.g. they clicked in and pressed Enter
        // without changing anything) so a deliberate "PhD" or
        // "MacLeod" doesn't get squashed.
        next[idx] = trimmed === names[idx] ? names[idx] : trimmed
        onChange(next)
      }
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
      className="flex min-h-[2.5rem] cursor-text flex-wrap items-center gap-1.5 rounded border border-line bg-surface px-2 py-1.5 text-sm focus-within:border-brand focus-within:ring-1 focus-within:ring-brand"
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
              className="min-w-[6rem] rounded border border-line bg-surface px-1.5 py-0.5 text-[17px] sm:text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
            />
          )
        }
        return (
          <span
            key={i}
            className="inline-flex items-center gap-1 rounded bg-canvas px-2 py-0.5 text-sm text-ink-soft hover:bg-line"
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
              className="text-ink-dim hover:text-ink-soft"
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
