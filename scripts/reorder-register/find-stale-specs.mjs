// The detector for DEFECT 1 — the rows whose `last_spec` describes an older
// purchase than the date beside it. This is the script that produced the id
// list in migration 000406.
//
// ⚠ The defect is INVISIBLE from inside the database. Detecting it needs the
// per-invoice product-line counts from the original Xero pull, and those were
// never stored — only their outputs were. So this runs against the raw pull in
// REGISTER_DATA_DIR, not against Supabase.
//
// Usage:  REGISTER_DATA_DIR=<dir> node scripts/reorder-register/find-stale-specs.mjs
// Output: stale.json in that directory, plus a summary on stdout.

import { readFileSync, writeFileSync, readdirSync } from 'fs'

const DIR = process.env.REGISTER_DATA_DIR ?? process.argv[2]
if (!DIR) {
  console.error('Usage: REGISTER_DATA_DIR=<dir> node scripts/reorder-register/find-stale-specs.mjs')
  process.exit(1)
}

// The spec pull: { c: contact_id, d: date, n: product-line count, q: qty, l: label }
const recs = readdirSync(`${DIR}/spec`)
  .filter((f) => f.endsWith('.json'))
  .flatMap((f) => {
    const j = JSON.parse(readFileSync(`${DIR}/spec/${f}`, 'utf8'))
    return Array.isArray(j) ? j : (j.records ?? [])
  })

const byContact = new Map()
for (const r of recs) {
  if (!byContact.has(r.c)) byContact.set(r.c, [])
  byContact.get(r.c).push(r)
}

// Replay aggregate-spec.mjs's selection, then ask whether the invoice it chose
// is the same one last_order_on came from (the latest, whatever its shape).
const stale = []
for (const [cid, list] of byContact) {
  const sorted = list.slice().sort((a, b) => (a.d < b.d ? 1 : -1))
  const latest = sorted[0]
  const singles = sorted.filter((r) => r.n === 1)
  if (!singles.length) continue
  const chosen = singles[0]
  if (chosen.d !== latest.d) {
    stale.push({
      cid,
      chosen: chosen.d,
      latest: latest.d,
      label: chosen.l,
      chosenQty: chosen.q,
      // > 0 means the newer invoice carried other products, so the phrase
      // describes a genuinely different order. 0 means the newer invoice had
      // no countable product line, so the date still isn't the date of the
      // thing being named. Both are wrong to print; both are nulled.
      latestLines: latest.n,
    })
  }
}

writeFileSync(`${DIR}/stale.json`, JSON.stringify(stale, null, 1))
const multi = stale.filter((r) => r.latestLines > 0).length
console.log(`spec records: ${recs.length}  contacts: ${byContact.size}`)
console.log(`stale: ${stale.length}  (${multi} with other products on the newer invoice, ${stale.length - multi} with none)`)
console.log('\nSQL id list:')
console.log(stale.map((r) => `'${r.cid}'`).join(','))
