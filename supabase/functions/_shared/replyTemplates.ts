// Shared server-side reply-template renderer. Extracted from proof-action's
// inline copy (its own comment set the extraction condition: "if a second
// server-side renderer ever appears, extract then" — send-nudges is that
// second renderer).
//
// ⚠ Must stay in sync with src/lib/replyTemplates.ts (the browser copy that
// powers the admin preview pane and MessageSendPanel). Same house pattern as
// the other Deno/browser mirrored modules: edge functions have no import
// path back into src/, so the renderer is duplicated with this sync comment
// on both sides. The renderer is small and the substitution syntax is
// stable; if it ever changes, change BOTH files.
//
// Syntax (matches the admin template editor):
//   {variable}             — substitute ctx[variable], empty if null/undefined
//   {? variable}body{/?}   — render body iff ctx[variable] is non-empty
//                            (after .trim() for strings; null/undefined
//                            collapse the block). No nesting.

export interface TemplateContext {
  first_name?: string
  full_name?: string
  company?: string | null
  version_number?: number | string
  url?: string
  designer_first_name?: string
  version_label?: string
  change_notes?: string
  chosen_variant?: string
  actor_name?: string
  recipient_name?: string
  [key: string]: string | number | null | undefined
}

export function renderTemplate(template: string, ctx: TemplateContext): string {
  // Pass 1: conditional blocks. Match {? var}body{/?} non-greedily so
  // multiple blocks in one template resolve independently. The body
  // recurses through substituteVariables so {var} tokens inside a
  // surviving block render correctly. Empty / whitespace / null /
  // undefined ctx values trim the whole block.
  let s = template.replace(
    /\{\?\s*(\w+)\s*\}([\s\S]*?)\{\/\?\}/g,
    (_match, varName: string, body: string) => {
      const v = ctx[varName]
      const empty = v == null || (typeof v === 'string' && v.trim() === '')
      return empty ? '' : substituteVariables(body, ctx)
    },
  )
  // Pass 2: bare variables outside conditional blocks.
  s = substituteVariables(s, ctx)
  return s
}

export function substituteVariables(text: string, ctx: TemplateContext): string {
  return text.replace(/\{(\w+)\}/g, (_match, v: string) => {
    const val = ctx[v]
    return val == null ? '' : String(val)
  })
}

// Validation for UNATTENDED sends (spec: "the renderer substitutes silently,
// so this gate is the real guardrail"). The designer-facing manual path
// deliberately does not use this — a human reads the body before clicking
// send.
//
// The check runs against the TEMPLATE, before rendering: substituteVariables
// replaces EVERY {word} token (unknown names become empty string), so
// inspecting the rendered output for leftovers can never fire — a typo'd
// {ur1} would silently produce an email with no link. Returns a
// human-readable problem string, or null when safe to send.
// `requiredUrlKey` names the ctx field that must render non-empty (the link the
// message exists to deliver). Defaults to 'url' (the proof-nudge link); the
// order-reminder sender passes 'order_url'.
export function templateProblem(
  template: string,
  ctx: TemplateContext,
  requiredUrlKey: 'url' | 'order_url' = 'url',
): string | null {
  // Strip conditional openers/closers, then collect every bare {token} the
  // renderer will try to substitute — each must exist as a ctx key (empty
  // values are caught by the value checks below for the fields that matter).
  const known = new Set(Object.keys(ctx))
  const conditionalNames = [...template.matchAll(/\{\?\s*(\w+)\s*\}/g)].map((m) => m[1])
  const bareNames = [...template.replace(/\{\?\s*\w+\s*\}|\{\/\?\}/g, '').matchAll(/\{(\w+)\}/g)]
    .map((m) => m[1])
  for (const name of [...conditionalNames, ...bareNames]) {
    if (!known.has(name)) return `unknown template variable {${name}}`
  }
  // Unbalanced conditional syntax survives the renderer verbatim.
  const openers = conditionalNames.length
  const closers = (template.match(/\{\/\?\}/g) ?? []).length
  if (openers !== closers) return `unbalanced conditional blocks (${openers} openers, ${closers} closers)`
  // The two fields a nudge cannot be sent without.
  const url = typeof ctx[requiredUrlKey] === 'string' ? (ctx[requiredUrlKey] as string).trim() : ''
  if (!url) return `${requiredUrlKey} rendered empty`
  const firstName = typeof ctx.first_name === 'string' ? ctx.first_name.trim() : ''
  if (!firstName) return 'customer first name rendered empty'
  return null
}

