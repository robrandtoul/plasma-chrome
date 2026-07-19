import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate, Navigate, useLocation } from 'react-router-dom'
import { KeyRound, Bell, Info, MailCheck } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { ButtonInk, Field, Input, LetterpressMotif } from '../design'
import { getPublicSettings } from '../lib/publicSettings'
import {
  LOGIN_HEADLINE_DEFAULT,
  LOGIN_DESCRIPTION_DEFAULT,
  LOGIN_STATS_DEFAULT,
  LOGIN_FORM_HEADING_DEFAULT,
  LOGIN_FORM_SUBCOPY_DEFAULT,
  type LoginStat,
} from '../lib/loginCopy'

export default function LoginPage() {
  const { session, loading } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  // Where to land after signing in. RequireAuth stamps the page the designer
  // was bounced off (a mid-session token refresh failure is the common case),
  // so they come back to it instead of always the dashboard. Guarded to
  // same-origin paths: the value is our own router state rather than user
  // input, but a leading "//" would still read as protocol-relative.
  const fromPath = (location.state as { from?: { pathname?: string; search?: string } } | null)?.from
  const candidate = fromPath?.pathname ? `${fromPath.pathname}${fromPath.search ?? ''}` : null
  const redirectTo =
    candidate && candidate.startsWith('/') && !candidate.startsWith('//') && candidate !== '/login'
      ? candidate
      : '/'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // 'signin' is the normal email + password form. 'forgot' swaps it for the
  // self-serve reset form; once a link has been sent, `sent` shows the
  // confirmation in its place.
  const [mode, setMode] = useState<'signin' | 'forgot'>('signin')
  const [sent, setSent] = useState(false)

  // Admin-editable login copy (migration 000206), fetched via the anon
  // public_settings RPC. Seeded with the shipped defaults so the first
  // paint shows readable copy with no flash, then updated if an admin
  // has changed it. getPublicSettings caches, so this is cheap.
  const [copy, setCopy] = useState<{
    headline: string
    description: string
    stats: LoginStat[]
    formHeading: string
    formSubcopy: string
  }>({
    headline: LOGIN_HEADLINE_DEFAULT,
    description: LOGIN_DESCRIPTION_DEFAULT,
    stats: LOGIN_STATS_DEFAULT,
    formHeading: LOGIN_FORM_HEADING_DEFAULT,
    formSubcopy: LOGIN_FORM_SUBCOPY_DEFAULT,
  })
  useEffect(() => {
    let cancelled = false
    void getPublicSettings().then((s) => {
      if (cancelled) return
      setCopy({
        headline: s.login_headline,
        description: s.login_description,
        stats: s.login_stats,
        formHeading: s.login_form_heading,
        formSubcopy: s.login_form_subcopy,
      })
    })
    return () => { cancelled = true }
  }, [])

  if (loading) return null
  if (session) return <Navigate to={redirectTo} replace />

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setSubmitting(true)

    const { error } = await supabase.auth.signInWithPassword({ email, password })

    if (error) {
      setError(error.message)
      setSubmitting(false)
    } else {
      navigate(redirectTo, { replace: true })
    }
  }

  async function handleForgot(e: FormEvent) {
    e.preventDefault()
    setError('')
    setSubmitting(true)
    // resetPasswordForEmail sends the project's "Reset password" email. The
    // link returns to this origin (which matches the project's Site URL in
    // production), where auth.tsx's PASSWORD_RECOVERY handling shows the
    // set-new-password screen. We never reveal whether the address exists.
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin,
    })
    setSubmitting(false)
    if (error) {
      setError(error.message)
      return
    }
    setSent(true)
  }

  return (
    <div className="min-h-dvh grid grid-cols-1 min-[880px]:grid-cols-2 bg-canvas">
      {/* Left brand panel. Ink-filled, white text. On narrow widths
          collapses to a 320px-tall top band with the headline shrunk
          and the stat row hidden — the form below is what matters
          on mobile, so the brand panel just sets the tone. */}
      <div
        className="relative overflow-hidden text-white bg-ink flex flex-col gap-8 px-8 pt-[calc(env(safe-area-inset-top)+3rem)] pb-12 min-[880px]:px-16 min-[880px]:py-16 min-h-[320px] min-[880px]:min-h-0"
      >
        {/* Full-colour Plasma logo lockup — the same white-text PNG
            the customer-facing proof header uses on its ink banner. */}
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
            {copy.headline}
          </h1>
          <p className="mt-5 text-[15px] text-white/65 max-w-[460px] leading-[1.55]">
            {copy.description}
          </p>
        </div>

        {/* Stat row. Hidden on narrow widths so the brand panel stays
            compact above the form. Values are admin-editable (migration
            000206); the panel renders whatever stats are configured
            (up to three). */}
        {copy.stats.length > 0 && (
          <div className="relative z-[2] hidden min-[880px]:flex gap-7">
            {copy.stats.map((s, i) => (
              <Stat key={i} value={s.value} label={s.label} />
            ))}
          </div>
        )}

        <LetterpressMotif size={360} top={48} right={-60} opacity={0.18} />
      </div>

      {/* Right form panel. Cream canvas, vertically centred, max-width
          on the inner stack so the form doesn't sprawl on wide screens. */}
      <div className="flex flex-col justify-center gap-7 px-8 py-12 min-[880px]:px-20 min-[880px]:py-14">
        <div className="max-w-[460px]">
          <div className="eyebrow">Designer sign in</div>
          <h2 className="mt-1.5 font-display font-medium tracking-[-0.02em] text-ink text-[36px] leading-tight m-0">
            {copy.formHeading}
          </h2>
          <p className="mt-2 text-[14px] text-ink-soft leading-[1.5] whitespace-pre-line">
            {copy.formSubcopy}
          </p>
        </div>

        {mode === 'signin' ? (
          <form
            onSubmit={handleSubmit}
            className="flex flex-col gap-3.5 max-w-[460px]"
          >
            <Field label="Email" htmlFor="login-email">
              <Input
                id="login-email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-11"
              />
            </Field>
            <Field label="Password" htmlFor="login-password">
              <Input
                id="login-password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-11"
              />
            </Field>
            {error && (
              <div
                role="alert"
                className="flex items-start gap-1.5 rounded-md bg-out-soft px-3 py-2 text-[13px] text-out"
              >
                <Info size={14} aria-hidden="true" className="mt-[2px] flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}
            <ButtonInk
              type="submit"
              block
              busy={submitting}
              className="mt-1.5 h-[52px] text-[15px]"
            >
              {submitting ? 'Signing in…' : 'Sign in'}
            </ButtonInk>
            <button
              type="button"
              onClick={() => {
                setMode('forgot')
                setError('')
                setSent(false)
              }}
              className="self-start text-[13px] font-medium text-brand hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--c-brand)] rounded-[2px]"
            >
              Forgot your password?
            </button>
          </form>
        ) : sent ? (
          <div className="flex flex-col gap-4 max-w-[460px]">
            <div className="flex items-start gap-1.5 rounded-md border border-line bg-surface px-3 py-2.5 text-[13px] text-ink-soft">
              <MailCheck size={14} aria-hidden="true" className="mt-[2px] flex-shrink-0 text-brand" />
              <span>
                If an account exists for {email || 'that address'}, a reset link
                is on its way. Open it on this device, then set a new password.
              </span>
            </div>
            <button
              type="button"
              onClick={() => {
                setMode('signin')
                setSent(false)
                setError('')
              }}
              className="self-start text-[13px] font-medium text-brand hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--c-brand)] rounded-[2px]"
            >
              Back to sign in
            </button>
          </div>
        ) : (
          <form
            onSubmit={handleForgot}
            className="flex flex-col gap-3.5 max-w-[460px]"
          >
            <Field
              label="Email"
              htmlFor="forgot-email"
              hint="We'll email you a link to set a new password."
            >
              <Input
                id="forgot-email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-11"
              />
            </Field>
            {error && (
              <div
                role="alert"
                className="flex items-start gap-1.5 rounded-md bg-out-soft px-3 py-2 text-[13px] text-out"
              >
                <Info size={14} aria-hidden="true" className="mt-[2px] flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}
            <ButtonInk
              type="submit"
              block
              busy={submitting}
              className="mt-1.5 h-[52px] text-[15px]"
            >
              {submitting ? 'Sending…' : 'Send reset link'}
            </ButtonInk>
            <button
              type="button"
              onClick={() => {
                setMode('signin')
                setError('')
              }}
              className="self-start text-[13px] font-medium text-brand hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--c-brand)] rounded-[2px]"
            >
              Back to sign in
            </button>
          </form>
        )}

        <div className="flex items-center gap-3 max-w-[460px]">
          <span className="flex-1 h-px bg-line-soft" aria-hidden="true" />
          <span className="eyebrow">Need help?</span>
          <span className="flex-1 h-px bg-line-soft" aria-hidden="true" />
        </div>

        <ul className="m-0 p-0 list-none flex flex-col gap-2.5 text-[13px] text-ink-soft max-w-[460px]">
          <li className="flex items-start gap-2">
            <KeyRound
              size={14}
              aria-hidden="true"
              className="mt-[2px] flex-shrink-0 text-brand"
            />
            Lost your password? Use "Forgot your password?" above, or ask Rob.
          </li>
          <li className="flex items-start gap-2">
            <Bell
              size={14}
              aria-hidden="true"
              className="mt-[2px] flex-shrink-0 text-brand"
            />
            Customer link not loading? Check Netlify status and try again.
          </li>
          <li className="flex items-start gap-2">
            <Info
              size={14}
              aria-hidden="true"
              className="mt-[2px] flex-shrink-0 text-brand"
            />
            Customers don't sign in. They get a private URL by email.
          </li>
        </ul>
      </div>
    </div>
  )
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <div
        className="font-mono font-medium text-white leading-none"
        style={{ fontSize: 28, fontFeatureSettings: 'var(--num-features)' }}
      >
        {value}
      </div>
      <div
        className="mt-1 font-mono font-medium uppercase text-white/45"
        style={{ fontSize: 10, letterSpacing: '0.18em' }}
      >
        {label}
      </div>
    </div>
  )
}
