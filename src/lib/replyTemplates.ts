// Reply-template substitution helpers. Foundation for the customer-
// reply feature (Ship 1 of intervention 3). Today this only powers
// the admin preview pane; Ship 2 wires it into the new-version flow's
// designer-facing message editor, and Ship 3 routes the rendered text
// through the Help Scout API send.
//
// ⚠ The server-side twin lives at supabase/functions/_shared/replyTemplates.ts
// (used by proof-action and send-nudges — edge functions have no import path
// into src/). The renderer and the nudge_* DEFAULT_BODIES are duplicated
// there with a matching sync comment: change one, change both.
//
// Two pieces:
//
//   * renderTemplate(template, ctx): apply variable substitution and
//     conditional rendering to a template string. Two passes —
//     conditional blocks first, then bare variables — so a variable
//     used inside a conditional resolves correctly even when the same
//     variable name is also used outside the block.
//
//   * TEMPLATE_VARIABLES: declarative metadata about each supported
//     variable, used by the admin UI to render insert chips and the
//     help panel below the template cards.
//
// Conditional syntax: {? variable_name}…{/?}
//   * Renders the contained block iff ctx[variable_name] is non-empty
//     (string with .trim().length > 0 after coercion). Empty,
//     whitespace-only, null, and undefined all collapse the block to
//     nothing. The opener carries the variable name; the closer is
//     generic ({/?}) so unnamed conditionals stay possible if we ever
//     add them. No nesting in v1 — documented constraint.
//
// Variable syntax: {variable_name}
//   * Substitutes ctx[variable_name] coerced to string. null and
//     undefined both substitute empty.

// ── Context shape ────────────────────────────────────────────────────────────
//
// Open-ended via the index signature so future variables (e.g.
// card_type, designer_email, customer_phone) can be added by
// extending TEMPLATE_VARIABLES without changing the renderer.

export interface TemplateContext {
  // Pre-send (designer-picked: first_proof, revision)
  first_name?: string
  full_name?: string
  company?: string | null
  version_number?: number | string
  url?: string
  designer_first_name?: string
  // Post-action confirmation (proof-viewer: proof_*)
  version_label?: string
  change_notes?: string
  chosen_variant?: string
  actor_name?: string
  recipient_name?: string
  [key: string]: string | number | null | undefined
}

// ── Render ───────────────────────────────────────────────────────────────────

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

// ── Variable metadata ────────────────────────────────────────────────────────
//
// Drives the admin UI: each entry produces an insert chip with the
// shown name as label and the description as a hover hint or
// underneath-the-toolbar caption. The conditional flag indicates
// "this value can be empty in real usage; consider wrapping in
// {? var}…{/?} if you reference it from a template". Doesn't affect
// renderer behaviour — the renderer treats empty/undefined identically
// for every variable.
//
// scope partitions variables by which template family they're used in:
//
//   * 'designer_picked' — populated by the designer-facing flow that
//     sends first_proof / revision messages from the new-version
//     editor. Variables come from the proof + customer + version row
//     at compose time.
//
//   * 'proof_viewer'    — populated by the proof-action edge function
//     when posting the system-triggered confirmation reply (one of
//     proof_approval_confirmation / proof_change_request_confirmation
//     / proof_variant_selection_confirmation). Variables come from
//     the customer's just-recorded action.
//
// Convention: reply template IDs prefixed `proof_*` are system-
// triggered confirmations sent automatically by the proof-action
// edge function. They render in the "Post-action confirmations"
// sub-section of the admin editor, with their own variable scope.
// Designer-picked templates (first_proof, revision) use unprefixed
// IDs and render in the "Pre-send messages" sub-section.

export type TemplateVariableScope = 'designer_picked' | 'proof_viewer' | 'order' | 'order_reminder' | 'order_confirmation' | 'order_lifecycle' | 'supplier_order'

export interface TemplateVariableMeta {
  // Variable name as it appears between braces in templates. Plain
  // string (rather than keyof TemplateContext) because the context
  // interface has a string index signature that makes keyof resolve
  // to string | number, and the UI's insert chips need a string.
  // The TEMPLATE_VARIABLES array below is the source of truth for
  // which names render in the toolbar.
  name: string
  scope: TemplateVariableScope
  description: string
  conditional: boolean
}

