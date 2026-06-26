import { Pill } from '../design'
import { FEEDBACK_STATUS_META, type FeedbackStatus } from '../lib/feedback'

// Status pill for the feedback board. Thin wrapper over the generic Pill
// primitive (mirrors ProofStatusPill's role) so the six feedback statuses
// render with consistent colours wherever they appear.
export function FeedbackStatusPill({ status }: { status: FeedbackStatus }) {
  const meta = FEEDBACK_STATUS_META[status]
  return <Pill colour={meta.colour}>{meta.label}</Pill>
}

export default FeedbackStatusPill
