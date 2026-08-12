// Unit tests for supplierNote.ts
// Run with: npx tsx supabase/functions/_shared/supplierNote.test.ts
//
// These two notes go on the CUSTOMER's proof thread, where the whole team reads
// them. The rule they exist to enforce has already caught this feature three
// times: only QX Metals send an artwork proof. Solopress send a booking
// confirmation, Swype a proforma invoice they won't start work without. Any note
// claiming a "proof" is therefore false on two suppliers out of three — and false
// again on whoever is added next.
//
// The notes are also a PAIR written in two different edge functions, so the
// second only makes sense as the answer to the first. That's the other thing
// worth pinning: they have to agree on how the supplier is named.

import { awaitingSupplierNote, supplierClearedNote } from './supplierNote.ts'

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
  try { fn(); console.log(`  ✓ ${name}`); passed++ }
  catch (err) { console.log(`  ✗ ${name}`); console.log(`    ${(err as Error).message}`); failed++ }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, message?: string) {
  if (actual !== expected) {
    throw new Error(message ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

// The three live suppliers, and what each actually sends back.
const SUPPLIERS = ['QX Metals', 'Solopress', 'Swype']

console.log('\nsupplierNote')

// ── The rule ────────────────────────────────────────────────────────────────

test('neither note ever claims a proof, for any supplier', () => {
  for (const s of SUPPLIERS.concat(['Some New Supplier Ltd'])) {
    const awaiting = awaitingSupplierNote(s, '<p>order body</p>').toLowerCase()
    const cleared = supplierClearedNote(s, 'Chris Jackson', true).toLowerCase()
    assert(!awaiting.includes('proof'), `awaiting note mentions a proof for ${s}`)
    assert(!cleared.includes('proof'), `cleared note mentions a proof for ${s}`)
  }
})

test('neither note claims the order was approved, or tells anyone to start', () => {
  // "Approved" reads as sign-off on artwork; on a Swype order the thing that
  // arrived was an invoice. "Go ahead" would be worse still — they don't start
  // until it's paid.
  for (const phrase of ['approved', 'go ahead', 'produce', 'print']) {
    for (const s of SUPPLIERS) {
      assert(
        !supplierClearedNote(s, 'Chris Jackson', true).toLowerCase().includes(phrase),
        `cleared note says "${phrase}" for ${s}`,
      )
    }
  }
})

test('both notes name the supplier, so the thread says who we are waiting on', () => {
  for (const s of SUPPLIERS) {
    assert(awaitingSupplierNote(s, '').includes(s.toUpperCase()), `awaiting note omits ${s}`)
    assert(supplierClearedNote(s, 'Chris Jackson', true).includes(s.toUpperCase()), `cleared note omits ${s}`)
  }
})

// ── The pair ────────────────────────────────────────────────────────────────

test('the two notes head the supplier identically, so they read as a pair', () => {
  // Written in two different edge functions at two different moments. If they
  // ever name the supplier differently, the thread stops reading as a sequence.
  for (const s of SUPPLIERS) {
    const a = awaitingSupplierNote(s, '').match(/<strong>[^<]*<\/strong>/)![0]
    const c = supplierClearedNote(s, 'Chris', true).match(/<strong>[^<]*<\/strong>/)![0]
    const name = s.toUpperCase()
    assert(a.includes(name) && c.includes(name), `headings disagree about ${s}`)
  }
})

test('the status leads the heading, not the contents', () => {
  // Whoever opens the thread wants "where has this got to", and a note headed
  // "copy of order" buries that under a wall of spec.
  assert(
    awaitingSupplierNote('QX Metals', '<p>x</p>').startsWith('<strong>AWAITING'),
    'the awaiting note should lead with its status',
  )
})

// ── Attribution + fallbacks ─────────────────────────────────────────────────

test('replied vs recorded is stated, because they mean different things', () => {
  // One means the supplier was told; the other means they were not. Someone
  // reading this back a fortnight later needs to be able to tell.
  const replied = supplierClearedNote('QX Metals', 'Chris Jackson', true)
  const recorded = supplierClearedNote('QX Metals', 'Chris Jackson', false)
  assert(replied.includes('Replied by Chris Jackson'), 'the replied note names who replied')
  assert(recorded.includes('no reply sent from here'), 'the recorded note says nobody was emailed')
  assert(replied !== recorded, 'the two paths must be distinguishable')
})

test('a missing supplier name degrades to something readable, never "UNDEFINED"', () => {
  for (const missing of [null, undefined, '', '   ']) {
    assertEqual(
      awaitingSupplierNote(missing, '').includes('THE SUPPLIER'),
      true,
      `awaiting note broke on ${JSON.stringify(missing)}`,
    )
    assertEqual(
      supplierClearedNote(missing, 'Chris', true).includes('THE SUPPLIER'),
      true,
      `cleared note broke on ${JSON.stringify(missing)}`,
    )
  }
})

test('a missing clearer name degrades too', () => {
  const note = supplierClearedNote('QX Metals', '   ', true)
  assert(note.includes('a member of the team'), 'should not read "Replied by ."')
})

test('the order copy rides through the awaiting note untouched', () => {
  // It is the exact body emailed to the supplier, already HTML — re-escaping or
  // trimming it here would silently change what the thread records was sent.
  const body = '<p>Qty: 500</p><br><a href="https://dropbox.example">artwork</a>'
  assert(awaitingSupplierNote('QX Metals', body).includes(body), 'the order copy was altered')
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
