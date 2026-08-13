// The workshop note became an editable template in Phase 3 of the order
// hand-off. The whole safety of that change rests on one claim: the SHIPPED
// DEFAULT renders byte-for-byte what the old line-by-line builder produced, so
// the workshop sees no change on the day it lands.
//
// This test pins that claim. It reimplements the old builder verbatim (from
// place-order's pre-Phase-3 in-house block) and asserts the rendered template
// equals it across every shape a real order takes.
//
// ⚠ ONE deliberate departure, added by migration 000412: the note now opens
// with "Order: <number>". The old builder had no such line, and that omission
// is what let Stock Control's importer re-import the note as a SECOND job under
// a guessed number (Brownies Tree, 13 Aug 2026 — see the 000412 header). So the
// invariant below is now "the old note, plus exactly that one leading line" —
// which still catches any other drift in the workshop note, which is what this
// test is really for.
//
// Run with: npx tsx supabase/functions/_shared/inhouseNoteTemplate.test.ts

import { renderTemplate } from './replyTemplates.ts'

// Byte-identical to INHOUSE_NOTE_DEFAULT in place-order/index.ts, to
// DEFAULT_BODIES.inhouse_production_note in src/lib/replyTemplates.ts, and to
// the body seeded by 000361 + amended by 000412. Change one, change all four.
const INHOUSE_NOTE_DEFAULT =
  'Order: {order_number}\n' +
  '{? prototype_warning}{prototype_warning}\n{/?}Qty: {qty}\nCard: {card}' +
  '{? date_required}\nDate required: {date_required}{/?}' +
  '{? ink_front}\nInk on front: {ink_front}{/?}' +
  '{? ink_back}\nInk on back: {ink_back}{/?}' +
  '{? packaging}\nPackaging: {packaging}{/?}' +
  '{? per_person}\n{per_person}{/?}' +
  '{? artwork_link}\nArtwork: {artwork_link}{/?}' +
  '{? note}\n\n{note}{/?}'

interface Order {
  orderNumber?: string
  isPrototype?: boolean
  prototypeMarker?: string
  qty: number
  card: string
  dateRequiredStr?: string
  inkFront?: string | null
  inkBack?: string | null
  packaging?: string | null
  splitLines?: string[]
  artwork?: string | null
  note?: string
}

// ── The OLD builder, from place-order before Phase 3 ───────────────────────
// One deliberate difference: sanitiseInhouseNote is NOT applied here. It still
// runs in 'off'/'shadow' mode (where Stock Control's parser really does read
// this note) but not in 'live', so it isn't part of the template's job. The
// brace-safety cases below cover the other deliberate difference.
function legacyNote(o: Order): string {
  const lines: string[] = []
  if (o.isPrototype) lines.push(o.prototypeMarker ?? '')
  lines.push(`Qty: ${o.qty}`, `Card: ${o.card}`)
  if (o.dateRequiredStr) lines.push(`Date required: ${o.dateRequiredStr}`)
  if (o.inkFront) lines.push(`Ink on front: ${o.inkFront}`)
  if (o.inkBack) lines.push(`Ink on back: ${o.inkBack}`)
  if (o.packaging) lines.push(`Packaging: ${o.packaging}`)
  for (const sl of o.splitLines ?? []) lines.push(sl)
  if (o.artwork) lines.push(`Artwork: ${o.artwork}`)
  if (o.note) {
    lines.push('')
    for (const nl of o.note.split('\n')) lines.push(nl)
  }
  return lines.join('\n')
}

// ── The NEW path ────────────────────────────────────────────────────────────
function templatedNote(o: Order): string {
  return renderTemplate(INHOUSE_NOTE_DEFAULT, {
    order_number: o.orderNumber ?? '404001',
    prototype_warning: o.isPrototype ? (o.prototypeMarker ?? '') : '',
    qty: String(o.qty),
    card: o.card,
    date_required: o.dateRequiredStr ?? '',
    ink_front: o.inkFront ?? '',
    ink_back: o.inkBack ?? '',
    packaging: o.packaging ?? '',
    per_person: (o.splitLines ?? []).join('\n'),
    artwork_link: o.artwork ?? '',
    note: o.note ?? '',
  })
}

