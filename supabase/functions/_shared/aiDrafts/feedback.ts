// Feedback-loop diff: compare an AI draft against the reply a human actually
// sent, and classify how much it changed. Pure, dependency-free, unit-tested.
//
// The headline acceptance metric (Phase 3) is built on this: sent_as_is /
// lightly_edited / rewritten / discarded per category. The semantic
// pattern-mining layer comes later; this is the mechanical measurement.
//
// Signature handling matters: Help Scout appends the sender's signature on
// send, so a draft sent completely untouched arrives with extra text the
// draft never had. Without stripping it, every send would look "edited".

export type EditClass = 'sent_as_is' | 'lightly_edited' | 'rewritten' | 'discarded'

// Sign-off phrases that can begin a signature block. A real signature occupies
// (almost) its whole line — "Many thanks", "Kind regards," or "Kind regards,
// Rob" — and sits at the END of the message. It is NOT a body line that merely
// OPENS with one of these words ("Thanks for getting in touch, …", "Thank you
// for letting us know …"), which Plasma's replies use constantly. Treating an
// opener as a signature (the old bug, PV 2026-06-13) chopped the entire body,
// so an identical sent-as-is reply scored ~0.02 and was logged "discarded".
//
// `rest` captures whatever follows the sign-off on the same line. The line is a
// signature only when `rest` is either empty (just the sign-off, maybe a comma)
// or a short NAME — which starts with a capital ("Kind regards, Rob"). A
// lowercase continuation ("Thank you for letting us know.", "Thanks for
// confirming…") is a body sentence, never a signature.
const SIGNOFF_LINE_RE =
  /^[\s>]*(?:kind(?:est)? regards|warm(?:est)? regards|best regards|best wishes|many thanks|thanks(?: (?:so|very) much)?|thank you|with thanks|cheers|regards|yours(?: sincerely| faithfully)?|speak soon|all the best|best)\b(?<rest>.*)$/i

export function stripSignature(text: string): string {
  if (!text) return ''
  const lines = text.split('\n')
  // Take the LAST qualifying sign-off line so a genuine trailing signature wins
  // over any earlier body line.
  let cutLine = -1
  for (let i = 0; i < lines.length; i++) {
    const m = SIGNOFF_LINE_RE.exec(lines[i])
    if (!m) continue
    const rest = (m.groups?.rest ?? '').replace(/^[\s,.!;:–-]+/, '') // drop leading punctuation
    if (rest === '' || (/^[A-Z]/.test(rest) && rest.length <= 40)) cutLine = i
  }
  if (cutLine > 0) {
    const offset = lines.slice(0, cutLine).join('\n').length + 1 // +1: the \n before the cut line
    return text.slice(0, offset)
  }
  return text
}

// Lowercase, drop punctuation, collapse whitespace — so trivial formatting
// differences don't register as edits. Capped so pathological lengths can't
// blow up the O(n*m) distance.
export function normalise(text: string): string {
  return (text ?? '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, (u) => u.replace(/[)\].,]+$/, '')) // keep URLs whole-ish
    .replace(/[^a-z0-9£€$%.\s/:-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000)
}

// Levenshtein distance with a rolling row (O(min(n,m)) memory).
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let prev = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    prev = cur
  }
  return prev[b.length]
}

// 1.0 = identical, 0.0 = nothing in common.
export function similarityRatio(a: string, b: string): number {
  const na = normalise(a)
  const nb = normalise(b)
  if (!na && !nb) return 1
  if (!na || !nb) return 0
  const maxLen = Math.max(na.length, nb.length)
  return 1 - levenshtein(na, nb) / maxLen
}

// The line between "they edited our draft" and "they wrote something else".
// ONE constant, used in exactly two places on purpose: classifyEdit treats it
// as the 'rewritten' floor (below it a reply is 'discarded'), and classifyMatch
// treats it as the gate every 'unrelated' rule sits behind. If those two ever
// drifted apart, the same pair could be an edit to one function and a different
// message to the other — so they read the same number rather than each
// hardcoding 0.45.
export const EDIT_EVIDENCE_FLOOR = 0.45

// Similarity as BOTH functions must see it: rounded to 3dp, which is also what
// gets stored in ai_drafts.edit_similarity.
//
// Rounding before the comparison is the whole point. classifyEdit thresholds
// the rounded number, so if classifyMatch gated on the raw one there would be a
// sliver — a raw 0.4495 to 0.4499 — stored as similarity 0.45 and class
// 'rewritten' while the gate saw it as below the floor and let a rule call the
// same pair 'unrelated'. That sliver is only reachable on bodies of a couple of
// thousand characters (a shorter message cannot land a Levenshtein ratio that
// finely), which is why live has no instance of it — but it would still break
// the one invariant this design rests on. Sharing this helper closes it
// outright rather than relying on the inputs staying short.
export function roundedSimilarity(a: string, b: string): number {
  return Math.round(similarityRatio(a, b) * 1000) / 1000
}

