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

// The day the live register was scored. Recency, cadence and the whole score
// are relative to it, so re-running with today's date produces different
// numbers — which is correct, and is why the nightly reconcile exists.
const TODAY = new Date(process.env.REGISTER_AS_AT ?? '2026-08-09')

// ⚠ DEFECT 3 (see README). Hardcoded, undated FX. These were spot rates on
// 2026-08-09 and nothing records that; they are used for SCORING only.
const GBP = { GBP: 1, USD: 0.78, EUR: 0.86 }

const invoices = readdirSync(DIR).filter(f => f.startsWith('xero-window-')).flatMap(f => JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8')))
const paid = invoices.filter(i => i.s === 'PAID' && i.id && i.t > 0)
console.log(`invoices: ${invoices.length} total, ${paid.length} PAID, statuses:`, Object.entries(paid.reduce((a,i)=>(a[i.s]=(a[i.s]||0)+1,a),{})), 'unpaid/other:', invoices.length - paid.length)

const byContact = new Map()
for (const inv of paid) {
  let c = byContact.get(inv.id)
  if (!c) { c = { id: inv.id, names: [], invs: [] }; byContact.set(inv.id, c) }
  c.invs.push(inv)
}

const DAY = 86400000
const customers = []
for (const c of byContact.values()) {
  c.invs.sort((a, b) => a.d.localeCompare(b.d))
  const first = c.invs[0].d, last = c.invs[c.invs.length - 1].d
  const n = c.invs.length
  const name = c.invs[c.invs.length - 1].c
  const curCounts = c.invs.reduce((a, i) => (a[i.cur] = (a[i.cur] || 0) + 1, a), {})
  // Modal currency — most invoices win. Fine for the 2,716 single-currency
  // contacts; part of DEFECT 3 for the other 23.
  const currency = Object.entries(curCounts).sort((a, b) => b[1] - a[1])[0][0]
  // lifetimeGbp is converted and drives the SCORE — that part is right.
  const lifetimeGbp = c.invs.reduce((a, i) => a + i.t * (GBP[i.cur] ?? 1), 0)
  // ⚠ DEFECT 3, the damaging half: lifetimeRaw sums totals across currencies
  // WITHOUT converting, and is then stored as `lifetime_value` labelled with
  // the modal currency below. A customer with £500 + $600 is recorded as
  // "£1,100". 23 of 2,739 contacts bought in more than one currency, so 23
  // rows carry an inflated lifetime figure on the register page. The score is
  // unaffected. Fixing it needs the original pull — see README.
  const lifetimeRaw = c.invs.reduce((a, i) => a + i.t, 0)
  const daysSince = Math.round((TODAY - new Date(last)) / DAY)
  const cadence = n >= 2 ? Math.round((new Date(last) - new Date(first)) / DAY / (n - 1)) : null

  let score = 0; const reasons = []
  const freqPts = n >= 5 ? 30 : n >= 3 ? 22 : n === 2 ? 15 : 5
  score += freqPts
  reasons.push(n === 1 ? '1 previous order' : `${n} previous orders`)
  let recPts = 0
  if (daysSince >= 180 && daysSince <= 730) recPts = 25
  else if (daysSince >= 120 && daysSince < 180) recPts = 15
  else if (daysSince > 730 && daysSince <= 1095) recPts = 12
  else if (daysSince > 1095) recPts = 5
  score += recPts
  const months = Math.round(daysSince / 30.4)
  reasons.push(`last ordered ~${months} months ago`)
  const valPts = lifetimeGbp >= 2000 ? 20 : lifetimeGbp >= 1000 ? 15 : lifetimeGbp >= 500 ? 10 : lifetimeGbp >= 250 ? 6 : 3
  score += valPts
  reasons.push(`~£${Math.round(lifetimeGbp)} lifetime`)
  if (cadence && cadence >= 30) {
    const ratio = daysSince / cadence
    if (ratio >= 1 && ratio <= 2.5) { score += 15; reasons.push(`overdue by their own rhythm (~every ${Math.round(cadence / 30.4)} months)`) }
    else if (ratio > 2.5) { score += 8 }
  }
  const suppressRecent = daysSince < 120
  const testName = /atari|joe bloggs|plasmadesign|test/i.test(name)
  customers.push({
    xero_contact_id: c.id, customer_name: name, currency,
    first_order_on: first, last_order_on: last, orders_count: n,
    lifetime_value: Math.round(lifetimeRaw * 100) / 100,
    avg_order_value: Math.round(lifetimeRaw / n * 100) / 100,
    cadence_days: cadence, score, score_reasons: reasons,
    state: testName ? 'suppressed' : suppressRecent ? 'suppressed' : 'pending',
    suppressed_until: suppressRecent && !testName ? new Date(new Date(last).getTime() + 180 * DAY).toISOString().slice(0, 10) : null,
    outcome_note: testName ? 'Test fixture — never contact' : suppressRecent ? 'Recent buyer — covered by the in-app reorder flow' : null,
  })
}
customers.sort((a, b) => b.score - a.score)
writeFileSync(`${DIR}/register.json`, JSON.stringify(customers, null, 1))

const pending = customers.filter(c => c.state === 'pending')
const multi = pending.filter(c => c.orders_count >= 2)
console.log(`customers: ${customers.length} | servable (pending): ${pending.length} | multi-order servable: ${multi.length} | suppressed-recent: ${customers.filter(c=>c.state==='suppressed'&&!c.outcome_note.includes('Test')).length}`)
console.log('score bands (pending): 70+:', pending.filter(c=>c.score>=70).length, '55-69:', pending.filter(c=>c.score>=55&&c.score<70).length, '40-54:', pending.filter(c=>c.score>=40&&c.score<55).length, '<40:', pending.filter(c=>c.score<40).length)
const gbpLife = v => v.reduce((a,c)=>a + c.lifetime_value * (GBP[c.currency]??1), 0)
console.log(`pending lifetime value ~£${Math.round(gbpLife(pending)).toLocaleString()} | top-260 (a year of desk at 5/day): ~£${Math.round(gbpLife(pending.slice(0,260))).toLocaleString()}`)
console.log('TOP 15:'); for (const c of pending.slice(0, 15)) console.log(`  ${c.score}  ${c.customer_name} — ${c.orders_count} orders, ~£${Math.round(c.lifetime_value*(GBP[c.currency]??1))}, last ${c.last_order_on}, ${c.currency}`)

mkdirSync(`${DIR}/seed-chunks`, { recursive: true })
const CHUNK = 150
for (let i = 0; i < customers.length; i += CHUNK) {
  writeFileSync(`${DIR}/seed-chunks/chunk-${String(i / CHUNK).padStart(2, '0')}.json`, JSON.stringify(customers.slice(i, i + CHUNK)))
}
console.log(`seed chunks: ${Math.ceil(customers.length / CHUNK)}`)
