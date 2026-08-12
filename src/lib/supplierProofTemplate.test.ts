// Seed-parity guard for the supplier proof approval template (000409).
// Run with: npx tsx src/lib/supplierProofTemplate.test.ts
//
// The migration's body is hand-frozen SQL (Postgres can't import TypeScript) and
// DEFAULT_BODIES is what the admin editor's "Reset to default" button writes
// back. If the two drift, Reset silently restores copy nobody wrote and a fresh
// replay seeds something different again — with nothing anywhere complaining.
// Same mechanism as the 000366 guard in abandonNotice.test.ts.

import { readFileSync } from 'node:fs'
import { DEFAULT_BODIES, TEMPLATE_VARIABLES } from './replyTemplates'

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

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, message?: string) {
  if (actual !== expected) {
    throw new Error(message ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

const SHARED_ID = 'supplier_proof_approval'
// One per live supplier. Each sends back something different, so each gets its
// own body — see the note in replyTemplates.ts.
const QX_ID = 'supplier_proof_approval:91eac49d-cea7-44c7-bbcf-974425d26dc7'
const SOLOPRESS_ID = 'supplier_proof_approval:ca962788-025e-41ca-b7d5-7a00b2a103db'
const SWYPE_ID = 'supplier_proof_approval:e9494599-a82a-4ccb-ae12-9428c9414fed'
const ALL_IDS = [SHARED_ID, QX_ID, SOLOPRESS_ID, SWYPE_ID]

function migrationSql(): string {
  return readFileSync(
    new URL('../../supabase/migrations/000409_supplier_proof_holding_pen.sql', import.meta.url),
    'utf8',
  )
}

/** Pull the body literal seeded against a given template id. The body is the 4th
 *  value in each tuple, so we walk forward from the id and take the fourth
 *  single-quoted string — extracting rather than testing containment, because a
 *  containment check passes when the migration merely STARTS with the code
 *  default, and appending a sentence to the SQL would then drift silently. */
function seededBody(sql: string, id: string): string {
  const at = sql.indexOf(`'${id}'`)
  if (at === -1) throw new Error(`000409 seeds no template with id ${id}`)
  let i = at
  let found = 0
  while (i < sql.length) {
    if (sql[i] !== "'") { i += 1; continue }
    // Read one single-quoted literal, honouring Postgres'' escaped apostrophes.
    let out = ''
    i += 1
    while (i < sql.length) {
      if (sql[i] === "'") {
        if (sql[i + 1] === "'") { out += "'"; i += 2; continue }
        i += 1
        break
      }
      out += sql[i]
      i += 1
    }
    found += 1
    if (found === 4) return out // id, display_name, description, body
  }
  throw new Error(`could not read the body literal for ${id}`)
}

console.log('\nsupplier proof template')

test('000409 seeds byte-for-byte what "Reset to default" restores, for every supplier', () => {
  const sql = migrationSql()
  for (const id of ALL_IDS) {
    assert(typeof DEFAULT_BODIES[id] === 'string', `DEFAULT_BODIES has no entry for ${id}`)
    assertEqual(
      seededBody(sql, id),
      DEFAULT_BODIES[id],
      `the 000409 seed body for ${id} no longer matches DEFAULT_BODIES — update whichever one is wrong`,
    )
  }
})

test('the shared default promises nothing a supplier could act on wrongly', () => {
  // The load-bearing one. Only QX send a proof; Solopress send a booking
  // confirmation and Swype send a proforma they will not start work without.
  // A shared body saying "the proof is approved, please go ahead and produce the
  // order" would have told Swype to start printing something they are waiting to
  // be paid for — and would say the same to any supplier added in future.
  const shared = DEFAULT_BODIES[SHARED_ID].toLowerCase()
  for (const phrase of ['proof', 'go ahead', 'produce', 'print']) {
    assert(!shared.includes(phrase), `the shared default should not mention "${phrase}" — it is sent to suppliers who send no proof`)
  }
  // …while QX's own version is free to be specific, since we know what they send.
  assert(DEFAULT_BODIES[QX_ID].toLowerCase().includes('proof'), "QX's version should name the proof")
})

test("Swype's version doesn't tell them to start, and doesn't promise payment", () => {
  // They do not begin production until the proforma is paid, and that payment is
  // handled outside this app — so this reply must neither instruct nor commit.
  const swype = DEFAULT_BODIES[SWYPE_ID].toLowerCase()
  for (const phrase of ['go ahead', 'produce', 'approved', 'paid', 'payment has been made']) {
    assert(!swype.includes(phrase), `Swype's reply should not say "${phrase}"`)
  }
})

test('the seeded body is not an E-string (which would smuggle literal \\n through)', () => {
  const insert = migrationSql().slice(migrationSql().indexOf('insert into proofs.reply_templates'))
  // Strip `--` comments first: the comment above the literal explains that it
  // deliberately is NOT an E-string, and would otherwise trip this guard.
  const stmt = insert
    .slice(0, insert.indexOf('on conflict'))
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
  assert(
    !/\bE'/.test(stmt),
    "the seed uses an E'' escape string — the extraction above would compare backslash-n against real newlines and pass for the wrong reason",
  )
})

test('every variable the default body uses is declared in the supplier_proof scope', () => {
  // A body referencing an undeclared variable renders the literal "{customer}"
  // to the supplier. The default uses none today, but this guard is what keeps
  // that true after someone edits the copy.
  const declared = new Set(
    TEMPLATE_VARIABLES.filter((v) => v.scope === 'supplier_proof').map((v) => v.name),
  )
  assert(declared.size > 0, 'the supplier_proof scope declares no variables at all')
  const used = ALL_IDS.flatMap((id) => [...DEFAULT_BODIES[id].matchAll(/\{\??\s*([a-z_]+)\s*\}/g)].map((m) => m[1]))
  for (const name of used) {
    assert(declared.has(name), `default body uses {${name}}, which the supplier_proof scope does not declare`)
  }
})

test('the approval message carries no machine-readable order block', () => {
  // supplier_order_email's {order_details} is parser-critical and must keep its
  // shape. This one is the opposite: the thread already carries the order, so
  // the wording is entirely free. Guarding it stops someone copying the spec
  // block in here and quietly creating a second format to keep in step.
  assert(
    !DEFAULT_BODIES[SHARED_ID].includes('{order_details}'),
    'the approval message should not repeat the spec block — the supplier already has it on this thread',
  )
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
