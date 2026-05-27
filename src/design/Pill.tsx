import { type HTMLAttributes } from 'react'

export type PillColour =
  | 'brand'
  | 'in-stock'
  | 'low'
  | 'out'
  | 'critical'
  | 'allocated'
  | 'neutral'
  | 'mute'

interface PillProps extends HTMLAttributes<HTMLSpanElement> {
  colour?: PillColour
  children: React.ReactNode
}

// Generic pill using the .pill base class from design-tokens.css with
// per-colour classes layered on. Use ProofStatusPill for proof-status
// rendering; this is the lower-level primitive for any other pill use
// (Custom quote indicator, variant-round badge, etc.). The leading
// dot is part of the base .pill class; pass `colour="mute"` for a
// quieter, dot-coloured variant when "neutral" reads too cool.
const COLOUR_CLASS: Record<PillColour, string> = {
  brand: 'pill-brand',
  'in-stock': 'pill-in-stock',
  low: 'pill-low',
  out: 'pill-out',
  critical: 'pill-critical',
  allocated: 'pill-allocated',
  neutral: 'text-ink-soft bg-line-soft',
  mute: 'text-ink-dim bg-line-soft',
}

export function Pill({ colour = 'brand', className = '', children, ...rest }: PillProps) {
  const cls = ['pill', COLOUR_CLASS[colour], className].filter(Boolean).join(' ')
  return (
    <span className={cls} {...rest}>
      {children}
    </span>
  )
}

export default Pill
