// Spot a contact stored with only a first name, and — where the evidence is
// good enough — propose the full name.
//
// Why this exists: on 2026-07-29 an audit found 18 live projects whose contact
// was a bare first name ("Sam", "Celia", "Karan"). None of them were typed that
// way. Every one arrived through the Help Scout paste flow, which pre-fills the
// contact from the HS customer record (`firstName + lastName`, see
// NewProofPage's applyPasteResult) — and in 12 of the 15 cases Help Scout held
// no surname either, so the form faithfully copied a first name and the
// designer accepted it. In the other 3, Help Scout DID have the surname but we
// never looked again: the paste flow matches an existing contact by email and
// reuses that row as-is, so a name that was right in July stayed stale.
//
// So the nudge has two jobs: warn where a name looks incomplete, and — the part
// that actually gets it fixed — offer the correct name as one click.
//
// Conservative by design, in the same spirit as matchMaterial.ts: a suggestion
// is offered only when the evidence points at exactly one answer, and nothing
// is ever applied automatically. A designer who ignores every prompt ends up
// exactly where they are today.

import { titleCase } from './titleCase'

// Shared mailboxes tell us nothing about a person's name. Checked against the
// local part before any matching, so `post@luftperspektiv.no` can't donate a
// surname to a contact who happens to be called Post.
const GENERIC_MAILBOXES = new Set([
  'info', 'admin', 'sales', 'hello', 'contact', 'post', 'mail', 'office',
  'enquiries', 'enquiry', 'accounts', 'support', 'team', 'studio', 'design',
  'print', 'orders', 'shop', 'marketing', 'hi', 'help', 'noreply', 'no-reply',
])

// Minimum letters for a token to be treated as a name. Kills the two failure
// modes that showed up in the live data: `sami69@mac.com` for a contact called
// "Sam" would otherwise propose "Sam I", and a one-letter initial in a
// separated local part ("ryxn.j123") is not a surname.
const MIN_TOKEN = 3

function hasLetters(s: string): boolean {
  return /\p{L}/u.test(s)
}

// Collapse any run of whitespace (including the non-breaking space that comes
// back from pasted HTML) to single spaces, and trim.
export function normaliseName(fullName: string): string {
  return (fullName ?? '').replace(/[\s ]+/g, ' ').trim()
}

// Word tokens that could plausibly be part of a name. Punctuation-only tokens
// are dropped so "Karen ." reads as one name token, not two.
export function nameTokens(fullName: string): string[] {
  return normaliseName(fullName).split(' ').filter(hasLetters)
}

// True when the stored name is a single word — a first name with no surname.
// An empty name is NOT flagged: that's a missing required field, which the
// form's own validation already covers, and two complaints about one blank box
// is worse than one.
export function isFirstNameOnly(fullName: string): boolean {
  return nameTokens(fullName).length === 1
}

