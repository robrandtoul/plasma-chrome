import { useId, useState } from 'react'
import Modal from './Modal'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { logAudit } from '../lib/audit'
import { Field, Textarea, Input, ButtonInk, ButtonGhost } from '../design'
import {
  ANNOUNCEMENT_TONES,
  expiryFromDateInput,
  type Announcement,
  type AnnouncementTone,
} from '../lib/announcements'

// Admin-only composer for a dashboard announcement. Mirrors FeedbackModal's
// shell (Modal + segmented picker + Field-wrapped inputs + busy/error handling).
// The poster's name/initials/colour are stamped server-side by the
// announcements_set_author trigger, so the client never supplies them.

const MAX_BODY = 280

interface AnnouncementModalProps {
  onClose: () => void
  onCreated: (announcement: Announcement) => void
}

// Local "today" as YYYY-MM-DD for the date input's min (no past expiry).
function todayInputValue(): string {
  const d = new Date()
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export default function AnnouncementModal({ onClose, onCreated }: AnnouncementModalProps) {
  const titleId = useId()
  const { session } = useAuth()
  const userId = session?.user.id ?? null

  const [tone, setTone] = useState<AnnouncementTone>('info')
  const [body, setBody] = useState('')
  const [showUntil, setShowUntil] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const clean = body.trim()
    if (!clean) {
      setError('Please write a message.')
      return
    }
    if (!userId) {
      setError('You appear to be signed out — please reload and try again.')
      return
    }

    setSubmitting(true)
    const expires_at = expiryFromDateInput(showUntil)
    const { data: row, error: insErr } = await supabase
      .from('announcements')
      .insert({ created_by: userId, tone, body: clean, expires_at })
      .select('*')
      .single()

    if (insErr || !row) {
      setSubmitting(false)
      setError(insErr?.message || 'Could not post the announcement. Please try again.')
      return
    }

    void logAudit({
      action: 'announcement.created',
      targetType: 'announcement',
      targetId: (row as Announcement).id,
      targetLabel: clean.slice(0, 80),
      metadata: { tone, expires_at },
    })

    setSubmitting(false)
    onCreated(row as Announcement)
  }

  return (
    <Modal
      open
      onClose={onClose}
      preventClose={submitting}
      ariaLabelledBy={titleId}
      panelClassName="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl"
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <h3 id={titleId} className="text-lg font-semibold text-ink">
            Post an announcement
          </h3>
          <p className="mt-1 text-[13px] text-ink-mute">
            Everyone sees this on their dashboard. Set an end date and it takes itself down — or
            leave it running until you remove it.
          </p>
        </div>

        {/* Tone */}
        <div>
          <span className="eyebrow mb-1.5 block">Style</span>
          <div className="flex gap-2" role="radiogroup" aria-label="Announcement style">
            {ANNOUNCEMENT_TONES.map((t) => (
              <button
                key={t.value}
                type="button"
                role="radio"
                aria-checked={tone === t.value}
                onClick={() => setTone(t.value)}
                className={[
                  'inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-[8px] border text-[13px] font-medium transition-colors',
                  tone === t.value
                    ? 'border-brand bg-brand-50 text-ink'
                    : 'border-line bg-surface text-ink-mute hover:bg-canvas',
                ].join(' ')}
              >
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: t.accent }}
                  aria-hidden="true"
                />
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <Field label="Message" htmlFor={`${titleId}-body`}>
          <Textarea
            id={`${titleId}-body`}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            maxLength={MAX_BODY}
            placeholder="e.g. 10% off all Steel cards until Friday — mention code STEEL10 to customers."
          />
        </Field>

        <Field
          label="Show until (optional)"
          hint="Leave blank to run until you remove it."
          htmlFor={`${titleId}-until`}
        >
          <Input
            id={`${titleId}-until`}
            type="date"
            value={showUntil}
            min={todayInputValue()}
            onChange={(e) => setShowUntil(e.target.value)}
          />
        </Field>

        {error && (
          <p role="alert" className="rounded-lg bg-out-soft px-3 py-2 text-[13px] text-out">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <ButtonGhost onClick={onClose} disabled={submitting}>
            Cancel
          </ButtonGhost>
          <ButtonInk type="submit" busy={submitting}>
            Post announcement
          </ButtonInk>
        </div>
      </form>
    </Modal>
  )
}
