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

export type TemplateVariableScope = 'designer_picked' | 'proof_viewer' | 'project_lifecycle' | 'order' | 'order_reminder' | 'order_confirmation' | 'order_lifecycle' | 'supplier_order' | 'inhouse_note'

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
  // Project messages (proof_abandoned) — sent only when the designer ticks
  // "let the customer know" while closing a project off. Deliberately just the
  // customer's name and company: there is no proof link here, because the
  // abandoned page shows a closed card with no artwork on it, so sending
  // someone back to it would be a dead end.
  { name: 'first_name',          scope: 'project_lifecycle', description: "Customer's first name",                                                          conditional: false },
  { name: 'company',             scope: 'project_lifecycle', description: 'Company name (when set)',                                                        conditional: true  },
  // Order messages (order_payment_link) — composed by the designer in the order
  // builder before sending the pay-link to the customer.
  { name: 'order_url',           scope: 'order',           description: "Customer order pay-page link",                                                    conditional: false },
  // Order reminder (order_reminder_1) — the single repeating reminder sent by
  // the automated sender, which has the full order → proof → contact context.
  { name: 'first_name',          scope: 'order_reminder',  description: "Customer's first name",                                                           conditional: false },
  { name: 'company',             scope: 'order_reminder',  description: 'Company name (when set)',                                                         conditional: true  },
  { name: 'order_url',           scope: 'order_reminder',  description: 'Customer order pay-page link',                                                    conditional: false },
  { name: 'order_expiry',        scope: 'order_reminder',  description: 'Date the order link expires (when set)',                                          conditional: true  },
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
  // an outsourced order is placed. {order_details} is the whole spec in one
  // block (the quick option); the individual fields below let an admin lay the
  // email out by hand instead. Nothing here is read by a machine any more —
  // the order goes into Stock Control directly when it's placed — so the
  // wording is free (docs/order-handoff-spec.md §6, Phase 3).
  { name: 'customer',            scope: 'supplier_order',  description: "Customer name the cards are for",                                                conditional: false },
  { name: 'order_details',       scope: 'supplier_order',  description: 'The whole spec in one block (quantity, per-person split, material, type, thickness, finish, must-ship-by, artwork link, and the designer’s note). Use this, or lay the fields out yourself with the variables below.', conditional: false },
  { name: 'order_number',        scope: 'supplier_order',  description: 'The six-digit order number',                                                     conditional: false },
  { name: 'note',                scope: 'supplier_order',  description: 'The designer’s “Note to supplier” for this order, when they typed one. Included in {order_details} — add it yourself if you lay the fields out by hand, or the note is silently dropped.', conditional: true  },
  { name: 'qty',                 scope: 'supplier_order',  description: 'How many cards the supplier makes (the customer’s quantity plus any spoilage overs)', conditional: false },
  { name: 'material',            scope: 'supplier_order',  description: 'The product type the supplier makes (e.g. “Carbon fibre”)',                       conditional: true  },
  { name: 'specific_type',       scope: 'supplier_order',  description: 'The exact card (e.g. “Carbon Fibre CNC”). Always set, so it can repeat the material — the {order_details} block leaves it out when it would.', conditional: false },
  { name: 'thickness',           scope: 'supplier_order',  description: 'Card thickness, on materials that have a choice',                                 conditional: true  },
  { name: 'finish',              scope: 'supplier_order',  description: 'Finish, on materials that have one',                                              conditional: true  },
  { name: 'must_ship_by',        scope: 'supplier_order',  description: 'Date the supplier must ship by (the customer’s date, less delivery time)',        conditional: true  },
  { name: 'per_person',          scope: 'supplier_order',  description: 'One line per person on a split order (“Joe Bloggs — 50”). Empty when the order isn’t split.', conditional: true  },
  { name: 'artwork_link',        scope: 'supplier_order',  description: 'Link to the Dropbox order folder (when there is one)',                            conditional: true  },
  { name: 'prototype_warning',   scope: 'supplier_order',  description: 'The prototype warning line. Empty on a normal production order.',                 conditional: true  },
  // In-house production note (inhouse_production_note) — the staff note posted
  // on the customer's Help Scout thread telling our own workshop what to make.
  // A human message: Stock Control gets the job directly, so nothing here has
  // to keep a fixed shape (docs/order-handoff-spec.md §6, Phase 3).
  { name: 'qty',                 scope: 'inhouse_note',    description: 'How many cards to make',                                                          conditional: false },
  { name: 'card',                scope: 'inhouse_note',    description: 'The card being made — material, and the paper colours on letterpress',            conditional: false },
  { name: 'date_required',       scope: 'inhouse_note',    description: 'Date the cards are needed by (when one is set)',                                  conditional: true  },
  { name: 'ink_front',           scope: 'inhouse_note',    description: 'Ink on the front, on materials where it’s specified',                             conditional: true  },
  { name: 'ink_back',            scope: 'inhouse_note',    description: 'Ink on the back, on materials where it’s specified',                              conditional: true  },
  { name: 'packaging',           scope: 'inhouse_note',    description: 'Domestic or International, from where the order is going',                        conditional: true  },
  { name: 'per_person',          scope: 'inhouse_note',    description: 'One line per person on a split order (“Joe Bloggs — 50”). Empty when the order isn’t split.', conditional: true  },
  { name: 'artwork_link',        scope: 'inhouse_note',    description: 'Link to the Dropbox order folder (when there is one)',                            conditional: true  },
  { name: 'prototype_warning',   scope: 'inhouse_note',    description: 'The prototype warning line. Empty on a normal production order.',                 conditional: true  },
  { name: 'note',                scope: 'inhouse_note',    description: 'Anything the designer typed in the note box when placing the order',              conditional: true  },
  { name: 'customer',            scope: 'inhouse_note',    description: 'Customer name the cards are for',                                                 conditional: false },
  { name: 'order_number',        scope: 'inhouse_note',    description: 'The six-digit order number',                                                      conditional: false },
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
  // Bundle review link — sent from the bundle workspace when a bundle of
  // cards goes to the customer (bundle orders Slice 3; seeded in 000311,
  // id kept as set_review_link — the internal key predates the naming
  // decision). {url} is the one /bundle/:id review link covering every
  // card. No order/payment language — this is the design phase.
  set_review_link:
    `Hi {first_name},\n\nHere are the proofs of your cards{? company} for {company}{/?}. There's a design for each card in the bundle — you can look through and approve each one here:\n\n{url}`,
  // Bundle update — sent from the bundle workspace when a card is added to
  // an already-sent bundle (seeded in 000312). Same {url} as the original
  // review link: the customer keeps the one link.
  bundle_update_link:
    `Hi {first_name},\n\nWe've added another card to your review page{? company} for {company}{/?} — same link as before, with the new design ready to look over alongside the others:\n\n{url}`,
  // Bundle revision — sent from the bundle workspace when the cards awaiting
  // an update send include REVISED ones (a revision round), not just
  // additions (seeded in 000386). The workspace picks this over
  // bundle_update_link whenever any unannounced card is past v1; the
  // post-save bundle checkpoint routes a whole revision round into ONE of
  // these instead of an email per card. Same {url}: the one link.
  bundle_revision_link:
    `Hi {first_name},\n\nWe've updated the designs on your review page{? company} for {company}{/?} — same link as before, with the latest versions ready to look over:\n\n{url}`,
  // Post-action confirmations
  proof_approval_confirmation:
    `Thanks for approving {version_label}. We'll be in touch shortly about next steps.`,
  proof_change_request_confirmation:
    `Thanks, we've recorded your changes for {version_label}:<br><br>{? change_notes}{change_notes}<br><br>{/?}We'll get an updated proof over to you shortly.`,
  proof_variant_selection_confirmation:
    `Thanks, we've recorded your selection for {version_label}: {chosen_variant}.<br><br>{? change_notes}{change_notes}<br><br>{/?}We'll incorporate this and get an updated proof over to you shortly.`,
  // Project closed — the optional note a designer can send when abandoning a
  // project (silent stays the default). Seeded in 000366.
  //
  // The copy is written to sit alongside the customer-facing closed screen,
  // which says only "This proof is closed" and offers a way back in. So: no
  // reason, no blame, nothing final-sounding, and deliberately no {url} — the
  // link still loads but renders the closed card with no artwork on it, so
  // pointing someone back at it would be a dead end. "Reply to this email"
  // lands on the same Help Scout thread the designer is already in; the closed
  // page's own contact form opens a fresh Customer Support conversation
  // instead, which is a worse place for this to arrive.
  proof_abandoned:
    `Hi {first_name},\n\nWe're closing off your card proof{? company} for {company}{/?} for now, so it's not left sitting on your list.\n\nNothing's lost at our end — if you'd like to pick it back up, just reply to this email and we'll carry on from where we left off.`,
  // Needs-attention reminders (one-click nudges from the resolve popover).
  // Seeded in 000207; designer_picked variable set; no sign-off.
  // The `_2` / `_final` ids (seeded in 000313) are the per-position bodies
  // for the automated reminder sequence — send-nudges resolves base → _2 →
  // _final by reminder number so a customer never receives the same email
  // twice. Bodies mirror NUDGE_DEFAULT_BODIES in the edge-function twin.
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
  // Return-tone reminder 1 (migration 000380, seeded there): used instead of
  // nudge_viewed_not_actioned when the customer has come back to their proof
  // on 2+ separate days without deciding — stuck, not hot. Obstacle-removal
  // wording, no closing pressure, and NEVER any reference to visits or views
  // (tracking is only ever disclosed in the negative). The sender's link
  // auto-opens the "Not ready to approve?" panel. Reminders 2+ fall back to
  // the standard _2/_final bodies.
  nudge_viewed_not_actioned_return:
    `Hi {first_name},\n\nNo rush on your card proof{? company} for {company}{/?} — it's saved and waiting whenever you're ready.\n\nIf anything's giving you pause — the price, a detail you'd like changed, or a question — just reply, or use the "Not ready to approve?" option on your proof page and we'll happily adjust:\n\n{url}`,
  // Bundle reminders (migration 000317): ONE reminder for a whole set of cards,
  // pointing at the bundle review link ({url}). Pluralised; no {version_number}.
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
  // Order messages — sent from the order builder with the pay-link.
  order_payment_link:
    `Hi,\n\nYour cards are approved and ready to order. You can choose your quantity, confirm delivery, and pay securely here:\n\n{order_url}\n\nIf you have any questions, just reply to this email.`,

  // Payment link re-sent (000369) — posted automatically when the customer
  // clicks "Email it to me again" on the "Ready to order?" card on their proof
  // page. Nobody composes this one, so it greets by name where we have one and
  // offers a human route if the email still isn't arriving. For a combined
  // payment {order_url} is the single link covering every card.
  order_link_resend:
    `Hi{? first_name} {first_name}{/?},\n\nNo problem — here's the link to order your cards again. You can choose your quantity, confirm delivery, and pay securely here:\n\n{order_url}\n\nIf it keeps not arriving, just reply to this email and we'll sort it out another way.`,

  // Offline (bank-transfer) order confirmation the designer sends from the order
  // builder — no "pay" language (it's already recorded as paid). The link is the
  // same order page, which doubles as the tracking page once tracking is on.
  order_confirmation_link:
    `Hi,\n\nThank you for your order — it's confirmed and on its way into production. You can view your order here, where it'll show its progress as we make and ship it:\n\n{order_url}\n\nIf you have any questions, just reply to this email.`,
  // Order reminder — the single repeating automated follow-up for an unpaid
  // order (000238; collapsed from two stages to one in 000270). The expiry
  // sentence renders only when the order has an expiry date.
  order_reminder_1:
    `Hi {first_name},\n\nJust a reminder that your cards{? company} for {company}{/?} are approved and ready to order whenever you're set. You can choose your quantity and pay securely here:\n\n{order_url}{? order_expiry}\n\nThis order link expires on {order_expiry}.{/?}`,
  // Combined-payment reminder (migration 000388) — the same repeating chase for
  // a payment group, whose members' own links aren't payable while it's live.
  // {order_url} is the one /order/group/ link; {order_expiry} the group's.
  order_reminder_group:
    `Hi {first_name},\n\nJust a reminder that your card orders{? company} for {company}{/?} are approved and ready whenever you're set. They're on a single payment link, so you can settle them all together here:\n\n{order_url}{? order_expiry}\n\nThis payment link expires on {order_expiry}.{/?}`,
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
  // In-house production note — the staff note posted on the customer's Help
  // Scout thread when an in-house order is placed, telling our own workshop
  // what to make. This default reproduces the layout the note has always had,
  // line for line; every optional line is wrapped so it disappears when there's
  // nothing to say (exactly as the old built-in version behaved).
  //
  // Nothing reads this note any more — the job goes into Stock Control directly
  // the moment the order is placed — so the wording is free to change
  // (docs/order-handoff-spec.md §6, Phase 3).
  inhouse_production_note:
    `{? prototype_warning}{prototype_warning}\n{/?}Qty: {qty}\nCard: {card}{? date_required}\nDate required: {date_required}{/?}{? ink_front}\nInk on front: {ink_front}{/?}{? ink_back}\nInk on back: {ink_back}{/?}{? packaging}\nPackaging: {packaging}{/?}{? per_person}\n{per_person}{/?}{? artwork_link}\nArtwork: {artwork_link}{/?}{? note}\n\n{note}{/?}`,
}