// Propose a full name recovered from the email address, or null when the
// address doesn't clearly carry one.
//
// Two shapes are accepted:
//
//   A. Separated — `karen.law@`, `kane_adams@`. The separator is explicit
//      evidence of a word boundary, so this shape is trusted even for a short
//      first name ("jo.smith" → Jo Smith). Either order matches, since
//      surname-first addresses exist.
//
//   B. Concatenated — `arnelburkic@`, `calebhozan16@`. The local part starts
//      with the first name and the remainder becomes the surname.
//
// ⚠ Shape B is a genuine guess and has two known false-positive classes, both
// kept deliberately rather than fixed, because no string rule distinguishes
// them from the cases it gets right:
//
//   1. The stored name is the whole forename but the address continues it —
//      `sialyse@hotmail.com` for "Sia" proposes "Sia Lyse", where the customer
//      is really Sialyse Ducaine. Indistinguishable from `arnelburkic` →
//      Arnel Burkic.
//   2. The stored name is a diminutive of the forename in the address —
//      "Sam" + `samantha@` proposes "Sam Antha"; "Dan" + `danielsmith@`
//      proposes "Dan Ielsmith".
//
// Class 2 at least fails LOUDLY — the output is visibly not a name, so a
// designer won't click it. Class 1 is the dangerous one because it reads as
// plausible. Both are tolerable only because the suggestion is a question with
// the email in view, is labelled as read from the address, and is never
// auto-applied. Shape B earns its keep: 3 of the 5 recoverable live cases
// (Caleb Hozan, Arnel Burkic, Andrea Egidio) come through it.
export function suggestNameFromEmail(fullName: string, email: string): string | null {
  const tokens = nameTokens(fullName)
  if (tokens.length !== 1) return null
  const firstOriginal = tokens[0]
  const first = firstOriginal.toLowerCase()

  const at = (email ?? '').indexOf('@')
  if (at <= 0) return null
  // Plus-addressing is a routing tag, not a name: `karen+cards@` must not
  // yield "Karen Cards". Strip it before anything else, then drop a trailing
  // digit run ("calebhozan16" → "calebhozan").
  const localCore = email
    .slice(0, at)
    .toLowerCase()
    .trim()
    .split('+')[0]
    .replace(/\d+$/, '')

  if (!localCore || GENERIC_MAILBOXES.has(localCore)) return null

  const compose = (surname: string) => `${firstOriginal} ${titleCase(surname)}`

  // A role word is never a surname, wherever it sits in the address. Checking
  // only the whole local part would let `john.sales@` propose "John Sales" —
  // and it would do so via shape A, the shape this code trusts most.
  const isRoleWord = (t: string) => GENERIC_MAILBOXES.has(t)

  // Shape A — an explicit separator.
  //
  // Dots and underscores are field separators essentially always, so they're
  // tried first. A hyphen is only tried when neither appears, because a hyphen
  // is just as likely to sit INSIDE a surname ("mary.smith-jones") as between
  // two fields ("mary-smith"): splitting on it unconditionally would chop
  // Smith-Jones in half. Either way the match still requires one part to equal
  // the contact's first name, so a lone hyphenated surname can't be mistaken
  // for a first/last pair.
  let parts = localCore.split(/[._]+/).filter(Boolean)
  if (parts.length === 1 && localCore.includes('-')) {
    parts = localCore.split('-').filter(Boolean)
  }
  if (parts.length === 2) {
    const [a, b] = parts
    // A surname may carry internal hyphens ("smith-jones") but nothing else.
    const usable = (t: string) =>
      t.length >= MIN_TOKEN && /^\p{L}+(-\p{L}+)*$/u.test(t) && !isRoleWord(t)
    if (a === first && usable(b)) return compose(b)
    if (b === first && usable(a)) return compose(a)
    return null
  }
  // Three or more parts is ambiguous (which one is the surname?) — say nothing.
  if (parts.length !== 1) return null

  // Shape B — concatenated.
  if (first.length < MIN_TOKEN) return null
  if (!localCore.startsWith(first)) return null
  const rest = localCore.slice(first.length)
  if (rest.length < MIN_TOKEN || !/^\p{L}+$/u.test(rest) || isRoleWord(rest)) return null
  return compose(rest)
}

// Propose `incoming` (e.g. the name Help Scout holds today) as a replacement
// for a stored first-name-only contact, or null when it isn't an improvement.
//
// The first token must agree, so an unrelated name can't overwrite the contact
// — this is the guard that keeps a shared mailbox or a merged HS customer from
// silently renaming somebody. Everything past that first token is returned
// verbatim rather than tidied: Help Scout sometimes holds a name with company
// cruft attached ("Andrea Egidio Marazzi - Beyond Group"), and trimming that
// would be another guess. The designer sees the exact proposed value and
// decides.
export function fullerNameFrom(existing: string, incoming: string): string | null {
  const cur = nameTokens(existing)
  const next = nameTokens(incoming)
  if (cur.length !== 1 || next.length < 2) return null
  if (next[0].toLowerCase() !== cur[0].toLowerCase()) return null
  const proposed = normaliseName(incoming)
  return proposed === normaliseName(existing) ? null : proposed
}

// The single best proposal for a stored contact, preferring what Help Scout
// actually holds over anything inferred from the email address. Returns null
// when there's nothing to propose.
//
// The `source` is not decoration: the UI words the two differently, because a
// Help Scout name is a fact somebody entered and an email-derived one is a
// reading of an address that the code knows can be wrong.
//
// ⚠ This is the function the UI must call. An earlier cut had ContactNameNudge
// re-deriving this same preference order inline, which meant the tests below
// covered a code path nothing shipped — a later edit could have flipped the
// precedence in the component with the suite still green. One implementation,
// one set of tests.
export function suggestContactName(
  fullName: string,
  email: string,
  helpscoutName?: string | null,
): { name: string; source: 'helpscout' | 'email' } | null {
  if (!isFirstNameOnly(fullName)) return null
  if (helpscoutName) {
    const fuller = fullerNameFrom(fullName, helpscoutName)
    if (fuller) return { name: fuller, source: 'helpscout' }
  }
  const fromEmail = suggestNameFromEmail(fullName, email)
  return fromEmail ? { name: fromEmail, source: 'email' } : null
}
