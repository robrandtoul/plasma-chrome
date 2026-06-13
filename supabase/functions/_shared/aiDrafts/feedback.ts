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

export interface EditResult {
  similarity: number // 0..1, rounded to 3dp
  editClass: EditClass
}

// Compare the AI draft to the human-sent reply (signature stripped).
export function classifyEdit(draftBody: string, sentBody: string): EditResult {
  const sim = similarityRatio(draftBody, stripSignature(sentBody))
  const rounded = Math.round(sim * 1000) / 1000
  let editClass: EditClass
  if (rounded >= 0.97) editClass = 'sent_as_is'
  else if (rounded >= 0.8) editClass = 'lightly_edited'
  else if (rounded >= 0.45) editClass = 'rewritten'
  else editClass = 'discarded'
  return { similarity: rounded, editClass }
}
