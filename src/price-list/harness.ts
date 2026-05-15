// Preview/test harness entry. Renders all 16 GBP placeholders just
// like the marketing-site script would, then runs the golden-master
// check against the live RPC payload and prints the result in a
// banner at the top of the page.
//
// Open via `pnpm dev` -> http://localhost:5173/price-list-preview.html.

import { fetchPriceList } from './fetch'
import { checkPayloadAgainstGolden, summariseResults } from './golden-master'
import {
  buildTable,
  ensureFontLoaded,
  ensureStylesInjected,
  renderTableInto,
} from './render'
import { TABLES } from './tables-config'

function renderBanner(parent: HTMLElement, state: 'loading' | 'pass' | 'fail', message: string): void {
  parent.replaceChildren()
  parent.setAttribute('data-state', state)
  parent.textContent = message
}

async function run(): Promise<void> {
  const banner = document.getElementById('harness-banner') as HTMLElement
  renderBanner(banner, 'loading', 'Fetching public_get_price_list(\'GBP\')…')

  ensureStylesInjected()
  ensureFontLoaded()

  const payload = await fetchPriceList('GBP')
  if (!payload) {
    renderBanner(banner, 'fail', 'RPC call failed — check Supabase env + that migration 000184 is applied.')
    return
  }

  for (const config of TABLES) {
    const host = document.querySelector<HTMLElement>(
      `[data-price-table="${config.key}"]`,
    )
    if (!host) continue
    const table = buildTable(payload, config)
    renderTableInto(host, table, payload.currency)
  }

  const results = checkPayloadAgainstGolden(payload)
  const summary = summariseResults(results)

  const summaryEl = document.getElementById('harness-summary') as HTMLElement
  summaryEl.replaceChildren()
  for (const t of summary.perTable) {
    const row = document.createElement('div')
    row.className = 'harness-summary-row'
    row.setAttribute('data-pass', String(t.failed === 0))
    row.textContent = `${t.key}: ${t.total - t.failed}/${t.total} cells${
      t.failed > 0 ? ` — ${t.failed} mismatch${t.failed === 1 ? '' : 'es'}` : ''
    }`
    summaryEl.appendChild(row)
  }

  const failures = results.filter((r) => !r.pass)
  const failuresEl = document.getElementById('harness-failures') as HTMLElement
  failuresEl.replaceChildren()
  if (failures.length > 0) {
    const heading = document.createElement('h3')
    heading.textContent = `Mismatches (${failures.length})`
    failuresEl.appendChild(heading)
    const list = document.createElement('ol')
    for (const f of failures) {
      const li = document.createElement('li')
      const col = f.columnIndex == null ? '' : ` col ${f.columnIndex}`
      const reason = 'reason' in f ? f.reason : 'mismatch'
      li.textContent = `${f.table} ${f.cellKind} qty ${f.quantity}${col}: ${reason} (expected ${f.expected ?? 'null'}, got ${f.actual ?? 'null'})`
      list.appendChild(li)
    }
    failuresEl.appendChild(list)
  }

  if (summary.failed === 0) {
    renderBanner(
      banner,
      'pass',
      `GBP golden-master check passed: ${summary.total}/${summary.total} cells across ${summary.perTable.length} tables match exactly.`,
    )
  } else {
    renderBanner(
      banner,
      'fail',
      `GBP golden-master check FAILED: ${summary.failed} of ${summary.total} cells mismatched (see list below).`,
    )
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    void run()
  })
} else {
  void run()
}