export interface EditResult {
  similarity: number // 0..1, rounded to 3dp
  editClass: EditClass
}

// Compare the AI draft to the human-sent reply (signature stripped).
export function classifyEdit(draftBody: string, sentBody: string): EditResult {
  const rounded = roundedSimilarity(draftBody, stripSignature(sentBody))
  let editClass: EditClass
  if (rounded >= 0.97) editClass = 'sent_as_is'
  else if (rounded >= 0.8) editClass = 'lightly_edited'
  else if (rounded >= EDIT_EVIDENCE_FLOOR) editClass = 'rewritten'
  else editClass = 'discarded'
  return { similarity: rounded, editClass }
}

// ── Match quality: was the sent reply an edit of the draft AT ALL? ───────────
//
// captureFeedback() pairs a draft with "the newest published staff reply sent
// after it". Often that reply is not an edited draft — it is a different
// message that happened to go out next: the proof delivery, the order link,
// the payment confirmation, an automated-style chase, or a one-line aside.
// Scored as an edit, those land in 'discarded' and drag the acceptance figure
// down for reasons that have nothing to do with draft quality. Measured
// against live on 2026-07-26, 97 of the 248 'discarded' rows (39%) are this.
// See docs/ai-draft-edit-review-2026-07.md §1.
//
// This verdict sits ALONGSIDE classifyEdit — the similarity and edit_class
// thresholds are untouched, so nothing that already reads them changes. An
// 'unrelated' verdict says one thing only: "do not read this pair as an edit."
//
// What that buys, precisely:
//   1. THE ACCEPTANCE METRIC. It is accepted drafts over matched drafts, and
//      39% of the 'discarded' side of that denominator is proof deliveries and
//      order emails. Excluding them is review §1's actual complaint, and the
//      whole reason these two columns exist.
//   2. TRUST IN THE LABEL. Someone reading a 'discarded' row on the Drafts
//      panel can see it was the order-link email, without opening Help Scout
//      to find out the team never rejected anything.
//
// What it does NOT buy, despite the obvious guess: protection for the pattern
// miner. The miner only mines edit_class 'lightly_edited' or 'rewritten', which
// BY DEFINITION means similarity >= EDIT_EVIDENCE_FLOOR — and the gate below
// returns 'edit' unconditionally at that similarity. The two sets are disjoint
// by construction, so the miner's match-quality filter excludes exactly zero
// rows: checked read-only against all 529 matched rows on live (2026-07-26),
// where no 'lightly_edited'/'rewritten' row sits below the floor and no
// 'discarded' row sits above it. That filter is a guard in case either
// threshold moves later, not something doing work today. Do not weaken the
// gate to manufacture the benefit — the gate is what rescues the 11 genuine
// order-link edits, which are the most valuable pairs in the set.
//
// Everything here is deliberately CONSERVATIVE. A wrong 'unrelated' throws
// away a real edit AND flatters the acceptance rate — the worse of the two
// errors — so every rule below has to clear a high bar, and anything doubtful
// stays an 'edit'.

export type MatchQuality = 'edit' | 'unrelated'

// Machine-readable so the miner and any future analytics can filter on the
// cause rather than parsing prose.
export type MatchReason =
  | 'proof_delivery' // the reply hands over a proof the draft never mentioned
  | 'order_message' // order link / payment confirmation, not a reply to the customer
  | 'stale_draft' // sent so long after the draft it cannot be the same message
  | 'different_message' // a one-liner with nothing of the draft left in it

export interface MatchVerdict {
  quality: MatchQuality
  reason: MatchReason | null // null whenever quality is 'edit'
}

export interface MatchOptions {
  draftCreatedAt?: string | Date | null
  sentAt?: string | Date | null
}

// A draft is written to be sent that day. Beyond three days the conversation
// has moved on and the next staff reply is answering something else. Three
// days rather than one because a Friday draft legitimately goes out Monday.
// Live backs the value up: no 'sent_as_is' pair took longer than 40 hours and
// no 'lightly_edited' pair longer than 22, while 25 'discarded' pairs sit past
// 72 hours — including one addressed to an entirely different customer.
export const STALE_DRAFT_HOURS = 72

// "Very short relative to the draft" — a reply that is both under ~2 sentences
// AND a quarter of the draft's length. A real edit that trims hard (the team
// does cut a 500-character draft to "Yes, our letterpress cards can be printed
// on both sides") still reuses the draft's words, so the overlap test below is
// what actually decides; these two only keep the test away from normal replies.
const TERSE_MAX_CHARS = 140
const TERSE_MAX_RATIO = 0.25
// At most a fifth of the reply's own words appear anywhere in the draft. Note
// this is forgiving by construction: house boilerplate ("please let me know if
// any further information would help") counts as shared, pushing borderline
// pairs back to 'edit'.
const TERSE_MAX_OVERLAP = 0.2

