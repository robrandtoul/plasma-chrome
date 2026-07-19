import { useCallback, useEffect, useState } from 'react'
import { Bell, Smartphone, Trash2 } from 'lucide-react'
import { DesignerChrome, PanelShell } from '../design'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import EnableNotificationsCard from '../components/EnableNotificationsCard'
import { disablePushOnThisDevice } from '../lib/push'

// Per-account notification preferences. Lives outside /admin so every designer
// (not just admins) controls their own. The per-event grammar matches the
// send-push resolver exactly: 'on' | 'off' | 'own_projects', plus a top-level
// "_muted" pause-everything flag. Order events use a 2-way Off/On (the default
// is decided by the fulfilment list server-side); proof events use a 3-way
// Off / My projects / Every project.

type PrefValue = 'on' | 'off' | 'own_projects'

// Keep these codes in lockstep with send-push and migration 000283.
const PROOF_EVENTS: { code: string; label: string; hint: string }[] = [
  { code: 'customer_requests_changes', label: 'Changes requested', hint: 'A customer asks for changes on a proof.' },
  { code: 'proof_approve_per_recipient', label: 'Proof approved', hint: 'A customer approves (per recipient).' },
  { code: 'project_reaches_approved_status', label: 'Fully approved', hint: 'A whole proof is signed off.' },
  { code: 'customer_replies_by_email', label: 'Customer replied by email', hint: 'A customer replies on the Help Scout thread.' },
  { code: 'project_flagged', label: 'Project flagged', hint: 'A project is flagged onto the board, including auto-flagged complaints.' },
]

const ORDER_EVENTS: { code: string; label: string; hint: string }[] = [
  { code: 'order_paid', label: 'Order paid', hint: 'A customer pays for an order.' },
  { code: 'pay_link_opened', label: 'Pay link opened', hint: 'A customer opens a pay link.' },
  { code: 'project_reaches_to_order_status', label: 'Ready to order', hint: 'A project reaches the to-order stage.' },
]

// Chat pushes had no controls at all, yet every direct message sends one —
// easily the highest-volume push event for a team that chats all day. The only
// escape was the account-wide Pause, which also silences "changes requested"
// and "order paid": exactly the signals worth keeping. send-push already
// honours `prefs[code] === 'off'` per event (migration 000320/000324), so
// these rows just expose what the server could always do.
const CHAT_EVENTS: { code: string; label: string; hint: string }[] = [
  { code: 'team_chat_dm', label: 'Direct messages', hint: 'Someone sends you a private message.' },
  { code: 'team_chat_mention', label: 'Mentions', hint: 'Someone @mentions you in the team room.' },
]

