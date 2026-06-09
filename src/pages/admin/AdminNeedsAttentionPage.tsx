import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { logAudit } from '../../lib/audit'

// ── Types ────────────────────────────────────────────────────────────────────

type RuleCode =
  | 'request_changes_no_version'
  | 'helpscout_follow_up_tag'
  | 'sent_never_viewed'
  | 'viewed_not_actioned'
  | 'approaching_dormant'
  | 'stuck_in_progress'

interface Rule {
  enabled: boolean
  threshold_days?: number
  calendar?: boolean
  priority: number
}

type Rules = Record<RuleCode, Rule>

interface RuleSpec {
  code: RuleCode
  label: string
  description: string
  hasThreshold: boolean
  /** Whether the rule supports a calendar/working-days toggle. */
  hasCalendarToggle: boolean
}

const RULE_SPECS: RuleSpec[] = [
  {
    code: 'request_changes_no_version',
    label: 'Customer requested changes, no new version',
    description: 'Fires when the latest customer event on the current version was a change request and no newer version has been shipped since.',
    hasThreshold: true,
    hasCalendarToggle: true,
  },
  {
    code: 'helpscout_follow_up_tag',
    label: 'Help Scout "follow up" tag',
    description: 'Fires when the linked Help Scout conversation carries the "follow up" tag. Will start firing once Phase 2b wires the HS → DB tag sync.',
    hasThreshold: false,
    hasCalendarToggle: false,
  },
  {
    code: 'sent_never_viewed',
    label: 'Sent but never opened',
    description: 'Fires when a proof has been in_progress for the threshold and the customer has never viewed the current version (non-bot).',
    hasThreshold: true,
    hasCalendarToggle: true,
  },
  {
    code: 'viewed_not_actioned',
    label: 'Viewed but not actioned',
    description: 'Fires when the customer viewed the current version but has not approved or requested changes within the threshold.',
    hasThreshold: true,
    hasCalendarToggle: true,
  },
  {
    code: 'approaching_dormant',
    label: 'Approaching dormant',
    description: 'Fires when last activity is within N days of the dormant cutoff (set above). Calendar days only — gives you a window to ping the customer before the auto-mark kicks in.',
    hasThreshold: true,
    // Approaching-dormant fires against the calendar dormant cutoff,
    // so the working-vs-calendar toggle would be meaningless here.
    hasCalendarToggle: false,
  },
  {
    code: 'stuck_in_progress',
    label: 'Stuck in progress',
    description: 'Fires when an in_progress proof has had no events or views for the threshold period — the catch-all backstop.',
    hasThreshold: true,
    hasCalendarToggle: true,
  },
]

const DEFAULT_RULES: Rules = {
  request_changes_no_version: { enabled: true,  threshold_days: 2,  calendar: false, priority: 1 },
  // helpscout_follow_up_tag defaults to disabled until Phase 2b ships
  // the HS-tag sync that populates proofs.helpscout_tags. Re-enable in
  // the same PR that wires the sync; threshold and priority stay set
  // so flipping the boolean is the only change needed (PV-2026W21-043).
  helpscout_follow_up_tag:    { enabled: false,                                         priority: 2 },
  sent_never_viewed:          { enabled: true,  threshold_days: 3,  calendar: false, priority: 3 },
  viewed_not_actioned:        { enabled: true,  threshold_days: 5,  calendar: false, priority: 4 },
  approaching_dormant:        { enabled: true,  threshold_days: 5,  calendar: true,  priority: 5 },
  stuck_in_progress:          { enabled: true,  threshold_days: 10, calendar: false, priority: 6 },
}

// Days of inactivity before the nightly cron flips an in_progress proof
// to dormant. Stored in its own site_settings column (migration 000209),
// read here alongside the rules. The "Approaching dormant" rule above
// counts its threshold back from this number.
const DEFAULT_DORMANCY_CUTOFF = 90

// ── Page ─────────────────────────────────────────────────────────────────────

