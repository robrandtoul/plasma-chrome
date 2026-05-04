import {
  ACCENT,
  PAPER_CARD_DIM,
  PAPER_INK,
  PAPER_SECONDARY,
  PAPER_TERTIARY,
  PAPER_QUATERNARY,
  SERIF,
} from '../lib/theme'

type PaperTimelineRowProps = {
  versionNumber: number
  createdAt: string
  note: string | null
  isActive: boolean
  isLatest: boolean
  onSelect: () => void
}

function formatRowDate(iso: string): string {
  return new Date(iso)
    .toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    .toUpperCase()
}

export function PaperTimelineRow({
  versionNumber,
  createdAt,
  note,
  isActive,
  isLatest,
  onSelect,
}: PaperTimelineRowProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={isActive ? 'step' : undefined}
      className={[
        'block w-full text-left py-3 px-4',
        // Active card uses rounded-r-md (square left edge against the
        // 4px purple accent border). Inactive uses rounded-md on all
        // four corners.
        isActive ? 'rounded-r-md' : 'rounded-md',
        'transition-colors hover:bg-[rgba(26,22,18,0.05)]',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(123,63,242,0.5)]',
      ].join(' ')}
      style={
        isActive
          ? {
              background: '#ffffff',
              borderLeft: `4px solid ${ACCENT}`,
            }
          : {
              background: PAPER_CARD_DIM,
              border: '0.5px solid rgba(26,22,18,0.12)',
            }
      }
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span style={{ fontFamily: SERIF, fontWeight: 400, fontSize: 24, color: PAPER_INK }}>
          v{versionNumber}
        </span>
        <span
          className="font-paper-mono uppercase"
          style={{ fontSize: 15, fontWeight: 500, letterSpacing: '0.22em', color: PAPER_TERTIARY }}
        >
          {formatRowDate(createdAt)}
        </span>
        {isLatest ? (
          <span
            className="inline-flex font-paper-mono uppercase rounded-full px-2 py-0.5"
            style={{
              fontSize: 13,
              fontWeight: 500,
              letterSpacing: '0.22em',
              background: 'rgba(81,180,148,0.18)',
              color: '#176b3f',
              border: '1px solid rgba(81,180,148,0.4)',
            }}
          >
            Current
          </span>
        ) : (
          <span
            className="font-paper-mono uppercase"
            style={{ fontSize: 13, fontWeight: 500, letterSpacing: '0.22em', color: PAPER_QUATERNARY }}
          >
            Superseded
          </span>
        )}
      </div>
      {note && (
        <p
          className="mt-2 font-body"
          style={{
            fontSize: 14,
            lineHeight: 1.6,
            color: PAPER_SECONDARY,
            maxWidth: '68ch',
          }}
        >
          {note}
        </p>
      )}
    </button>
  )
}