export const TEMPLATE_VARIABLES: TemplateVariableMeta[] = [
  // Pre-send messages (first_proof, revision)
  { name: 'first_name',          scope: 'designer_picked', description: "Customer's first name",                                                            conditional: false },
  { name: 'full_name',           scope: 'designer_picked', description: "Customer's full name",                                                             conditional: false },
  { name: 'company',             scope: 'designer_picked', description: 'Company name (when set)',                                                          conditional: true  },
  { name: 'version_number',      scope: 'designer_picked', description: 'Proof version number',                                                             conditional: false },
  { name: 'url',                 scope: 'designer_picked', description: 'Customer-facing proof URL',                                                        conditional: false },
  { name: 'designer_first_name', scope: 'designer_picked', description: "Designer's first name (deferred, resolves to empty until designer accounts ship)", conditional: true  },
  // Post-action confirmations (proof_approval_confirmation, proof_change_request_confirmation, proof_variant_selection_confirmation)
  { name: 'version_label',       scope: 'proof_viewer',    description: 'Version label as shown to the customer (e.g. "version 3")',                       conditional: false },
  { name: 'change_notes',        scope: 'proof_viewer',    description: "What the customer typed in the change-notes box. Empty for plain approvals — wrap in {? change_notes}…{/?} when used.", conditional: true },
  { name: 'chosen_variant',      scope: 'proof_viewer',    description: 'Variant the customer picked (variant round only; empty otherwise)',               conditional: true  },
  { name: 'actor_name',          scope: 'proof_viewer',    description: 'Name the customer typed when confirming their action',                            conditional: false },
  { name: 'recipient_name',      scope: 'proof_viewer',    description: "Per-recipient slot on multi-recipient proofs; empty on shared/all-shared proofs — wrap in {? recipient_name}…{/?} when used.", conditional: true },
  // Order messages (order_payment_link) — composed by the designer in the order
  // builder before sending the pay-link to the customer.
  { name: 'order_url',           scope: 'order',           description: "Customer order pay-page link",                                                    conditional: false },
  // Order reminders (order_reminder_1 / _2) — sent by the automated sender,
  // which has the full order → proof → contact context.
  { name: 'first_name',          scope: 'order_reminder',  description: "Customer's first name",                                                           conditional: false },
  { name: 'company',             scope: 'order_reminder',  description: 'Company name (when set)',                                                         conditional: true  },
  { name: 'order_url',           scope: 'order_reminder',  description: 'Customer order pay-page link',                                                    conditional: false },
  { name: 'order_expiry',        scope: 'order_reminder',  description: 'Date the order link expires',                                                     conditional: false },
  // Order-paid confirmation (order_paid_confirmation) — posted automatically by
  // the Stripe webhook when a payment lands; Help Scout emails it to the customer.
  { name: 'first_name',          scope: 'order_confirmation', description: "Customer's first name (falls back to a friendly greeting if unknown)",          conditional: false },
  { name: 'company',             scope: 'order_confirmation', description: 'Company name (when set)',                                                       conditional: true  },
  { name: 'payment_reference',   scope: 'order_confirmation', description: 'The order reference (ORD-…) shown to the customer',                             conditional: false },
  { name: 'order_url',           scope: 'order_confirmation', description: "Link to the customer's order page (doubles as the tracking page). Wrap in {? order_url}…{/?}.", conditional: true  },
  // Order lifecycle (order_cancelled / order_revision) — posted by the
  // order-lifecycle edge function, which has order → proof → contact context.
  { name: 'first_name',          scope: 'order_lifecycle', description: "Customer's first name",                                                           conditional: false },
  { name: 'company',             scope: 'order_lifecycle', description: 'Company name (when set)',                                                         conditional: true  },
  // Supplier order email (supplier_order_email) — emailed to the supplier when
  // an outsourced order is placed. The spec block is machine-generated.
  { name: 'customer',            scope: 'supplier_order',  description: "Customer name the cards are for",                                                conditional: false },
  { name: 'order_details',       scope: 'supplier_order',  description: 'Machine-generated spec block (Qty / per-person split / Material / Type / Thickness / Finish / Must ship by / Artwork). Keep this exactly — Stock Control reads it.', conditional: false },
]

// ── Default bodies ───────────────────────────────────────────────────────────
//
// Source-of-truth defaults for the Reset button. Must stay in sync
// with the seed inserts in two migrations:
//   * supabase/migrations/000102_add_reply_templates.sql
//     (first_proof, revision)
//   * supabase/migrations/000157_seed_proof_viewer_reply_templates.sql
//     (proof_approval_confirmation, proof_change_request_confirmation,
//      proof_variant_selection_confirmation)
// The migrations seed these once on first apply; subsequent edits
// are admin-driven through the Settings page. Reset reads from this
// constant rather than re-fetching the migrations.
//
// The first_proof / revision bodies use {? company} to demonstrate
// the conditional syntax in the seeded copy so admins see a working
// example before touching anything.

