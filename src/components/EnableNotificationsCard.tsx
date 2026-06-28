import { useCallback, useEffect, useState } from 'react'
import { BellRing, BellOff, Share, Smartphone } from 'lucide-react'
import { PanelShell } from '../design'
import { ButtonInk, ButtonGhost } from '../design/Button'
import {
  enablePush,
  disablePushOnThisDevice,
  isPushConfigured,
  isPushSupported,
  isStandalone,
  notificationPermission,
  type EnableResult,
} from '../lib/push'

// The gesture-gated "Enable notifications on this device" card. Feature-detects
// and shows the iOS-correct guidance for each state rather than a button that
// silently fails:
//   * not the installed app      -> "Add to Home Screen first"
//   * permission previously denied -> "turn back on in iOS Settings"
//   * already on                 -> confirmation + per-device "turn off"
//   * ready                      -> the enable button
//
// Lives on the Notifications settings page and can be dropped anywhere a
// designer-facing surface wants the opt-in.

type DeviceState = 'loading' | 'unsupported' | 'not_configured' | 'not_installed' | 'denied' | 'on' | 'off'

function reasonMessage(r: Exclude<EnableResult, { ok: true }>['reason']): string {
  switch (r) {
    case 'denied':
      return 'Notifications are blocked for this app. Turn them back on in iOS Settings → Notifications → Proof Viewer.'
    case 'dismissed':
      return 'No problem — tap Enable again whenever you’re ready.'
    case 'not_installed':
      return 'Add Proof Viewer to your Home Screen first, then come back.'
    case 'not_configured':
      return 'Notifications aren’t switched on for this site yet.'
    case 'unsupported':
      return 'This browser can’t show notifications.'
    default:
      return 'Something went wrong turning notifications on. Please try again.'
  }
}

export default function EnableNotificationsCard({ onChange }: { onChange?: () => void }) {
  const [state, setState] = useState<DeviceState>('loading')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!isPushSupported()) {
      setState('unsupported')
      return
    }
    if (!isPushConfigured()) {
      setState('not_configured')
      return
    }
    if (!isStandalone()) {
      setState('not_installed')
      return
    }
    const perm = notificationPermission()
    if (perm === 'denied') {
      setState('denied')
      return
    }
    try {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      setState(perm === 'granted' && sub ? 'on' : 'off')
    } catch {
      setState('off')
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function handleEnable() {
    setBusy(true)
    setNote(null)
    const result = await enablePush()
    setBusy(false)
    if (result.ok) {
      setState('on')
      onChange?.()
    } else {
      setNote(reasonMessage(result.reason))
      await refresh()
    }
  }

  async function handleDisable() {
    setBusy(true)
    setNote(null)
    try {
      await disablePushOnThisDevice()
      setState('off')
      onChange?.()
    } finally {
      setBusy(false)
    }
  }

  if (state === 'loading') return null

  // Unsupported / not configured — a quiet informational card, no button.
  if (state === 'unsupported' || state === 'not_configured') {
    return (
      <PanelShell title="Notifications" eyebrow="This device" icon={BellOff}>
        <p className="text-[13px] text-ink-mute">{reasonMessage(state)}</p>
      </PanelShell>
    )
  }

  if (state === 'not_installed') {
    return (
      <PanelShell title="Notifications" eyebrow="This device" icon={Smartphone}>
        <p className="text-[13px] text-ink-soft mb-2">
          To get notifications on this phone, add Proof Viewer to your Home Screen first.
        </p>
        <ol className="text-[13px] text-ink-mute list-decimal pl-5 space-y-1">
          <li className="flex items-center gap-1.5">
            Tap the Share button <Share size={13} aria-hidden="true" className="inline" /> in Safari
          </li>
          <li>Choose “Add to Home Screen”</li>
          <li>Open Proof Viewer from your Home Screen, then return here</li>
        </ol>
      </PanelShell>
    )
  }

  if (state === 'denied') {
    return (
      <PanelShell title="Notifications" eyebrow="This device" icon={BellOff}>
        <p className="text-[13px] text-ink-soft">{reasonMessage('denied')}</p>
      </PanelShell>
    )
  }

  if (state === 'on') {
    return (
      <PanelShell
        title="Notifications"
        eyebrow="This device"
        icon={BellRing}
        action={
          <ButtonGhost size="sm" icon={BellOff} busy={busy} onClick={handleDisable}>
            Turn off here
          </ButtonGhost>
        }
      >
        <p className="text-[13px] text-ink-soft">
          Notifications are on for this device. You’ll get a tap when something needs you — choose
          exactly what, below.
        </p>
        {note && <p className="mt-2 text-[12px] text-out">{note}</p>}
      </PanelShell>
    )
  }

  // state === 'off'
  return (
    <PanelShell title="Notifications" eyebrow="This device" icon={BellRing}>
      <p className="text-[13px] text-ink-soft mb-3">
        Turn on notifications to get a tap on this device when a customer approves a proof, requests
        changes, replies, or pays — without keeping the app open.
      </p>
      <ButtonInk icon={BellRing} busy={busy} onClick={handleEnable}>
        Enable notifications
      </ButtonInk>
      {note && <p className="mt-2 text-[12px] text-out">{note}</p>}
    </PanelShell>
  )
}
