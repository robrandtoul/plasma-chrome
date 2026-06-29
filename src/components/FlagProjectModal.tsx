import { useEffect, useId, useState } from 'react'
import { Search, Check } from 'lucide-react'
import Modal from './Modal'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { logAudit } from '../lib/audit'
import { Field, Textarea, ButtonInk, ButtonGhost } from '../design'
import { WATCH_CATEGORIES, type WatchCategory, type WatchItem } from '../lib/watchList'

// Flag a project onto the Watch list. Two modes:
//   • fixed  — a `proof` is passed (from a proof / order page); the project is
//     locked and we just pick a category + write the first note.
//   • search — no `proof`; the board opens this and the user searches for the
//     project to flag first.
// The card's author + proof context (company/contact/designer/order) are stamped
// server-side by the watch_items_set_context trigger (000290), so the client
// only supplies proof_id, category, and its own created_by.

interface FixedProof {
  id: string
  companyName: string | null
  contactName: string | null
}

interface FlagProjectModalProps {
  /** Fixed-proof mode: flag this project. Omit for the board's search mode. */
  proof?: FixedProof | null
  onClose: () => void
  /** Called with the new card so the caller can prepend it to the board. */
  onCreated: (item: WatchItem) => void
}

interface ProjectHit {
  proof_id: string
  company_name: string | null
  contact_name: string | null
}

function projectLabel(company: string | null, contact: string | null): string {
  return company?.trim() || contact?.trim() || 'Untitled project'
}

