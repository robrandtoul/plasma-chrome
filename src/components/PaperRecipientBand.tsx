import type { ReactNode } from 'react'
import { PAPER_INK, SERIF } from '../lib/theme'

type PaperRecipientBandProps = {
  heading: string
  pillSlot?: ReactNode
  topRule?: boolean
  children: ReactNode
}

export function PaperRecipientBand({
  heading,
  pillSlot,
  topRule = true,
  children,
}: PaperRecipientBandProps) {
  return (
    <div
      className={[
        topRule ? 'border-t-2 border-[rgba(26,22,18,0.8)] pt-6' : '',
        'mb-16',
      ].join(' ')}
    >
      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-3">
        <h3
          className="break-words"
          style={{
            fontFamily: SERIF,
            fontWeight: 400,
            fontSize: 'clamp(28px, 7vw, 38px)',
            lineHeight: 1,
            color: PAPER_INK,
          }}
        >
          {heading}
        </h3>
        {pillSlot}
      </div>
      {children}
    </div>
  )
}
