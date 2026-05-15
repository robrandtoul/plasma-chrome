// Golden-master check: compares the script's rendered output against
// the verified GBP cell values from the 2026-05-15 parity audit
// (golden-master-gbp.ts). Runs in the browser-side preview harness
// against live RPC data.
//
// Output is a flat list of cell-level results. The harness prints a
// per-table pass/fail tally plus a list of every mismatch.

import type { GoldenTable } from './golden-master-gbp'
import { GOLDEN_GBP } from './golden-master-gbp'
import { buildTable, type ApiPayload } from './render'
import { TABLES } from './tables-config'

export type CellResult =
  | {
      table: string
      cellKind: 'price' | 'surcharge'
      quantity: number
      columnIndex: number | null
      expected: number | null
      actual: number | null
      pass: true
    }
  | {
      table: string
      cellKind: 'price' | 'surcharge'
      quantity: number
      columnIndex: number | null
      expected: number | null
      actual: number | null
      pass: false
      reason: string
    }

function compareNumbers(
  expected: number | null | undefined,
  actual: number | null,
): { pass: boolean; reason?: string } {
  if (expected == null && actual == null) return { pass: true }
  if (expected == null) return { pass: false, reason: 'unexpected value' }
  if (actual == null) return { pass: false, reason: 'missing value' }
  // Round to integer pounds before comparing — the golden master is
  // integer pounds. Anything beyond that is a real mismatch worth
  // surfacing.
  if (Math.round(actual) !== Math.round(expected)) {
    return { pass: false, reason: `expected ${expected}, got ${actual}` }
  }
  return { pass: true }
}

export function checkPayloadAgainstGolden(payload: ApiPayload): CellResult[] {
  const goldenByKey = new Map<string, GoldenTable>(GOLDEN_GBP.map((g) => [g.key, g]))
  const results: CellResult[] = []

  for (const config of TABLES) {
    const golden = goldenByKey.get(config.key)
    if (!golden) {
      results.push({
        table: config.key,
        cellKind: 'price',
        quantity: -1,
        columnIndex: null,
        expected: null,
        actual: null,
        pass: false,
        reason: 'no golden-master entry for this table',
      })
      continue
    }

    const rendered = buildTable(payload, config)

    // Price cells
    for (const row of rendered.rows) {
      const expectedRow = golden.expected_gbp[String(row.quantity)] ?? []
      for (let i = 0; i < row.cells.length; i += 1) {
        const expected = expectedRow[i] ?? null
        const actual = row.cells[i]
        const cmp = compareNumbers(expected, actual)
        const base = {
          table: config.key,
          cellKind: 'price' as const,
          quantity: row.quantity,
          columnIndex: i,
          expected,
          actual,
        }
        results.push(
          cmp.pass
            ? { ...base, pass: true }
            : { ...base, pass: false, reason: cmp.reason ?? 'mismatch' },
        )
      }
    }

    // Surcharge cells
    if (golden.expected_gbp_surcharge) {
      for (const row of rendered.rows) {
        const expected = golden.expected_gbp_surcharge[String(row.quantity)] ?? null
        const cmp = compareNumbers(expected, row.surcharge)
        const base = {
          table: config.key,
          cellKind: 'surcharge' as const,
          quantity: row.quantity,
          columnIndex: null,
          expected,
          actual: row.surcharge,
        }
        results.push(
          cmp.pass
            ? { ...base, pass: true }
            : { ...base, pass: false, reason: cmp.reason ?? 'mismatch' },
        )
      }
    }
  }
  return results
}

export interface TableSummary {
  key: string
  total: number
  failed: number
}

export function summariseResults(results: CellResult[]): {
  total: number
  failed: number
  perTable: TableSummary[]
} {
  const perTable = new Map<string, TableSummary>()
  for (const r of results) {
    const entry = perTable.get(r.table) ?? { key: r.table, total: 0, failed: 0 }
    entry.total += 1
    if (!r.pass) entry.failed += 1
    perTable.set(r.table, entry)
  }
  return {
    total: results.length,
    failed: results.filter((r) => !r.pass).length,
    perTable: Array.from(perTable.values()),
  }
}
