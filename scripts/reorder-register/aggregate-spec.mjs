// ⚠ THIS IS AN AS-RUN ARCHIVE, NOT A MAINTAINED TOOL.
//
// This file is a verbatim copy of the script that actually produced the live
// reorder register on 2026-08-09, rescued from a session-scoped temp directory
// before it was cleaned up. Its logic is UNCHANGED — including the defects
// noted below — because its whole value is that it describes what really
// happened to 2,739 customer records. "Fixing" it in place would make it stop
// being a record of anything.
//
// The only edit is that the hardcoded scratchpad path became a parameter.
//
// See scripts/reorder-register/README.md before running or changing anything.

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'fs'

const DIR = process.env.REGISTER_DATA_DIR ?? process.argv[2]
if (!DIR) {
  console.error('Usage: REGISTER_DATA_DIR=<dir> node <script>   (or pass the dir as argv[2])')
  console.error('The dir holds the raw Xero pulls — see README.md.')
  process.exit(1)
}

const rows = readdirSync(`${DIR}/spec`).filter(f => f.startsWith('spec-'))
  .flatMap(f => JSON.parse(readFileSync(`${DIR}/spec/${f}`, 'utf8')))

// ⚠ DEFECT 1 (see README) — FIXED IN THE DATABASE BY MIGRATION 000406, NOT
// HERE. Read carefully: this filters to single-product invoices FIRST and then
// takes the latest of the SURVIVORS. It does NOT mean "the latest invoice, if
// that invoice was single-product". So for a customer whose most recent
// invoice carried two or more products, the phrase describes an OLDER
// purchase — while `last_order_on` (set in aggregate.mjs from the latest
// invoice regardless) describes the newer one. recognitionLine() then renders
// the pair as one sentence and tells the customer something untrue about their
// own order. It hit 41 of 2,611 rows. find-stale-specs.mjs is the detector.
//
// Latest invoice per contact that resolved to exactly ONE product line.
const best = new Map()
for (const r of rows) {
  if (!r || !r.c || !r.d) continue
  if (r.n !== 1 || !r.l || r.q == null) continue
  const prev = best.get(r.c)
  if (!prev || r.d > prev.d) best.set(r.c, r)
}

// Lowercase the opening word so the phrase reads inside a sentence — but never
// an acronym (NFC, QR, UV), which lowercasing would mangle.
// ⚠ DEFECT 2 (see README). This only lowercases position 0, so a Title Case
// item name keeps its inner capitals: "Carbon Fibre Cards" becomes "carbon
// Fibre Cards", which is what 40 live rows say. The acronym guard is right;
// the fix is to lowercase the whole label except known acronyms, which is a
// change to what the register SAYS and so belongs in a data fix, not here.
function leadIn(label) {
  const first = label.split(/\s+/)[0] ?? ''
  const isAcronym = first.length > 1 && first[0] === first[0].toUpperCase() && first[1] === first[1].toUpperCase()
  return isAcronym ? label : label.charAt(0).toLowerCase() + label.slice(1)
}

const out = []
const rejected = { qty: 0, label: 0, tooLong: 0 }
for (const [contact, r] of best) {
  // ⚠ `r.l` is the Xero ITEM NAME, not the line description — proved four ways
  // in the README. That is precisely why the register has no FINISH anywhere:
  // the description says "Gold metal business cards (500 micron with brushed
  // finish)" and the item name says "Gold metal cards (500 micron)".
  let label = String(r.l).split('\n')[0].trim().replace(/\s+/g, ' ')
  const qty = Math.round(Number(r.q))
  if (!Number.isFinite(qty) || qty < 1 || qty > 100000) { rejected.qty++; continue }
  if (!label) { rejected.label++; continue }
  const phrase = `${qty.toLocaleString('en-GB')} ${leadIn(label)}`
  if (phrase.length > 120) { rejected.tooLong++; continue }
  out.push({ x: contact, s: phrase })
}

mkdirSync(`${DIR}/spec-seed`, { recursive: true })
const CHUNK = 350
for (let i = 0; i < out.length; i += CHUNK) {
  writeFileSync(`${DIR}/spec-seed/chunk-${String(i / CHUNK).padStart(2, '0')}.json`, JSON.stringify(out.slice(i, i + CHUNK)))
}
console.log(`invoice records: ${rows.length}`)
console.log(`contacts with an unambiguous latest spec: ${out.length}`)
console.log(`rejected — qty ${rejected.qty}, label ${rejected.label}, too long ${rejected.tooLong}`)
console.log(`chunks: ${Math.ceil(out.length / CHUNK)}`)
console.log('\nsamples:')
for (const s of out.slice(0, 6)) console.log(`  ${s.s}`)
const lens = out.map(o => o.s.length).sort((a,b)=>a-b)
console.log(`\nphrase length: median ${lens[Math.floor(lens.length/2)]}, max ${lens[lens.length-1]}`)
