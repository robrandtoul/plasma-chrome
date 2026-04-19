import { useState, type FormEvent } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'

export default function NewProofPage() {
  const { session } = useAuth()
  const navigate = useNavigate()

  const [customerName, setCustomerName] = useState('')
  const [company, setCompany] = useState('')
  const [helpscoutUrl, setHelpscoutUrl] = useState('')
  const [internalNotes, setInternalNotes] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setSubmitting(true)

    const { data, error } = await supabase
      .from('proofs')
      .insert({
        customer_name: customerName.trim(),
        company: company.trim() || null,
        helpscout_thread_url: helpscoutUrl.trim() || null,
        internal_notes: internalNotes.trim() || null,
        created_by: session!.user.id,
      })
      .select('id')
      .single()

    if (error) {
      setError(error.message)
      setSubmitting(false)
      return
    }

    navigate(`/proofs/${data.id}`)
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-xl px-4 py-10 sm:px-6">

        <div className="mb-6">
          <Link to="/" className="text-sm text-gray-400 hover:text-gray-700">← Back to proofs</Link>
        </div>

        <h1 className="mb-8 text-2xl font-bold text-gray-900">New proof</h1>

        <form onSubmit={handleSubmit} className="rounded-2xl bg-white p-8 shadow-sm ring-1 ring-gray-200">

          <Field label="Customer name" required>
            <input
              type="text"
              required
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              className={inputClass}
            />
          </Field>

          <Field label="Company" hint="Optional">
            <input
              type="text"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              className={inputClass}
            />
          </Field>

          <Field label="Help Scout thread URL" hint="Optional — internal only">
            <input
              type="url"
              value={helpscoutUrl}
              onChange={(e) => setHelpscoutUrl(e.target.value)}
              placeholder="https://secure.helpscout.net/…"
              className={inputClass}
            />
          </Field>

          <Field label="Internal notes" hint="Optional — never shown to customers">
            <textarea
              rows={3}
              value={internalNotes}
              onChange={(e) => setInternalNotes(e.target.value)}
              className={inputClass}
            />
          </Field>

          {error && (
            <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-gray-700 disabled:opacity-50"
          >
            {submitting ? 'Creating…' : 'Create proof'}
          </button>
        </form>
      </div>
    </div>
  )
}

const inputClass = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900'

function Field({ label, hint, required, children }: {
  label: string
  hint?: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="mb-5">
      <label className="mb-1.5 block text-sm font-medium text-gray-700">
        {label}
        {required && <span className="ml-1 text-red-500">*</span>}
        {hint && <span className="ml-2 font-normal text-gray-400">({hint})</span>}
      </label>
      {children}
    </div>
  )
}
