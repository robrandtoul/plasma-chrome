// Change-Help-Scout modal, rendered from ProofDetailPage.
//
// Re-runs the email lookup for the proof's contact and lets the
// designer:
//   * pick a different (or the same) Help Scout conversation
//   * paste a URL manually
//   * replace the link with a documented override reason
//
// Audit log emissions cover the three transitions that matter:
//   * proof.helpscout_link_set    — null / override → link
//   * proof.helpscout_link_changed — link → different link
//   * proof.helpscout_override_set — anything → override
//
// The picker's "these aren't right" escape hatch reveals the
// override panel, same pattern as the new-proof form.

import { useEffect, useRef, useState } from 'react'
import Modal from './Modal'
import { supabase } from '../lib/supabase'
import { logAudit } from '../lib/audit'
import { parseHelpscoutUrl, MIN_OVERRIDE_REASON_LENGTH } from '../lib/helpscout'

interface HelpScoutMatch {
  id: number
  subject: string | null
  status: string | null
  modifiedAt: string | null
  url: string
  mailboxId: number | null
  mailboxName: string | null
}

export interface HelpScoutEditModalProps {
  proofId: string
  proofLabel: string
  contactEmail: string | null
  current: {
    conversationId: string | null
    conversationUrl: string | null
    overrideReason: string | null
  }
  onSaved: () => void
  onClose: () => void
}

