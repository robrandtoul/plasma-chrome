import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

interface ProofRow {
  id: string
  customer_name: string
  company: string | null
  created_at: string
  current_version: number | null
}

export default function DashboardPage() {
  const navigate = useNavigate()
  const [proofs, setProofs] = useState<ProofRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadProofs()
  }, [])

  async function loadProofs() {
    const { data } = await supabase
      .from('proofs')
      .select(`
        id, customer_name, company, created_at,
        proof_versions(version_number, is_current)
      `)
      .order('created_at', { ascending: false })

    const rows = (data ?? []).map((p: any) => ({
      id: p.id,
      customer_name: p.customer_name,
      company: p.company,
      created_at: p.created_at,
      current_version: p.proof_versions?.find((v: any) => v.is_current)?.version_number ?? null,
    }))

    setProofs(rows)
    setLoading(false)
  }

  async function handleSignOut() {
    await supabase.auth.signOut()
    navigate('/login')
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 lg:px-8">

        {/* Header */}
        <div className="mb-8 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium uppercase tracking-widest text-gray-400">Plasma Design</p>
            <h1 className="mt-1 text-2xl font-bold text-gray-900">Proofs</h1>
          </div>
          <div className="flex items-center gap-3">
            <Link
              to="/proofs/new"
              className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-700"
            >
              New proof
            </Link>
            <button
              onClick={handleSignOut}
              className="rounded-lg px-4 py-2 text-sm font-medium text-gray-500 hover:bg-gray-100"
            >
              Sign out
            </button>
          </div>
        </div>

        {/* Proofs list */}
        {loading ? (
          <div className="flex justify-center py-20">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-200 border-t-gray-900" />
          </div>
        ) : proofs.length === 0 ? (
          <div className="rounded-2xl bg-white py-20 text-center shadow-sm ring-1 ring-gray-200">
            <p className="text-gray-400">No proofs yet.</p>
            <Link to="/proofs/new" className="mt-3 inline-block text-sm font-medium text-gray-900 underline">
              Create the first one
            </Link>
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-200">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Customer</th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Company</th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Current version</th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Created</th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Customer link</th>
                </tr>
              </thead>
              <tbody>
                {proofs.map((proof) => (
                  <tr key={proof.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50">
                    <td className="px-6 py-4">
                      <Link to={`/proofs/${proof.id}`} className="font-medium text-gray-900 hover:underline">
                        {proof.customer_name}
                      </Link>
                    </td>
                    <td className="px-6 py-4 text-gray-500">{proof.company ?? '—'}</td>
                    <td className="px-6 py-4 text-gray-500">
                      {proof.current_version != null ? `v${proof.current_version}` : '—'}
                    </td>
                    <td className="px-6 py-4 text-gray-500">
                      {new Date(proof.created_at).toLocaleDateString('en-GB')}
                    </td>
                    <td className="px-6 py-4">
                      <a
                        href={`/p/${proof.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-gray-400 hover:text-gray-900"
                      >
                        /p/{proof.id.slice(0, 8)}…
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
