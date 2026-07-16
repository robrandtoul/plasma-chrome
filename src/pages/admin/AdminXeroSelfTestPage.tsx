import { Fragment, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'

// Admin: Xero invoice self-test.
//
// Runs every product type through the SAME invoice builder the live Stripe→Xero
// path uses (supabase/functions/xero-invoice-selftest), creating one DRAFT
// invoice per product in the connected Xero org and reading back the item code +
// tax rate Xero resolved. Lets the team confirm every code is right before going
// live, instead of paying through Stripe checkout dozens of times.
//
// Drafts never hit the ledger; "Delete test drafts" removes every draft whose
// reference starts with SELFTEST. Run it against Demo as a sanity check; the
// meaningful run is after the app is pointed at the live Xero org.

interface ResultRow {
  test: string
  group: string
  expectedCode: string | null
  resolvedCode: string | null
  taxType: string | null
  accountCode: string | null
  status: 'pass' | 'fail' | 'error'
  message: string
  invoiceId: string | null
}

interface RunResponse {
  action: string
  tenantId?: string
  summary?: { total: number; pass: number; fail: number; error: number }
  results?: ResultRow[]
  deleted?: number
  found?: number
  error?: string
}

const STATUS_STYLES: Record<ResultRow['status'], string> = {
  pass: 'bg-in-stock-soft text-in-stock ring-in-stock',
  fail: 'bg-out-soft text-out ring-out',
  error: 'bg-low-soft text-low ring-low',
}

export default function AdminXeroSelfTestPage() {
  const [running, setRunning] = useState(false)
  const [cleaning, setCleaning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [data, setData] = useState<RunResponse | null>(null)

  async function run() {
    setRunning(true)
    setError(null)
    setNotice(null)
    const { data: res, error: fnErr } = await supabase.functions.invoke<RunResponse>('xero-invoice-selftest', {
      body: { action: 'run' },
    })
    setRunning(false)
    if (fnErr) {
      setError(fnErr.message)
      return
    }
    if (res?.error) {
      setError(res.error)
      return
    }
    setData(res ?? null)
  }

  async function cleanup() {
    setCleaning(true)
    setError(null)
    setNotice(null)
    const { data: res, error: fnErr } = await supabase.functions.invoke<RunResponse>('xero-invoice-selftest', {
      body: { action: 'cleanup' },
    })
    setCleaning(false)
    if (fnErr) {
      setError(fnErr.message)
      return
    }
    if (res?.error) {
      setError(res.error)
      return
    }
    setData(null)
    setNotice(`Deleted ${res?.deleted ?? 0} test draft${(res?.deleted ?? 0) === 1 ? '' : 's'} from Xero.`)
  }

  // Group results in the order they first appear (Products, Options, Add-ons).
  const groups = useMemo(() => {
    const out: { name: string; rows: ResultRow[] }[] = []
    for (const r of data?.results ?? []) {
      const g = out.find((x) => x.name === r.group)
      if (g) g.rows.push(r)
      else out.push({ name: r.group, rows: [r] })
    }
    return out
  }, [data])

  const summary = data?.summary

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-bold text-ink">Xero invoice self-test</h3>
        <p className="mt-1 text-sm text-ink-mute">
          Creates one <strong>draft</strong> invoice per product type in the connected Xero org — using the exact same logic a real paid order uses — then checks each one booked to the right item code and shows the tax rate Xero applied. No Stripe checkout, no real money, nothing posted to the ledger.
        </p>
        <p className="mt-2 text-xs text-ink-dim">
          Run it against the Demo org as a sanity check; the run that matters is after the app is pointed at the live Xero org, just before going live. When you're done, use “Delete test drafts” to remove every draft this created.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={run}
          disabled={running || cleaning}
          className="rounded bg-ink px-4 py-2 text-sm font-semibold text-on-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {running ? 'Running…' : 'Run self-test'}
        </button>
        <button
          type="button"
          onClick={cleanup}
          disabled={running || cleaning}
          className="rounded border border-line bg-surface px-4 py-2 text-sm font-medium text-ink-soft hover:border-out hover:text-out disabled:cursor-not-allowed disabled:opacity-40"
        >
          {cleaning ? 'Deleting…' : 'Delete test drafts'}
        </button>
        {running && <span className="text-xs text-ink-dim">Creating draft invoices in Xero — this can take a few seconds…</span>}
      </div>

      {error && (
        <div className="rounded-lg bg-out-soft px-3 py-2 text-sm text-out ring-1 ring-out">{error}</div>
      )}
      {notice && (
        <div className="rounded-lg bg-in-stock-soft px-3 py-2 text-sm text-in-stock ring-1 ring-in-stock">{notice}</div>
      )}

      {summary && (
        <div className="flex flex-wrap gap-3 text-sm">
          <span className="rounded-full bg-canvas px-3 py-1 font-medium text-ink ring-1 ring-line">{summary.total} tested</span>
          <span className="rounded-full bg-in-stock-soft px-3 py-1 font-medium text-in-stock ring-1 ring-in-stock">{summary.pass} passed</span>
          {summary.fail > 0 && (
            <span className="rounded-full bg-out-soft px-3 py-1 font-medium text-out ring-1 ring-out">{summary.fail} wrong code</span>
          )}
          {summary.error > 0 && (
            <span className="rounded-full bg-low-soft px-3 py-1 font-medium text-low ring-1 ring-low">{summary.error} rejected by Xero</span>
          )}
        </div>
      )}

      {groups.length > 0 && (
        <div className="overflow-hidden rounded-2xl bg-surface shadow-sm ring-1 ring-line">
          <table className="min-w-full divide-y divide-line-soft">
            <thead>
              <tr className="bg-canvas text-left text-xs font-semibold uppercase tracking-widest text-ink-mute">
                <th className="px-5 py-3">Product</th>
                <th className="px-5 py-3">Expected</th>
                <th className="px-5 py-3">Xero used</th>
                <th className="px-5 py-3">Tax</th>
                <th className="px-5 py-3">Result</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft text-sm">
              {groups.map((group) => (
                <Fragment key={group.name}>
                  <tr className="bg-canvas">
                    <td colSpan={5} className="px-5 py-2 text-xs font-semibold uppercase tracking-wider text-ink-dim">{group.name}</td>
                  </tr>
                  {group.rows.map((r) => (
                    <tr key={r.test} className={r.status === 'pass' ? '' : 'bg-low-soft/40'}>
                      <td className="px-5 py-3 align-top">
                        <div className="text-ink-soft">{r.test}</div>
                        {r.status !== 'pass' && <div className="mt-0.5 text-xs text-ink-dim">{r.message}</div>}
                      </td>
                      <td className="px-5 py-3 align-top font-mono text-ink-soft">{r.expectedCode ?? '—'}</td>
                      <td className="px-5 py-3 align-top font-mono text-ink-soft">{r.resolvedCode ?? '—'}</td>
                      <td className="px-5 py-3 align-top text-ink-dim">{r.taxType ?? '—'}</td>
                      <td className="px-5 py-3 align-top">
                        <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide ring-1 ${STATUS_STYLES[r.status]}`}>
                          {r.status === 'pass' ? 'Pass' : r.status === 'fail' ? 'Wrong code' : 'Rejected'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
