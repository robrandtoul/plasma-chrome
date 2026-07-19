// The ordered list of proofs the designer is currently working through.
//
// WHY THIS EXISTS. Working a queue of proofs meant a full round trip through
// the dashboard for every single one: open a proof, act, go back, find your
// place again, open the next. The detail page had no idea there was a "next".
//
// The dashboard publishes whatever it is currently showing — already filtered,
// searched and sorted, so the order matches what the designer sees — and the
// proof detail page reads it to offer ← / → navigation.
//
// Module-level and deliberately not persisted: it is a within-session
// convenience, and a stale list from yesterday would step through proofs that
// are no longer on screen. Everything degrades to "no arrows" when the list is
// empty or the current proof isn't in it (e.g. opened from a link or search),
// so nothing depends on it being populated.

export interface ProofWorklistEntry {
  proofId: string
  label: string
}

let worklist: ProofWorklistEntry[] = []

export function setProofWorklist(entries: ProofWorklistEntry[]) {
  worklist = entries
}

export interface WorklistPosition {
  index: number
  total: number
  prev: ProofWorklistEntry | null
  next: ProofWorklistEntry | null
}

// Where `proofId` sits in the published list, or null when it isn't in it.
// Callers render nothing in that case.
export function getWorklistPosition(proofId: string | undefined): WorklistPosition | null {
  if (!proofId || worklist.length < 2) return null
  const index = worklist.findIndex((e) => e.proofId === proofId)
  if (index === -1) return null
  return {
    index,
    total: worklist.length,
    prev: index > 0 ? worklist[index - 1] : null,
    next: index < worklist.length - 1 ? worklist[index + 1] : null,
  }
}
