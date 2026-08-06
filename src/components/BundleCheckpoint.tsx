// The bundle checkpoint card — shown instead of the MessageSendPanel after
// saving a version on a proof that belongs to a bundle with other live cards.
//
// Why it exists: a revision round across a bundle used to end each save at
// the send panel, whose primary button emailed the customer immediately —
// one email per card, the first arriving while the other cards were still
// un-revised. The correct ending (one email once the whole round is done)
// lives on the bundle workspace's "Send update" step; this card is the
// routing that gets the designer there. All decisions and copy come from
// src/lib/bundleCheckpoint.ts, which is where the tests point.
//
// The per-card send is deliberately demoted, not removed: "Send a message
// about just this card instead" hands over to the ordinary MessageSendPanel
// (the parent flips a bypass flag), with a caution saying what sending now
// actually does. A designer announcing a genuine single-card revision is one
// click from the old flow.

import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Check, Layers, Send } from 'lucide-react'
import { ButtonCoral, ButtonGhost } from '../design'
import {
  checkpointGuidance,
  primaryActionLabel,
  sendJustThisCardCaution,
  type BundleCheckpointModel,
  type CheckpointCardState,
} from '../lib/bundleCheckpoint'

interface BundleCheckpointProps {
  model: BundleCheckpointModel
  setId: string
  customerLabel: string
  onSendJustThisCard: () => void
}

export default function BundleCheckpoint({
  model,
  setId,
  customerLabel,
  onSendJustThisCard,
}: BundleCheckpointProps) {
  const navigate = useNavigate()

  return (
    <div className="rounded-2xl bg-surface p-6 shadow-sm ring-1 ring-line sm:p-8">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-canvas ring-1 ring-line">
          <Layers size={16} aria-hidden="true" className="text-ink-soft" />
        </span>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-ink">Part of {customerLabel}’s bundle</h2>
          <p className="mt-0.5 text-sm text-ink-soft">
            The customer reviews all {model.activeCount} cards on a single link — where the bundle stands:
          </p>
        </div>
      </div>

      <ul className="mt-4 divide-y divide-line rounded-xl bg-canvas ring-1 ring-line">
        {model.rows.map((row) => (
          <li key={row.proofId} className="flex items-center gap-3 px-4 py-3">
            <StateMark state={row.state} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-ink">
                {row.label}
                {row.isSavedCard && <span className="ml-1.5 text-xs font-normal text-ink-mute">(this card)</span>}
              </p>
              {row.sub && <p className="truncate text-xs text-ink-mute">{row.sub}</p>}
            </div>
            <p
              className={`shrink-0 text-xs font-medium ${
                row.state === 'saved_now'
                  ? 'text-emerald-700'
                  : row.state === 'awaiting_send'
                    ? 'text-amber-700'
                    : 'text-ink-mute'
              }`}
            >
              {row.stateLabel}
            </p>
          </li>
        ))}
      </ul>

      <p className="mt-4 text-sm text-ink-soft">{checkpointGuidance(model)}</p>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        {model.readyForOneSend ? (
          <>
            <ButtonCoral icon={Send} onClick={() => navigate(`/bundles/${setId}?send=1`)}>
              {primaryActionLabel(model)}
            </ButtonCoral>
            <ButtonGhost onClick={() => navigate(`/bundles/${setId}`)}>Back to the bundle</ButtonGhost>
          </>
        ) : (
          <ButtonCoral icon={ArrowLeft} onClick={() => navigate(`/bundles/${setId}`)}>
            {primaryActionLabel(model)}
          </ButtonCoral>
        )}
      </div>

      <div className="mt-5 border-t border-line pt-4">
        <button
          type="button"
          onClick={onSendJustThisCard}
          className="text-sm font-medium text-ink underline underline-offset-4 hover:opacity-80"
        >
          Send a message about just this card instead
        </button>
        <p className="mt-1.5 text-xs text-ink-soft">{sendJustThisCardCaution(model)}</p>
      </div>
    </div>
  )
}

// Row marker: the four states at a glance. Saved/announce-pending cards are
// the ones a bundle send covers (emerald tick / amber dot); the muted tick is
// "the customer already holds this"; the hollow ring is an unbuilt shell.
function StateMark({ state }: { state: CheckpointCardState }) {
  if (state === 'saved_now') {
    return (
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-50 ring-1 ring-emerald-200">
        <Check size={13} aria-hidden="true" className="text-emerald-700" />
      </span>
    )
  }
  if (state === 'awaiting_send') {
    return (
      <span className="flex h-6 w-6 shrink-0 items-center justify-center">
        <span className="h-2.5 w-2.5 rounded-full bg-amber-500" />
      </span>
    )
  }
  if (state === 'with_customer') {
    return (
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-canvas ring-1 ring-line">
        <Check size={13} aria-hidden="true" className="text-ink-mute" />
      </span>
    )
  }
  return (
    <span className="flex h-6 w-6 shrink-0 items-center justify-center">
      <span className="h-2.5 w-2.5 rounded-full border border-dashed border-ink-mute" />
    </span>
  )
}