// ⚠ The two link rules below can only see a URL that survived into the text we
// store. Help Scout hands thread bodies back as HTML and normaliseBody() strips
// the tags, so a reply written as <a href="…/p/<id>">view proofs</a> keeps
// "view proofs" and loses the address entirely — no rule here can fire on it.
// Rare in practice, because Help Scout auto-links a URL the sender simply
// pasted: exactly 1 of the 248 'discarded' rows on live has the anchor-text
// shape (it is fixture 7 in the tests, and the staleness rule catches that one
// anyway). This under-catches, which is the safe direction: the pair stays an
// 'edit', so the worst case is a mismatch we could have excluded and did not.
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
// Proof delivery: /p/<id> is the customer proof page, /bundle/<id> the
// multi-card review page. The drafter cannot invent either — the ids are
// unguessable — so one appearing in the reply and NOT in the draft means the
// reply is handing over artwork, which is not what the draft was doing.
const PROOF_LINK_RE = new RegExp(`/(?:p|bundle)/${UUID}`, 'i')
// Order traffic: the pay link, and the ORD-/GRP- reference that only the
// payment-confirmation email carries. Same argument — both are generated after
// the fact, so the drafter could not have written them.
const ORDER_LINK_RE = new RegExp(`/order/(?:group/)?${UUID}`, 'i')
const ORDER_REF_RE = /\b(?:ORD|GRP)-[0-9A-Z]{8,}\b/ // case-sensitive: the real references are upper case

function hasOrderMarker(text: string): boolean {
  return ORDER_LINK_RE.test(text) || ORDER_REF_RE.test(text)
}

// The greeting names the customer in both messages, so it can never be
// evidence that the two ARE the same message. Dropped before the word overlap.
const GREETING_LINE_RE = /^[\s>]*(?:hi|hello|hey|dear|good (?:morning|afternoon|evening))\b[^\n]*\n/i

function dropGreeting(text: string): string {
  return text.replace(GREETING_LINE_RE, '')
}

// Words of four characters or more, which skips most of the connective tissue
// ("is", "the", "and") without needing a stopword list to maintain.
function contentWords(text: string): Set<string> {
  const words = new Set<string>()
  for (const word of normalise(dropGreeting(text)).split(' ')) {
    if (word.length >= 4) words.add(word)
  }
  return words
}

// Share of `words` that also appear in `within`. An empty set counts as fully
// covered — no words is no evidence of difference.
function coverage(words: Set<string>, within: Set<string>): number {
  if (words.size === 0) return 1
  let hits = 0
  for (const word of words) if (within.has(word)) hits++
  return hits / words.size
}

function toMillis(value?: string | Date | null): number | null {
  if (!value) return null
  const ms = value instanceof Date ? value.getTime() : Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

// Decide whether `sentBody` is plausibly an edited version of `draftBody`.
// Timestamps are optional; the staleness rule simply does not apply without
// them. Signature-stripped on the sent side for the same reason classifyEdit
// is — Help Scout appends one on send.
export function classifyMatch(
  draftBody: string,
  sentBody: string,
  opts: MatchOptions = {},
): MatchVerdict {
  const draft = draftBody ?? ''
  const sent = stripSignature(sentBody ?? '')
  // Nothing to compare — say nothing rather than guess.
  if (!draft.trim() || !sent.trim()) return { quality: 'edit', reason: null }

  // The one gate every rule below sits behind. At or above this similarity the
  // reply demonstrably kept the draft's substance, so it IS an edit no matter
  // what else it contains — exactly the case the team creates when they paste
  // the live order URL into an otherwise-kept draft (review §2.1) or swap
  // "I will attach your proof" for the proof link (§2.4). Without the gate
  // those would be thrown away: on live, 11 'rewritten' and 1 'lightly_edited'
  // row trip a signal below and are saved here.
  //
  // roundedSimilarity, not the raw ratio, so this reads the same number
  // classifyEdit thresholded — see the note on the helper.
  if (roundedSimilarity(draft, sent) >= EDIT_EVIDENCE_FLOOR) return { quality: 'edit', reason: null }

  if (PROOF_LINK_RE.test(sent) && !PROOF_LINK_RE.test(draft)) {
    return { quality: 'unrelated', reason: 'proof_delivery' }
  }
  if (hasOrderMarker(sent) && !hasOrderMarker(draft)) {
    return { quality: 'unrelated', reason: 'order_message' }
  }

  const draftMs = toMillis(opts.draftCreatedAt)
  const sentMs = toMillis(opts.sentAt)
  if (draftMs !== null && sentMs !== null && sentMs - draftMs > STALE_DRAFT_HOURS * 3600_000) {
    return { quality: 'unrelated', reason: 'stale_draft' }
  }

  const sentLen = normalise(dropGreeting(sent)).length
  const draftLen = normalise(dropGreeting(draft)).length
  const terse = sentLen <= TERSE_MAX_CHARS && sentLen <= TERSE_MAX_RATIO * draftLen
  if (terse && coverage(contentWords(sent), contentWords(draft)) <= TERSE_MAX_OVERLAP) {
    return { quality: 'unrelated', reason: 'different_message' }
  }

  return { quality: 'edit', reason: null }
}
