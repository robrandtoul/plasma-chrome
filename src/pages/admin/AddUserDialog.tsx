import { useState } from 'react'
import Modal from '../../components/Modal'
import { supabase } from '../../lib/supabase'

// ── Password helpers ──────────────────────────────────────────────────────────

// Alphanumeric charset with visually ambiguous glyphs stripped (0/O, 1/l/I).
const PW_CHARS = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function generatePassword(length = 12): string {
  const arr = new Uint32Array(length)
  crypto.getRandomValues(arr)
  let out = ''
  for (let i = 0; i < length; i++) {
    out += PW_CHARS[arr[i] % PW_CHARS.length]
  }
  return out
}

// ── Component ────────────────────────────────────────────────────────────────

interface CreatedUser {
  id: string
  email: string
  full_name: string
  password: string
}

export default function AddUserDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: () => void
}) {
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<CreatedUser | null>(null)
  // Esc handling + first-field auto-focus owned by Modal.
  // preventClose wired to `submitting` blocks dismissal during
  // the in-flight create.

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    const cleanName = fullName.trim()
    const cleanEmail = email.trim().toLowerCase()
    if (!cleanName) { setError('Full name is required.'); return }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) { setError('Please enter a valid email.'); return }
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return }

    setSubmitting(true)
    const { data, error: fnErr } = await supabase.functions.invoke('create-user', {
      body: { email: cleanEmail, full_name: cleanName, password },
    })
    setSubmitting(false)

    if (fnErr) {
      setError(fnErr.message || 'Failed to create user')
      return
    }
    if ((data as any)?.error) {
      setError((data as any).error)
      return
    }

    const result = data as { id: string; email: string; full_name: string }
    setCreated({ id: result.id, email: result.email, full_name: result.full_name, password })
    onCreated()
  }

  async function copyToClipboard(text: string) {
    try { await navigator.clipboard.writeText(text) } catch { /* ignore */ }
  }

  return (
    <Modal
      open
      onClose={onClose}
      preventClose={submitting}
      ariaLabelledBy="add-user-title"
    >
          {created ? (
            <CredentialsView
              user={created}
              onCopy={copyToClipboard}
              onClose={onClose}
            />
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <h3 id="add-user-title" className="text-lg font-semibold text-gray-900">Add user</h3>
                <p className="mt-1 text-xs text-gray-500">
                  Creates a new Designer account. Share the credentials with the person directly — we'll show them once.
                </p>
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700">
                  Full name <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className={inputClass}
                  placeholder="e.g. Alice Thompson"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700">
                  Email <span className="text-rose-500">*</span>
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={inputClass}
                  placeholder="alice@plasmadesign.co.uk"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-700">
                  Password <span className="text-rose-500">*</span>
                </label>
                <div className="flex gap-2">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className={inputClass + ' font-mono'}
                    placeholder="At least 8 characters"
                  />
                  <button
                    type="button"
                    onClick={() => setPassword(generatePassword(12))}
                    className="shrink-0 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
                  >
                    Generate
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowPassword(v => !v)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="shrink-0 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
                  >
                    {showPassword ? 'Hide' : 'Show'}
                  </button>
                </div>
              </div>

              {error && (
                <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  disabled={submitting}
                  className="rounded-lg px-4 py-2 text-sm font-medium text-gray-500 hover:bg-gray-100 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-700 disabled:opacity-50"
                >
                  {submitting ? 'Creating…' : 'Create user'}
                </button>
              </div>
            </form>
          )}
    </Modal>
  )
}

function CredentialsView({ user, onCopy, onClose }: {
  user: CreatedUser
  onCopy: (t: string) => void
  onClose: () => void
}) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-gray-900">User created</h3>
        <p className="mt-1 text-sm text-gray-600">
          Share these credentials with {user.full_name}:
        </p>
      </div>

      <CopyRow label="Email" value={user.email} onCopy={onCopy} />
      <CopyRow label="Password" value={user.password} onCopy={onCopy} mono />

      <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
        Save these credentials now, they won't be shown again.
      </p>

      <div className="flex justify-end">
        <button
          onClick={onClose}
          className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-700"
        >
          Done
        </button>
      </div>
    </div>
  )
}

function CopyRow({ label, value, onCopy, mono }: {
  label: string
  value: string
  onCopy: (t: string) => void
  mono?: boolean
}) {
  const [copied, setCopied] = useState(false)
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-gray-400">{label}</div>
      <div className="flex gap-2">
        <input
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          className={[inputClass, mono ? 'font-mono' : ''].join(' ')}
        />
        <button
          type="button"
          onClick={async () => {
            await onCopy(value)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
          className="shrink-0 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  )
}

const inputClass = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-[17px] sm:text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900'