// Default bodies for the needs-attention nudge templates, the fallback when
// the reply_templates row is missing. Must stay in sync with BOTH the seed
// migrations (000207 base bodies, 000313 sequence bodies) and
// src/lib/replyTemplates.ts DEFAULT_BODIES.
// No sign-off: Help Scout auto-appends the configured signature.
//
// The `_2` / `_final` ids are the per-position bodies for the automated
// reminder sequence (000313): send-nudges resolves them via nudgeTemplateIds
// so a customer never receives the same reminder twice — base body for
// reminder 1, `_2` for the middle, `_final` (the "we'll stop nudging you"
// close) for the last allowed reminder.
export const NUDGE_DEFAULT_BODIES: Record<string, string> = {
  nudge_sent_never_viewed:
    `Hi {first_name},\n\nJust checking the proof of your cards{? company} for {company}{/?} reached you — it doesn't look like it's been opened yet. Here's the link again whenever you have a moment:\n\n{url}`,
  nudge_sent_never_viewed_2:
    `Hi {first_name},\n\nEmails have a way of getting buried, so here's the link to the proof of your cards{? company} for {company}{/?} again — it only takes a minute to look over:\n\n{url}\n\nIf now isn't a good time, just reply and let us know — we'll hold off on the reminders.`,
  nudge_sent_never_viewed_final:
    `Hi {first_name},\n\nWe haven't managed to reach you about your card proof{? company} for {company}{/?}, so this is our last reminder — we don't want to clutter your inbox.\n\nYour proof stays saved, and you can pick it up any time:\n\n{url}\n\nIf the timing's wrong or something's not quite right, a one-line reply is all it takes.`,
  nudge_viewed_not_actioned:
    `Hi {first_name},\n\nHope you've had a chance to look over the proof{? company} for {company}{/?}. Any thoughts, or are you happy for us to go ahead? Here's the link if you'd like another look:\n\n{url}`,
  nudge_viewed_not_actioned_2:
    `Hi {first_name},\n\nJust picking up on the proof of your cards{? company} for {company}{/?}. If you're happy with it, you can approve it on the page in a few seconds — and if you'd like anything changed (layout, wording, colours), just reply and we'll sort it:\n\n{url}\n\nIf it's the price giving you pause, tell us — there's often a more affordable route with a different material or quantity.`,
  nudge_viewed_not_actioned_final:
    `Hi {first_name},\n\nThis is our last reminder about your card proof{? company} for {company}{/?} — we don't want to be a pest. Your proof stays saved, so you can come back to it whenever suits:\n\n{url}\n\nIf you've decided not to go ahead, no hard feelings — a quick reply telling us why (price, timing, direction) genuinely helps us do better.`,
  // Return-tone reminder 1 (migration 000380): the viewed_not_actioned chase
  // for a customer who has come back to their proof on 2+ separate days
  // without deciding — stuck, not hot, usually on price. Obstacle-removal
  // wording, no closing pressure, and NEVER any reference to visits or views
  // (the house rule: tracking is only ever disclosed in the negative). The
  // sender appends &ask=1 to its {url} so the link auto-opens the "Not ready
  // to approve?" panel. Only the base position is seeded — reminders 2+
  // deliberately fall back to the standard _2/_final bodies via the
  // per-position chain (nudgeTemplateIdsFor).
  nudge_viewed_not_actioned_return:
    `Hi {first_name},\n\nNo rush on your card proof{? company} for {company}{/?} — it's saved and waiting whenever you're ready.\n\nIf anything's giving you pause — the price, a detail you'd like changed, or a question — just reply, or use the "Not ready to approve?" option on your proof page and we'll happily adjust:\n\n{url}`,
  // Bundle reminders (migration 000317): ONE reminder for a whole set of cards,
  // pointing at the bundle review link ({url}) rather than a single card's page.
  // Pluralised, and no {version_number} — a bundle spans versions.
  nudge_bundle:
    `Hi {first_name},\n\nJust checking the proofs of your cards{? company} for {company}{/?} reached you — a few are still waiting for your review. You can look over the whole set, and approve each one, here:\n\n{url}`,
  nudge_bundle_2:
    `Hi {first_name},\n\nCircling back on your card proofs{? company} for {company}{/?} — a few are still waiting for the go-ahead. It only takes a minute to review the set and approve the ones you're happy with:\n\n{url}\n\nIf now isn't a good time, just reply and let us know — we'll hold off on the reminders.`,
  nudge_bundle_final:
    `Hi {first_name},\n\nWe haven't managed to reach you about your card proofs{? company} for {company}{/?}, so this is our last reminder — we don't want to clutter your inbox.\n\nYour proofs stay saved, and you can review the set any time:\n\n{url}\n\nIf the timing's wrong or something's not quite right, a one-line reply is all it takes.`,
  nudge_approaching_dormant:
    `Hi {first_name},\n\nJust a quick nudge on your card proof{? company} for {company}{/?} before it slips off our active list. Let us know if you'd like any changes — here's the link:\n\n{url}`,
  nudge_stuck_in_progress:
    `Hi {first_name},\n\nChecking in on your card proof{? company} for {company}{/?} — we haven't heard back in a little while. Happy to help with any tweaks; here's the link again:\n\n{url}`,
}

