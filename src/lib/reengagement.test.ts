// Unit tests for src/lib/reengagement.ts
// Run with: npx tsx src/lib/reengagement.test.ts
//
// This module decides what a PAST customer sees when the Reorder desk brings
// them back to /p/:id (000389 / 000392). Two very different kinds of failure
// live in here, and both are worth pinning:
//
//   1. A LEAK. buildReengagementContext reads a row from the reorder register,
//      which carries scores, lifetime value, an email address and the
//      designer's own outcome notes. Its output is stored on the proof and
//      served to an anonymous browser. The allow-list is the only thing
//      standing between the two, so the tests below assert what is ABSENT as
//      hard as what is present.
//
//   2. A LIE. Every sentence here is spoken to someone who did not ask to hear
//      from us, about their own past order. Claiming a date we don't have, or
//      a repeat-customer history that isn't there, spends the one asset the
//      whole feature rests on — that we are demonstrably their real supplier.
//      So each copy branch is pinned to the facts the snapshot actually holds.
//
// Unlike reorderDesk.test.ts this file needs no import shim: reengagement.ts
// imports nothing but previousSpec.ts, which is itself pure. That matters —
// this module is reachable from the customer page, and a customer page must
// not pull a supabase client through a copy module.
//
// The third section is newer and answers a different question: the band SAYS
// what they last bought, and the markers POINT at it in the price grid and the
// thickness guide. A marker is a stronger claim than a sentence — it asserts
// that THIS cell is what they had — so the tests below are mostly about when
// we refuse to place one.

import {
  REENGAGEMENT_COPY,
  buildReengagementContext,
  changeHelp,
  specMatchesMaterial,
  formatOrderMonth,
  historyLine,
  parseReengagementContext,
  previousOrderMarkers,
  previousOrderThicknessRows,
  previousSpecFromReengagement,
  recognitionLine,
  reengagementMatchesMaterial,
  reengagementRequestOnFile,
  reorderNotePrefill,
  reorderQuantityPrefill,
  shouldShowReengagementBand,
  suppressApproveForOutreach,
  variantDimension,
} from './reengagement.ts'
import { chooserGuidance, quantityHint } from './previousSpec.ts'

// ── Harness ─────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.log(`  ✗ ${name}`)
    console.log(`    ${(err as Error).message}`)
    failed++
  }
}

