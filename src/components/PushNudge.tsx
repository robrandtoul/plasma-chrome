import { useEffect, useState } from 'react'
import { BellRing } from 'lucide-react'
import { ButtonInk, ButtonGhost } from '../design/Button'
import {
  enablePush,
  isPushConfigured,
  isPushSupported,
  needsInstallFirst,
  notificationPermission,
} from '../lib/push'

// A one-time, gesture-gated nudge to turn on push notifications, shown a few
// seconds after a signed-in designer lands on any page. Deliberately NOT the
// native browser prompt fired on load — that pattern gets auto-suppressed by
// Chrome/Safari and a reflex "Block" is near-permanent. Instead this card
// explains the value first; the real browser dialog only appears when the
// person clicks Enable (a user gesture, as Safari requires).
//
// Self-gating: renders nothing when push is unsupported/unconfigured, when
// iOS still needs the Home-Screen install (the settings page walks through
// that), when permission has already been decided either way, or while
// snoozed ("Not now" hides it for 14 days; declining the native prompt
// snoozes too).

const SNOOZE_KEY = 'pv:push-nudge-snoozed-at'
const SNOOZE_DAYS = 14

function isSnoozed(): boolean {
  try {
    const raw = localStorage.getItem(SNOOZE_KEY)
    if (!raw) return false
    const t = Date.parse(raw)
    return Number.isFinite(t) && Date.now() - t < SNOOZE_DAYS * 86_400_000
  } catch {
    return false
  }
}

export default function PushNudge() {
  const [visible, setVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  useEffect(() => {
    if (!isPushSupported() || !isPushConfigured()) return
    if (needsInstallFirst()) return
    if (notificationPermission() !== 'default') return
    if (isSnoozed()) return
    const t = window.setTimeout(() => setVisible(true), 2500)
    return () => window.clearTimeout(t)
  }, [])

  if (!visible) return null

  function snooze() {
    try {
      localStorage.setItem(SNOOZE_KEY, new Date().toISOString())
    } catch {
      /* localStorage unavailable — it just reappears next visit */
    }
    setVisible(false)
  }

  async function handleEnable() {
    setBusy(true)
    const result = await enablePush()
    setBusy(false)
    if (result.ok) {
      setDone(true)
      window.setTimeout(() => setVisible(false), 2200)
    } else {
      // They declined (or dismissed) the native prompt — stop asking for now;
      // the Notifications settings page stays available.
      snooze()
    }
  }

  return (
    <div
      role="dialog"
      aria-label="Turn on notifications"
      className="fixed right-4 z-40 w-[calc(100vw-2rem)] max-w-[340px] rounded-[14px] border border-line bg-surface p-4 shadow-xl bottom-[calc(76px+env(safe-area-inset-bottom))] md:bottom-6 md:right-6"
    >
      {done ? (
        <p className="text-[13px] text-ink-soft">You’re set — notifications are on for this device.</p>
      ) : (
        <>
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand">
              <BellRing size={16} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="text-[14px] font-semibold text-ink">Turn on notifications?</p>
              <p className="mt-0.5 text-[13px] leading-snug text-ink-mute">
                Get an alert when you’re @mentioned, sent a private message, or a customer responds —
                even with this tab in the background.
              </p>
            </div>
          </div>
          <div className="mt-3 flex items-center justify-end gap-2">
            <ButtonGhost size="sm" onClick={snooze}>
              Not now
            </ButtonGhost>
            <ButtonInk size="sm" icon={BellRing} busy={busy} onClick={() => void handleEnable()}>
              Enable
            </ButtonInk>
          </div>
        </>
      )}
    </div>
  )
}