export default function HelpScoutEditModal({
  proofId,
  proofLabel,
  contactEmail,
  current,
  onSaved,
  onClose,
}: HelpScoutEditModalProps) {
  // Draft state — mirrors the new-proof form's shape so the behaviour
  // stays consistent across the two entry points.
  const [helpscoutUrl, setHelpscoutUrl] = useState(current.conversationUrl ?? '')
  const [hsConversationId, setHsConversationId] = useState<string | null>(current.conversationId)
  const [hsLinkedSubject, setHsLinkedSubject] = useState<string | null>(
    current.conversationId ? `Conversation #${current.conversationId}` : null,
  )
  const [hsPickerMatches, setHsPickerMatches] = useState<HelpScoutMatch[]>([])
  const [hsPickerOpen, setHsPickerOpen] = useState(false)
  const [hsLookupInFlight, setHsLookupInFlight] = useState(false)
  const [hsLookupError, setHsLookupError] = useState<string | null>(null)
  const [hsLookupReturnedZero, setHsLookupReturnedZero] = useState(false)
  const [overrideReason, setOverrideReason] = useState(current.overrideReason ?? '')
  const [urlFormatError, setUrlFormatError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  // Tracks whether the current link resolution came from the designer
  // typing/pasting a URL into the input. Auto-applied lookups and
  // picker selections leave this false. Drives the audit metadata's
  // `source` field on link_set so attribution mirrors the pattern
  // PV-2026W20-001 introduced in NewProofPage.
  const [pasteWasUsed, setPasteWasUsed] = useState(false)
  const lookupRan = useRef(false)

  // Esc handling is owned by the Modal primitive; preventClose
  // wired to `saving` blocks it during an in-flight save.

  // Run a lookup on mount if we have an email — same trigger as the
  // new-proof form's contact-selection effect.
  useEffect(() => {
    if (lookupRan.current) return
    lookupRan.current = true
    if (!contactEmail) return
    void runLookup(contactEmail)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactEmail])

  async function runLookup(rawEmail: string) {
    const email = rawEmail.trim().toLowerCase()
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return
    setHsLookupError(null)
    setHsLookupInFlight(true)
    try {
      const { data, error: fnError } = await supabase.functions.invoke('match-helpscout-conversation', {
        body: { email },
      })
      if (fnError) throw new Error(fnError.message || 'Help Scout lookup failed')
      const matches: HelpScoutMatch[] = (data?.matches ?? []) as HelpScoutMatch[]
      if (matches.length === 0) {
        setHsLookupReturnedZero(true)
      } else if (matches.length === 1 && !hsConversationId) {
        // Only auto-apply if there's no current link — otherwise we'd
        // silently overwrite what the designer already had.
        applyMatch(matches[0])
      } else {
        setHsPickerMatches(matches)
        setHsPickerOpen(true)
      }
    } catch (err) {
      setHsLookupError((err as Error).message)
    } finally {
      setHsLookupInFlight(false)
    }
  }

  function applyMatch(m: HelpScoutMatch) {
    setHsConversationId(String(m.id))
    setHsLinkedSubject(m.subject ?? `Conversation #${m.id}`)
    setHelpscoutUrl(m.url)
    setHsPickerOpen(false)
    setHsPickerMatches([])
    setHsLookupReturnedZero(false)
    setOverrideReason('')
    setUrlFormatError(null)
    setPasteWasUsed(false)
  }

  function clearLink() {
    setHsConversationId(null)
    setHsLinkedSubject(null)
    setHsPickerOpen(false)
    setHsPickerMatches([])
    setPasteWasUsed(false)
  }

  function switchToOverride() {
    setHsPickerOpen(false)
    setHsPickerMatches([])
    clearLink()
    setHelpscoutUrl('')
    setHsLookupReturnedZero(true)
  }

  async function handleSave() {
    setSaveError(null)
    const typedUrl = helpscoutUrl.trim()
    const parsedUrl = typedUrl ? parseHelpscoutUrl(typedUrl) : null
    const reason = overrideReason.trim()
    if (typedUrl && !parsedUrl) {
      setSaveError('The Help Scout URL is invalid. Expected https://secure.helpscout.net/conversation/<id>.')
      return
    }
    if (!parsedUrl && reason.length < MIN_OVERRIDE_REASON_LENGTH) {
      setSaveError(`Pick a Help Scout conversation, or provide an override reason of at least ${MIN_OVERRIDE_REASON_LENGTH} characters.`)
      return
    }

    const resolvedConvoId = parsedUrl?.id ?? null
    const resolvedConvoUrl = parsedUrl?.url ?? null
    const resolvedOverride = resolvedConvoId ? null : reason

    // No-op check: if nothing actually changed, close without a
    // write or audit entry.
    const nothingChanged =
      resolvedConvoId === current.conversationId &&
      resolvedConvoUrl === current.conversationUrl &&
      resolvedOverride === (current.overrideReason ?? null)
    if (nothingChanged) {
      onClose()
      return
    }

    setSaving(true)
    try {
      const { error } = await supabase
        .from('proofs')
        .update({
          helpscout_thread_url:       resolvedConvoUrl,
          helpscout_conversation_id:  resolvedConvoId,
          helpscout_conversation_url: resolvedConvoUrl,
          helpscout_override_reason:  resolvedOverride,
        })
        .eq('id', proofId)
      if (error) throw new Error(error.message)

      // Emit the right lifecycle event for the transition that
      // happened. Priority:
      //   link → override: override_set
      //   link → different link: link_changed
      //   null/override → link: link_set
      //   anything → override: override_set
      if (resolvedConvoId) {
        if (current.conversationId && current.conversationId !== resolvedConvoId) {
          void logAudit({
            action: 'proof.helpscout_link_changed',
            targetType: 'proof',
            targetId: proofId,
            targetLabel: proofLabel,
            beforeValue: {
              helpscout_conversation_id: current.conversationId,
              helpscout_conversation_url: current.conversationUrl,
            },
            afterValue: {
              helpscout_conversation_id: resolvedConvoId,
              helpscout_conversation_url: resolvedConvoUrl,
            },
          })
        } else if (!current.conversationId) {
          void logAudit({
            action: 'proof.helpscout_link_set',
            targetType: 'proof',
            targetId: proofId,
            targetLabel: proofLabel,
            beforeValue: {
              helpscout_conversation_id: null,
              helpscout_conversation_url: null,
              helpscout_override_reason: current.overrideReason ?? null,
            },
            afterValue: {
              helpscout_conversation_id: resolvedConvoId,
              helpscout_conversation_url: resolvedConvoUrl,
            },
            metadata: {
              // Picker selections clear hsPickerMatches via
              // applyMatch before save runs, so the
              // hsPickerMatches.length>0 branch was unreachable.
              // Picker resolutions audit as 'auto', same as the
              // single-match auto-apply path.
              source: pasteWasUsed ? 'paste' : 'auto',
            },
          })
        }
        // Same id as before with no URL change falls through as a no-op.
      } else {
        // Moved to override (either from a link or from a prior
        // override with updated text).
        void logAudit({
          action: 'proof.helpscout_override_set',
          targetType: 'proof',
          targetId: proofId,
          targetLabel: proofLabel,
          beforeValue: {
            helpscout_conversation_id: current.conversationId,
            helpscout_conversation_url: current.conversationUrl,
            helpscout_override_reason: current.overrideReason ?? null,
          },
          afterValue: {
            helpscout_override_reason: resolvedOverride,
          },
        })
      }

      onSaved()
      onClose()
    } catch (e) {
      setSaveError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Modal
        open
        onClose={onClose}
        preventClose={saving}
        ariaLabelledBy="hs-edit-title"
        panelClassName="flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl"
      >
          <div className="flex items-start justify-between border-b border-gray-100 px-6 py-4">
            <div>
              <h3 id="hs-edit-title" className="text-lg font-semibold text-gray-900">Change Help Scout conversation</h3>
              <p className="mt-0.5 text-xs text-gray-500">
                {contactEmail
                  ? `Looking up conversations for ${contactEmail}.`
                  : 'No contact email on this project — paste a URL or provide a reason manually.'}
              </p>
            </div>
            <button
              onClick={onClose}
              disabled={saving}
              className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50"
              aria-label="Close"
            >
              <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
              </svg>
            </button>
          </div>

          <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
            {/* Current state */}
            <section className="rounded-lg bg-gray-50 px-4 py-3 ring-1 ring-gray-200">
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">
                Current
              </p>
              <p className="mt-1 text-sm text-gray-700">
                {current.conversationUrl ? (
                  <a href={current.conversationUrl} target="_blank" rel="noopener noreferrer" className="text-amber-800 underline">
                    {current.conversationUrl}
                  </a>
                ) : current.overrideReason ? (
                  <span className="italic text-gray-600">Override: {current.overrideReason}</span>
                ) : (
                  <span className="italic text-gray-500">Nothing recorded.</span>
                )}
              </p>
            </section>

            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-700">
                Help Scout conversation URL
              </label>
              <input
                type="url"
                value={helpscoutUrl}
                onChange={(e) => {
                  const v = e.target.value
                  setHelpscoutUrl(v)
                  setUrlFormatError(null)
                  const parsed = parseHelpscoutUrl(v)
                  if (parsed) {
                    setHsConversationId(parsed.id)
                    if (!hsLinkedSubject || hsConversationId !== parsed.id) {
                      setHsLinkedSubject(`Conversation #${parsed.id}`)
                    }
                    setHsLookupReturnedZero(false)
                    setPasteWasUsed(true)
                  } else {
                    clearLink()
                  }
                }}
                onBlur={(e) => {
                  const v = e.target.value.trim()
                  if (v && !parseHelpscoutUrl(v)) {
                    setUrlFormatError('Must be a Help Scout conversation URL like https://secure.helpscout.net/conversation/12345.')
                  }
                }}
                placeholder="https://secure.helpscout.net/conversation/…"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-[17px] sm:text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
              />
              {hsLookupInFlight && (
                <p className="mt-1.5 text-xs text-gray-400">Checking Help Scout…</p>
              )}
              {!hsLookupInFlight && hsLinkedSubject && hsConversationId && (
                <p className="mt-1.5 text-xs text-emerald-600">
                  Linked to Help Scout thread: <span className="font-medium">{hsLinkedSubject}</span>
                </p>
              )}
              {!hsLookupInFlight && hsPickerMatches.length > 1 && (
                <button
                  type="button"
                  onClick={() => setHsPickerOpen(true)}
                  className="mt-1.5 text-xs text-amber-600 underline hover:text-amber-700"
                >
                  {hsPickerMatches.length} Help Scout threads found — choose one
                </button>
              )}
              {urlFormatError && (
                <p className="mt-1.5 text-xs text-red-600">{urlFormatError}</p>
              )}
              {hsLookupError && (
                <p className="mt-1.5 text-xs text-gray-400">
                  Couldn't check Help Scout — {hsLookupError}. Paste a URL manually or provide an override reason.
                </p>
              )}
            </div>

            {hsLookupReturnedZero && !hsConversationId && (
              <div className="rounded-lg bg-amber-50 p-4 ring-1 ring-amber-100">
                <p className="text-sm font-medium text-amber-900">
                  No Help Scout conversation linked
                </p>
                <p className="mt-1 text-xs text-amber-800">
                  {contactEmail ? `No matches found for ${contactEmail}.` : ''} Paste a URL above, or provide a reason to continue without one.
                </p>
                <label className="mt-3 block text-xs font-medium text-amber-900">
                  Why is this proof not linked to a Help Scout conversation? <span className="text-red-500">*</span>
                </label>
                <textarea
                  rows={2}
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                  placeholder={`At least ${MIN_OVERRIDE_REASON_LENGTH} characters.`}
                  className="mt-1 w-full rounded-lg border border-amber-200 bg-white px-3 py-2 text-[17px] sm:text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
                />
                <p className="mt-1 text-xs text-amber-700">
                  {overrideReason.trim().length < MIN_OVERRIDE_REASON_LENGTH
                    ? `${overrideReason.trim().length} / ${MIN_OVERRIDE_REASON_LENGTH} characters`
                    : 'OK'}
                </p>
              </div>
            )}

            {saveError && (
              <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{saveError}</p>
            )}
          </div>

          <div className="flex justify-end gap-2 border-t border-gray-100 px-6 py-4">
            <button
              onClick={onClose}
              disabled={saving}
              className="rounded-lg px-4 py-2 text-sm font-medium text-gray-500 hover:bg-gray-100 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={() => void handleSave()}
              disabled={saving}
              className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-700 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
      </Modal>

      {hsPickerOpen && (
        <HelpScoutPickerInline
          matches={hsPickerMatches}
          onPick={applyMatch}
          onOverride={switchToOverride}
          onClose={() => setHsPickerOpen(false)}
        />
      )}
    </>
  )
}

// Small inline picker — same shape as the one in NewProofPage but
// kept local so the modal doesn't cross-import designer-form state.
function HelpScoutPickerInline({
  matches, onPick, onOverride, onClose,
}: {
  matches: HelpScoutMatch[]
  onPick: (m: HelpScoutMatch) => void
  onOverride: () => void
  onClose: () => void
}) {
  return (
    <Modal
      open
      onClose={onClose}
      ariaLabelledBy="hs-picker-title"
      backdropClassName="bg-black/40"
    >
          <h3 id="hs-picker-title" className="text-sm font-semibold text-gray-900">Multiple Help Scout threads found</h3>
          <p className="mt-1 text-xs text-gray-500">Pick the conversation this proof relates to.</p>
          <div className="mt-4 max-h-72 space-y-1.5 overflow-y-auto">
            {matches.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => onPick(m)}
                className="flex w-full flex-col items-start gap-0.5 rounded-lg border border-gray-200 px-3 py-2.5 text-left text-sm hover:bg-gray-50 focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
              >
                <span className="font-medium text-gray-900">{m.subject ?? `Conversation #${m.id}`}</span>
                <span className="text-xs text-gray-500">
                  <span className={m.status === 'active' ? 'font-medium text-emerald-600' : 'text-gray-500'}>
                    {m.status ?? 'unknown'}
                  </span>
                  {m.mailboxName && ` · ${m.mailboxName}`}
                  {m.modifiedAt && ` · ${new Date(m.modifiedAt).toLocaleDateString('en-GB')}`}
                </span>
              </button>
            ))}
          </div>
          <div className="mt-4 flex items-center justify-between">
            <button
              type="button"
              onClick={onOverride}
              className="text-xs text-gray-500 underline hover:text-gray-900"
            >
              These aren't right — I'll provide a reason
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-100"
            >
              Close
            </button>
          </div>
    </Modal>
  )
}
