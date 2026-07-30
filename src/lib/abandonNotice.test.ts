// Unit tests for abandonNotice.ts
// Run with: npx tsx src/lib/abandonNotice.test.ts
//
// Two things worth pinning down:
//
//   1. The notify option must never be OFFERED when the send would fail. The
//      abandon dialog is the wrong place to discover that a proof has no
//      linked conversation — and a version-less project is exactly the kind
//      most likely to be closed off (a lead that never got artwork), so the
//      "no version" case is a normal path, not an edge case.
//
//   2. The rendered message must survive a blank company. {? company}…{/?}
//      only collapses on an empty-after-trim value, so a company of "   "
//      reaching the renderer would print "your cards for   " to a customer.

import { readFileSync } from 'node:fs'
import {
  abandonNoticeContext,
  notifyBlocker,
  resolveNoticeVersionId,
  ABANDON_TEMPLATE_ID,
} from './abandonNotice.ts'
import { DEFAULT_BODIES, renderTemplate } from './replyTemplates.ts'

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.log(`  ✗ ${name}`)
    console.log(`    ${(err as Error).message}`)
    failed++
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
}

function assertEquals<T>(actual: T, expected: T, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`)
  }
}

const V1 = { id: 'v1', version_number: 1, is_current: false }
const V2 = { id: 'v2', version_number: 2, is_current: true }

// ── notifyBlocker ───────────────────────────────────────────────────────────

console.log('\nnotifyBlocker')

test('a linked, versioned proof with replies on can be notified', () => {
  assertEquals(
    notifyBlocker({ helpscoutConversationId: '123', versions: [V1, V2], repliesEnabled: true }),
    null,
    'nothing should block the notify option',
  )
})

test('replies paused blocks it, whatever else is true', () => {
  const blocker = notifyBlocker({
    helpscoutConversationId: '123',
    versions: [V1, V2],
    repliesEnabled: false,
  })
  assertEquals(blocker?.code, 'replies_paused', 'the admin kill-switch must win')
})

test('no linked conversation blocks it', () => {
  const blocker = notifyBlocker({
    helpscoutConversationId: null,
    versions: [V1, V2],
    repliesEnabled: true,
  })
  assertEquals(blocker?.code, 'no_conversation', 'there is no thread to post on')
})

test('a version-less project blocks it — send-helpscout-reply needs a version_id', () => {
  const blocker = notifyBlocker({
    helpscoutConversationId: '123',
    versions: [],
    repliesEnabled: true,
  })
  assertEquals(blocker?.code, 'no_version', 'nothing to anchor the reply to')
})

test('a missing conversation is reported ahead of a missing version', () => {
  // Both are broken. Telling the designer to link a conversation when there
  // would still be nothing to send afterwards sends them on a pointless
  // errand, so the more fundamental blocker is the one named.
  const blocker = notifyBlocker({
    helpscoutConversationId: null,
    versions: [],
    repliesEnabled: true,
  })
  assertEquals(blocker?.code, 'no_conversation', 'report the outer problem first')
})

test('every blocker carries copy a designer can act on', () => {
  const cases = [
    { helpscoutConversationId: '1', versions: [V2], repliesEnabled: false },
    { helpscoutConversationId: null, versions: [V2], repliesEnabled: true },
    { helpscoutConversationId: '1', versions: [], repliesEnabled: true },
  ]
  for (const c of cases) {
    const blocker = notifyBlocker(c)
    assert(!!blocker && blocker.detail.trim().length > 20, `blocker ${blocker?.code} needs real copy`)
  }
})

// ── resolveNoticeVersionId ──────────────────────────────────────────────────

console.log('\nresolveNoticeVersionId')

test('prefers the current version', () => {
  assertEquals(resolveNoticeVersionId([V1, V2]), 'v2', 'the current version is the honest anchor')
})

test('falls back to the highest version number when none is current', () => {
  // Reachable while a delete auto-promote is mid-flight. Blocking the send on
  // a transient would be worse than anchoring on the newest version.
  assertEquals(
    resolveNoticeVersionId([
      { id: 'a', version_number: 1, is_current: false },
      { id: 'c', version_number: 3, is_current: false },
      { id: 'b', version_number: 2, is_current: false },
    ]),
    'c',
    'newest wins',
  )
})

test('returns null with no versions at all', () => {
  assertEquals(resolveNoticeVersionId([]), null, 'nothing to anchor to')
})

// ── abandonNoticeContext + the template ─────────────────────────────────────

console.log('\nabandonNoticeContext')

test('pulls a first name out of a full name', () => {
  const ctx = abandonNoticeContext({ fullName: 'Takashi Yamada', companyName: 'Yanko Design' })
  assertEquals(ctx.first_name, 'Takashi', 'first name')
  assertEquals(ctx.company, 'Yanko Design', 'company')
})

test('a blank company is normalised to null, not passed through as whitespace', () => {
  // renderTemplate's own {? company} guard already trims, so the DEFAULT body
  // survives either way — this asserts the CONTEXT, which is the part that
  // matters. An admin who edits the template to use a bare {company} (no
  // conditional block) gets "your cards for    " from a whitespace-only
  // company name unless it was normalised here.
  const ctx = abandonNoticeContext({ fullName: 'Madonna', companyName: '   ' })
  assertEquals(ctx.company, null, 'whitespace-only company must be null')
  assertEquals(
    renderTemplate('your cards{? company} for {company}{/?} — done', ctx),
    'your cards — done',
    'the conditional block collapses',
  )
  const rendered = renderTemplate(DEFAULT_BODIES[ABANDON_TEMPLATE_ID], ctx)
  assert(rendered.includes('Hi Madonna,'), 'still greets by name')
})

test('renders cleanly with a company', () => {
  const ctx = abandonNoticeContext({ fullName: 'Takashi Yamada', companyName: 'Yanko Design' })
  const rendered = renderTemplate(DEFAULT_BODIES[ABANDON_TEMPLATE_ID], ctx)
  assert(rendered.includes('for Yanko Design'), 'company should appear')
  assert(!rendered.includes('{'), `no unresolved variables left: ${rendered}`)
})

test('the default body never invites the customer back to the proof link', () => {
  // The link still loads after an abandon, but it renders the closed card with
  // no artwork on it — so "take another look at your designs" would be a dead
  // end. The call to action is a reply, which lands on the same Help Scout
  // thread rather than opening a fresh Customer Support conversation the way
  // the closed page's own contact form does.
  const body = DEFAULT_BODIES[ABANDON_TEMPLATE_ID]
  assert(!body.includes('{url}'), 'the abandon notice must not carry a proof link')
  assert(/repl(y|ies)/i.test(body), 'the notice should tell them replying reopens the conversation')
})

test('the default body avoids words the closed page contradicts', () => {
  // The customer-facing page says "closed" and nothing else — not cancelled,
  // not declined, not expired — and the link keeps working.
  const body = DEFAULT_BODIES[ABANDON_TEMPLATE_ID].toLowerCase()
  for (const word of ['cancelled', 'declined', 'rejected', 'expired', 'abandoned']) {
    assert(!body.includes(word), `"${word}" contradicts the closed-proof page`)
  }
})

// ── The seed and the code default must not drift ────────────────────────────

console.log('\nseed parity')

test('000366 seeds byte-for-byte what "Reset to default" restores', () => {
  // The migration's body is hand-frozen SQL (Postgres can't import TypeScript),
  // and DEFAULT_BODIES is what the admin editor's Reset button writes back. If
  // the two drift, Reset silently restores different copy than a fresh replay
  // would seed, and nothing anywhere complains. Same class of gap
  // `check:briefing-seed` exists to close, and the same substring mechanism.
  const sql = readFileSync(
    new URL('../../supabase/migrations/000366_seed_proof_abandoned_template.sql', import.meta.url),
    'utf8',
  )
  // Extract the seeded body rather than testing containment. A substring check
  // passes when the migration's literal merely STARTS with the code default,
  // so appending a sentence to the SQL — the natural way to soften the copy,
  // since the SQL is the human-readable version — would drift silently.
  // The body is the 4th value: (id, display_name, description, body).
  const values = sql.slice(sql.indexOf('values'))
  const bodyStart = values.indexOf("'Hi {first_name}")
  assert(bodyStart !== -1, 'could not find the seeded body literal in 000366')
  // Walk to the closing quote, skipping Postgres'' escaped apostrophes.
  let i = bodyStart + 1
  let seeded = ''
  while (i < values.length) {
    if (values[i] === "'") {
      if (values[i + 1] === "'") { seeded += "'"; i += 2; continue }
      break
    }
    seeded += values[i]
    i += 1
  }
  assertEquals(
    seeded,
    DEFAULT_BODIES[ABANDON_TEMPLATE_ID],
    'the 000366 seed body no longer matches DEFAULT_BODIES.proof_abandoned — update whichever one is wrong',
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
