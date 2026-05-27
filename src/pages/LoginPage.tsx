import { useState, type FormEvent } from 'react'
import { useNavigate, Navigate } from 'react-router-dom'
import { Layers, KeyRound, Bell, Info } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { ButtonInk, Field, Input, LetterpressMotif } from '../design'

export default function LoginPage() {
  const { session, loading } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  if (loading) return null
  if (session) return <Navigate to="/" replace />

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setSubmitting(true)

    const { error } = await supabase.auth.signInWithPassword({ email, password })

    if (error) {
      setError(error.message)
      setSubmitting(false)
    } else {
      navigate('/')
    }
  }

  return (
    <div className="min-h-dvh grid grid-cols-1 min-[880px]:grid-cols-2 bg-canvas">
      {/* Left brand panel. Ink-filled, white text. On narrow widths
          collapses to a 320px-tall top band with the headline shrunk
          and the stat row hidden — the form below is what matters
          on mobile, so the brand panel just sets the tone. */}
      <div
        className="relative overflow-hidden text-white bg-ink flex flex-col gap-8 px-8 py-12 min-[880px]:p-16 min-h-[320px] min-[880px]:min-h-0"
      >
        {/* Inverted wordmark — hand-rolled rather than reusing
            PlasmaWordmark because that primitive is ink-on-cream
            by default and the only consumer that needs the
            inverted variant is this brand panel. */}
        <div className="relative z-[2] inline-flex items-center gap-3">
          <span className="inline-flex items-center justify-center w-10 h-10 rounded-[8px] bg-white text-ink">
            <Layers size={20} aria-hidden="true" />
          </span>
          <div className="leading-none">
            <div className="font-display font-medium tracking-[-0.02em] text-[24px]">
              PlasmaDesign
            </div>
            <div
              className="font-mono font-medium uppercase mt-1 text-white/55"
              style={{ fontSize: 10, letterSpacing: '0.2em' }}
            >
              Proofs
            </div>
          </div>
        </div>

        <div className="relative z-[2] mt-auto">
          <h1
            className="font-display font-medium tracking-[-0.02em] m-0"
            style={{ fontSize: 'clamp(32px, 5vw, 56px)', lineHeight: 1.05 }}
          >
            Every revision,<br />
            every recipient,<br />
            one private link.
          </h1>
          <p className="mt-5 text-[15px] text-white/65 max-w-[460px] leading-[1.55]">
            The signed-in side of the proof viewer. Drop in a JPEG, set the
            spec, snapshot the price. The customer reads, replies, signs off.
            No JPEGs in inboxes, no spreadsheet trail.
          </p>
        </div>

        {/* Stat row. Hidden on narrow widths so the brand panel
            stays compact above the form. Values are static
            placeholders per the handoff [Assumed] flag — wire to
            real Supabase counts later if useful, but the login is
            designer-only and rarely re-loaded, so live data
            wouldn't add much. */}
        <div className="relative z-[2] hidden min-[880px]:flex gap-7">
          <Stat value="142" label="proofs sent this year" />
          <Stat value="03" label="designers on the team" />
          <Stat value="24 h" label="typical turnaround" />
        </div>

        <LetterpressMotif size={360} top={48} right={-60} opacity={0.18} />
      </div>

      {/* Right form panel. Cream canvas, vertically centred, max-width
          on the inner stack so the form doesn't sprawl on wide screens. */}
      <div className="flex flex-col justify-center gap-7 px-8 py-12 min-[880px]:px-20 min-[880px]:py-14">
        <div className="max-w-[460px]">
          <div className="eyebrow">Designer sign in</div>
          <h2 className="mt-1.5 font-display font-medium tracking-[-0.02em] text-ink text-[36px] leading-tight m-0">
            Welcome back
          </h2>
          <p className="mt-2 text-[14px] text-ink-soft leading-[1.5]">
            Accounts are issued by an admin. New here? Ask Rob for a temporary
            password and change it from the header on first sign-in.
          </p>
        </div>

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
        </form>

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
            Lost your password? Reset is admin-only, ask Rob.
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
