// Tests for the live briefing reader — fetchBriefing + the briefing VERSION it
// carries (migration 000351).
//
// Run: pnpm test:ai-drafts-briefing   (or `pnpm test`, which walks the tree)
// Hand-rolled harness, same convention as guardrails.test.ts / feedback.test.ts
// — no test framework in this repo; exits 1 on any failure.
//
// Why this file exists as well as the fetchBriefing checks in guardrails.test.ts:
// those use a stub client with no `maybeSingle`, so every version read inside
// fetchBriefing threw and was swallowed. The tests still passed — the version
// simply came back null every time — which meant the whole of 000351's
// behaviour was untested AND the failure was invisible except as stray warning
// lines in an otherwise-green run. The stub below has maybeSingle, so the
// version path is actually exercised.
//
// The claim these tests are really here to defend: a briefing VERSION that
// cannot be read must never cost us the BRIEFING. The version is bookkeeping;
// the house rules are what stop the drafter quoting freely and leaking. Throwing
// away an admin's live rules over a bit of missing metadata would be a safety
// regression in the opposite direction to the one the fallback exists to
// prevent. Until now that was asserted only in a code comment.

import { fetchBriefing, DEFAULT_BRIEFING, FALLBACK_BRIEFING_VERSION } from './briefing.ts'
import { HOUSE_RULES } from './briefing/houseRules.ts'
import { EXEMPLARS } from './briefing/exemplars.ts'

let failures = 0
let passes = 0

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passes++
  } else {
    failures++
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function eq<T>(name: string, actual: T, expected: T) {
  check(
    name,
    JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  )
}

// ── Stub Supabase client ─────────────────────────────────────────────────────
// Minimal shape: .from(table) returns a chainable builder that resolves at
// whichever terminal the real code uses — .order() for the two list reads,
// .maybeSingle() for the settings singleton. `throws: true` makes that terminal
// blow up, which is how a network-level failure actually shows up.
//
// Audit inserts are captured rather than discarded, because "the broken read is
// VISIBLE" is one of the things under test — a silent null is exactly the bug.

interface StubResult {
  data?: unknown
  error?: { message: string } | null
  throws?: boolean
}

function stubClient(byTable: Record<string, StubResult>) {
  const audits: { action: string; metadata: unknown }[] = []
  const client = {
    from(table: string) {
      const res = byTable[table] ?? { data: [], error: null }
      const settle = () => {
        if (res.throws) return Promise.reject(new Error(`network down reading ${table}`))
        return Promise.resolve({ data: res.data ?? null, error: res.error ?? null })
      }
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        order: () => settle(),
        maybeSingle: () => settle(),
        insert: (row: Record<string, unknown>) => {
          if (table === 'audit_log') {
            audits.push({ action: row.action as string, metadata: row.metadata })
          }
          return Promise.resolve({ error: null })
        },
      }
      return builder
    },
  }
  return { client: client as unknown as Parameters<typeof fetchBriefing>[0], audits }
}

// Two rules and one exemplar, enough for the DB briefing to be considered good.
const OK_RULES = { data: [{ rule_text: 'R1' }, { rule_text: 'R2' }], error: null }
const OK_EXEMPLARS = {
  data: [{ category: 'quote_request', customer_text: 'C', reply_text: 'Rep' }],
  error: null,
}
const version = (v: unknown) => ({ data: { ai_draft_briefing_version: v }, error: null })

const usedDbRules = (b: { houseRules: string[] }) =>
  b.houseRules.length === 2 && b.houseRules[0] === 'R1' && b.houseRules[1] === 'R2'

// ── 1. The compiled fallback carries its honest marker ───────────────────────
// 0 is reserved for "the constants in this bundle". It must never be recorded
// as version 1 — once an admin has edited anything, the code briefing is
// nobody's live briefing, and 0 sorts below every real version, which is
// exactly where it belongs.

eq('DEFAULT_BRIEFING is marked as the code fallback', DEFAULT_BRIEFING.version, FALLBACK_BRIEFING_VERSION)
eq('the fallback marker is 0', FALLBACK_BRIEFING_VERSION, 0)
check('DEFAULT_BRIEFING IS the compiled constants', DEFAULT_BRIEFING.houseRules === HOUSE_RULES && DEFAULT_BRIEFING.exemplars === EXEMPLARS)

// ── 2. A good DB read carries the real version ───────────────────────────────

{
  const { client, audits } = stubClient({
    ai_draft_house_rules: OK_RULES,
    ai_draft_exemplars: OK_EXEMPLARS,
    settings: version(7),
  })
  const b = await fetchBriefing(client)
  eq('DB briefing carries the version from settings', b.version, 7)
  check('DB briefing uses the DB rules', usedDbRules(b))
  eq('a healthy read audits nothing', audits.length, 0)
}

// Version 1 is a real version, not a falsy nothing — a `v || null` style bug
// would turn the very first briefing into "not recorded".
{
  const { client } = stubClient({
    ai_draft_house_rules: OK_RULES,
    ai_draft_exemplars: OK_EXEMPLARS,
    settings: version(1),
  })
  eq('version 1 survives (not treated as falsy)', (await fetchBriefing(client)).version, 1)
}

