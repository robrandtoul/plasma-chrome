import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Mail, Share2 } from 'lucide-react'
import { Pill } from '../design'
import { firstName } from '../lib/firstName'

// "Share with your team" panel (migration 000304).
//
// Shown on the customer page when the current version has
// team_sharing_enabled and 2+ named recipients. Lists every name with
// its approval status and a per-person link (/p/:id?for=<name>) that
// opens this same page focused on that person's card. Doubles as the
// main contact's chase list — the status chips update as colleagues
// approve.
//
// The links carry no extra access: anyone with any link sees the whole
// page. The ?for= param only changes which card the page brings into
// focus, which the footer copy states plainly so nobody mistakes a
// personal link for private access.

interface ShareWithTeamPanelProps {
  proofId: string
  names: string[]
  approvedNames: Set<string>
  company: string | null
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  const first = parts[0][0] ?? ''
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : ''
  return (first + last).toUpperCase()
}

export function shareLinkForName(proofId: string, name: string): string {
  return `${window.location.origin}/p/${proofId}?for=${encodeURIComponent(name)}`
}

export function ShareWithTeamPanel({ proofId, names, approvedNames, company }: ShareWithTeamPanelProps) {
  // Which row just had its link copied — keyed by name, cleared on a
  // timer so the tick reverts to the copy icon.
  const [copiedName, setCopiedName] = useState<string | null>(null)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
  }, [])

  // navigator.share is the mobile path (WhatsApp / Messages / mail in
  // one sheet). Feature-detected once; on desktop the button is absent
  // and copy + email carry the load.
  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

  const approvedCount = names.filter((n) => approvedNames.has(n)).length

  async function handleCopy(name: string) {
    try {
      await navigator.clipboard.writeText(shareLinkForName(proofId, name))
      setCopiedName(name)
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => setCopiedName(null), 1600)
    } catch {
      // Clipboard denied (rare — non-secure context or permissions).
      // Fall back to the prompt-free option: select-nothing, do
      // nothing. The email + share buttons remain available.
    }
  }

  function emailHref(name: string): string {
    const subject = `Your business card proof is ready to review`
    const body = [
      `Hi ${firstName(name)},`,
      '',
      `Your new business card design${company ? ` for ${company}` : ''} is ready for you to check and approve. Open your proof here:`,
      '',
      shareLinkForName(proofId, name),
      '',
      `The link opens the proof page with your card at the top — have a look and approve it, or request changes if anything needs adjusting.`,
    ].join('\n')
    return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
  }

  async function handleNativeShare(name: string) {
    try {
      await navigator.share({
        title: 'Business card proof',
        text: `${firstName(name)}, your business card proof is ready to review and approve.`,
        url: shareLinkForName(proofId, name),
      })
    } catch {
      // Customer dismissed the share sheet — not an error.
    }
  }

  return (
    <section
      aria-labelledby="share-team-heading"
      className="order-4 lg:order-none bg-surface border border-line rounded-[14px] overflow-hidden"
    >
      <div className="flex flex-wrap items-center gap-3 px-5 py-4">
        <div className="min-w-0">
          <h2
            id="share-team-heading"
            className="font-display font-medium text-ink text-[17px] leading-tight"
          >
            Share with your team
          </h2>
          <p className="mt-0.5 text-[13px] text-ink-mute">
            Each person approves their own card — send them their link.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2.5">
          <span className="eyebrow text-ink-mute whitespace-nowrap">
            {approvedCount} of {names.length} approved
          </span>
          <span
            aria-hidden="true"
            className="hidden sm:block h-1.5 w-24 rounded-full bg-line-soft overflow-hidden"
          >
            <span
              className="block h-full rounded-full bg-in-stock"
              style={{ width: `${names.length > 0 ? (approvedCount / names.length) * 100 : 0}%` }}
            />
          </span>
        </div>
      </div>

      <ul className="m-0 list-none p-0">
        {names.map((name) => {
          const approved = approvedNames.has(name)
          const copied = copiedName === name
          return (
            <li
              key={name}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3 border-t border-line-soft"
            >
              <span
                aria-hidden="true"
                className="grid place-items-center h-8 w-8 rounded-full bg-canvas border border-line text-[11px] font-semibold text-ink-soft"
              >
                {initials(name)}
              </span>
              <span className="min-w-0 flex-1 text-[15px] font-medium text-ink truncate">
                {name}
              </span>
              <Pill colour={approved ? 'in-stock' : 'mute'}>
                {approved ? 'Approved' : 'Awaiting review'}
              </Pill>
              <span className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleCopy(name)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 py-1.5 text-[13px] font-semibold text-ink-soft hover:bg-canvas transition-colors"
                >
                  {copied ? (
                    <Check size={13} aria-hidden="true" style={{ color: 'var(--c-in-stock)' }} />
                  ) : (
                    <Copy size={13} aria-hidden="true" />
                  )}
                  {copied ? 'Copied' : 'Copy link'}
                </button>
                <a
                  href={emailHref(name)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 py-1.5 text-[13px] font-semibold text-ink-soft hover:bg-canvas transition-colors no-underline"
                >
                  <Mail size={13} aria-hidden="true" />
                  Email
                </a>
                {canNativeShare && (
                  <button
                    type="button"
                    onClick={() => handleNativeShare(name)}
                    aria-label={`Share ${firstName(name)}'s link`}
                    className="inline-flex items-center rounded-full border border-line bg-surface p-2 text-ink-soft hover:bg-canvas transition-colors"
                  >
                    <Share2 size={13} aria-hidden="true" />
                  </button>
                )}
              </span>
            </li>
          )
        })}
      </ul>

      <p className="m-0 flex items-start gap-2 border-t border-line-soft bg-canvas px-5 py-3 text-[12.5px] leading-relaxed text-ink-mute">
        Anyone with a link can see the whole set — a personal link simply
        opens the page on that person&rsquo;s card.
      </p>
    </section>
  )
}