function assert(cond: boolean, message: string) {
  if (!cond) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, label = '') {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${label} expected ${e}, got ${a}`)
}

// ── buildReengagementContext: the allow-list ────────────────────────────────

console.log('\nbuildReengagementContext — the allow-list (security critical)')

test('a full register row yields ONLY the display-safe fields', () => {
  // ⚠ THE SECURITY-CRITICAL TEST. Everything below the seven allowed keys is
  // a real column on the reorder register: the desk's score and its reasons,
  // what the customer has spent with us, their email address, and a
  // designer's private note about how the last chase went. All of it would
  // be stored on the proof and served to an anonymous browser if the builder
  // ever became a spread-and-delete instead of a named allow-list.
  const built = buildReengagementContext({
    last_order_on: '2024-06-01',
    orders_count: 3,
    last_spec: '500 translucent plastic cards (760 micron)',
    last_qty: 500,
    last_variant_id: 'var-760',
    last_variant_label: '760 micron',
    last_material_id: 'mat-plastic',
    score: 87,
    score_reasons: ['3 orders', 'steady cadence'],
    lifetime_value: 1200,
    avg_order_value: 400,
    email: 'someone@example.invalid',
    outcome_note: 'chased twice, went quiet',
    xero_contact_id: 'xc-99',
  })
  assertEqual(
    built,
    {
      last_order_on: '2024-06-01',
      orders_count: 3,
      last_spec: '500 translucent plastic cards (760 micron)',
      last_qty: 500,
      last_variant_id: 'var-760',
      last_variant_label: '760 micron',
      last_material_id: 'mat-plastic',
    },
    'built',
  )
  // Asserted by key set as well as by value, so a future field that happens
  // to stringify identically still trips this. ⚠ This list is also the exact
  // set the database CHECK permits (000392, widened 000393 and again for the
  // four pointing fields) — the two must move together, because the CHECK is
  // subtractive: a key it doesn't name makes every outreach proof fail to
  // INSERT, and a key IT names that this list doesn't will never be written.
  assertEqual(
    Object.keys(built!).sort(),
    [
      'last_material_id',
      'last_order_on',
      'last_qty',
      'last_spec',
      'last_variant_id',
      'last_variant_label',
      'orders_count',
    ],
    'keys',
  )
})

test('the pointing fields are each validated, not merely copied across', () => {
  const base = { last_order_on: '2024-06-01' }
  // A quantity has to be a positive whole number of cards: a fraction means
  // the register did arithmetic it shouldn't have, and either would render
  // as a marker against a row that cannot exist.
  for (const qty of [0, -5, 12.5, NaN, Infinity, '500', null, undefined]) {
    assertEqual(
      buildReengagementContext({ ...base, last_qty: qty as never }),
      base,
      `last_qty ${String(qty)}`,
    )
  }
  // Ids and labels: non-strings, blanks and anything pathologically long are
  // dropped. An over-long "label" would be printed verbatim in the
  // not-available explainer.
  for (const bad of ['', '   ', null, undefined, 42, {}, 'x'.repeat(200)]) {
    assertEqual(
      buildReengagementContext({ ...base, last_variant_id: bad as never }),
      base,
      `last_variant_id ${JSON.stringify(bad)}`,
    )
    assertEqual(
      buildReengagementContext({ ...base, last_material_id: bad as never }),
      base,
      `last_material_id ${JSON.stringify(bad)}`,
    )
    assertEqual(
      buildReengagementContext({ ...base, last_variant_label: bad as never }),
      base,
      `last_variant_label ${JSON.stringify(bad)}`,
    )
  }
})

test('the pointing fields alone conjure no band', () => {
  // They describe where to put a marker, not anything the band can SAY. A
  // snapshot carrying only a variant id would open with "welcome back" and
  // then fail to name when we last made their cards — the one thing that
  // proves we are their real supplier. An empty greeting is worse than none.
  assertEqual(
    buildReengagementContext({
      last_qty: 500,
      last_variant_id: 'var-500',
      last_variant_label: '500 micron',
      last_material_id: 'mat-steel',
    }),
    null,
    'pointing fields only',
  )
})

test('an over-long or empty spec is dropped rather than published', () => {
  // The phrase is derived from a catalogue item name, so it should be short.
  // The cap guards against a pathological free-text description reaching a
  // customer's page as a wall of words.
  const long = 'x'.repeat(200)
  assertEqual(
    buildReengagementContext({ orders_count: 2, last_spec: long }),
    { orders_count: 2 },
    'over-long spec dropped',
  )
  for (const bad of ['', '   ', null, undefined, 42, { qty: 5 }]) {
    assertEqual(
      buildReengagementContext({ orders_count: 2, last_spec: bad as never }),
      { orders_count: 2 },
      `unusable spec ${JSON.stringify(bad)}`,
    )
  }
  // …and a normal one survives with its surrounding whitespace trimmed.
  assertEqual(
    buildReengagementContext({ last_spec: '  50 stainless steel cards (300 micron)  ' }),
    { last_spec: '50 stainless steel cards (300 micron)' },
    'trimmed',
  )
})

test('an unusable or missing date is dropped rather than passed through', () => {
  // A malformed date reaching formatOrderMonth would render nothing anyway,
  // but a half-populated snapshot is worse than none: it makes the band
  // appear (the presence of the object is the gate) with a sentence that has
  // lost its whole point.
  for (const last of ['not-a-date', '2024-6-1', '', '18/03/2024', null, undefined, 20240318]) {
    const built = buildReengagementContext({ last_order_on: last as never, orders_count: 2 })
    assertEqual(built, { orders_count: 2 }, `last_order_on ${JSON.stringify(last)}`)
  }
})

test('a timestamp is truncated to its date, since only the month is ever spoken', () => {
  assertEqual(
    buildReengagementContext({ last_order_on: '2024-06-01T09:30:00Z' }),
    { last_order_on: '2024-06-01' },
    'timestamp',
  )
})

test('a count that is not a positive whole number is dropped', () => {
  // 0 and negatives are nonsense for "how many times they have ordered", and
  // a fraction means the register did arithmetic it shouldn't have. Any of
  // them would surface in historyLine as a sentence a human never wrote.
  for (const count of [0, -1, 2.5, NaN, Infinity, '3', null, undefined]) {
    const built = buildReengagementContext({
      last_order_on: '2024-06-01',
      orders_count: count as never,
    })
    assertEqual(built, { last_order_on: '2024-06-01' }, `orders_count ${String(count)}`)
  }
})

test('nothing usable at all returns null, so no band is shown', () => {
  // An empty greeting is worse than none: it opens with "welcome back" and
  // then fails to say when we last made their cards, which is the one thing
  // that proves we are their real supplier.
  assertEqual(buildReengagementContext({}), null, 'empty row')
  assertEqual(buildReengagementContext({ last_order_on: null, orders_count: null }), null, 'nulls')
  assertEqual(
    buildReengagementContext({ score: 99, lifetime_value: 5000, email: 'a@b.invalid' }),
    null,
    'internals only — a row with nothing sayable must not produce a band',
  )
})

test('either field alone is enough to build a snapshot', () => {
  assertEqual(buildReengagementContext({ last_order_on: '2024-06-01' }), {
    last_order_on: '2024-06-01',
  }, 'date only')
  assertEqual(buildReengagementContext({ orders_count: 4 }), { orders_count: 4 }, 'count only')
})

// ── parseReengagementContext: reading it back off the RPC ───────────────────

console.log('\nparseReengagementContext — reading the snapshot back')

test('anything that is not a plain object reads as "not outreach"', () => {
  // The key is absent on every ordinary proof and on any deployment
  // predating 000392, so this path is the common case, not the error case —
  // it must degrade quietly rather than throw on a customer's page.
  for (const raw of [null, undefined, [], ['a'], 'nonsense', 42, true]) {
    assertEqual(parseReengagementContext(raw), null, `${JSON.stringify(raw) ?? 'undefined'}`)
  }
})

test('a good snapshot round-trips, and a stored one is re-filtered on the way out', () => {
  const ctx = { last_order_on: '2024-03-18', orders_count: 4 }
  assertEqual(parseReengagementContext(ctx), ctx, 'round trip')
  // Reading goes through the same allow-list as writing, so a row written
  // before a column was added to the list — or by hand in the SQL editor —
  // still cannot reach the page with anything extra on it.
  assertEqual(
    parseReengagementContext({ ...ctx, lifetime_value: 9999, outcome_note: 'went quiet' }),
    ctx,
    're-filtered',
  )
})

// ── formatOrderMonth ────────────────────────────────────────────────────────

console.log('\nformatOrderMonth — month precision only')

test('an ISO date becomes a spoken month and year', () => {
  assertEqual(formatOrderMonth('2024-03-18'), 'March 2024', 'March')
  // Both ends of the month index, since an off-by-one here is silent: it
  // renders a real month name, just the wrong one.
  assertEqual(formatOrderMonth('2023-01-05'), 'January 2023', 'January')
  assertEqual(formatOrderMonth('2023-12-31'), 'December 2023', 'December')
})

test('a timestamp formats from its date part', () => {
  assertEqual(formatOrderMonth('2024-03-18T14:00:00Z'), 'March 2024', 'timestamp')
})

test('an unparseable or impossible date returns null rather than a wrong month', () => {
  for (const raw of ['not-a-date', '', '2024-3-8', '18-03-2024']) {
    assertEqual(formatOrderMonth(raw), null, `"${raw}"`)
  }
  // Shaped like an ISO date but no such month — must not index off the end
  // of the table and render "undefined 2024".
  assertEqual(formatOrderMonth('2024-13-01'), null, 'month 13')
  assertEqual(formatOrderMonth('2024-00-01'), null, 'month 0')
})

// ── recognitionLine ─────────────────────────────────────────────────────────

console.log('\nrecognitionLine — the highest-value sentence on the page')

test('date + repeat history names when they last ordered', () => {
  const line = recognitionLine({ last_order_on: '2024-03-18', orders_count: 4 })
  assert(line.includes('March 2024'), `the month must be named (got "${line}")`)
  assert(/last ordered/i.test(line), 'a repeat customer is told when they LAST ordered')
})

test('a date with no repeat history still anchors the memory', () => {
  // orders_count 1 is not a repeat customer: "you last ordered it in…"
  // would imply a series that doesn't exist.
  const line = recognitionLine({ last_order_on: '2024-03-18', orders_count: 1 })
  assert(line.includes('March 2024'), `the month must still be named (got "${line}")`)
  assert(!/last ordered/i.test(line), 'a one-time customer must not be told about a series')
})

test('a one-time customer is never told they "last ordered" — spec or no spec', () => {
  // The date-only branches have always drawn this distinction: "you last
  // ordered" asserts a series. The first spec draft sat ABOVE those branches
  // and ignored orders_count, so the moment a spec existed every one-time
  // customer was told about a series that never happened — and the existing
  // guard test passed only because it supplied no spec.
  const line = recognitionLine(
    { last_order_on: '2024-03-18', orders_count: 1, last_spec: '500 steel cards (300 micron)' },
    { materialDisplay: 'Stainless Steel' },
  )
  assert(line.includes('500 steel cards (300 micron)'), `the spec still appears: "${line}"`)
  assert(!/last ordered/i.test(line), `no series may be implied: "${line}"`)

  const repeat = recognitionLine(
    { last_order_on: '2024-03-18', orders_count: 4, last_spec: '500 steel cards (300 micron)' },
    { materialDisplay: 'Stainless Steel' },
  )
  assert(/last ordered/i.test(repeat), `a repeat customer still gets "last ordered": "${repeat}"`)
})

test('a purchase is only spoken when it describes the artwork on screen', () => {
  // THE truthfulness guard. The spec comes from the customer's latest INVOICE;
  // the page shows whatever the designer rebuilt from the archive. Someone who
  // bought steel in 2019 and plastic last year gets a steel proof, and pairing
  // it with "you last ordered 500 translucent plastic cards" turns two true
  // facts into a false impression.
  const ctx = {
    last_order_on: '2026-01-26',
    orders_count: 5,
    last_spec: '500 translucent plastic cards (760 micron)',
  }
  const mismatch = recognitionLine(ctx, { materialDisplay: 'Stainless Steel' })
  assert(!mismatch.includes('translucent'), `a different material must not be claimed: "${mismatch}"`)
  assert(mismatch.includes('January 2026'), `but the date survives: "${mismatch}"`)

  const match = recognitionLine(ctx, { materialDisplay: 'Translucent Plastic' })
  assert(match.includes('500 translucent plastic cards'), `a match is spoken: "${match}"`)
})

test('material matching handles the catalogue, including its one synonym', () => {
  const cases: [string, string, boolean][] = [
    ['50 stainless steel cards (300 micron)', 'Stainless Steel', true],
    ['100 matte black metal cards (300 micron)', 'Matte Black Metal', true],
    ['1,000 letterpress cards (900gsm)', 'Letterpress', true],
    ['100 perspex cards (3mm thick)', 'Acrylic (Perspex)', true], // the synonym
    ['500 letterpress cards (900gsm)', 'Stainless Steel', false],
    ['70 gold metal cards (500 micron)', 'Rose Gold Metal', true], // shares "gold"
    ['500 translucent plastic cards (760 micron)', 'Full Colour Plastic', true], // shares "plastic"
  ]
  for (const [spec, material, expected] of cases) {
    assertEqual(specMatchesMaterial(spec, material), expected, `${spec} vs ${material}`)
  }
  // A version with no material makes no competing claim, so the spec stands.
  assertEqual(specMatchesMaterial('50 steel cards', null), true, 'no material to contradict')
  assertEqual(specMatchesMaterial(null, 'Stainless Steel'), false, 'no spec, nothing to say')
})

test('the spec, when known, says what they bought as well as when', () => {
  // "You last ordered 500 translucent plastic cards (760 micron) in January
  // 2026" is far stronger evidence that we're their real supplier than a bare
  // date, and it saves them remembering what they bought.
  const line = recognitionLine(
    {
      last_order_on: '2026-01-26',
      orders_count: 5,
      last_spec: '500 translucent plastic cards (760 micron)',
    },
    { materialDisplay: 'Translucent Plastic' },
  )
  assert(line.includes('500 translucent plastic cards (760 micron)'), `spec verbatim: "${line}"`)
  assert(line.includes('January 2026'), `and the month: "${line}"`)
})

test('a spec with no date still says what, and claims no when', () => {
  const line = recognitionLine(
    { last_spec: '50 stainless steel cards (300 micron)', orders_count: 3 },
    { materialDisplay: 'Stainless Steel' },
  )
  assert(line.includes('50 stainless steel cards (300 micron)'), `spec verbatim: "${line}"`)
  assert(!/\d{4}/.test(line.replace(/\(\d+ micron\)/g, '')), `no year invented: "${line}"`)
})

test('no date at all claims nothing about when', () => {
  // The band can still appear on a count-only snapshot, and the sentence has
  // to survive that without inventing a date or trailing off.
  const line = recognitionLine({ orders_count: 5 })
  assert(line.length > 0, 'there must still be a sentence')
  assert(!/\d{4}/.test(line), `no year may be claimed without one in the snapshot (got "${line}")`)
  assert(!/undefined|null|NaN/i.test(line), 'and no placeholder may leak into it')
})

test('an empty snapshot still produces a whole sentence', () => {
  const line = recognitionLine({})
  assert(line.length > 0 && line.trim().endsWith('.'), `got "${line}"`)
  assert(!/undefined|null|NaN/i.test(line), 'no placeholder may leak into it')
})

// ── historyLine ─────────────────────────────────────────────────────────────

console.log('\nhistoryLine — the quiet thank-you')

test('fewer than three orders says nothing at all', () => {
  // Two orders is not a history worth flattering, and a number attached to a
  // small figure reads as marketing rather than recognition.
  for (const n of [undefined, 1, 2]) {
    assertEqual(historyLine({ orders_count: n as never }), null, `orders_count ${String(n)}`)
  }
  assertEqual(historyLine({}), null, 'an empty snapshot')
})

test('three or more mentions the count', () => {
  const three = historyLine({ orders_count: 3 })
  assert(three != null && three.includes('3'), `the count must be stated (got "${three}")`)
  const many = historyLine({ orders_count: 12 })
  assert(many != null && many.includes('12'), `the count must be stated (got "${many}")`)
})

// ── detailsCheckItems ───────────────────────────────────────────────────────

console.log('\nchangeHelp — what to look at, named on the action that acts on it')

test('the QR clause appears only when the artwork actually carries one', () => {
  // A dead QR is worse than no QR, and it is the one thing a customer cannot
  // check by squinting at the card in their hand — but mentioning one on a
  // card that has none sends them hunting for something that isn't there.
  const without = changeHelp({ hasQrCodes: false })
  const with_ = changeHelp({ hasQrCodes: true })
  assert(!/QR/i.test(without), 'no QR mention on artwork with no QR')
  assert(/QR/i.test(with_), 'the QR clause appears when there is one to check')
})

test('both forms name the fields most likely to have gone stale', () => {
  // The whole reason this text exists: naming specifics is what makes someone
  // actually look, rather than glancing at a familiar design and moving on.
  for (const help of [changeHelp({ hasQrCodes: false }), changeHelp({ hasQrCodes: true })]) {
    for (const field of ['Names', 'job titles', 'phone numbers', 'addresses']) {
      assert(help.toLowerCase().includes(field.toLowerCase()), `names ${field}: ${help}`)
    }
  }
})

test('it never instructs the customer or editorialises about their business', () => {
  // The earlier draft ("Details move on. Before anything is printed, check
  // these are still right") told an adult who didn't ask to be told, and
  // narrated their own company back at them. Rob called it presumptuous; this
  // pins the correction so it can't creep back.
  const all = [
    changeHelp({ hasQrCodes: true }),
    REENGAGEMENT_COPY.intro,
    REENGAGEMENT_COPY.newPersonHelp,
  ].join(' ')
  for (const phrase of ['details move on', 'make sure', 'you should', 'please check']) {
    assert(!all.toLowerCase().includes(phrase), `instructing phrase crept back in: "${phrase}"`)
  }
})

// ── Pointing at what they bought ────────────────────────────────────────────

console.log('\npreviousSpecFromReengagement — when a marker may be placed at all')

// A snapshot with everything: they bought 250 of the 500-micron steel card.
const BOUGHT = {
  last_order_on: '2024-03-18',
  orders_count: 4,
  last_qty: 250,
  last_variant_id: 'var-500',
  last_variant_label: '500 micron',
  last_material_id: 'mat-steel',
}

test('a different material refuses EVERY marker', () => {
  // ⚠ THE TRUTHFULNESS GUARD, and the reason this returns a spec rather than
  // the page reading the fields directly. The remembered purchase comes from
  // an invoice; the page shows whatever the designer rebuilt from the
  // archive. A tint down the "760 micron" column of a steel proof doesn't
  // merely mention plastic — it asserts that this cell is what they had.
  assertEqual(
    previousSpecFromReengagement(BOUGHT, { materialId: 'mat-plastic' }),
    null,
    'different material',
  )
  // Unknown is not the same as matching: an absent id on either side is a
  // refusal, so a pre-existing snapshot from before these fields existed
  // quietly marks nothing rather than guessing.
  assertEqual(previousSpecFromReengagement(BOUGHT, { materialId: null }), null, 'no material on page')
  assertEqual(
    previousSpecFromReengagement(
      { ...BOUGHT, last_material_id: undefined },
      { materialId: 'mat-steel' },
    ),
    null,
    'no material on the snapshot',
  )
  assertEqual(previousSpecFromReengagement(null, { materialId: 'mat-steel' }), null, 'no snapshot')
  assert(!reengagementMatchesMaterial(BOUGHT, 'mat-plastic'), 'the guard says so directly too')
  assert(reengagementMatchesMaterial(BOUGHT, 'mat-steel'), 'and passes the matching case')
})

test('a matching material yields a spec the pay-page rules can read', () => {
  // The shape is previousSpec.ts's, deliberately: the badge text, the
  // id-matching and the not-available wording are all its rules, already
  // reviewed, and a returning customer must read the same thing on the proof
  // page and the pay page.
  const spec = previousSpecFromReengagement(BOUGHT, { materialId: 'mat-steel' })
  assertEqual(
    spec,
    {
      variant_id: 'var-500',
      variant_label: '500 micron',
      option_id: null,
      option_label: null,
      quantity: 250,
      label: 'March 2024',
      source: 'auto',
    },
    'spec',
  )
  // The finish is deliberately null: the register knows the thickness but not
  // which artwork tab it was proofed under, and a guess would badge a tab at
  // random.
  const finish = chooserGuidance('finish', spec, ['opt-gloss', 'opt-matte'], null)
  assertEqual(finish.badgeId, null, 'no finish badge')
  assertEqual(finish.note, null, 'and nothing said about finishes')
})

test('the badge lands on the column they actually bought, matched by id', () => {
  const spec = previousSpecFromReengagement(BOUGHT, { materialId: 'mat-steel' })
  const guidance = chooserGuidance('thickness', spec, ['var-300', 'var-500', 'var-800'], null)
  assertEqual(guidance.badgeId, 'var-500', 'badged column')
  assert(guidance.badgeText === 'Your last order · March 2024', `badge text: ${guidance.badgeText}`)
  assert(guidance.suppressCatalogueBadges, 'our own recommendations stand down while it shows')
  assertEqual(guidance.note, null, 'nothing to explain — it is right there in the grid')
})

test('a thickness this proof does not price is explained, never badged', () => {
  // The grid is scoped to what THIS proof prices, so the option may still be
  // in the catalogue — hence "isn't available on this order" rather than "we
  // no longer offer", which would be a lie we cannot check.
  const spec = previousSpecFromReengagement(BOUGHT, { materialId: 'mat-steel' })
  const guidance = chooserGuidance('thickness', spec, ['var-300', 'var-800'], null)
  assertEqual(guidance.badgeId, null, 'no badge')
  assert(guidance.note != null && guidance.note.includes('500 micron'), `names it: ${guidance.note}`)
  assert(!/no longer offer/i.test(guidance.note!), `claims nothing about the catalogue: ${guidance.note}`)
  assert(!guidance.suppressCatalogueBadges, 'and nothing of ours needs to stand down')
})

test('a quantity with no thickness still marks the row', () => {
  // Most materials — paper, wood, acrylic, carbon fibre — have one column, so
  // the quantity row is the ONLY marker available. It has to survive a
  // snapshot that knows nothing about variants.
  const spec = previousSpecFromReengagement(
    { last_order_on: '2024-03-18', last_qty: 500, last_material_id: 'mat-paper' },
    { materialId: 'mat-paper' },
  )
  assert(spec != null, 'a spec is still built')
  assertEqual(spec!.quantity, 500, 'the quantity survives')
  assertEqual(spec!.variant_id, null, 'with no thickness claimed')
  // Nothing is said about thicknesses at all — not even the explainer, which
  // would be answering a question the snapshot never asked.
  assertEqual(chooserGuidance('thickness', spec, ['var-a'], null).note, null, 'silent')
  const hint = quantityHint(spec)
  assert(hint != null && hint.includes('500'), `the number is stated: ${hint}`)
})

test('a remembered label with no catalogue variant behind it points at nothing', () => {
  // ⚠ 000399 stores last_variant_label even when no variant resolves, and it is
  // right to: on live 2,263 rows carry a label and only 1,039 an id, the rest
  // being real purchases of letterpress "900gsm" and perspex "3mm thick" —
  // materials priced by ink count, or gone from the catalogue. The label is the
  // only record of what those customers bought.
  //
  // But a bare label cannot say which DIMENSION it described, and previousSpec
  // reads "label present, id not offered" as retired-or-not-offered and prints
  // "…which isn't available on this order — the thicknesses above are the
  // current options". Over an ink-count grid that is simply false, and it was
  // false for 822 of 2,158 markable rows against roughly 25 honest ones.
  //
  // So the label rides with the id or not at all. The cost is named and
  // accepted: a genuinely retired variant whose id the FK nulled loses its
  // explainer. Silence, for a sentence we cannot check.
  const spec = previousSpecFromReengagement(
    { ...BOUGHT, last_variant_id: undefined },
    { materialId: 'mat-steel' },
  )
  assert(spec != null, 'the quantity still gives us something to point at')
  assertEqual(spec!.variant_label, null, 'but the label is not carried on its own')
  assertEqual(spec!.variant_id, null, 'and there was never an id')
  assertEqual(spec!.quantity, 250, 'the quantity row survives untouched')
  // The consequence, stated where it matters: nothing is said about the grid.
  assertEqual(
    chooserGuidance('thickness', spec, ['var-300', 'var-800'], null).note,
    null,
    'no explainer can be conjured from a label alone',
  )
  // And with no quantity either there is nothing to mark at all.
  assertEqual(
    previousSpecFromReengagement(
      { ...BOUGHT, last_variant_id: undefined, last_qty: undefined },
      { materialId: 'mat-steel' },
    ),
    null,
    'a label on its own is not a marker',
  )
})

test('nothing to point at yields no spec, even on a matching material', () => {
  // The band still shows — it has a date to speak. There is simply no marker.
  assertEqual(
    previousSpecFromReengagement(
      { last_order_on: '2024-03-18', orders_count: 4, last_material_id: 'mat-steel' },
      { materialId: 'mat-steel' },
    ),
    null,
    'material known, purchase not',
  )
})

// ── Why the ORDER BUILDER reads the proof, not the register ─────────────────
//
// Part B of the re-scrape spec proposed a second source for the builder's
// "Their last order": look the customer up in the register when we hold no paid
// order. Measured against live, that lookup returned 17 answers of which 14 were
// the proof's OWN order handed back as the customer's PREVIOUS one — because
// reconcile_reorder_register() folds app payments into the register, and the
// only discriminator available was a date whose two sides come from different
// clocks (Xero's invoice date vs Stripe's payment stamp, 1-16 days apart).
//
// So the builder reads the PROOF's own reengagement_context instead: a snapshot
// written once at outreach time, from history that was already complete then,
// which therefore cannot echo an order placed afterwards. These tests pin the
// properties that design relies on.

test('the snapshot converts to exactly the builder\'s PreviousSpec shape', () => {
  const spec = previousSpecFromReengagement(BOUGHT, { materialId: BOUGHT.last_material_id })
  assert(spec !== null, 'a matching snapshot converts')
  assert(spec!.variant_id === BOUGHT.last_variant_id, 'variant id rides through')
  assert(spec!.quantity === BOUGHT.last_qty, 'quantity rides through')
  assert(spec!.source === 'auto', 'it is an auto suggestion, not a hand entry')
})

test('⚠ it NEVER emits a finish, so the builder cannot suggest one', () => {
  // The register learned finishes in 000407, but they are deliberately not let
  // through here — see the spec's decision 4. Measured: only 5 of the surfaced
  // answers would carry one, so the gate costs nothing and stays until it is
  // explicitly opened.
  const spec = previousSpecFromReengagement(BOUGHT, { materialId: BOUGHT.last_material_id })
  assert(spec!.option_id === null, 'no option id')
  assert(spec!.option_label === null, 'no option label')
})

test('⚠ a material mismatch refuses the WHOLE spec, not just the variant', () => {
  // The quantity and the date must go too. "Last time you ordered 1,500" printed
  // over a grid for a different material is a claim about the customer's own
  // history that happens to be about a different product — and it reaches the
  // pay page through previous_spec, which is customer-visible.
  const spec = previousSpecFromReengagement(BOUGHT, { materialId: 'a-different-material' })
  assert(spec === null, 'nothing at all, not a partial suggestion')
})

test('the month is pre-formatted, so no caller can re-derive it from a timestamp', () => {
  // ⚠ The register stores a DATE. Casting it to a timestamptz uses the server's
  // timezone while the client formats in the browser's, which slides a
  // 1st-of-month into the previous month west of Greenwich.
  const spec = previousSpecFromReengagement(
    { ...BOUGHT, last_order_on: '2024-03-01' },
    { materialId: BOUGHT.last_material_id },
  )
  assert(spec!.label === 'March 2024', `got ${spec!.label}`)
})

console.log('\nvariantDimension — what a grid’s columns actually are')

test('one known type is the dimension; anything else refuses', () => {
  // ⚠ The field the first cut of this feature forgot existed. A proof's grid
  // is columned by whatever its material is priced on — metal by thickness,
  // Standard Paper by finish, Translucent / Satin Plastic and Letterpress by
  // INK COUNT ("2 Inks", "3 Inks"). Assuming thickness makes every sentence
  // written about those columns false.
  assertEqual(variantDimension(['thickness', 'thickness']), 'thickness', 'thickness')
  assertEqual(variantDimension(['ink_count']), 'ink_count', 'ink count')
  assertEqual(variantDimension(['finish']), 'finish', 'finish')
  assertEqual(variantDimension(['default']), 'default', 'default')
  // Empty, mixed, unresolvable (a variant row the page couldn't find) and
  // anything the catalogue might grow later all refuse rather than guess. A
  // grid whose dimension is unknown gets no sentence about its columns.
  assertEqual(variantDimension([]), null, 'empty grid')
  assertEqual(variantDimension(['thickness', 'ink_count']), null, 'mixed grid')
  assertEqual(variantDimension(['thickness', undefined]), null, 'one row unresolved')
  assertEqual(variantDimension([null]), null, 'no type at all')
  assertEqual(variantDimension(['weight']), null, 'a type this module cannot name')
})

console.log('\npreviousOrderMarkers — one decision, read by every surface')

// The two-step the page performs: resolve the purchase, then resolve it
// against the columns THIS grid renders and what those columns are.
function markersFor(
  ctx: Parameters<typeof previousSpecFromReengagement>[0],
  opts: {
    materialId?: string
    offeredVariantIds: readonly string[]
    dimension: Parameters<typeof previousOrderMarkers>[1]['dimension']
  },
) {
  const spec = previousSpecFromReengagement(ctx, { materialId: opts.materialId ?? 'mat-steel' })
  return previousOrderMarkers(spec, {
    offeredVariantIds: opts.offeredVariantIds,
    dimension: opts.dimension,
  })
}

test('an ink-count grid is never narrated as though it showed thicknesses', () => {
  // ⚠ THE 822-ROW BUG. Translucent Plastic, Satin Plastic and Letterpress are
  // priced by ink count, so their columns read "2 Inks", "3 Inks" — and the
  // page used to hand every grid to the THICKNESS chooser regardless. A
  // returning plastic customer whose remembered "760 micron" matched none of
  // those columns was told, under a grid of ink counts: "Your last order was
  // 760 micron, which isn't available on this order — the thicknesses above
  // are the current options." Every clause of that is wrong.
  const marks = markersFor(
    {
      ...BOUGHT,
      last_material_id: 'mat-plastic',
      last_variant_id: 'var-760',
      last_variant_label: '760 micron',
    },
    { materialId: 'mat-plastic', offeredVariantIds: ['var-ink2', 'var-ink3'], dimension: 'ink_count' },
  )
  assertEqual(marks.note, null, 'nothing is said about columns we have no wording for')
  assertEqual(marks.badgeId, null, 'and no column is badged')
  // …but the quantity marker is untouched. It is a number of cards, which
  // means the same thing whatever the columns are — and on these single-choice
  // grids it is the only marker there is, so losing it would take the feature
  // away from the very customers the bug was hurting.
  assertEqual(marks.quantity, 250, 'the quantity row still gets its marker')
  assert(marks.badgeTextShort != null, 'and the chip to put on it')
  assert(marks.quantityNote != null && marks.quantityNote.includes('250'), 'and its fallback line')
})

test('a "default" grid is equally silent, and a finish grid claims no finish', () => {
  // Wood, acrylic and carbon fibre carry a single 'default' variant: there is
  // no choice on screen, so there is nothing to explain.
  const plain = markersFor(BOUGHT, { offeredVariantIds: ['var-only'], dimension: 'default' })
  assertEqual(plain.note, null, 'no note')
  assertEqual(plain.badgeId, null, 'no badge')
  assertEqual(plain.quantity, 250, 'quantity survives')

  // Standard Paper's columns ARE finishes, so the finish chooser is the honest
  // one to ask — and it marks nothing here, because the register remembers the
  // variant a customer bought and never which finish option it was. Under-
  // claiming deliberately: a guessed finish would badge a column at random.
  const paper = markersFor(BOUGHT, { offeredVariantIds: ['var-300', 'var-500'], dimension: 'finish' })
  assertEqual(paper.badgeId, null, 'no finish badge')
  assertEqual(paper.note, null, 'and no explainer about finishes')
  assertEqual(paper.quantity, 250, 'quantity survives here too')
})

test('a thickness grid still badges the column, and still explains a missing one', () => {
  // The behaviour the fix must not cost. Both halves are the legitimate ~25
  // live cases the false 822 were drowning out.
  const badged = markersFor(BOUGHT, {
    offeredVariantIds: ['var-300', 'var-500', 'var-800'],
    dimension: 'thickness',
  })
  assertEqual(badged.badgeId, 'var-500', 'the column they bought')
  assertEqual(badged.badgeText, 'Your last order · March 2024', 'dated chip for roomy surfaces')
  assertEqual(badged.badgeTextShort, 'Your last order', 'undated chip for the grid’s narrow cells')
  assertEqual(badged.badgeLabel, '500 micron', 'the frozen label, for prose surfaces')
  assertEqual(badged.note, null, 'nothing to explain — it is right there')

  const missing = markersFor(BOUGHT, {
    offeredVariantIds: ['var-300', 'var-800'],
    dimension: 'thickness',
  })
  assertEqual(missing.badgeId, null, 'no column to badge')
  assert(missing.note != null && missing.note.includes('500 micron'), `names it: ${missing.note}`)
  assert(/thickness/i.test(missing.note!), `in the grid’s own vocabulary: ${missing.note}`)
  assert(!/no longer offer/i.test(missing.note!), 'and claims nothing about the catalogue')
})

test('no purchase at all yields a wholly empty set of markers', () => {
  const none = previousOrderMarkers(null, {
    offeredVariantIds: ['var-500'],
    dimension: 'thickness',
  })
  assertEqual(
    none,
    {
      badgeId: null,
      badgeText: null,
      badgeTextShort: null,
      badgeLabel: null,
      note: null,
      quantity: null,
      quantityNote: null,
    },
    'every field empty — an ordinary proof marks nothing',
  )
})

console.log('\npreviousOrderThicknessRows — the guide row they last bought')

const GUIDE = [
  { label: '300µm', name: 'Slim', description: '…' },
  { label: '500µm', name: 'Mid-weight', description: '…', badge: 'Most popular' },
  { label: '800µm', name: 'Substantial', description: '…' },
]

// The grid the guide sits beside: all three thicknesses priced.
const FULL_GRID = { offeredVariantIds: ['var-300', 'var-500', 'var-800'], dimension: 'thickness' } as const

test('the row is matched across the micron / µm spelling gap', () => {
  // The catalogue writes "500 micron" and the customer-facing guide writes
  // "500µm" — and the µ is sometimes a micro sign and sometimes a Greek mu.
  // Comparing the number sidesteps all of it.
  const rows = previousOrderThicknessRows(GUIDE, markersFor(BOUGHT, FULL_GRID))
  assertEqual(rows.map((r) => r.badge), [undefined, 'Your last order · March 2024', undefined], 'badges')
  // ⚠ And "Most popular" is GONE. Two badges on two different rows is the
  // page nudging a returning customer off their own history — precisely what
  // previousSpec's suppressCatalogueBadges rule exists to prevent.
  assert(!rows.some((r) => r.badge === 'Most popular'), 'the catalogue badge stands down')
})

test('a curated grid that drops their thickness leaves the guide unbadged', () => {
  // ⚠ THE CONTRADICTION. A designer may curate the grid down to the thicknesses
  // this proof offers (displayed_variant_ids), and the grid then says plainly
  // "your last order was 500 micron, which isn't available on this order".
  // The guide used to decide separately, by parsing microns out of the
  // remembered label and never consulting the ids the grid renders — so it
  // badged "500µm · Your last order" a few centimetres from the sentence
  // saying that exact thickness wasn't available. Two confident, contradictory
  // claims about the customer's own history, on one screen.
  const marks = markersFor(BOUGHT, {
    offeredVariantIds: ['var-300', 'var-800'],
    dimension: 'thickness',
  })
  assert(marks.note != null, 'the grid is the one explaining the absence')
  assertEqual(
    previousOrderThicknessRows(GUIDE, marks).map((r) => r.badge),
    [undefined, undefined, undefined],
    'so the guide badges nothing — it may only echo what the grid badged',
  )
  // And the same when the grid was never asked, because its columns are not
  // thicknesses at all: an ink-count proof shows no guide, but a marker
  // leaking through would be a thickness claim nobody made.
  assertEqual(
    previousOrderThicknessRows(
      GUIDE,
      markersFor(BOUGHT, { offeredVariantIds: ['var-ink2'], dimension: 'ink_count' }),
    ).map((r) => r.badge),
    [undefined, undefined, undefined],
    'no dimension, no badge',
  )
})

test('with no last order the guide carries no badges at all', () => {
  // This surface has never shown the catalogue's "Most popular" — it is copy
  // for the pay-page chooser. Rendering opt.badge naively would put a
  // recommendation on every metal proof in the system, about a thickness the
  // designer already chose.
  for (const rows of [
    previousOrderThicknessRows(GUIDE, null),
    previousOrderThicknessRows(GUIDE, previousOrderMarkers(null, FULL_GRID)),
  ]) {
    assertEqual(rows.map((r) => r.badge), [undefined, undefined, undefined], 'no badges')
  }
  // Same when their thickness simply isn't one of the rows shown.
  const marks = markersFor({ ...BOUGHT, last_variant_label: '900 micron' }, FULL_GRID)
  assertEqual(marks.badgeId, 'var-500', 'the grid badged its column')
  assertEqual(
    previousOrderThicknessRows(GUIDE, marks).map((r) => r.badge),
    [undefined, undefined, undefined],
    'no row to badge',
  )
})

test('a label with no micron unit never matches by bare number', () => {
  // "3mm thick" and a "300µm" row share no digits, but a looser reading of
  // either would pair a millimetre with a micron. Both sides must carry a
  // micron unit or there is no match.
  const marks = markersFor({ ...BOUGHT, last_variant_label: '3mm thick' }, FULL_GRID)
  const millimetreRow: { label: string; name: string; description: string; badge?: string }[] = [
    { label: '3mm', name: 'Thick', description: '…' },
  ]
  const rows = previousOrderThicknessRows(millimetreRow, marks)
  assertEqual(rows.map((r) => r.badge), [undefined], 'no badge across units')
})

// ── shouldShowReengagementBand ──────────────────────────────────────────────

console.log('\nshouldShowReengagementBand — when the page changes its opening')

const CTX = { last_order_on: '2024-03-18', orders_count: 4 }

test('a live outreach proof on its current version shows the band', () => {
  for (const status of ['in_progress', 'dormant', null, undefined]) {
    assert(
      shouldShowReengagementBand({ context: CTX, proofStatus: status, isCurrentVersion: true }),
      `status ${String(status)} should still greet the customer`,
    )
  }
})

test('no snapshot means no band — this is what keeps it off ordinary proofs', () => {
  assert(
    !shouldShowReengagementBand({ context: null, proofStatus: 'in_progress', isCurrentVersion: true }),
    'a customer who asked for their proof must get the ordinary page',
  )
})

test('an older version shows no band', () => {
  // The greeting would sit above artwork the customer is only browsing, and
  // the details check would be against a card that is not the one on offer.
  assert(
    !shouldShowReengagementBand({ context: CTX, proofStatus: 'in_progress', isCurrentVersion: false }),
    'an earlier version is browsing, not deciding',
  )
})

test('an approved or abandoned proof shows no band', () => {
  // Approved has its own celebration and the decision is already made;
  // abandoned renders the closed screen, where a welcome would be grotesque.
  for (const status of ['approved', 'abandoned']) {
    assert(
      !shouldShowReengagementBand({ context: CTX, proofStatus: status, isCurrentVersion: true }),
      `status ${status} must not be greeted`,
    )
  }
})

// ── The copy's standing constraints ─────────────────────────────────────────

console.log('\nthe copy — pressure, promises and links')

test('nothing in the band pressures a customer we approached', () => {
  // We started this conversation. Urgency, scarcity or a countdown reads as
  // spam and spends a relationship that took years to build — see the header
  // of ReengagementBand.tsx.
  const forbidden =
    /\b(hurry|act now|limited time|expires?|ends soon|last chance|only \d+ left|don.t miss)\b/i
  for (const [key, v] of Object.entries(REENGAGEMENT_COPY)) {
    assert(!forbidden.test(v), `copy "${key}" applies pressure: "${v}"`)
  }
})

test('no copy carries a link, a path, a token or a price', () => {
  // Same rule the Ready-to-order card follows (000367): a /p/ link is shared
  // broadly, so nothing rendered on it may carry a bearer capability — and
  // the prices live in the grid below, where they are computed rather than
  // written down.
  for (const [key, v] of Object.entries(REENGAGEMENT_COPY)) {
    const t = v.toLowerCase()
    for (const bad of ['/order/', '/p/', 'token', 'http://', 'https://']) {
      assert(!t.includes(bad), `copy "${key}" must never contain ${bad}: "${v}"`)
    }
    assert(!/[£$€]\s?\d/.test(v), `copy "${key}" must quote no amount: "${v}"`)
  }
})

test('both openings are named, and the exit is a choice rather than a failure', () => {
  // The buying route and the new-joiner route are peers; the exit is a win too
  // (information that stops the chase), so none may be worded as a refusal the
  // customer has to justify.
  assert(REENGAGEMENT_COPY.repeatAction.length > 0, 'the buying route must be named')
  assert(REENGAGEMENT_COPY.newPersonAction.length > 0, 'the new-joiner route must be named')
  assert(REENGAGEMENT_COPY.declineAction.length > 0, 'the exit must be named')
  assert(
    !/no problem|don't worry/i.test(REENGAGEMENT_COPY.declineAction),
    'the exit is named as a choice, not apologised for',
  )
})

// ── The band collects a request; it never transacts ─────────────────────────
//
// This section exists because the band's actions used to point at the page's
// own Approve button, which was wrong in a way no copy test could catch: on an
// outreach proof a press marks the register "Ordered again" with no order in
// existence. The rules below are the fix, and they are the kind that shipped
// broken twice on this project — fully wired except one call site — so each is
// pinned at the boundary rather than in the middle.

test('the reassurance states the boundary the page cannot cross', () => {
  const t = REENGAGEMENT_COPY.reassurance.toLowerCase()
  assert(t.includes('nothing has been ordered'), 'must say nothing has been ordered')
  assert(t.includes('nothing is being printed'), 'must say nothing is being printed')
})

test('no acknowledgement claims a payment link has been sent', () => {
  // The form may promise a link is COMING (a designer sends it by hand); the
  // acknowledgement must not imply one already exists, because on this page
  // it never does yet.
  for (const key of ['sent', 'already'] as const) {
    const t = REENGAGEMENT_COPY[key].toLowerCase()
    assert(!/link/.test(t), `"${key}" must not mention a link: "${REENGAGEMENT_COPY[key]}"`)
  }
})

test('only the new-joiner prompt is pre-filled, and it names all three fields', () => {
  // An empty box is the honest prompt for a plain repeat: pre-filling a change
  // would invent one the customer has not got. The new-joiner path is the
  // opposite — naming the fields is the entire reason it is a separate door,
  // and a first reply carrying all three is usually the only reply needed.
  assert(reorderNotePrefill('repeat') === '', 'a plain repeat starts empty')
  const p = reorderNotePrefill('new_person').toLowerCase()
  for (const field of ['name', 'job title', 'contact details']) {
    assert(p.includes(field), `the new-joiner prefill must name "${field}"`)
  }
})

test('the quantity box starts on what they actually bought, or on nothing', () => {
  // Their last quantity is almost always the right answer and typing a number
  // on a phone is where a mildly-interested visitor gives up. But an invented
  // default would be a confident claim about their own history — so an absent,
  // zero or nonsense quantity yields an empty box, never a guess.
  const base = { last_order_on: '2024-03-18', orders_count: 4 }
  assert(reorderQuantityPrefill({ ...base, last_qty: 250 }) === '250', 'uses last_qty')
  assert(reorderQuantityPrefill(base) === '', 'absent → empty')
  assert(reorderQuantityPrefill({ ...base, last_qty: 0 }) === '', 'zero → empty')
  assert(
    reorderQuantityPrefill({ ...base, last_qty: Number.NaN }) === '',
    'nonsense → empty, never "NaN"',
  )
})

test('Approve is withheld on an outreach v1 and returns of its own accord at v2', () => {
  // ⚠ The correctness fix, not a taste one. syncProspectOutcomes flips a
  // prospect to state='converted' — rendered "Ordered again" — on
  // status === 'approved' ALONE, with no order in existence, and that drops
  // the customer out of every follow-up bucket permanently.
  const ctx = { last_order_on: '2024-03-18', orders_count: 4 }
  assert(
    suppressApproveForOutreach({ context: ctx, versionNumber: 1 }),
    'v1 of an outreach proof withholds Approve',
  )
  assert(
    !suppressApproveForOutreach({ context: ctx, versionNumber: 2 }),
    'once a designer has replied the customer really is reviewing work',
  )
  assert(
    !suppressApproveForOutreach({ context: null, versionNumber: 1 }),
    'an ORDINARY proof is untouched — this must never reach a normal customer',
  )
  assert(
    !suppressApproveForOutreach({ context: ctx, versionNumber: null }),
    'an unknown version number fails open rather than hiding the control',
  )
})

test('the ask holds until it is answered, not for a fixed window', () => {
  // Deliberately unlike the ordinary panel's 24-hour re-arm. Re-showing
  // "Order these again" to someone who asked on Monday tells them we lost it —
  // the worst thing a re-engagement page can say. An order existing on the
  // proof is the answer arriving.
  const long = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
  assert(
    reengagementRequestOnFile({ requestedAt: long, hasOrder: false }),
    'a request from six weeks ago is still on file',
  )
  assert(
    !reengagementRequestOnFile({ requestedAt: long, hasOrder: true }),
    'once an order exists the ask has been answered',
  )
  assert(
    !reengagementRequestOnFile({ requestedAt: null, hasOrder: false }),
    'no request, no acknowledgement',
  )
  assert(
    !reengagementRequestOnFile({ requestedAt: 'not a date', hasOrder: false }),
    'an unparseable stamp must not be read as a request',
  )
})

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
