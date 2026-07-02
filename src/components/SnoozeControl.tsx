import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Clock } from 'lucide-react'
import { snoozeProof, unsnoozeProof } from '../lib/snooze'
import { formatAbsoluteDateTime } from '../lib/relativeTime'
import type { NeedsAttentionRule } from '../lib/dashboardGrouping'

// Snooze / unsnooze control for the proof detail page. Self-contained: it does
// its own DB writes via the shared snoozeProof / unsnoozeProof helpers and
// calls onChange so the parent can refresh. The popover mirrors the dashboard's
// SnoozeButton (preset durations, custom date, optional note) but collapses the
// dashboard's four style variants into the single button used here, and folds
// the unsnooze path in so a snoozed proof can be woken from the same control.
//
// Renders nothing when there's neither an active snooze to clear nor a firing
// rule to snooze — so the caller can drop it in unconditionally next to the
// status pill and let it decide whether it has anything to offer.

interface SnoozeControlProps {
  proofId: string
  /** The currently-firing needs-attention rule to snooze against (null = none). */
  ruleCode: NeedsAttentionRule | null
  /** Active snooze end time (null / in the past = not currently snoozed). */
  snoozedUntil: string | null
  /** The rule the active snooze row was written against — needed to clear it. */
  snoozeRuleCode: NeedsAttentionRule | null
  /** Note stored with the active snooze, shown in the snoozed popover. */
  snoozeNote?: string | null
  /** Called after a successful snooze / unsnooze so the parent can refresh. */
  onChange: () => void
}

const PRESETS = [
  { label: '24 hours', hours: 24 },
  { label: '48 hours', hours: 48 },
  { label: '1 week',   hours: 168 },
  { label: '2 weeks',  hours: 336 },
  { label: '1 month',  hours: 720 },
] as const

// Minimum date (tomorrow, YYYY-MM-DD) for the custom-date input.
function minDate() {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return d.toISOString().slice(0, 10)
}

// Convert a YYYY-MM-DD date into hours from now until the end of that day, so
// "snooze until Friday" means the proof reappears first thing on Saturday.
function hoursUntilEndOfDate(dateStr: string): number {
  const target = new Date(dateStr)
  target.setDate(target.getDate() + 1)
  target.setHours(0, 0, 0, 0)
  return Math.max(1, Math.ceil((target.getTime() - Date.now()) / 3_600_000))
}

