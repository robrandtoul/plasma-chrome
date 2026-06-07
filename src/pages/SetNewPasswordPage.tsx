import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { CheckCircle2 } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { ButtonInk, Field, Input, LetterpressMotif } from '../design'

// Matches MIN_PASSWORD_LENGTH in the admin-user-password edge function.
const MIN_PASSWORD_LENGTH = 8

// Shown by AppShell whenever the auth provider is in a recovery state, i.e. the
// user arrived via an admin-sent reset link. It takes over the whole viewport so
// the user is asked to set a new password rather than being dropped on the
// dashboard still signed in with their old one. Mirrors the LoginPage layout
// (ink / cream split, logo lockup, mono micro-labels).
export default function SetNewPasswordPage() {
  const { recovery, recoveryError, endRecovery } = useAuth()
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const isError = recovery === 'error'

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`)
      return
    }
    if (password !== confirm) {
      setError('The two passwords do not match.')
      return
    }
    setSubmitting(true)
    const { error: updateError } = await supabase.auth.updateUser({ password })
    setSubmitting(false)
    if (updateError) {
      setError(updateError.message)
      return
    }
    // The recovery link already signed the user in; hand back to the app.
    endRecovery()
    navigate('/', { replace: true })
  }

  return (
    <div className="min-h-dvh grid grid-cols-1 min-[880px]:grid-cols-2 bg-canvas">
      {/* Left brand panel — same lockup as the login screen. */}
      <div className="relative overflow-hidden text-white bg-ink flex flex-col gap-8 px-8 pt-[calc(env(safe-area-inset-top)+3rem)] pb-12 min-[880px]:px-16 min-[880px]:py-16 min-h-[260px] min-[880px]:min-h-0">
        <img
          src="/logo-dark.png"
          alt="PlasmaDesign Proofs"
          className="relative z-[2] self-start h-[50px] w-auto"
        />
        <div className="relative z-[2] mt-auto">
          <h1
            className="font-display font-medium tracking-[-0.02em] m-0 whitespace-pre-line"
            style={{ fontSize: 'clamp(32px, 5vw, 56px)', lineHeight: 1.05 }}
          >
            {isError ? 'Reset link\nexpired.' : 'Set a new\npassword.'}
          </h1>
          <p className="mt-5 text-[15px] text-white/65 max-w-[460px] leading-[1.55]">
            {isError
              ? 'This recovery link is no longer valid. Request a fresh one from the sign-in screen, or ask an admin.'
              : 'Choose a new password for your account. You will be signed in straight after.'}
          </p>
        </div>
        <LetterpressMotif size={360} top={48} right={-60} opacity={0.18} />
      </div>

      {/* Right form panel. */}
      <div className="flex flex-col justify-center gap-7 px-8 py-12 min-[880px]:px-20 min-[880px]:py-14">
        <div className="max-w-[460px] w-full">
          <div className="eyebrow">Recovery</div>
          <h2 className="mt-1.5 font-display font-medium tracking-[-0.02em] text-ink text-[36px] leading-tight m-0">
            {isError ? 'Link expired' : 'Set a new password'}
          </h2>

          {isError ? (
            <div className="mt-6 flex flex-col gap-5 max-w-[400px]">
              <p className="text-[14px] text-ink-soft leading-[1.5]">
                {recoveryError ??
                  'This reset link has expired or has already been used. Request a new one from the sign-in screen, or ask an admin.'}
              </p>
              <ButtonInk
                onClick={() => {
                  endRecovery()
                  navigate('/login', { replace: true })
                }}
              >
                Back to sign in
              </ButtonInk>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4 max-w-[400px]">
              <Field label="New password" error={error || undefined}>
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  invalid={!!error}
                  required
                />
              </Field>
              <Field label="Confirm new password">
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                />
              </Field>
              <ButtonInk type="submit" busy={submitting} icon={CheckCircle2} block>
                Save new password
              </ButtonInk>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
