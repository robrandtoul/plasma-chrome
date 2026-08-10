// Turn register rows into the SQL that fills their finish — using the SAME
// parser the tests cover, never a re-implementation in SQL.
//
// The parser has to live in one place. Writing these rules a second time in a
// migration would mean the tested version and the version that actually ran
// were different programs, which is how the register got its defects in the
// first place (see README.md).
//
// Usage:
//   node scripts/reorder-register/apply-finish.mjs wood      < rows.json
//   node scripts/reorder-register/apply-finish.mjs xero      < rows.json
//
// Reads a JSON array on stdin and writes SQL to stdout, plus a breakdown of
// refusal reasons to stderr so a shadow run can be counted by CAUSE rather
// than just "didn't work".
//
// Expected row shape:
//   wood  { id, last_spec, options: [{id, code, display_name}] }
//   xero  { id, description, item_name, item_microns, material_code,
//           options: [{id, code, display_name}] }

import { parseFinish, parseWoodSpecies } from './finishParse.mjs'

const mode = process.argv[2]
if (mode !== 'wood' && mode !== 'xero') {
  console.error('Usage: node apply-finish.mjs <wood|xero> < rows.json')
  process.exit(1)
}

const raw = await new Promise((resolve) => {
  let s = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (d) => (s += d))
  process.stdin.on('end', () => resolve(s))
})

const rows = JSON.parse(raw)
const source = mode === 'wood' ? 'item_name' : 'xero_description'
const matched = []
const reasons = new Map()

for (const r of rows) {
  const res =
    mode === 'wood'
      ? parseWoodSpecies(r.last_spec, r.options)
      : parseFinish({
          description: r.description,
          itemName: r.item_name,
          itemMicrons: r.item_microns ?? null,
          materialCode: r.material_code,
          options: r.options,
        })
  reasons.set(res.reason, (reasons.get(res.reason) ?? 0) + 1)
  if (res.option) matched.push({ id: r.id, option: res.option })
}

console.error(`rows in: ${rows.length}   matched: ${matched.length}   refused: ${rows.length - matched.length}`)
console.error('by reason:')
for (const [reason, n] of [...reasons].sort((a, b) => b[1] - a[1])) {
  console.error(`  ${String(n).padStart(5)}  ${reason}`)
}

if (matched.length === 0) {
  console.error('\nnothing to write')
  process.exit(0)
}

// ⚠ Only ever fills a row that has NO finish yet. The order-column source is
// more trustworthy than either parse, so it must never be overwritten by one —
// and re-running this must not churn rows a human has since corrected.
const sqlEscape = (s) => String(s).replace(/'/g, "''")
const values = matched
  .map((m) => `('${m.id}'::uuid, '${m.option.id}'::uuid, '${sqlEscape(m.option.display_name)}')`)
  .join(',\n  ')

process.stdout.write(`update proofs.reorder_prospects rp
   set last_option_id = v.option_id,
       last_option_label = v.option_label,
       last_option_source = '${source}'
  from (values
  ${values}
) as v(prospect_id, option_id, option_label)
 where rp.id = v.prospect_id
   and rp.last_option_id is null;
`)
