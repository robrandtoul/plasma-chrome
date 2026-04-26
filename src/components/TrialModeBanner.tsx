// Persistent in-content banner shown on every authenticated page
// when the global customer-replies feature is paused (migration
// 000104). Renders nothing when replies are enabled, so the
// banner costs zero pixels in normal operation.
//
// Mounted inside RequireAuth so every authenticated route picks
// it up automatically without per-page wiring. Designers see the
// pause state on Dashboard, ProofDetail, NewVersion, EditVersion;
// admins see it across the admin area too. The MessageSendPanel
// and ProofDetailPage Customer reply section also surface their
// own disabled-state copy on the relevant Send buttons; this
// banner is the always-visible signal so the pause state stays
// top-of-mind even when a designer is on a page that doesn't
// expose Send affordances.
//
// Copy varies by role: admins see an "Enable in Settings" link
// they can act on; non-admin designers see the bare announcement
// since they can't toggle the flag.

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { getRepliesEnabled } from '../lib/repliesEnabled'
import { useAuth } from '../lib/auth'

export function TrialModeBanner() {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const { role } = useAuth()

  useEffect(() => {
    let cancelled = false
    void getRepliesEnabled().then((v) => {
      if (!cancelled) setEnabled(v)
    })
    return () => { cancelled = true }
  }, [])

  // Render nothing while loading and when the feature is on. Both
  // states are common; the banner only surfaces when the flag is
  // explicitly false, which is the trial-mode / kill-switch
  // condition we want designers to notice.
  if (enabled !== false) return null

  return (
    <div className="border-b border-amber-200 bg-amber-50 px-4 py-2.5 sm:px-6">
      <p className="mx-auto max-w-5xl text-xs text-amber-800">
        Customer replies are paused. Designers can compose messages but Send is disabled.
        {role === 'admin' && (
          <>
            {' '}
            <Link
              to="/admin/settings"
              className="font-medium underline underline-offset-2 hover:text-amber-900"
            >
              Enable in Settings
            </Link>
            .
          </>
        )}
      </p>
    </div>
  )
}