export default function AdminNeedsAttentionPage() {
  const [savedRules, setSavedRules] = useState<Rules | null>(null)
  const [draft, setDraft]           = useState<Rules | null>(null)
  // Dormant cutoff lives in its own column, edited beside the rules.
  const [savedCutoff, setSavedCutoff] = useState<number>(DEFAULT_DORMANCY_CUTOFF)
  const [draftCutoff, setDraftCutoff] = useState<number>(DEFAULT_DORMANCY_CUTOFF)
  // The order designers see in the UI. Initialised from the saved
  // priority field, then mutated by drag-and-drop. Saving rewrites
  // the priority field on each rule to (1-indexed position).
  const [order, setOrder]           = useState<RuleCode[]>([])
  const [loadError, setLoadError]   = useState<string | null>(null)
  const [saving, setSaving]         = useState(false)
  const [savedAt, setSavedAt]       = useState<number | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  // Drag-state tracker. dragKey is the rule_code currently being
  // dragged; null when idle.
  const dragKey = useRef<RuleCode | null>(null)

  useEffect(() => { void load() }, [])

  async function load() {
    const { data, error } = await supabase
      .from('site_settings')
      .select('needs_attention_rules, dormancy_threshold_days')
      .eq('id', 1)
      .single()
    if (error || !data) { setLoadError(error?.message ?? 'site_settings row missing'); return }
    const rules = (data.needs_attention_rules ?? DEFAULT_RULES) as Rules
    const cutoff = (data.dormancy_threshold_days ?? DEFAULT_DORMANCY_CUTOFF) as number
    setSavedRules(rules)
    setDraft(rules)
    setOrder(orderFromPriority(rules))
    setSavedCutoff(cutoff)
    setDraftCutoff(cutoff)
  }

  function orderFromPriority(rules: Rules): RuleCode[] {
    return [...RULE_SPECS]
      .map((s) => s.code)
      .sort((a, b) => (rules[a]?.priority ?? 99) - (rules[b]?.priority ?? 99))
  }

  // True when draft differs from savedRules in any way that should be
  // persisted (rule fields or order).
  const dirty = useMemo(() => {
    if (!draft || !savedRules) return false
    if (draftCutoff !== savedCutoff) return true
    if (JSON.stringify(orderFromPriority(savedRules)) !== JSON.stringify(order)) return true
    for (const code of RULE_SPECS.map((s) => s.code)) {
      const a = draft[code]
      const b = savedRules[code]
      if (JSON.stringify({ ...a, priority: undefined }) !== JSON.stringify({ ...b, priority: undefined })) {
        return true
      }
    }
    return false
  }, [draft, savedRules, order, draftCutoff, savedCutoff])

  function patchRule<K extends keyof Rule>(code: RuleCode, key: K, value: Rule[K]) {
    setDraft((d) => d ? { ...d, [code]: { ...d[code], [key]: value } } : d)
  }

  function onDragStart(code: RuleCode) {
    dragKey.current = code
  }
  function onDragOver(e: React.DragEvent, target: RuleCode) {
    e.preventDefault()
    const src = dragKey.current
    if (!src || src === target) return
    setOrder((curr) => {
      const next = [...curr]
      const from = next.indexOf(src)
      const to = next.indexOf(target)
      if (from < 0 || to < 0) return curr
      next.splice(from, 1)
      next.splice(to, 0, src)
      return next
    })
  }
  function onDragEnd() {
    dragKey.current = null
  }

  async function save() {
    if (!draft || !savedRules) return
    setSaving(true)
    // Re-derive priority from current display order so saves always
    // produce a contiguous 1..N priority sequence.
    const next: Rules = { ...draft }
    order.forEach((code, i) => { next[code] = { ...next[code], priority: i + 1 } })

    const { error } = await supabase
      .from('site_settings')
      .update({ needs_attention_rules: next, dormancy_threshold_days: draftCutoff })
      .eq('id', 1)

    setSaving(false)
    if (error) {
      setLoadError(`Save failed: ${error.message}`)
      return
    }

    void logAudit({
      action: 'setting.needs_attention_rules_updated',
      targetType: 'setting',
      targetId: 'needs_attention_rules',
      targetLabel: 'Needs-attention rules',
      beforeValue: { rules: savedRules, dormancy_threshold_days: savedCutoff },
      afterValue: { rules: next, dormancy_threshold_days: draftCutoff },
    })

    setSavedRules(next)
    setDraft(next)
    setSavedCutoff(draftCutoff)
    setSavedAt(Date.now())
  }

  async function resetToDefaults() {
    setConfirmReset(false)
    // Merge defaults OVER the saved object rather than replacing it, so
    // non-rule scalar keys stored alongside the six rules in the
    // needs_attention_rules JSONB survive a reset+save. Today that's
    // helpscout_reply_grace_days (000208); DEFAULT_RULES spread last
    // still resets all six rule objects to their defaults (PV-2026W22-239).
    setDraft({ ...(savedRules ?? {}), ...DEFAULT_RULES })
    setOrder(orderFromPriority(DEFAULT_RULES))
    setDraftCutoff(DEFAULT_DORMANCY_CUTOFF)
    // Don't auto-save — leave the diff visible so the admin still has
    // to click Save. Matches Bob-rule-of-least-surprise: reset
    // populates the form, the user commits.
  }

  // Force a re-render of the "saved Xm ago" line at a low cadence so
  // the wording stays current without a per-second tick.
  const [, setTick] = useState(0)
  useEffect(() => {
    const i = setInterval(() => setTick((n) => n + 1), 30_000)
    return () => clearInterval(i)
  }, [])

  if (loadError) {
    return (
      <div className="rounded-2xl bg-out-soft p-6 text-sm text-out ring-1 ring-out">
        Failed to load Needs-attention rules: {loadError}
      </div>
    )
  }
  if (!draft) {
    return (
      <div className="flex justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-gray-900" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-ink">Needs-attention rules</h2>
          <p className="mt-1 text-sm text-ink-mute">
            Configure which projects show up in the Needs-attention tile on the designer dashboard. Drag to reorder priority — the highest-priority rule that fires on a project is the one whose chip the dashboard shows.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {savedAt && !dirty && (
            <span className="text-xs text-in-stock">{savedLabel(savedAt)}</span>
          )}
          <button
            type="button"
            disabled={!dirty || saving}
            onClick={save}
            className={[
              'rounded px-4 py-2 text-sm font-semibold',
              dirty && !saving
                ? 'bg-ink text-on-ink hover:opacity-90'
                : 'bg-line text-ink-dim cursor-not-allowed',
            ].join(' ')}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-line">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-ink">Dormant cutoff</h3>
          <p className="mt-1 text-xs text-ink-mute">
            A project with no activity for this many calendar days is automatically marked <span className="font-medium">dormant</span> by the nightly job. The “Approaching dormant” rule below counts its threshold back from this number.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <input
            type="number"
            min={1}
            step={1}
            value={draftCutoff}
            onChange={(e) => {
              const n = Number(e.target.value)
              setDraftCutoff(Number.isFinite(n) ? Math.max(1, Math.floor(n)) : DEFAULT_DORMANCY_CUTOFF)
            }}
            className="w-20 rounded border border-line px-2 py-1 text-sm focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none"
          />
          <span className="text-xs text-ink-mute">days</span>
        </div>
      </div>

      <div className="space-y-3">
        {order.map((code, i) => {
          const spec = RULE_SPECS.find((r) => r.code === code)!
          const rule = draft[code]
          return (
            <div
              key={code}
              draggable
              onDragStart={() => onDragStart(code)}
              onDragOver={(e) => onDragOver(e, code)}
              onDragEnd={onDragEnd}
              className="flex gap-4 rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-line"
            >
              {/* Drag handle. Lives on the rule card so the whole
                  card is the drag target — keeps the keyboard /
                  pointer affordances simple. */}
              <div className="flex shrink-0 flex-col items-center gap-1">
                <span
                  aria-label="Drag to reorder"
                  title="Drag to reorder"
                  className="cursor-grab text-ink-dim active:cursor-grabbing"
                >
                  <svg viewBox="0 0 16 16" className="h-5 w-5" fill="currentColor">
                    <circle cx="5" cy="3" r="1.25" /><circle cx="5" cy="8" r="1.25" /><circle cx="5" cy="13" r="1.25" />
                    <circle cx="11" cy="3" r="1.25" /><circle cx="11" cy="8" r="1.25" /><circle cx="11" cy="13" r="1.25" />
                  </svg>
                </span>
                <span className="text-xs font-semibold text-ink-dim tabular-nums">{i + 1}</span>
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-ink">{spec.label}</h3>
                    <p className="mt-1 text-xs text-ink-mute">{spec.description}</p>
                  </div>
                  <Toggle
                    value={rule.enabled}
                    onChange={(v) => patchRule(code, 'enabled', v)}
                    label={`${spec.label} enabled`}
                  />
                </div>

                {(spec.hasThreshold || spec.hasCalendarToggle) && (
                  <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3">
                    {spec.hasThreshold && (
                      <div className="flex items-center gap-2">
                        <label className="text-xs font-medium uppercase tracking-wider text-ink-mute">Threshold</label>
                        <input
                          type="number"
                          min={0}
                          step={1}
                          value={rule.threshold_days ?? 0}
                          onChange={(e) => {
                            const n = Number(e.target.value)
                            patchRule(code, 'threshold_days', Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0)
                          }}
                          className="w-20 rounded border border-line px-2 py-1 text-sm focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none"
                        />
                        <span className="text-xs text-ink-mute">days</span>
                      </div>
                    )}
                    {spec.hasCalendarToggle && (
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium uppercase tracking-wider text-ink-mute">Counts</span>
                        <Segmented
                          value={rule.calendar ? 'calendar' : 'working'}
                          options={[
                            { value: 'working',  label: 'Working days' },
                            { value: 'calendar', label: 'Calendar days' },
                          ]}
                          onChange={(v) => patchRule(code, 'calendar', v === 'calendar')}
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <div className="flex justify-end pt-2">
        {confirmReset ? (
          <div className="flex items-center gap-3 rounded-lg bg-low-soft px-3 py-2 text-xs text-low ring-1 ring-low">
            <span>Replace all rules with defaults?</span>
            <button
              type="button"
              onClick={() => void resetToDefaults()}
              className="rounded bg-low px-2 py-1 text-xs font-semibold text-on-ink hover:opacity-90"
            >Reset</button>
            <button
              type="button"
              onClick={() => setConfirmReset(false)}
              className="text-xs text-low underline"
            >Cancel</button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmReset(true)}
            className="text-xs text-ink-mute underline underline-offset-2 hover:text-ink"
          >
            Reset to defaults
          </button>
        )}
      </div>
    </div>
  )
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function savedLabel(ts: number): string {
  const diffSec = Math.floor((Date.now() - ts) / 1000)
  if (diffSec < 5)   return 'Saved just now'
  if (diffSec < 60)  return `Saved ${diffSec}s ago`
  const min = Math.floor(diffSec / 60)
  if (min < 60)      return `Saved ${min} minute${min === 1 ? '' : 's'} ago`
  const hr = Math.floor(min / 60)
  return `Saved ${hr} hour${hr === 1 ? '' : 's'} ago`
}

// Local Toggle copy of the AdminSettingsPage primitive — same look,
// pulled in here rather than refactored shared because the admin
// pages have been deliberately keeping their own primitives lightly
// duplicated (see AdminTemplatesSection, AdminSettingsPage). Shared
// component pass is a separate cleanup.
function Toggle({ value, onChange, label }: {
  value: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={label}
      onClick={() => onChange(!value)}
      className={[
        'relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors',
        value ? 'bg-ink' : 'bg-line',
      ].join(' ')}
    >
      <span
        className={[
          'inline-block h-5 w-5 translate-y-0.5 transform rounded-full bg-surface transition-transform',
          value ? 'translate-x-[1.375rem]' : 'translate-x-0.5',
        ].join(' ')}
      />
    </button>
  )
}

function Segmented<T extends string>({
  options, value, onChange,
}: {
  options: Array<{ value: T; label: string }>
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="flex rounded-lg border border-line bg-surface p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={[
            'rounded px-3 py-1 text-xs font-medium transition-colors',
            value === o.value ? 'bg-canvas text-ink' : 'text-ink-mute hover:text-ink',
          ].join(' ')}
        >{o.label}</button>
      ))}
    </div>
  )
}