export default function SnoozeControl({
  proofId,
  ruleCode,
  snoozedUntil,
  snoozeRuleCode,
  snoozeNote,
  onChange,
}: SnoozeControlProps) {
  const isSnoozed =
    !!snoozedUntil && !!snoozeRuleCode && new Date(snoozedUntil).getTime() > Date.now()

  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [customMode, setCustomMode] = useState(false)
  const [customDate, setCustomDate] = useState('')
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  // Shared dismissal path — every close drops the popover back to a clean
  // state so reopening never surfaces a stale half-typed note or custom date.
  function resetState() {
    setOpen(false)
    setNote('')
    setCustomMode(false)
    setCustomDate('')
  }

  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent) {
      // The popover is portalled to <body>, so the click-outside test has to
      // exclude both the trigger and the portalled popover.
      const t = e.target as Node
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return
      resetState()
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') resetState()
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  async function handleSnooze(hours: number) {
    if (!ruleCode || saving) return
    setSaving(true)
    try {
      await snoozeProof(proofId, ruleCode, hours, note, 'detail_page')
      resetState()
      onChange()
    } catch (err) {
      console.error('[SnoozeControl] snooze failed:', err)
    } finally {
      setSaving(false)
    }
  }

  async function handleUnsnooze() {
    if (!snoozeRuleCode || saving) return
    setSaving(true)
    try {
      await unsnoozeProof(proofId, snoozeRuleCode)
      resetState()
      onChange()
    } catch (err) {
      console.error('[SnoozeControl] unsnooze failed:', err)
    } finally {
      setSaving(false)
    }
  }

  // Nothing to offer: not snoozed and no active rule to snooze against.
  if (!isSnoozed && !ruleCode) return null

  // Position the popover via a fixed-position portal so it escapes any parent
  // overflow / stacking context, left-aligned under the trigger and clamped
  // on-screen (mirrors the dashboard SnoozeButton's portal).
  const POPOVER_W = 224
  const POPOVER_H_GUESS = 320
  const popPos = open && btnRef.current
    ? (() => {
        const r = btnRef.current!.getBoundingClientRect()
        const left = Math.max(16, Math.min(r.left, window.innerWidth - POPOVER_W - 16))
        const top = Math.max(16, Math.min(r.bottom + 4, window.innerHeight - POPOVER_H_GUESS - 16))
        return { left, top, width: POPOVER_W }
      })()
    : null

  return (
    <div className="relative inline-flex">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={isSnoozed ? 'Snoozed — click to manage' : 'Snooze this alert'}
        aria-label={isSnoozed ? 'Manage snooze' : 'Snooze this alert'}
        className={[
          'inline-flex h-6 items-center gap-1 rounded px-2 text-[12px] transition-colors',
          isSnoozed
            ? 'bg-canvas text-ink-soft hover:bg-line-soft'
            : 'text-ink-mute hover:bg-canvas hover:text-ink',
        ].join(' ')}
      >
        <Clock size={13} aria-hidden="true" />
        {isSnoozed
          ? `Snoozed until ${new Date(snoozedUntil!).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
          : 'Snooze'}
      </button>
      {open && popPos && createPortal(
        <div
          role="dialog"
          ref={popRef}
          aria-label="Snooze options"
          style={popPos}
          className="fixed z-[90] overflow-hidden rounded-[10px] bg-surface py-2 shadow-md border border-line"
        >
          {isSnoozed ? (
            /* ── Snoozed: show when + note, offer to wake now ── */
            <div className="px-3 py-1">
              <p className="mb-1 eyebrow text-ink-mute">Snoozed</p>
              <p className="text-sm text-ink-soft">Until {formatAbsoluteDateTime(snoozedUntil!)}</p>
              {snoozeNote && <p className="mt-1 text-xs text-ink-mute">“{snoozeNote}”</p>}
              <button
                type="button"
                disabled={saving}
                onClick={handleUnsnooze}
                className="mt-2 w-full rounded bg-ink px-3 py-1.5 text-sm font-medium text-on-ink hover:opacity-90 disabled:opacity-40"
              >{saving ? 'Working…' : 'Unsnooze now'}</button>
            </div>
          ) : customMode ? (
            /* ── Custom date picker ── */
            <div className="px-3 py-2">
              <p className="mb-2 eyebrow text-ink-mute">Snooze until</p>
              <input
                type="date"
                min={minDate()}
                value={customDate}
                onChange={(e) => setCustomDate(e.target.value)}
                className="w-full rounded border border-line px-2 py-1.5 text-sm text-ink-soft focus:border-[var(--c-brand)] focus:outline-none focus:outline-2 focus:outline-offset-[-1px] focus:outline-[var(--c-brand)]"
              />
              <button
                type="button"
                disabled={saving || !customDate}
                onClick={() => handleSnooze(hoursUntilEndOfDate(customDate))}
                className="mt-2 w-full rounded bg-ink px-3 py-1.5 text-sm font-medium text-on-ink hover:opacity-90 disabled:opacity-40"
              >{saving ? 'Saving…' : 'Snooze'}</button>
              <button
                type="button"
                onClick={() => { setCustomMode(false); setCustomDate('') }}
                className="mt-1 w-full py-1 text-xs text-ink-mute hover:text-ink-soft"
              >← Back</button>
            </div>
          ) : (
            /* ── Preset list ── */
            <>
              <p className="px-3 pb-1.5 eyebrow text-ink-mute">Snooze for</p>
              {PRESETS.map(({ label, hours }) => (
                <button
                  key={hours}
                  type="button"
                  disabled={saving}
                  onClick={() => handleSnooze(hours)}
                  className="w-full px-3 py-2 text-left text-sm text-ink-soft hover:bg-canvas disabled:opacity-50"
                >{label}</button>
              ))}
              <button
                type="button"
                disabled={saving}
                onClick={() => setCustomMode(true)}
                className="w-full px-3 py-2 text-left text-sm text-ink-soft hover:bg-canvas disabled:opacity-50"
              >Custom date…</button>
            </>
          )}
          {/* Note + cancel — shown in the snooze-picking modes only. */}
          {!isSnoozed && (
            <div className="mt-1 border-t border-line-soft px-3 pt-2">
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Add a note (optional)"
                rows={2}
                className="w-full resize-none rounded border border-line px-2 py-1.5 text-xs text-ink-soft placeholder:text-ink-dim focus:border-[var(--c-brand)] focus:outline-none focus:outline-2 focus:outline-offset-[-1px] focus:outline-[var(--c-brand)]"
              />
              <button
                type="button"
                onClick={resetState}
                className="mt-1 w-full py-1 text-xs text-ink-mute hover:text-ink-soft"
              >Cancel</button>
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  )
}
