import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'

interface ContactRow {
  id: string
  full_name: string
  email: string
  proofCount: number
}

interface CompanyRow {
  id: string
  name: string
  contacts: ContactRow[]
  proofCount: number
}

type Pending =
  | { kind: 'contact'; id: string; label: string }
  | { kind: 'company'; id: string; name: string; contactCount: number }

export default function CustomersPage() {
  const [companies, setCompanies] = useState<CompanyRow[]>([])
  const [orphans, setOrphans] = useState<ContactRow[]>([])
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState<Pending | null>(null)
  const [working, setWorking] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    // We pull the proof rows with their version count so we can ignore
    // "shell" proofs (row exists but no version has been added). Those
    // are cleaned up on delete by the RPC anyway.
    const [companiesResult, orphanResult] = await Promise.all([
      supabase
        .from('companies')
        .select('id, name, contacts(id, full_name, email, proofs(id, proof_versions(count)))')
        .order('name'),
      supabase
        .from('contacts')
        .select('id, full_name, email, proofs(id, proof_versions(count))')
        .is('company_id', null)
        .order('full_name'),
    ])

    function countRealProofs(proofs: any[]): number {
      return proofs.filter((p) => (p.proof_versions?.[0]?.count ?? 0) > 0).length
    }

    const rawCompanies = (companiesResult.data ?? []) as any[]
    const compRows: CompanyRow[] = rawCompanies.map((c) => {
      const contacts: ContactRow[] = ((c.contacts ?? []) as any[]).map((k) => ({
        id: k.id,
        full_name: k.full_name,
        email: k.email,
        proofCount: countRealProofs(k.proofs ?? []),
      }))
      contacts.sort((a, b) => a.full_name.localeCompare(b.full_name, 'en', { sensitivity: 'base' }))
      return {
        id: c.id,
        name: c.name,
        contacts,
        proofCount: contacts.reduce((sum, k) => sum + k.proofCount, 0),
      }
    })

    const rawOrphans = (orphanResult.data ?? []) as any[]
    const orphanRows: ContactRow[] = rawOrphans.map((k) => ({
      id: k.id,
      full_name: k.full_name,
      email: k.email,
      proofCount: countRealProofs(k.proofs ?? []),
    }))

    setCompanies(compRows)
    setOrphans(orphanRows)
    setLoading(false)
  }

  function showToast(message: string) {
    setToast(message)
    setTimeout(() => setToast(null), 3000)
  }

  async function handleConfirm() {
    if (!pending) return
    setWorking(true)
    setErrorMsg(null)
    try {
      if (pending.kind === 'contact') {
        const { error } = await supabase.rpc('delete_contact_if_empty', { p_contact_id: pending.id })
        if (error) throw new Error(error.message)
        showToast(`Deleted ${pending.label}`)
      } else {
        const { error } = await supabase.rpc('delete_company_if_empty', { p_company_id: pending.id })
        if (error) throw new Error(error.message)
        showToast(`Deleted ${pending.name}`)
      }
      setPending(null)
      await load()
    } catch (err) {
      setErrorMsg((err as Error).message)
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6 lg:px-8">
        <div className="mb-6">
          <Link to="/" className="text-sm text-gray-400 hover:text-gray-700">← Back to proofs</Link>
        </div>

        <div className="mb-8">
          <p className="text-sm font-medium uppercase tracking-widest text-gray-400">Plasma Design</p>
          <h1 className="mt-1 text-2xl font-bold text-gray-900">Customers</h1>
          <p className="mt-2 text-sm text-gray-500">
            View and tidy up companies and contacts. You can only delete entries with no proofs attached.
          </p>
        </div>

        {loading ? (
          <div className="flex justify-center py-20">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-200 border-t-gray-900" />
          </div>
        ) : (
          <div className="space-y-8">
            {companies.map((c) => {
              const canDeleteCompany = c.proofCount === 0
              return (
                <section key={c.id}>
                  <div className="mb-3 flex items-center gap-3">
                    <span className="whitespace-nowrap text-sm font-semibold text-gray-800">{c.name}</span>
                    <CountBadge count={c.proofCount} />
                    <div className="flex-1 border-t border-gray-200" />
                    {canDeleteCompany && (
                      <button
                        onClick={() => setPending({ kind: 'company', id: c.id, name: c.name, contactCount: c.contacts.length })}
                        className="shrink-0 text-xs font-medium text-rose-600 underline-offset-2 hover:underline"
                      >
                        Delete company
                      </button>
                    )}
                  </div>

                  <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-200">
                    {c.contacts.length === 0 ? (
                      <div className="px-5 py-4 text-sm text-gray-400">No contacts.</div>
                    ) : (
                      c.contacts.map((k, i) => (
                        <ContactRowUI
                          key={k.id}
                          contact={k}
                          withTopBorder={i > 0}
                          onDelete={() => setPending({ kind: 'contact', id: k.id, label: k.full_name })}
                        />
                      ))
                    )}
                  </div>
                </section>
              )
            })}

            {/* No-company section */}
            {orphans.length > 0 && (
              <section>
                <div className="mb-3 flex items-center gap-3">
                  <span className="whitespace-nowrap text-sm font-semibold text-gray-500">No company</span>
                  <div className="flex-1 border-t border-gray-200" />
                </div>
                <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-200">
                  {orphans.map((k, i) => (
                    <ContactRowUI
                      key={k.id}
                      contact={k}
                      withTopBorder={i > 0}
                      onDelete={() => setPending({ kind: 'contact', id: k.id, label: k.full_name })}
                    />
                  ))}
                </div>
              </section>
            )}

            {companies.length === 0 && orphans.length === 0 && (
              <div className="rounded-2xl bg-white py-16 text-center shadow-sm ring-1 ring-gray-200">
                <p className="text-gray-400">No customers yet.</p>
              </div>
            )}
          </div>
        )}
      </div>

      {pending && (
        <ConfirmDialog
          message={
            pending.kind === 'contact'
              ? `Delete ${pending.label}? This cannot be undone.`
              : `Delete ${pending.name} and its ${pending.contactCount} contact${pending.contactCount === 1 ? '' : 's'}? This cannot be undone.`
          }
          working={working}
          errorMsg={errorMsg}
          onConfirm={handleConfirm}
          onCancel={() => { setPending(null); setErrorMsg(null) }}
        />
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-gray-900 px-5 py-2.5 text-sm font-medium text-white shadow-lg">
          {toast}
        </div>
      )}
    </div>
  )
}

