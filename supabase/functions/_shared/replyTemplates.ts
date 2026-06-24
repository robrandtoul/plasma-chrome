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

// Default bodies for the four needs-attention nudge templates, the fallback
// when the reply_templates row is missing. Must stay in sync with BOTH the
// seed migration (000207) and src/lib/replyTemplates.ts DEFAULT_BODIES.
// No sign-off: Help Scout auto-appends the configured signature.
export const NUDGE_DEFAULT_BODIES: Record<string, string> = {
  nudge_sent_never_viewed:
    `Hi {first_name},\n\nJust checking the proof of your cards{? company} for {company}{/?} reached you — it doesn't look like it's been opened yet. Here's the link again whenever you have a moment:\n\n{url}`,
  nudge_viewed_not_actioned:
    `Hi {first_name},\n\nHope you've had a chance to look over the proof{? company} for {company}{/?}. Any thoughts, or are you happy for us to go ahead? Here's the link if you'd like another look:\n\n{url}`,
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
  `Hi {first_name},\n\nThank you — we've received your payment and your cards{? company} for {company}{/?} are now in production. Your order reference is {payment_reference}.\n\nWe'll email you dispatch details as soon as your cards are on their way, and your VAT invoice will arrive in a separate email shortly.\n\nIf you have any questions, just reply to this email.`

// Default bodies for the two order-reminder templates (migration 000238), the
// fallback when the reply_templates row is missing. Must stay in sync with the
// seed migration and src/lib/replyTemplates.ts DEFAULT_BODIES. No sign-off.
export const ORDER_REMINDER_DEFAULT_BODIES: Record<string, string> = {
  order_reminder_1:
    `Hi {first_name},\n\nJust a gentle reminder that your cards{? company} for {company}{/?} are approved and ready to order whenever you're set. You can choose your quantity and pay securely here:\n\n{order_url}`,
  order_reminder_2:
    `Hi {first_name},\n\nA quick reminder that your order link{? company} for {company}{/?} expires on {order_expiry}. If you'd still like to go ahead, you can complete it here:\n\n{order_url}\n\nIf the link has lapsed by the time you read this, just reply and we'll send a fresh one.`,
}

// The order_cancelled / order_revision default bodies (migration 000260) live in
// src/lib/replyTemplates.ts DEFAULT_BODIES (admin "Reset to default") and the
// 000260 seed. The order-lifecycle edge function inlines its own matching copy
// (self-contained MCP deploy, like place-order), so there is deliberately no
// _shared constant here to keep in sync.