let passed = 0
let failed = 0
function check(name: string, o: Order) {
  // The old note, plus the one line 000412 deliberately added in front of it.
  const want = `Order: ${o.orderNumber ?? '404001'}\n` + legacyNote(o)
  const got = templatedNote(o)
  if (want === got) {
    console.log(`  ✓ ${name}`)
    passed++
  } else {
    console.log(`  ✗ ${name}`)
    console.log(`    old:\n${JSON.stringify(want)}`)
    console.log(`    new:\n${JSON.stringify(got)}`)
    failed++
  }
}

const DBX = 'https://www.dropbox.com/scl/fo/abc/h?rlkey=x&dl=0'

console.log('the shipped default must reproduce the old note, plus the order line')
check('bare minimum (qty + card only)', { qty: 100, card: 'Stainless Steel' })
check('typical in-house order', {
  qty: 250, card: 'Satin Black Plastic', dateRequiredStr: '30 Jun 2026',
  inkFront: 'White', packaging: 'Domestic', artwork: DBX,
})
check('everything set, incl. split + note', {
  isPrototype: true, prototypeMarker: 'PROTOTYPE SAMPLE — up to 2 exact copies, NOT a production run.',
  qty: 2, card: 'Letterpress (Snow, Ebony, Snow) + gilding', dateRequiredStr: '01 Aug 2026',
  inkFront: 'Metallic Gold', inkBack: 'Black', packaging: 'International',
  splitLines: ['Ada — 1', 'Grace — 1'], artwork: DBX, note: 'Rounded corners please',
})
check('per-person split, no inks', {
  qty: 100, card: 'Translucent Plastic', dateRequiredStr: '05 Aug 2026',
  splitLines: ['Joe Bloggs — 50', 'Jane Doe — 50'], packaging: 'Domestic',
})
check('multi-line free note', {
  qty: 50, card: 'Bamboo', note: 'Line one\nLine two\nLine three',
})
check('prototype with no artwork', {
  isPrototype: true, prototypeMarker: 'PROTOTYPE SAMPLE — up to 1 exact copy, NOT a production run.',
  qty: 1, card: 'Gold Metal',
})
check('artwork url keeps its & query string', { qty: 10, card: 'Copper Metal', artwork: DBX })

// ── Substitution must be ONE-SHOT ───────────────────────────────────────────
// renderTemplate re-scans its own output, so a value sitting inside a
// conditional block gets read twice. place-order parks braces in the VALUES to
// stop that; this pins the behaviour the workshop actually needs — a note is
// reproduced verbatim, whatever it contains.
const BRACE_OPEN = '\u0001'
const BRACE_CLOSE = '\u0002'
function renderOnce(body: string, vars: Record<string, string>): string {
  const parked: Record<string, string> = {}
  for (const [k, v] of Object.entries(vars)) {
    parked[k] = String(v ?? '').replaceAll('{', BRACE_OPEN).replaceAll('}', BRACE_CLOSE)
  }
  return renderTemplate(body, parked).replaceAll(BRACE_OPEN, '{').replaceAll(BRACE_CLOSE, '}')
}

console.log('a note is reproduced verbatim, braces and all')
function checkNote(name: string, note: string) {
  const out = renderOnce(INHOUSE_NOTE_DEFAULT, {
    prototype_warning: '', qty: '100', card: 'Steel', date_required: '', ink_front: '',
    ink_back: '', packaging: '', per_person: '', artwork_link: '', note,
  })
  if (out.endsWith(`\n\n${note}`)) {
    console.log(`  \u2713 ${name}`)
    passed++
  } else {
    console.log(`  \u2717 ${name}\n    wanted note verbatim: ${JSON.stringify(note)}\n    got: ${JSON.stringify(out)}`)
    failed++
  }
}
checkNote('plain note', 'Rounded corners please')
checkNote('note naming a file in braces', 'Match the {logo} file exactly')
checkNote('note quoting a template variable', 'Qty is {qty} not 50')
checkNote('note with both braces', 'Use {front}/{back} as supplied')

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