interface DeviceRow {
  id: string
  user_agent: string | null
  last_seen_at: string
  endpoint: string
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  disabled?: boolean
}) {
  return (
    <div className="inline-flex rounded-[6px] border border-line bg-canvas p-0.5" role="group">
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={[
              'px-2.5 h-7 text-[12px] rounded-[4px] transition-colors disabled:opacity-50',
              active ? 'bg-surface text-ink border border-line-soft' : 'text-ink-mute hover:text-ink',
            ].join(' ')}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

export default function NotificationSettingsPage() {
  const { session, role: authRole } = useAuth()
  const userId = session?.user.id ?? null
  const role = authRole ?? 'designer'

  const [loading, setLoading] = useState(true)
  const [prefs, setPrefs] = useState<Record<string, PrefValue | boolean>>({})
  const [roleDefaults, setRoleDefaults] = useState<Record<string, PrefValue>>({})
  const [inFulfilment, setInFulfilment] = useState(false)
  const [devices, setDevices] = useState<DeviceRow[]>([])
  const [saving, setSaving] = useState(false)

  const muted = prefs._muted === true

  const loadDevices = useCallback(async () => {
    if (!userId) return
    const { data } = await supabase
      .from('push_subscriptions')
      .select('id, user_agent, last_seen_at, endpoint')
      .order('last_seen_at', { ascending: false })
    setDevices((data ?? []) as DeviceRow[])
  }, [userId])

  useEffect(() => {
    if (!userId) return
    let cancelled = false
    void (async () => {
      const [prefRes, settingsRes] = await Promise.all([
        supabase.from('notification_preferences').select('prefs').eq('user_id', userId).maybeSingle(),
        supabase.from('settings').select('notification_role_defaults, fulfilment_user_ids').eq('id', 1).maybeSingle(),
      ])
      if (cancelled) return
      setPrefs((prefRes.data?.prefs as Record<string, PrefValue | boolean>) ?? {})
      const defaults = (settingsRes.data?.notification_role_defaults as Record<string, Record<string, PrefValue>> | null) ?? {}
      setRoleDefaults(defaults[role] ?? {})
      const fulfil = (settingsRes.data?.fulfilment_user_ids as string[] | null) ?? []
      setInFulfilment(fulfil.includes(userId))
      await loadDevices()
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [userId, role, loadDevices])

  const savePrefs = useCallback(
    async (next: Record<string, PrefValue | boolean>) => {
      if (!userId) return
      setPrefs(next)
      setSaving(true)
      await supabase
        .from('notification_preferences')
        .upsert({ user_id: userId, prefs: next, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
      setSaving(false)
    },
    [userId],
  )

  function setEvent(code: string, value: PrefValue) {
    void savePrefs({ ...prefs, [code]: value })
  }

  function proofValue(code: string): PrefValue {
    const v = prefs[code]
    if (v === 'on' || v === 'off' || v === 'own_projects') return v
    return roleDefaults[code] ?? 'own_projects'
  }

  // Chat pushes default ON when unset, matching send-push (which only skips on
  // an explicit 'off'), so this control reflects live behaviour rather than
  // silently changing it.
  function chatValue(code: string): 'on' | 'off' {
    return prefs[code] === 'off' ? 'off' : 'on'
  }

  function orderValue(code: string): 'on' | 'off' {
    const v = prefs[code]
    if (v === 'on') return 'on'
    if (v === 'off') return 'off'
    return inFulfilment ? 'on' : 'off'
  }

  async function removeDevice(d: DeviceRow) {
    // If this is the current device, unsubscribe it too; otherwise just drop
    // the saved row so we stop sending to it.
    let isThisDevice = false
    try {
      const reg = await navigator.serviceWorker?.ready
      const sub = await reg?.pushManager.getSubscription()
      isThisDevice = sub?.endpoint === d.endpoint
    } catch {
      isThisDevice = false
    }
    if (isThisDevice) {
      await disablePushOnThisDevice()
    } else {
      await supabase.from('push_subscriptions').delete().eq('id', d.id)
    }
    await loadDevices()
  }

  return (
    <DesignerChrome active={null}>
      <main className="mx-auto max-w-[760px] px-4 sm:px-7 py-6 space-y-4">
        <div>
          <h1 className="font-display text-[26px] font-medium tracking-[-0.02em] text-ink">Notifications</h1>
          <p className="text-[13px] text-ink-mute mt-1">
            Get a tap on your phone when something needs you. Each person chooses their own.
          </p>
        </div>

        <EnableNotificationsCard onChange={loadDevices} />

        {!loading && (
          <>
            <PanelShell title="Pause" eyebrow="Whole account" icon={Bell}>
              <label className="flex items-center justify-between gap-4">
                <span className="text-[13px] text-ink-soft">
                  Pause all notifications for my account
                  <span className="block text-[12px] text-ink-mute">
                    Turn everything off without changing your choices below.
                  </span>
                </span>
                <input
                  type="checkbox"
                  checked={muted}
                  onChange={(e) => savePrefs({ ...prefs, _muted: e.target.checked })}
                  className="h-5 w-5 accent-[var(--c-brand)]"
                />
              </label>
            </PanelShell>

            <PanelShell title="Proofs" eyebrow="What to notify me about" icon={Bell}>
              <div className="divide-y divide-line-soft">
                {PROOF_EVENTS.map((ev) => (
                  <div key={ev.code} className="flex items-center justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
                    <div className="min-w-0">
                      <div className="text-[13px] text-ink">{ev.label}</div>
                      <div className="text-[12px] text-ink-mute">{ev.hint}</div>
                    </div>
                    <Segmented
                      value={proofValue(ev.code)}
                      disabled={muted}
                      onChange={(v) => setEvent(ev.code, v)}
                      options={[
                        { value: 'off', label: 'Off' },
                        { value: 'own_projects', label: 'My projects' },
                        { value: 'on', label: 'Every project' },
                      ]}
                    />
                  </div>
                ))}
              </div>
            </PanelShell>

            <PanelShell title="Orders" eyebrow="What to notify me about" icon={Bell}>
              <div className="divide-y divide-line-soft">
                {ORDER_EVENTS.map((ev) => (
                  <div key={ev.code} className="flex items-center justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
                    <div className="min-w-0">
                      <div className="text-[13px] text-ink">{ev.label}</div>
                      <div className="text-[12px] text-ink-mute">{ev.hint}</div>
                    </div>
                    <Segmented
                      value={orderValue(ev.code)}
                      disabled={muted}
                      onChange={(v) => setEvent(ev.code, v)}
                      options={[
                        { value: 'off', label: 'Off' },
                        { value: 'on', label: 'On' },
                      ]}
                    />
                  </div>
                ))}
              </div>
            </PanelShell>

            <PanelShell title="Team chat" eyebrow="What to notify me about" icon={Bell}>
              <div className="divide-y divide-line-soft">
                {CHAT_EVENTS.map((ev) => (
                  <div key={ev.code} className="flex items-center justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
                    <div className="min-w-0">
                      <div className="text-[13px] text-ink">{ev.label}</div>
                      <div className="text-[12px] text-ink-mute">{ev.hint}</div>
                    </div>
                    <Segmented
                      value={chatValue(ev.code)}
                      disabled={muted}
                      onChange={(v) => setEvent(ev.code, v)}
                      options={[
                        { value: 'off', label: 'Off' },
                        { value: 'on', label: 'On' },
                      ]}
                    />
                  </div>
                ))}
              </div>
              <p className="mt-3 text-[12px] text-ink-mute">
                Ordinary messages in the team room never push — only mentions and direct messages do.
              </p>
            </PanelShell>

            <PanelShell title="Your devices" eyebrow="Where notifications go" icon={Smartphone} count={devices.length}>
              {devices.length === 0 ? (
                <p className="text-[13px] text-ink-mute">
                  No devices yet. Enable notifications above on each phone or computer you want pinged.
                </p>
              ) : (
                <ul className="divide-y divide-line-soft">
                  {devices.map((d) => (
                    <li key={d.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                      <div className="min-w-0">
                        <div className="text-[13px] text-ink truncate">{describeDevice(d.user_agent)}</div>
                        <div className="text-[12px] text-ink-mute">
                          Last active {new Date(d.last_seen_at).toLocaleDateString()}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeDevice(d)}
                        aria-label="Remove device"
                        className="inline-flex h-8 w-8 items-center justify-center rounded-[6px] text-ink-mute hover:text-out hover:bg-canvas"
                      >
                        <Trash2 size={15} aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </PanelShell>

            <p className="text-[12px] text-ink-mute" aria-live="polite">
              {saving ? 'Saving…' : 'Your choices save automatically.'}
            </p>
          </>
        )}
      </main>
    </DesignerChrome>
  )
}

function describeDevice(ua: string | null): string {
  if (!ua) return 'Unknown device'
  if (/iPhone/i.test(ua)) return 'iPhone'
  if (/iPad/i.test(ua)) return 'iPad'
  if (/Macintosh|Mac OS/i.test(ua)) return 'Mac'
  if (/Android/i.test(ua)) return 'Android device'
  if (/Windows/i.test(ua)) return 'Windows PC'
  return 'This browser'
}