// Bodies do not include a sign-off: Help Scout auto-appends the
// configured signature to every outgoing reply, so a manual
// "Many thanks, PlasmaDesign" duplicates it for the customer.
// Bug audit PV-2026W19-001 flagged the original drift.
export const DEFAULT_BODIES: Record<string, string> = {
  // Pre-send messages
  first_proof:
    `Hi {first_name},\n\nHere's the first proof of your cards{? company} for {company}{/?}. Have a look and let us know what you think.\n\n{url}`,
  revision:
    `Hi {first_name},\n\nHere's v{version_number} of your cards{? company} for {company}{/?} with the changes you asked for. Take another look when you have a moment.\n\n{url}`,
  // Post-action confirmations
  proof_approval_confirmation:
    `Thanks for approving {version_label}. We'll be in touch shortly about next steps.`,
  proof_change_request_confirmation:
    `Thanks, we've recorded your changes for {version_label}:<br><br>{? change_notes}{change_notes}<br><br>{/?}We'll get an updated proof over to you shortly.`,
  proof_variant_selection_confirmation:
    `Thanks, we've recorded your selection for {version_label}: {chosen_variant}.<br><br>{? change_notes}{change_notes}<br><br>{/?}We'll incorporate this and get an updated proof over to you shortly.`,
  // Needs-attention reminders (one-click nudges from the resolve popover).
  // Seeded in 000207; designer_picked variable set; no sign-off.
  nudge_sent_never_viewed:
    `Hi {first_name},\n\nJust checking the proof of your cards{? company} for {company}{/?} reached you — it doesn't look like it's been opened yet. Here's the link again whenever you have a moment:\n\n{url}`,
  nudge_viewed_not_actioned:
    `Hi {first_name},\n\nHope you've had a chance to look over the proof{? company} for {company}{/?}. Any thoughts, or are you happy for us to go ahead? Here's the link if you'd like another look:\n\n{url}`,
  nudge_approaching_dormant:
    `Hi {first_name},\n\nJust a quick nudge on your card proof{? company} for {company}{/?} before it slips off our active list. Let us know if you'd like any changes — here's the link:\n\n{url}`,
  nudge_stuck_in_progress:
    `Hi {first_name},\n\nChecking in on your card proof{? company} for {company}{/?} — we haven't heard back in a little while. Happy to help with any tweaks; here's the link again:\n\n{url}`,
  // Order messages — sent from the order builder with the pay-link.
  order_payment_link:
    `Hi,\n\nYour cards are approved and ready to order. You can choose your quantity, confirm delivery, and pay securely here:\n\n{order_url}\n\nIf you have any questions, just reply to this email.`,

  // Offline (bank-transfer) order confirmation the designer sends from the order
  // builder — no "pay" language (it's already recorded as paid). The link is the
  // same order page, which doubles as the tracking page once tracking is on.
  order_confirmation_link:
    `Hi,\n\nThank you for your order — it's confirmed and on its way into production. You can view your order here, where it'll show its progress as we make and ship it:\n\n{order_url}\n\nIf you have any questions, just reply to this email.`,
  // Order reminders — automated follow-ups for an unpaid order (000238).
  order_reminder_1:
    `Hi {first_name},\n\nJust a gentle reminder that your cards{? company} for {company}{/?} are approved and ready to order whenever you're set. You can choose your quantity and pay securely here:\n\n{order_url}`,
  order_reminder_2:
    `Hi {first_name},\n\nA quick reminder that your order link{? company} for {company}{/?} expires on {order_expiry}. If you'd still like to go ahead, you can complete it here:\n\n{order_url}\n\nIf the link has lapsed by the time you read this, just reply and we'll send a fresh one.`,
  // Order-paid confirmation — posted automatically by the Stripe webhook when a
  // payment lands; Help Scout emails it to the customer (migration 000248).
  order_paid_confirmation:
    `Hi {first_name},\n\nThank you — we've received your payment and your cards{? company} for {company}{/?} are now in production. Your order reference is {payment_reference}.{? order_url}\n\nYou can view your order here, where it'll show its progress as we make and ship it:\n\n{order_url}{/?}\n\nWe'll email you dispatch details as soon as your cards are on their way, and your VAT invoice will arrive in a separate email shortly.\n\nIf you have any questions, just reply to this email.`,
  // Order lifecycle messages — posted by the order-lifecycle edge function when an
  // order link is cancelled (order_cancelled) or a paid/placed order is held for
  // a redesign (order_revision). Seeded in 000260. No sign-off.
  order_cancelled:
    `Hi {first_name},\n\nWe've cancelled the order and payment link for your cards{? company} for {company}{/?}. No payment has been taken.\n\nIf you'd like to go ahead after all, just reply and we'll send a fresh link.`,
  order_revision:
    `Hi {first_name},\n\nWe're updating your cards{? company} for {company}{/?} — a fresh proof will follow shortly for you to approve before we go ahead.\n\nIf you have any questions in the meantime, just reply to this email.`,
  // Supplier order email — emailed to the supplier when an outsourced order is
  // placed. {order_details} is the machine-generated, parser-critical spec block
  // (Qty / split / Material / Type / Thickness / Finish / Must ship by / Artwork);
  // keep it exactly so Stock Control can read the order. Only the prose around
  // it is meant to be edited. Seeded in 000258.
  supplier_order_email:
    `Hi,\n\nPlease produce the following order for {customer}:\n\n{order_details}\n\nMany thanks.`,
}
