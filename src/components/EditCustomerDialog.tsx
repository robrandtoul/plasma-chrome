// Edit-customer dialog, rendered from ProofDetailPage.
//
// The customer identity on the proof header was display-only: the only
// place a company or contact could be corrected was Admin → Customers →
// open the company — three navigations from where a typo is actually
// noticed, and gated behind the admin area even though companies/contacts
// RLS (000015) has always allowed any signed-in designer to update them.
// The pencil on the identity block opens this dialog for every designer,
// putting the fix at the point of need.
//
// Scope is deliberately correction-sized: company name, contact name,
// contact email. Structural work (re-parenting a contact, merging or
// deleting companies, adding contacts) stays on Admin → Customers, which
// admins can jump to from the footer link.
//
// Validation, error copy and audit emissions mirror CustomerDetailPage
// exactly — company.updated / contact.updated with the same before/after
// shapes — so the Activity page can't tell the two surfaces apart.

import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import Modal from './Modal'
import { supabase } from '../lib/supabase'
import { logAudit } from '../lib/audit'
import { isValidEmail } from '../pages/customers/parts'

export interface EditCustomerDialogProps {
  contactId: string
  /** Null when the contact has no company — the company field is omitted
      rather than offering a rename of nothing. */
  companyId: string | null
  current: {
    companyName: string | null
    contactName: string
    contactEmail: string
  }
  /** Shows the footer link into Admin → Customers for the fuller record. */
  isAdmin: boolean
  onSaved: () => void
  onClose: () => void
}

export default function EditCustomerDialog({
  contactId,
  companyId,
  current,
  isAdmin,
  onSaved,
  onClose,
}: EditCustomerDialogProps) {
  const [companyDraft, setCompanyDraft] = useState(current.companyName ?? '')
  const [nameDraft, setNameDraft] = useState(current.contactName)
  const [emailDraft, setEmailDraft] = useState(current.contactEmail)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The two updates run sequentially; if the company save lands and the
  // contact save fails, a retry must not re-write (and re-audit) the
  // company. The ref survives the retry because the dialog stays mounted
  // through the error state.
  const companySaved = useRef(false)

  async function handleSave() {
    setError(null)
    const nextCompany = companyId ? companyDraft.trim() : null
    const nextName = nameDraft.trim()
    const nextEmail = emailDraft.trim()
    if (companyId && !nextCompany) { setError('Company name is required.'); return }
    if (!nextName) { setError('Contact name is required.'); return }
    if (!nextEmail) { setError('Email is required.'); return }
    if (!isValidEmail(nextEmail)) { setError('Email looks malformed.'); return }

    const companyChanged =
      companyId != null && !companySaved.current && nextCompany !== current.companyName
    const contactChanged =
      nextName !== current.contactName || nextEmail !== current.contactEmail

    if (!companyChanged && !contactChanged) {
      // Nothing to write — but if an earlier attempt already saved the
      // company, the caller still needs its refresh + toast.
      if (companySaved.current) onSaved()
      onClose()
      return
    }

    setSaving(true)
    try {
      if (companyChanged && companyId && nextCompany) {
        const { data, error: companyError } = await supabase
          .from('companies').update({ name: nextCompany }).eq('id', companyId).select('id, name').single()
        if (companyError || !data) {
          throw new Error(
            (companyError as { code?: string } | null)?.code === '23505'
              ? `A company called "${nextCompany}" already exists.`
              : companyError?.message ?? 'Save failed.',
          )
        }
        companySaved.current = true
        void logAudit({
          action: 'company.updated',
          targetType: 'company',
          targetId: companyId,
          targetLabel: data.name,
          beforeValue: { name: current.companyName },
          afterValue: { name: data.name },
        })
      }

      if (contactChanged) {
        // company_id rides along unchanged so the before/after shape
        // matches what Admin → Customers writes for the same action.
        const before = { full_name: current.contactName, email: current.contactEmail, company_id: companyId }
        const after = { full_name: nextName, email: nextEmail, company_id: companyId }
        const { data, error: contactError } = await supabase
          .from('contacts').update({ full_name: nextName, email: nextEmail }).eq('id', contactId).select('id').single()
        if (contactError || !data) {
          throw new Error(
            (contactError as { code?: string } | null)?.code === '23505'
              ? 'Another contact in that company already uses this email.'
              : contactError?.message ?? 'Save failed.',
          )
        }
        void logAudit({
          action: 'contact.updated',
          targetType: 'contact',
          targetId: contactId,
          targetLabel: nextName,
          beforeValue: before,
          afterValue: after,
        })
      }

      onSaved()
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const inputClass =
    'w-full rounded-lg border border-line px-3 py-2 text-[17px] sm:text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand'

  return (
    <Modal
      open
      onClose={onClose}
      preventClose={saving}
      ariaLabelledBy="edit-customer-title"
      panelClassName="flex max-h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-2xl bg-surface shadow-xl"
    >
      <div className="flex items-start justify-between border-b border-line-soft px-6 py-4">
        <div>
          <h3 id="edit-customer-title" className="text-lg font-semibold text-ink">Edit customer details</h3>
          <p className="mt-0.5 text-xs text-ink-mute">
            Changes apply everywhere this customer appears — this project, the dashboard and any other projects.
          </p>
        </div>
        <button
          onClick={onClose}
          disabled={saving}
          className="rounded p-1.5 text-ink-dim hover:bg-canvas hover:text-ink-soft disabled:opacity-50"
          aria-label="Close"
        >
          <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
            <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
          </svg>
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
        {companyId && (
          <div>
            <label htmlFor="edit-customer-company" className="mb-1.5 block text-sm font-medium text-ink-soft">
              Company name
            </label>
            <input
              id="edit-customer-company"
              type="text"
              value={companyDraft}
              onChange={(e) => { setCompanyDraft(e.target.value); setError(null) }}
              className={inputClass}
            />
          </div>
        )}
        <div>
          <label htmlFor="edit-customer-name" className="mb-1.5 block text-sm font-medium text-ink-soft">
            Contact name
          </label>
          <input
            id="edit-customer-name"
            type="text"
            value={nameDraft}
            onChange={(e) => { setNameDraft(e.target.value); setError(null) }}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="edit-customer-email" className="mb-1.5 block text-sm font-medium text-ink-soft">
            Email
          </label>
          <input
            id="edit-customer-email"
            type="email"
            value={emailDraft}
            onChange={(e) => { setEmailDraft(e.target.value); setError(null) }}
            className={inputClass}
          />
          <p className="mt-1.5 text-xs text-ink-mute">
            Used for Help Scout matching and future orders — correct it here if it was mistyped.
          </p>
        </div>

        {error && (
          <p className="rounded-lg bg-out-soft px-4 py-3 text-sm text-out">{error}</p>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-line-soft px-6 py-4">
        {isAdmin ? (
          <Link
            to={companyId ? `/admin/customers/${companyId}` : '/admin/customers/none'}
            className="text-xs text-ink-mute underline underline-offset-2 hover:text-ink"
          >
            Open in Admin → Customers
          </Link>
        ) : <span />}
        <div className="flex gap-2">
          <button
            onClick={onClose}
            disabled={saving}
            className="rounded px-4 py-2 text-sm font-medium text-ink-mute hover:bg-canvas disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={saving}
            className="rounded bg-ink px-4 py-2 text-sm font-semibold text-on-ink hover:opacity-90 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
