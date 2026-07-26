// Admin → System → Demo data.
//
// A known starting point for staff demos and for the end-to-end tests. Both had
// been relying on two hand-made projects staying as they were found, which they
// never did: notes ended up stranded on an old version after someone added a
// new one, and tests matching seeded wording broke as soon as a human rewrote it.
//
// Scope is narrow on purpose. It resets STATE — status, per-recipient approvals,
// notes and pins — and never touches audit history, because a button that could
// rewrite who approved what would undermine the record everything else depends
// on. Every action re-checks against the database that it is acting on a fixture
// project, so it cannot be aimed at a real customer.

import { useCallback, useEffect, useState } from 'react'
import { RotateCcw, MessageSquarePlus, RefreshCw } from 'lucide-react'
import { useAuth } from '../../lib/auth'
import { ProofStatusPill } from '../../design'
import {
  FIXTURE_COMPANY,
  loadFixtures,
  resetFixture,
  seedFixtureNotes,
  type FixtureProof,
} from '../../lib/demoFixtures'

type Busy = { id: string; action: 'reset' | 'seed' } | null

export default function AdminDemoDataPage() {
  const { session } = useAuth()
  const [fixtures, setFixtures] = useState<FixtureProof[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setError(null)
    try {
      setFixtures(await loadFixtures())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the demo projects.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function run(id: string, action: 'reset' | 'seed') {
    setBusy({ id, action })
    setError(null)
    setNotice(null)
    try {
      if (action === 'reset') {
        const r = await resetFixture(id)
        const bits = [
          r.notesCleared > 0 ? `${r.notesCleared} note${r.notesCleared === 1 ? '' : 's'} and pins` : null,
          r.approvalsCleared > 0
            ? `${r.approvalsCleared} approval${r.approvalsCleared === 1 ? '' : 's'}`
            : null,
          r.statusChanged ? 'status back to in progress' : null,
        ].filter(Boolean)
        setNotice(bits.length > 0 ? `Cleared ${bits.join(', ')}.` : 'Already clean — nothing to do.')
      } else {
        if (!session?.user?.id) throw new Error('No signed-in user to attribute the notes to.')
        const n = await seedFixtureNotes(id, session.user.id)
        setNotice(`Added ${n} sample note${n === 1 ? '' : 's'} to the current version.`)
      }
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="max-w-3xl">
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-medium text-ink">Demo data</h2>
        <button
          type="button"
          onClick={() => void refresh()}
          className="inline-flex items-center gap-1.5 rounded-[6px] border border-line px-2.5 py-1 text-[12px] text-ink-soft hover:border-ink-mute hover:text-ink"
        >
          <RefreshCw size={13} aria-hidden="true" />
          Refresh
        </button>
      </div>
      <p className="mb-5 max-w-prose text-sm text-ink-mute">
        The <strong className="font-medium text-ink-soft">{FIXTURE_COMPANY}</strong> projects are
        test data, not real customers. Reset them to a known state before a demo, or before running
        the end-to-end tests, so you start from the same place every time.
      </p>

      {error && (
        <p className="mb-4 rounded-[8px] border border-out bg-out-soft px-3 py-2 text-[13px] text-ink">
          {error}
        </p>
      )}
      {notice && !error && (
        <p className="mb-4 rounded-[8px] border border-in-stock bg-in-stock-soft px-3 py-2 text-[13px] text-ink">
          {notice}
        </p>
      )}

      {loading ? (
        <p className="text-[13.5px] text-ink-mute">Loading…</p>
      ) : fixtures.length === 0 ? (
        <p className="rounded-[10px] border border-line bg-surface px-4 py-6 text-[13.5px] text-ink-mute">
          No {FIXTURE_COMPANY} projects found. Nothing here can act on any other customer, so this
          page has nothing to do.
        </p>
      ) : (
        <ul className="grid gap-3">
          {fixtures.map((f) => {
            const isBusy = busy?.id === f.id
            return (
              <li
                key={f.id}
                className="rounded-[12px] border border-line bg-surface px-4 py-3.5"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="m-0 text-[14px] font-medium text-ink">
                      {f.contactName}
                      {f.materialDisplay && (
                        <span className="font-normal text-ink-mute"> · {f.materialDisplay}</span>
                      )}
                    </p>
                    <p className="m-0 mt-0.5 text-[12px] text-ink-mute">
                      {f.versionCount} version{f.versionCount === 1 ? '' : 's'}
                      {f.currentVersionNumber != null && ` · current v${f.currentVersionNumber}`}
                      {f.noteCount > 0 && ` · ${f.noteCount} note${f.noteCount === 1 ? '' : 's'}`}
                      {f.pinCount > 0 && ` · ${f.pinCount} pin${f.pinCount === 1 ? '' : 's'}`}
                      {f.approvalCount > 0 &&
                        ` · ${f.approvalCount} approval${f.approvalCount === 1 ? '' : 's'}`}
                    </p>
                  </div>
                  <ProofStatusPill status={f.status as never} />
                </div>

                <div className="mt-3 flex flex-wrap gap-2 border-t border-line-soft pt-3">
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => void run(f.id, 'reset')}
                    className="inline-flex items-center gap-1.5 rounded-[6px] border border-line px-2.5 py-1.5 text-[12.5px] text-ink-soft hover:border-ink-mute hover:text-ink disabled:opacity-50"
                  >
                    <RotateCcw size={13} aria-hidden="true" />
                    {isBusy && busy?.action === 'reset' ? 'Resetting…' : 'Reset to clean'}
                  </button>
                  <button
                    type="button"
                    disabled={isBusy || f.currentVersionId == null}
                    onClick={() => void run(f.id, 'seed')}
                    className="inline-flex items-center gap-1.5 rounded-[6px] border border-line px-2.5 py-1.5 text-[12.5px] text-ink-soft hover:border-ink-mute hover:text-ink disabled:opacity-50"
                  >
                    <MessageSquarePlus size={13} aria-hidden="true" />
                    {isBusy && busy?.action === 'seed' ? 'Adding…' : 'Add sample notes'}
                  </button>
                  <a
                    href={`/proofs/${f.id}`}
                    className="ml-auto self-center text-[12.5px] text-brand-700 underline decoration-1 underline-offset-2"
                  >
                    Open project
                  </a>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <div className="mt-6 rounded-[10px] border border-line bg-canvas px-4 py-3">
        <p className="m-0 text-[12.5px] text-ink-mute">
          <strong className="font-medium text-ink-soft">What reset does not do.</strong> Views,
          approvals and change requests already recorded in the activity trail stay where they are.
          That history is append-only by design — a button that could rewrite who approved what
          would undermine the record the rest of the app relies on. So a reset project may still
          show its past, and that is honest rather than a gap.
        </p>
      </div>
    </div>
  )
}