// ── 3. THE central safety claim ──────────────────────────────────────────────
// An unreadable version yields null and NOTHING ELSE. The admin's live rules
// must still be the ones the drafter uses.

{
  const { client, audits } = stubClient({
    ai_draft_house_rules: OK_RULES,
    ai_draft_exemplars: OK_EXEMPLARS,
    settings: { data: null, error: { message: 'permission denied for column ai_draft_briefing_version' } },
  })
  const b = await fetchBriefing(client)
  check('unreadable version does NOT fall back to the code briefing', b !== DEFAULT_BRIEFING)
  check('unreadable version keeps the DB rules', usedDbRules(b))
  eq('unreadable version is recorded as unknown, not guessed', b.version, null)
  check(
    'a broken version read is visible in the audit log',
    audits.some((a) => a.action === 'ai_draft.briefing_version_unreadable'),
    `audited: ${JSON.stringify(audits.map((a) => a.action))}`,
  )
  check(
    'the audit row does NOT claim the briefing was affected',
    !audits.some((a) => a.action === 'ai_draft.briefing_fallback'),
  )
}

// Same again when the read throws outright rather than returning an error.
{
  const { client, audits } = stubClient({
    ai_draft_house_rules: OK_RULES,
    ai_draft_exemplars: OK_EXEMPLARS,
    settings: { throws: true },
  })
  const b = await fetchBriefing(client)
  check('a thrown version read keeps the DB rules', b !== DEFAULT_BRIEFING && usedDbRules(b))
  eq('a thrown version read yields null', b.version, null)
  check(
    'a thrown version read is audited',
    audits.some((a) => a.action === 'ai_draft.briefing_version_unreadable'),
  )
}

// The column missing entirely (the shape before migration 000351 is applied):
// the row reads fine, there is just no number in it. Still a broken read from
// the panel's point of view, so it must be reported, not pass as historical.
{
  const { client, audits } = stubClient({
    ai_draft_house_rules: OK_RULES,
    ai_draft_exemplars: OK_EXEMPLARS,
    settings: { data: {}, error: null },
  })
  const b = await fetchBriefing(client)
  eq('a missing version column yields null', b.version, null)
  check('a missing version column keeps the DB rules', usedDbRules(b))
  check(
    'a missing version column is audited',
    audits.some((a) => a.action === 'ai_draft.briefing_version_unreadable'),
  )
}

// A non-numeric value must not leak through as a version. Anything that isn't a
// finite number is "don't know", never coerced.
for (const [label, bad] of [
  ['a numeric string', '12'],
  ['an explicit null', null],
  ['NaN', NaN],
  ['an object', {}],
] as [string, unknown][]) {
  const { client } = stubClient({
    ai_draft_house_rules: OK_RULES,
    ai_draft_exemplars: OK_EXEMPLARS,
    settings: version(bad),
  })
  eq(`${label} version is treated as unknown`, (await fetchBriefing(client)).version, null)
}

// ── 4. The reverse direction: falling back must NOT keep the DB version ──────
// If the rules are unreadable the drafter runs on the compiled constants, so
// the stamp has to say 0 — even though the version scalar itself read back
// perfectly well. Stamping 12 here would attribute code-briefing drafts to the
// admin's v12 and quietly poison the very comparison this is all for.

{
  const { client, audits } = stubClient({
    ai_draft_house_rules: { data: null, error: { message: 'permission denied' } },
    ai_draft_exemplars: { data: null, error: { message: 'permission denied' } },
    settings: version(12),
  })
  const b = await fetchBriefing(client)
  check('unreadable rules fall back to the code briefing', b === DEFAULT_BRIEFING)
  eq('the fallback is stamped 0, not the DB version it displaced', b.version, FALLBACK_BRIEFING_VERSION)
  check(
    'the fallback is audited',
    audits.some((a) => a.action === 'ai_draft.briefing_fallback'),
  )
  check(
    'the audit records which briefing the fallback displaced',
    audits.some((a) => a.action === 'ai_draft.briefing_fallback' && (a.metadata as { db_version?: unknown })?.db_version === 12),
  )
}

// Zero house rules is a SAFETY fallback (an unconstrained drafter quotes freely
// and leaks), so it must land on the code briefing and its 0 stamp too — even
// with a perfectly readable version.
{
  const { client } = stubClient({
    ai_draft_house_rules: { data: [], error: null },
    ai_draft_exemplars: OK_EXEMPLARS,
    settings: version(9),
  })
  const b = await fetchBriefing(client)
  check('zero rules falls back to the code briefing', b === DEFAULT_BRIEFING)
  eq('the zero-rules fallback is stamped 0', b.version, FALLBACK_BRIEFING_VERSION)
}

// Zero EXEMPLARS is only a voice matter — the rules still constrain the facts —
// so the admin's rules (and their version) are kept.
{
  const { client } = stubClient({
    ai_draft_house_rules: { data: [{ rule_text: 'R1' }], error: null },
    ai_draft_exemplars: { data: [], error: null },
    settings: version(4),
  })
  const b = await fetchBriefing(client)
  check('zero exemplars keeps the DB briefing', b !== DEFAULT_BRIEFING && b.exemplars.length === 0)
  eq('zero exemplars keeps the DB version', b.version, 4)
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\nbriefing: ${passes} passed, ${failures} failed`)
if (failures > 0) process.exit(1)
