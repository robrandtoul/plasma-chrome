import { type ReactNode } from 'react'
import { Info } from 'lucide-react'

interface FieldProps {
  label: string
  hint?: string
  error?: string
  /** Render the label as part of a <label> element wrapping children.
      Set false when the input has its own label (e.g. a fieldset of
      radios where each radio has its own labelled chip). Default true. */
  asLabel?: boolean
  /** Optional id passed through to the rendered <label htmlFor>. */
  htmlFor?: string
  className?: string
  children: ReactNode
}

// Labelled-form-field shell. Eyebrow above input, hint below, error
// in place of hint (with an Info icon and out-coloured text) once an
// error is set. Use with Input or Textarea below; for radio groups
// or custom widgets pass `asLabel={false}` and provide your own labelling.
export function Field({ label, hint, error, asLabel = true, htmlFor, className = '', children }: FieldProps) {
  const Wrapper = asLabel ? 'label' : 'div'
  const wrapperProps = asLabel && htmlFor ? { htmlFor } : {}
  return (
    <Wrapper className={['block', className].filter(Boolean).join(' ')} {...wrapperProps}>
      <span className="eyebrow block mb-1.5">{label}</span>
      {children}
      {error ? (
        <div className="mt-1.5 flex items-start gap-1 text-[12px] leading-snug text-out">
          <Info size={12} aria-hidden="true" className="mt-[1px] flex-shrink-0" />
          <span>{error}</span>
        </div>
      ) : hint ? (
        <div className="mt-1.5 text-[12px] leading-snug text-ink-mute">{hint}</div>
      ) : null}
    </Wrapper>
  )
}

export default Field
