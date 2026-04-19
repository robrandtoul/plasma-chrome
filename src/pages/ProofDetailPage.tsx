import { useEffect, useState, useRef } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import VersionDetailModal, { type ModalVersion } from '../components/VersionDetailModal'

interface Proof {
  id: string
  helpscout_thread_url: string | null
  internal_notes: string | null
  created_at: string
  contacts: {
    full_name: string
    email: string
    companies: { name: string } | null
  }
}

export default function ProofDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [proof, setProof] = useState<Proof | null>(null)
  const [versions, setVersions] = useState<ModalVersion[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedVersion, setSelectedVersion] = useState<ModalVersion | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const fallbackInputRef = useRef<HTMLInputElement>(null)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (id) loadProof(id)
  }, [id])

  async function loadProof(proofId: string) {
    const [proofResult, versionsResult] = await Promise.all([
      supabase
        .from('proofs')
        .select('id, helpscout_thread_url, internal_notes, created_at, contacts(full_name, email, companies(name))')
        .eq('id', proofId)
        .single(),
      supabase
        .from('proof_versions')
        .select('id, version_number, material_id, material_display, ink_names, currency, is_current, created_at, change_notes, pricing_snapshot, shipping_note, materials(featured_quantities)')
        .eq('proof_id', proofId)
        .order('version_number', { ascending: false }),
    ])

    if (proofResult.error || !proofResult.data) {
      navigate('/')
      return
    }

    setProof(proofResult.data as unknown as Proof)
    setVersions((versionsResult.data ?? []) as unknown as ModalVersion[])
    setLoading(false)
  }

  function showToast(message: string) {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    setToast(message)
    toastTimerRef.current = setTimeout(() => setToast(null), 3000)
  }

  function handleVersionUpdated(message: string) {
    setSelectedVersion(null)
    showToast(message)
    if (id) loadProof(id)
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-200 border-t-gray-900" />
      </div>
    )
  }

  async function copyCustomerUrl() {
    const url = `${window.location.origin}/p/${proof!.id}`
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      if (fallbackInputRef.current) {
        fallbackInputRef.current.value = url
        fallbackInputRef.current.select()
        document.execCommand('copy')
      }
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (!proof) return null

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6 lg:px-8">

        {/* Back */}
        <div className="mb-6">
          <Link to="/" className="text-sm text-gray-400 hover:text-gray-700">← Back to proofs</Link>
        </div>

        {/* Proof header */}
        <div className="mb-8 flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{proof.contacts.full_name}</h1>
            {proof.contacts.companies?.name && (
              <p className="mt-1 text-gray-500">{proof.contacts.companies.name}</p>
            )}
            <p className="mt-0.5 text-sm text-gray-400">{proof.contacts.email}</p>
          </div>
          <div className="flex gap-2">
            <a
              href={`/p/${proof.id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-gray-500 ring-1 ring-gray-200 hover:bg-gray-50"
            >
              <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 3H3.5A1.5 1.5 0 002 4.5v8A1.5 1.5 0 003.5 14h8A1.5 1.5 0 0013 12.5V10M10 2h4m0 0v4m0-4L7 9" />
              </svg>
              Preview
            </a>
            <button
              onClick={copyCustomerUrl}
              className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-gray-500 ring-1 ring-gray-200 hover:bg-gray-50"
            >
              {copied ? (
                <>
                  <svg className="h-4 w-4 text-emerald-500" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l3.5 3.5 6.5-7" />
                  </svg>
                  <span className="text-emerald-600">Link copied</span>
                </>
              ) : (
                <>
                  <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <rect x="5" y="5" width="8" height="8" rx="1.5" />
                    <path strokeLinecap="round" d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5" />
                  </svg>
                  Copy customer URL
                </>
              )}
            </button>
            {/* Hidden input for clipboard fallback */}
            <input ref={fallbackInputRef} className="sr-only" readOnly aria-hidden="true" />
            <Link
              to={`/proofs/${proof.id}/versions/new`}
              className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-700"
            >
              Add version
            </Link>
          </div>
        </div>

        {/* Internal metadata */}
        {(proof.helpscout_thread_url || proof.internal_notes) && (
          <div className="mb-8 rounded-2xl bg-amber-50 p-5 ring-1 ring-amber-100">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-amber-600">Internal</p>
            {proof.helpscout_thread_url && (
              <p className="mb-1 text-sm">
                <span className="text-gray-500">Help Scout: </span>
                <a href={proof.helpscout_thread_url} target="_blank" rel="noopener noreferrer"
                  className="text-amber-800 underline">
                  {proof.helpscout_thread_url}
                </a>
              </p>
            )}
            {proof.internal_notes && (
              <p className="text-sm text-amber-900">{proof.internal_notes}</p>
            )}
          </div>
        )}

        {/* Versions */}
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-gray-400">Versions</h2>

        {versions.length === 0 ? (
          <div className="rounded-2xl bg-white py-16 text-center shadow-sm ring-1 ring-gray-200">
            <p className="text-gray-400">No versions yet.</p>
            <Link to={`/proofs/${proof.id}/versions/new`}
              className="mt-3 inline-block text-sm font-medium text-gray-900 underline">
              Add the first version
            </Link>
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-200">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Version</th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Material</th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Currency</th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Notes</th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Added</th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Status</th>
                  <th className="w-8 px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => (
                  <tr
                    key={v.id}
                    onClick={() => setSelectedVersion(v)}
                    className="cursor-pointer border-b border-gray-50 last:border-0 hover:bg-gray-50"
                  >
                    <td className="px-6 py-4 font-medium text-gray-900">v{v.version_number}</td>
                    <td className="px-6 py-4 text-gray-700">{v.material_display}</td>
                    <td className="px-6 py-4 text-gray-500">{v.currency}</td>
                    <td className="max-w-xs truncate px-6 py-4 text-gray-500">{v.change_notes ?? '—'}</td>
                    <td className="px-6 py-4 text-gray-500">
                      {new Date(v.created_at).toLocaleDateString('en-GB')}
                    </td>
                    <td className="px-6 py-4">
                      {v.is_current && (
                        <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">
                          Current
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-4">
                      <svg className="h-4 w-4 text-gray-300" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 3l5 5-5 5" />
                      </svg>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Version detail modal */}
      {selectedVersion && (
        <VersionDetailModal
          version={selectedVersion}
          proofId={proof.id}
          allVersions={versions}
          onClose={() => setSelectedVersion(null)}
          onVersionUpdated={handleVersionUpdated}
        />
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-gray-900 px-5 py-2.5 text-sm font-medium text-white shadow-lg">
          {toast}
        </div>
      )}
    </div>
  )
}
