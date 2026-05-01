import type { CSSProperties } from 'react'

type Props = {
  proofRef: string | null
  versionNumber?: number
  accentGlow: string
  captionStyle: CSSProperties
}

export function DocketBar({ proofRef, versionNumber, accentGlow, captionStyle }: Props) {
  return (
    <div className="mx-auto flex max-w-[1080px] flex-wrap items-center justify-between gap-3 px-8 py-5 sm:px-8">
      <div className="flex items-center gap-3">
        <img
          src="/logo-cards.png"
          alt="Plasma"
          className="h-10 w-auto"
          style={{ filter: `drop-shadow(0 0 18px ${accentGlow})` }}
        />
        <span className="ml-1 h-4 w-px bg-white/20" />
        <span style={captionStyle}>Proof Viewer</span>
      </div>
      <div className="flex items-center gap-5">
        {/* Masthead right-side = proof reference only.
            The material + variant composite that used
            to ride here was dropped — the hero facts
            row, revisions finish-picker, and spec sheet
            already carry the same information three
            times below. */}
        {proofRef && (
          <span style={captionStyle}>
            {versionNumber != null ? `${proofRef} · v${versionNumber}` : proofRef}
          </span>
        )}
      </div>
    </div>
  )
}
