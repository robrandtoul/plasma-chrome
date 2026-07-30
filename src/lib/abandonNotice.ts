// Abandon-notice composition rules — the pure half of "tell the customer we've
// closed this project off".
//
// Abandoning a project has always been silent: handleAbandon wrote one row and
// showed the designer a toast, and the only way a customer found out was by
// returning to their link and reading the "This proof is closed" card. Silence
// stays the default (most abandons are ghosted leads or the designer tidying
// up), but a designer can now tick a box and send the customer a short note.
//
// Two things live here rather than in the dialog, because both are worth
// testing and neither needs React:
//
//   * notifyBlocker() — whether the notify option can be offered at all. The
//     send rides send-helpscout-reply, which hard-requires a linked Help Scout
//     conversation AND a version_id (index.ts:203), and is killed globally by
//     settings.replies_enabled. Each of those is a real, reachable state for a
//     proof being abandoned — a lead that never got artwork is precisely the
//     population most likely to be closed off — so the checkbox explains
//     itself instead of failing at send time.
//
//   * abandonNoticeContext() — the {first_name} / {company} pair the
//     proof_abandoned template renders against. Deliberately NO {url}: the
//     link still loads but shows the closed card with no artwork on it, so
//     inviting the customer to "take another look" there is a dead end. The
//     call to action is a plain reply, which lands back on the same Help Scout
//     thread the designer is already in. (The closed page's own contact form
//     opens a NEW conversation in Customer Support — a different, worse place
//     for this to land.)

import { firstName } from './firstName'
import type { TemplateContext } from './replyTemplates'

/** The reply template the abandon notice renders from. */
export const ABANDON_TEMPLATE_ID = 'proof_abandoned'

export interface AbandonNotifyTarget {
  /** proofs.helpscout_conversation_id — null when nothing is linked. */
  helpscoutConversationId: string | null
  /**
   * Versions of this proof, newest-relevant first is not required — the
   * resolver prefers the current one and falls back to the newest by
   * version_number.
   */
  versions: { id: string; version_number: number; is_current: boolean }[]
  /** settings.replies_enabled, the global send kill-switch (migration 000104). */
  repliesEnabled: boolean
}

export interface AbandonNotifyBlocker {
  /** Machine-readable so the dialog can vary its treatment if it ever needs to. */
  code: 'replies_paused' | 'no_conversation' | 'no_version'
  /** Shown under the disabled checkbox, in the designer's language. */
  detail: string
}

// Order matters: report the most fundamental reason first, so a proof with no
// conversation AND no version doesn't tell the designer to go link a
// conversation when there'd still be nothing to send afterwards. Replies-paused
// outranks both because it's an admin switch that affects every project.
export function notifyBlocker(target: AbandonNotifyTarget): AbandonNotifyBlocker | null {
  if (!target.repliesEnabled) {
    return {
      code: 'replies_paused',
      detail: 'Sending customer replies is paused in Admin → Settings, so this project can only be closed silently.',
    }
  }
  if (!target.helpscoutConversationId) {
    return {
      code: 'no_conversation',
      detail: 'No Help Scout conversation is linked to this project, so there’s no thread to post on. Link one first, or message the customer yourself.',
    }
  }
  if (resolveNoticeVersionId(target.versions) == null) {
    return {
      code: 'no_version',
      detail: 'This project has no proof version yet, so there’s nothing to send the message against. Message the customer in Help Scout instead.',
    }
  }
  return null
}

// send-helpscout-reply pins the reply to one version (it stamps that version's
// last_reply_sent_at). The current version is the honest anchor; a proof with
// versions but none flagged current — reachable while a delete auto-promote is
// mid-flight — falls back to the highest version number so the send still
// works rather than being blocked on a transient.
export function resolveNoticeVersionId(
  versions: { id: string; version_number: number; is_current: boolean }[],
): string | null {
  if (versions.length === 0) return null
  const current = versions.find((v) => v.is_current)
  if (current) return current.id
  return versions.reduce((a, b) => (b.version_number > a.version_number ? b : a)).id
}

export function abandonNoticeContext(contact: {
  fullName: string | null | undefined
  companyName: string | null | undefined
}): TemplateContext {
  // Blank company must reach the renderer as empty, not as "   ", or the
  // {? company}…{/?} block survives and the customer reads "your cards for  ".
  const company = (contact.companyName ?? '').trim()
  return {
    first_name: firstName(contact.fullName),
    full_name: (contact.fullName ?? '').trim(),
    company: company === '' ? null : company,
  }
}