// Default body for the order-paid confirmation, posted by stripe-webhook when
// a customer's payment lands (Help Scout emails it out). Fallback when the
// reply_templates row is missing. Must stay in sync with the seed migration
// and src/lib/replyTemplates.ts DEFAULT_BODIES. No sign-off — Help Scout
// auto-appends the configured signature.
export const ORDER_CONFIRMATION_DEFAULT_BODY =
  `Hi {first_name},\n\nThank you — we've received your payment and your cards{? company} for {company}{/?} are now in production. Your order reference is {payment_reference}.{? order_url}\n\nYou can view your order here, where it'll show its progress as we make and ship it:\n\n{order_url}{/?}\n\nWe'll email you dispatch details as soon as your cards are on their way, and your VAT invoice will arrive in a separate email shortly.\n\nIf you have any questions, just reply to this email.`

// Default body for the order-reminder template (migration 000238; collapsed
// from two stages to one repeating reminder in 000270), the fallback when the
// reply_templates row is missing. Must stay in sync with the seed migration and
// src/lib/replyTemplates.ts DEFAULT_BODIES. The expiry sentence renders only
// when the order has an expiry date. No sign-off.
export const ORDER_REMINDER_DEFAULT_BODIES: Record<string, string> = {
  order_reminder_1:
    `Hi {first_name},\n\nJust a reminder that your cards{? company} for {company}{/?} are approved and ready to order whenever you're set. You can choose your quantity and pay securely here:\n\n{order_url}{? order_expiry}\n\nThis order link expires on {order_expiry}.{/?}`,
  // The combined-payment twin (migration 000388): same four variables, with
  // {order_url} being the one /order/group/ link that covers every card in the
  // group and {order_expiry} the group's own expiry.
  order_reminder_group:
    `Hi {first_name},\n\nJust a reminder that your card orders{? company} for {company}{/?} are approved and ready whenever you're set. They're on a single payment link, so you can settle them all together here:\n\n{order_url}{? order_expiry}\n\nThis payment link expires on {order_expiry}.{/?}`,
}

// The order_cancelled / order_revision default bodies (migration 000260) live in
// src/lib/replyTemplates.ts DEFAULT_BODIES (admin "Reset to default") and the
// 000260 seed. The order-lifecycle edge function inlines its own matching copy
// (self-contained MCP deploy, like place-order), so there is deliberately no
// _shared constant here to keep in sync.
