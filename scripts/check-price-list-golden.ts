#!/usr/bin/env tsx
//
// scripts/check-price-list-golden.ts
//
// Headless golden-master check for the price-list rendering pipeline.
//
// Calls public_get_price_list('GBP') against the linked Supabase
// project, runs the same buildTable() + checkPayloadAgainstGolden()
// logic the browser harness uses, and prints a per-table tally plus
// a list of mismatches. Exits non-zero if any cell mismatches.
//
// Run via: pnpm tsx scripts/check-price-list-golden.ts

import { config as loadEnv } from 'dotenv'
import { checkPayloadAgainstGolden, summariseResults } from '../src/price-list/golden-master'
import type { ApiPayload } from '../src/price-list/render'

loadEnv()

const url = process.env.VITE_SUPABASE_URL
const anonKey = process.env.VITE_SUPABASE_ANON_KEY
if (!url || !anonKey) {
  console.error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in env.')
  process.exit(1)
}

const endpoint = `${url}/rest/v1/rpc/public_get_price_list`

async function main(): Promise<void> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Proof data lives in the `proofs` schema of the shared stock
      // project; the function name collides with stock's public schema
      // under one PostgREST, so the schema must be selected explicitly.
      'Accept-Profile': 'proofs',
      'Content-Profile': 'proofs',
      apikey: anonKey!,
      Authorization: `Bearer ${anonKey!}`,
    },
    body: JSON.stringify({ p_currency: 'GBP' }),
  })
  if (!response.ok) {
    console.error(`RPC failed: HTTP ${response.status}`)
    console.error(await response.text())
    process.exit(2)
  }
  const payload = (await response.json()) as ApiPayload
  if (!payload || !Array.isArray(payload.materials)) {
    console.error('RPC returned an unexpected shape.')
    process.exit(2)
  }

  const results = checkPayloadAgainstGolden(payload)
  const summary = summariseResults(results)

  console.log('')
  console.log(
    `Golden-master check (GBP): ${summary.total - summary.failed}/${summary.total} cells pass`,
  )
  console.log('')
  for (const t of summary.perTable) {
    const status = t.failed === 0 ? '✓' : '✗'
    const detail = t.failed === 0 ? '' : ` — ${t.failed} mismatch${t.failed === 1 ? '' : 'es'}`
    console.log(`  ${status} ${t.key.padEnd(22)} ${t.total - t.failed}/${t.total}${detail}`)
  }

  const failures = results.filter((r) => !r.pass)
  if (failures.length > 0) {
    console.log('')
    console.log(`Mismatches (${failures.length}):`)
    for (const f of failures) {
      const col = f.columnIndex == null ? '' : ` col ${f.columnIndex}`
      const reason = 'reason' in f ? f.reason : 'mismatch'
      console.log(
        `  - ${f.table} ${f.cellKind} qty ${f.quantity}${col}: ${reason} (expected ${f.expected ?? 'null'}, got ${f.actual ?? 'null'})`,
      )
    }
    process.exit(1)
  }
}

main().catch((err: unknown) => {
  console.error('Unexpected error:', err)
  process.exit(2)
})
