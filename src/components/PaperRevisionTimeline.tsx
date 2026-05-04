import { useState } from 'react'
import type { PublicProofVersion } from '../lib/types'
import { PaperTimelineRow } from './PaperTimelineRow'
import {
  PAPER_INK,
  PAPER_TINT_1,
  PAPER_TERTIARY,
  PAPER_QUATERNARY,
  SERIF,
} from '../lib/theme'

type PaperRevisionTimelineProps = {
  versions: PublicProofVersion[]
  activeVersion: PublicProofVersion
  onSelectVersion: (v: PublicProofVersion) => void
}

// Coachmark localStorage key — preserved character-for-character
// from the previous timeline so customers who already dismissed
// the coachmark do not see it again on the new layout.
const COACH_STORAGE_KEY = 'pv_timeline_coach_seen'

// Collapse-the-tail thresholds. When versions.length exceeds the
// threshold, only the most recent N stay visible by default; the
// rest fold behind a toggle. The active version is always pulled
// into view via a between-marker if it would otherwise be hidden.
const COLLAPSE_THRESHOLD = 5
const VISIBLE_RECENT = 3

export function PaperRevisionTimeline({
  versions,
  activeVersion,
  onSelectVersion,
}: PaperRevisionTimelineProps) {
  const [coachSeen, setCoachSeen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true
    try {
      return localStorage.getItem(COACH_STORAGE_KEY) === '1'
    } catch {
      return true
    }
  })
  const [expanded, setExpanded] = useState(false)

  const dismissCoach = () => {
    try {
      localStorage.setItem(COACH_STORAGE_KEY, '1')
    } catch {
      // storage unavailable — still dismiss in-memory
    }
    setCoachSeen(true)
  }

  const handleSelectVersion = (v: PublicProofVersion) => {
    onSelectVersion(v)
    if (!coachSeen) dismissCoach()
  }

  const latest = versions[versions.length - 1]
  const reversed = [...versions].reverse()

  const shouldCollapse = versions.length > COLLAPSE_THRESHOLD && !expanded
  const visibleRecent = reversed.slice(0, VISIBLE_RECENT)
  const activeInVisibleRecent = visibleRecent.some((v) => v.id === activeVersion.id)
  const activeIndex = reversed.findIndex((v) => v.id === activeVersion.id)
  // Number of versions sitting between the last visible recent (v[VISIBLE_RECENT-1])
  // and the active version, when active is older than the visible set.
  const gapCount =
    !activeInVisibleRecent && shouldCollapse ? activeIndex - VISIBLE_RECENT : 0
  const lastVisibleRecentNumber =
    visibleRecent[visibleRecent.length - 1]?.version_number
  // Total versions hidden under the toggle (everything except top N
  // and, when applicable, the always-visible active row).
  const hiddenCount = shouldCollapse
    ? activeInVisibleRecent
      ? versions.length - VISIBLE_RECENT
      : versions.length - VISIBLE_RECENT - 1
    : 0

  const renderRow = (v: PublicProofVersion) => (
    <PaperTimelineRow
      key={v.id}
      versionNumber={v.version_number}
      createdAt={v.created_at}
      note={v.change_notes}
      isActive={v.id === activeVersion.id}
      isLatest={v.id === latest.id}
      onSelect={() => handleSelectVersion(v)}
    />
  )

  return (
    <section
      aria-label="Revisions"
      className="border-y border-[rgba(26,22,18,0.10)]"
      style={{ background: PAPER_TINT_1 }}
    >
      <div className="mx-auto max-w-[1080px] px-8 py-12">
        <div className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
          <span
            className="font-paper-mono uppercase"
            style={{ fontSize: 10, fontWeight: 500, letterSpacing: '0.32em', color: PAPER_TERTIARY }}
          >
            Revisions
          </span>
          <span
            className="font-paper-mono uppercase"
            style={{ fontSize: 10, fontWeight: 500, letterSpacing: '0.24em', color: PAPER_QUATERNARY }}
          >
            {versions.length} entries · most recent on top
          </span>
        </div>

        <div className="grid grid-cols-1 gap-6 sm:grid-cols-[120px_1fr_140px]">
          <div className="sm:text-right">
            <span
              className="block"
              style={{ fontFamily: SERIF, fontWeight: 400, fontSize: 96, lineHeight: 0.9, color: PAPER_INK }}
            >
              v{activeVersion.version_number}
            </span>
            <p
              className="mt-2 font-paper-mono uppercase"
              style={{ fontSize: 10, fontWeight: 500, letterSpacing: '0.22em', color: PAPER_TERTIARY }}
            >
              showing
            </p>
          </div>

          <div className="space-y-2">
            {!shouldCollapse
              ? reversed.map(renderRow)
              : activeInVisibleRecent
                ? visibleRecent.map(renderRow)
                : (
                  <>
                    {visibleRecent.map(renderRow)}
                    <div
                      className="font-paper-mono uppercase text-center py-2"
                      style={{
                        fontSize: 10,
                        fontWeight: 500,
                        letterSpacing: '0.32em',
                        color: PAPER_QUATERNARY,
                      }}
                    >
                      · · · {gapCount} version{gapCount === 1 ? '' : 's'} between v{lastVisibleRecentNumber} and v{activeVersion.version_number} · · ·
                    </div>
                    {renderRow(activeVersion)}
                  </>
                )}
            {versions.length > COLLAPSE_THRESHOLD && (
              <button
                type="button"
                onClick={() => {
                  setExpanded((e) => !e)
                  // Toggling the tail is engagement with the
                  // timeline too — dismiss the coachmark so it
                  // doesn't linger forever for a customer who
                  // expands the older versions but never picks
                  // a row to compare against.
                  if (!coachSeen) dismissCoach()
                }}
                className="block w-full text-center py-3 mt-2 font-paper-mono uppercase transition-colors hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(123,63,242,0.5)] rounded-sm"
                style={{
                  fontSize: 11,
                  fontWeight: 500,
                  letterSpacing: '0.32em',
                  color: PAPER_TERTIARY,
                }}
              >
                {expanded
                  ? '− Hide earlier versions'
                  : `+ ${hiddenCount} earlier version${hiddenCount === 1 ? '' : 's'}`}
              </button>
            )}
          </div>

          <div className="sm:text-right">
            {!coachSeen && (
              <span
                className="font-paper-mono uppercase"
                style={{ fontSize: 10, fontWeight: 500, letterSpacing: '0.22em', color: PAPER_TERTIARY }}
              >
                Tap any row to compare
              </span>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
