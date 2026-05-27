import type { ReactNode } from 'react'

type PaperRecipientBandProps = {
  heading: string
  pillSlot?: ReactNode
  topRule?: boolean
  children: ReactNode
}

// Per-recipient band wrapping the image grid + per-band action
// row. Heading reads "Eve's card" / "Eve and Marie's cards" etc.
// (the parent passes the formatted string), pillSlot carries an
// approval / changes-requested pill when the band already has a
// recorded action.
//
// File name kept as Paper* during the reskin per REVISIONS.md
// guidance — only the visual layer changes, the component stays
// at the same import path so call sites don't need edits.
export function PaperRecipientBand({
  heading,
  pillSlot,
  topRule = true,
  children,
}: PaperRecipientBandProps) {
  return (
    <div
      className={[
        topRule ? 'border-t border-line pt-6' : '',
        'mb-10',
      ].join(' ')}
    >
      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-3">
        <h3
          className="font-display font-medium tracking-[-0.02em] text-ink break-words leading-tight"
          style={{ fontSize: 'clamp(22px, 4vw, 28px)' }}
        >
          {heading}
        </h3>
        {pillSlot}
      </div>
      {children}
    </div>
  )
}
