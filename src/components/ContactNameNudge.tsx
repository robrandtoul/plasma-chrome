// A soft, non-blocking prompt shown when a contact is stored with only a first
// name — and, where we can work out the full name, a one-click fix.
//
// Deliberately quiet. It never blocks a save and disappears the moment the name
// has a surname. Some customers only ever give us a first name, so a designer
// who ignores this every time is not doing anything wrong; the prompt exists
// for the times a surname IS knowable and nobody noticed.
//
// Two shapes, chosen by `allowEdit`:
//
//   * Staging (the new-contact form, the admin contact editor) — `onApply`
//     writes into a text field the designer already has in front of them, so
//     the prompt only needs to offer the suggestion. They can correct it in
//     that field before saving.
//
//   * Editing (the selected-contact pill) — there is no text field, and
//     `onApply` writes straight to the customer record. So this shape offers an
//     inline box: accept the suggestion as-is, adjust it first, or type a
//     surname when we have nothing to suggest. Without that box the only
//     affordance was a blind commit of a value the matcher deliberately passes
//     through un-tidied (Help Scout sometimes holds "Andrea Egidio Marazzi -
//     Beyond Group"), and a non-admin designer has no route to fix a customer
//     record afterwards — the contact editor lives behind RequireAdmin.
//
// `warnWithoutSuggestion` controls whether we speak up when we have nothing to
// propose. It should be on wherever the designer can act. The paste flow is the
// clearest case: they have the Help Scout thread open and can often read the
// surname straight off the customer's signature, and every one of the contacts
// that prompted this feature resolves to an existing row — i.e. to the pill.

import { useState } from 'react'
import { isFirstNameOnly, suggestContactName } from '../lib/contactNames'

export default function ContactNameNudge({
  fullName,
  email,
  helpscoutName = null,
  onApply,
  warnWithoutSuggestion = false,
  allowEdit = false,
  busy = false,
  error = null,
}: {
  fullName: string
  email: string
  /** The name Help Scout holds for this customer, when we've just looked it up. */
  helpscoutName?: string | null
  onApply: (name: string) => void
  warnWithoutSuggestion?: boolean
  /** Offer an inline field. Use where onApply persists rather than stages. */
  allowEdit?: boolean
  busy?: boolean
  error?: string | null
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  // Hooks must run before any early return, so the visibility test lives here.
  const suggestion = suggestContactName(fullName, email, helpscoutName)
  const visible = isFirstNameOnly(fullName) && (suggestion !== null || warnWithoutSuggestion)
  if (!visible) return null

  const startEditing = () => {
    setDraft(suggestion ? suggestion.name : `${fullName.trim()} `)
    setEditing(true)
  }

  const commit = () => {
    const next = draft.trim().replace(/\s+/g, ' ')
    if (!next || next === fullName.trim()) return
    setEditing(false)
    onApply(next)
  }

  return (
    <div className="mt-2 rounded-lg bg-low-soft px-3 py-2.5 text-xs text-ink-soft">
      {editing ? (
        <>
          <label className="block font-medium text-ink">Full name</label>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={draft}
              autoFocus
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commit() }
                if (e.key === 'Escape') { e.preventDefault(); setEditing(false) }
              }}
              className="min-w-0 flex-1 rounded border border-low bg-white px-2 py-1 text-xs text-ink focus:outline-none focus:ring-1 focus:ring-[var(--c-focus)]"
            />
            <button
              type="button"
              onClick={commit}
              disabled={busy || !draft.trim() || draft.trim() === fullName.trim()}
              className="rounded border border-low bg-white px-2 py-1 text-[11px] font-semibold text-ink hover:bg-canvas disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={busy}
              className="text-[11px] font-medium text-ink-mute hover:text-ink disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </>
      ) : suggestion ? (
        <>
          <p>
            This looks like a first name only.{' '}
            {suggestion.source === 'helpscout'
              ? 'Help Scout has a fuller name for them:'
              : 'Their email address suggests:'}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <span className="font-semibold text-ink">{suggestion.name}</span>
            <button
              type="button"
              onClick={() => onApply(suggestion.name)}
              disabled={busy}
              className="rounded border border-low bg-white px-2 py-1 text-[11px] font-semibold text-ink hover:bg-canvas disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Use this name'}
            </button>
            {allowEdit && (
              <button
                type="button"
                onClick={startEditing}
                disabled={busy}
                className="text-[11px] font-medium text-ink-mute underline hover:text-ink disabled:opacity-50"
              >
                Edit first
              </button>
            )}
          </div>
          {suggestion.source === 'email' && (
            <p className="mt-1.5 text-ink-mute">
              Worth a glance — this is read from the email address, so it can be wrong.
            </p>
          )}
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <p>This looks like a first name only.</p>
          {allowEdit ? (
            <button
              type="button"
              onClick={startEditing}
              disabled={busy}
              className="rounded border border-low bg-white px-2 py-1 text-[11px] font-semibold text-ink hover:bg-canvas disabled:opacity-50"
            >
              Add surname
            </button>
          ) : (
            <span className="text-ink-mute">Add a surname if you know it.</span>
          )}
        </div>
      )}
      {error && <p className="mt-1.5 font-medium text-out">{error}</p>}
    </div>
  )
}