function ContactRowUI({ contact, withTopBorder, onDelete }: {
  contact: ContactRow
  withTopBorder: boolean
  onDelete: () => void
}) {
  const canDelete = contact.proofCount === 0
  return (
    <div className={['flex items-center gap-3 px-5 py-3', withTopBorder ? 'border-t border-gray-100' : ''].join(' ')}>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-gray-900">{contact.full_name}</div>
        <div className="truncate text-xs text-gray-400">{contact.email}</div>
      </div>
      <CountBadge count={contact.proofCount} />
      {canDelete && (
        <button
          onClick={onDelete}
          className="shrink-0 text-xs font-medium text-rose-600 underline-offset-2 hover:underline"
        >
          Delete
        </button>
      )}
    </div>
  )
}

function CountBadge({ count }: { count: number }) {
  if (count === 0) {
    return <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">No proofs</span>
  }
  return (
    <span className="shrink-0 rounded-full bg-gray-900 px-2 py-0.5 text-xs font-medium text-white">
      {count} proof{count === 1 ? '' : 's'}
    </span>
  )
}

function ConfirmDialog({
  message,
  working,
  errorMsg,
  onConfirm,
  onCancel,
}: {
  message: string
  working: boolean
  errorMsg: string | null
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50" onClick={() => !working && onCancel()} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
          <p className="text-sm text-gray-700">{message}</p>
          {errorMsg && (
            <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{errorMsg}</p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <button
              onClick={onCancel}
              disabled={working}
              className="rounded-lg px-4 py-2 text-sm font-medium text-gray-500 hover:bg-gray-100 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              disabled={working}
              className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
            >
              {working ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
