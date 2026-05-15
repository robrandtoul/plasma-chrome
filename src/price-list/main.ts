// Entry point for the Squarespace-embedded price-list script.
//
// Bootstraps once on DOMContentLoaded:
//   1. Pick the currency.
//   2. Find every placeholder.
//   3. Fetch public_get_price_list for that currency (one round-trip).
//   4. Render each placeholder.
//
// Placeholder shape:
//   <div data-price-table="<key>"></div>
//
// Currency selection precedence:
//   - <body data-price-list-currency="GBP|EUR|USD">  (explicit override)
//   - URL pathname:  /gbp-price-list / /euro-price-list / /us-price-list
//   - default: GBP

import { fetchPriceList } from './fetch'
import {
  buildTable,
  ensureFontLoaded,
  ensureStylesInjected,
  renderTableInto,
} from './render'
import { TABLES, type TableConfig } from './tables-config'

function detectCurrency(): 'GBP' | 'EUR' | 'USD' {
  const explicit = document.body.getAttribute('data-price-list-currency')
  if (explicit === 'GBP' || explicit === 'EUR' || explicit === 'USD') return explicit
  const path = window.location.pathname.toLowerCase()
  if (path.includes('euro-price-list')) return 'EUR'
  if (path.includes('us-price-list')) return 'USD'
  return 'GBP'
}

function findPlaceholders(): Map<string, HTMLElement[]> {
  const groups = new Map<string, HTMLElement[]>()
  const nodes = document.querySelectorAll<HTMLElement>('[data-price-table]')
  for (const node of Array.from(nodes)) {
    // Skip rendered tables (they also carry data-price-table). The
    // placeholders are <div>/<section>; rendered output is <table>.
    if (node.tagName.toLowerCase() === 'table') continue
    const key = node.getAttribute('data-price-table')
    if (!key) continue
    const list = groups.get(key) ?? []
    list.push(node)
    groups.set(key, list)
  }
  return groups
}

function setState(elements: HTMLElement[], state: 'loading' | 'ready' | 'error'): void {
  for (const el of elements) {
    el.classList.add('plasma-price-list-placeholder')
    el.setAttribute('data-state', state)
    if (state !== 'ready') {
      el.replaceChildren()
    }
  }
}

async function bootstrap(): Promise<void> {
  const placeholders = findPlaceholders()
  if (placeholders.size === 0) return

  ensureStylesInjected()
  ensureFontLoaded()

  for (const elements of placeholders.values()) {
    setState(elements, 'loading')
  }

  const currency = detectCurrency()
  const payload = await fetchPriceList(currency)
  if (!payload) {
    for (const elements of placeholders.values()) {
      setState(elements, 'error')
    }
    return
  }

  const configByKey = new Map<string, TableConfig>(TABLES.map((t) => [t.key, t]))
  for (const [key, elements] of placeholders.entries()) {
    const config = configByKey.get(key)
    if (!config) {
      setState(elements, 'error')
      continue
    }
    const table = buildTable(payload, config)
    for (const el of elements) {
      setState([el], 'ready')
      el.classList.remove('plasma-price-list-placeholder')
      renderTableInto(el, table, currency)
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    void bootstrap()
  })
} else {
  void bootstrap()
}