export default function FlagProjectModal({ proof, onClose, onCreated }: FlagProjectModalProps) {
  const titleId = useId()
  const { session } = useAuth()
  const userId = session?.user.id ?? null

  const [category, setCategory] = useState<WatchCategory>('lost_in_transit')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Search mode only.
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<ProjectHit[]>([])
  const [searching, setSearching] = useState(false)
  const [picked, setPicked] = useState<ProjectHit | null>(null)

  const fixed = proof ?? null
  const resolvedProofId = fixed?.id ?? picked?.proof_id ?? null
  const resolvedLabel = fixed
    ? projectLabel(fixed.companyName, fixed.contactName)
    : picked
      ? projectLabel(picked.company_name, picked.contact_name)
      : null

  // Debounced project search (search mode). The .or() filter is built from
  // sanitised input — strip the PostgREST control chars (, ( ) %) so a stray
  // comma can't break the filter or inject a condition.
  useEffect(() => {
    if (fixed) return
    const q = query.trim()
    if (q.length < 2) {
      setHits([])
      return
    }
    let cancelled = false
    setSearching(true)
    const handle = setTimeout(() => {
      const esc = q.replace(/[,()%]/g, ' ')
      void (async () => {
        const { data } = await supabase
          .from('public_dashboard_projects')
          .select('proof_id, company_name, contact_name')
          .or(`company_name.ilike.%${esc}%,contact_name.ilike.%${esc}%`)
          .limit(12)
        if (cancelled) return
        setHits((data ?? []) as ProjectHit[])
        setSearching(false)
      })()
    }, 220)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [query, fixed])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!userId) {
      setError('You appear to be signed out — please reload and try again.')
      return
    }
    if (!resolvedProofId) {
      setError('Pick a project to flag first.')
      return
    }

    setSubmitting(true)

    const { data: row, error: insErr } = await supabase
      .from('watch_items')
      .insert({ proof_id: resolvedProofId, category, created_by: userId })
      .select('*')
      .single()

    if (insErr || !row) {
      setSubmitting(false)
      // 23505 = the partial unique index: this project already has an open card.
      if (insErr?.code === '23505') {
        setError('This project is already on the watch list. Open the board to add an update.')
        return
      }
      setError(insErr?.message || 'Could not flag this project. Please try again.')
      return
    }

    const item = row as WatchItem

    // The first note is optional but is the whole point of the board, so it's
    // strongly nudged. A failed note must not orphan the card — surface it but
    // keep the card (the user can add the note on the board).
    const cleanNote = note.trim()
    if (cleanNote) {
      const { error: noteErr } = await supabase
        .from('watch_updates')
        .insert({ watch_item_id: item.id, kind: 'note', body: cleanNote, created_by: userId })
      if (noteErr) {
        setSubmitting(false)
        setError('Flagged, but the first note didn’t save — add it on the board.')
        onCreated(item)
        return
      }
    }

    void logAudit({
      action: 'watch.flagged',
      targetType: 'watch_item',
      targetId: item.id,
      targetLabel: resolvedLabel ?? item.company_name ?? 'project',
      metadata: { category, proof_id: resolvedProofId },
    })

    setSubmitting(false)
    onCreated(item)
  }

  return (
    <Modal
      open
      onClose={onClose}
      preventClose={submitting}
      ariaLabelledBy={titleId}
      panelClassName="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl"
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <h3 id={titleId} className="text-lg font-semibold text-ink">
            Flag a project
          </h3>
          <p className="mt-1 text-[13px] text-ink-mute">
            Add this project to the shared watch list so anyone can see the latest and log updates.
          </p>
        </div>

        {/* Project: fixed (from a proof/order page) or searched (from the board). */}
        {fixed ? (
          <div className="rounded-[10px] border border-line bg-canvas px-3 py-2.5">
            <span className="eyebrow block">Project</span>
            <span className="mt-0.5 block text-[14px] font-medium text-ink">{resolvedLabel}</span>
          </div>
        ) : picked ? (
          <div className="flex items-center justify-between gap-2 rounded-[10px] border border-line bg-canvas px-3 py-2.5">
            <div className="min-w-0">
              <span className="eyebrow block">Project</span>
              <span className="mt-0.5 block truncate text-[14px] font-medium text-ink">{resolvedLabel}</span>
            </div>
            <ButtonGhost size="sm" onClick={() => setPicked(null)}>Change</ButtonGhost>
          </div>
        ) : (
          <div>
            <span className="eyebrow mb-1.5 block">Project</span>
            <label className="flex h-10 items-center gap-2 rounded-[8px] border border-line bg-surface px-2.5 focus-within:border-brand">
              <Search size={15} aria-hidden="true" className="shrink-0 text-ink-mute" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by company or contact…"
                className="flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-dim"
                autoFocus
              />
            </label>
            {query.trim().length >= 2 && (
              <div className="mt-2 max-h-56 overflow-y-auto rounded-[10px] border border-line">
                {searching && hits.length === 0 ? (
                  <p className="px-3 py-2.5 text-[13px] text-ink-mute">Searching…</p>
                ) : hits.length === 0 ? (
                  <p className="px-3 py-2.5 text-[13px] text-ink-mute">No matching projects.</p>
                ) : (
                  hits.map((h) => (
                    <button
                      key={h.proof_id}
                      type="button"
                      onClick={() => { setPicked(h); setQuery('') }}
                      className="flex w-full items-center justify-between gap-2 border-b border-line-soft px-3 py-2 text-left last:border-b-0 hover:bg-canvas"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-medium text-ink">
                          {projectLabel(h.company_name, h.contact_name)}
                        </span>
                        {h.company_name && h.contact_name && (
                          <span className="block truncate text-[12px] text-ink-mute">{h.contact_name}</span>
                        )}
                      </span>
                      <Check size={14} aria-hidden="true" className="shrink-0 text-ink-dim" />
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        )}

        {/* Category */}
        <div>
          <span className="eyebrow mb-1.5 block">What’s the problem?</span>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Problem category">
            {WATCH_CATEGORIES.map((c) => (
              <button
                key={c.value}
                type="button"
                role="radio"
                aria-checked={category === c.value}
                onClick={() => setCategory(c.value)}
                className={[
                  'h-9 rounded-[8px] border px-2 text-[12.5px] font-medium transition-colors',
                  category === c.value
                    ? 'border-brand bg-brand-50 text-ink'
                    : 'border-line bg-surface text-ink-mute hover:bg-canvas',
                ].join(' ')}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>

        <Field
          label="First update"
          hint="What’s happened so far — the more the next person knows, the better."
          htmlFor={`${titleId}-note`}
        >
          <Textarea
            id={`${titleId}-note`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder="e.g. Courier marked delivered but customer never received. Claim opened; need to re-run the 500."
          />
        </Field>

        {error && (
          <p role="alert" className="rounded-lg bg-out-soft px-3 py-2 text-[13px] text-out">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <ButtonGhost onClick={onClose} disabled={submitting}>Cancel</ButtonGhost>
          <ButtonInk type="submit" busy={submitting} disabled={!resolvedProofId}>
            Add to watch list
          </ButtonInk>
        </div>
      </form>
    </Modal>
  )
}
