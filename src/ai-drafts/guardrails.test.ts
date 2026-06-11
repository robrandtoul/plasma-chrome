// Tests for the AI-draft guardrails + supporting text utilities.
// Run: pnpm test:ai-drafts
// (Hand-rolled harness convention, same as nudgeDecision.test.ts — no test
// framework in this repo; exits 1 on any failure.)

import {
  AllowedFigures,
  buildAllowedFigures,
  extractMoneyFigures,
  extractUrls,
  isApprovedUrl,
  runGuardrails,
} from './guardrails'
import { htmlToText, normaliseBody } from './htmlText'
import { renderThread } from './prompts'
import type { GroundingData, ThreadMessage } from './types'

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

// ── htmlToText ───────────────────────────────────────────────────────────────

eq('paragraphs become blank-line breaks', htmlToText('<p>One</p><p>Two</p>'), 'One\n\nTwo')
eq('br becomes newline', htmlToText('a<br>b<br/>c'), 'a\nb\nc')
eq('entities decode', htmlToText('&pound;39 &amp; &euro;49 &gt; £50'), '£39 & €49 > £50')
eq('numeric entities decode', htmlToText('&#163;25 &#x20AC;30'), '£25 €30')
check('style blocks stripped', !htmlToText('<style>p{color:red}</style>Hello').includes('color'))
eq('plain text untouched', normaliseBody('  Just text £39  '), 'Just text £39')
check('html detected and stripped', normaliseBody('<div>Hi <b>there</b></div>') === 'Hi there')

// ── extractMoneyFigures ──────────────────────────────────────────────────────

eq(
  'simple figures',
  extractMoneyFigures('£39 plus $49 and €25').map((f) => `${f.currency}:${f.pence}`),
  ['GBP:3900', 'USD:4900', 'EUR:2500'],
)
eq(
  'thousands and decimals',
  extractMoneyFigures('that is £1,799.00 total').map((f) => f.pence),
  [179900],
)
eq('plain numbers ignored', extractMoneyFigures('500 micron, 25 cards, 13-15 days').length, 0)
eq('space after symbol tolerated', extractMoneyFigures('£ 279').map((f) => f.pence), [27900])
eq('decimal figure', extractMoneyFigures('£274.17 ex VAT').map((f) => f.pence), [27417])

// ── extractUrls / isApprovedUrl ──────────────────────────────────────────────

eq(
  'urls extracted, punctuation trimmed',
  extractUrls('see https://www.plasmadesign.co.uk/gbp-price-list. Thanks'),
  ['https://www.plasmadesign.co.uk/gbp-price-list'],
)
eq(
  'www-prefix normalised to https',
  extractUrls('visit www.plasmadesign.co.uk/support today'),
  ['https://www.plasmadesign.co.uk/support'],
)
check('price list approved', isApprovedUrl('https://www.plasmadesign.co.uk/gbp-price-list'))
check('proof link approved', isApprovedUrl('https://proofs.plasmadesign.co.uk/p/abc-123'))
check('random url rejected', !isApprovedUrl('https://evil.example.com/'))
check(
  'host-suffix spoof rejected',
  !isApprovedUrl('https://www.plasmadesign.co.uk.evil.com/gbp-price-list'),
)
check('case-insensitive match', isApprovedUrl('HTTPS://WWW.PLASMADESIGN.CO.UK/SUPPORT'))

// ── AllowedFigures ───────────────────────────────────────────────────────────

const allowed = new AllowedFigures()
allowed.add('GBP', 27900) // £279 base
allowed.add('GBP', 5000) // £50 personalisation
allowed.add('EUR', 3900) // €39

check('exact figure accepted', allowed.accepts('GBP', 27900))
check('sum of two accepted (279+50=329)', allowed.accepts('GBP', 32900))
check('ex-VAT of a sum accepted (329/1.2≈274.17)', allowed.accepts('GBP', 27417))
check('inc-VAT of a known figure accepted (279*1.2=334.80)', allowed.accepts('GBP', 33480))
check('arbitrary figure rejected', !allowed.accepts('GBP', 30000))
check('one penny off a known figure rejected', !allowed.accepts('GBP', 27901))
check('currency isolation: EUR figure not valid as GBP', !allowed.accepts('GBP', 3900))
check('exact EUR accepted', allowed.accepts('EUR', 3900))
check('no VAT transform outside GBP (39/1.2=32.50)', !allowed.accepts('EUR', 3250))
check('double of a figure accepted as self-sum (50+50)', allowed.accepts('GBP', 10000))

// ── buildAllowedFigures ──────────────────────────────────────────────────────

const grounding: GroundingData = {
  byCurrency: { GBP: [], EUR: [], USD: [] },
  leadTimes: [],
  figures: [{ amount: 279, currency: 'GBP', description: 'Gold 500µm x25' }],
  fetchedAt: 'test',
}
const thread: ThreadMessage[] = [
  {
    role: 'customer',
    createdAt: '2026-06-01T00:00:00Z',
    author: 'Sam',
    body: '<p>You quoted me &pound;999 last year — does that still stand?</p>',
  },
]
const built = buildAllowedFigures(grounding, thread)
check('grounding figure allowed', built.accepts('GBP', 27900))
check('house-rule one-off £180 allowed', built.accepts('GBP', 18000))
check('house-rule shipping £12.90 allowed', built.accepts('GBP', 1290))
check('customer-quoted figure allowed (echoing is safe)', built.accepts('GBP', 99900))
check('still rejects the unknown', !built.accepts('GBP', 123456))

// ── runGuardrails ────────────────────────────────────────────────────────────

const cleanDraft = `Hi Sam,

25 gold cards would be £279, plus £50 personalisation.

Total: £329 inc VAT (£274.17 ex VAT).

Full pricing: https://www.plasmadesign.co.uk/gbp-price-list`
eq('clean draft passes', runGuardrails(cleanDraft, built), { ok: true })

const badFigure = runGuardrails('Hi, that would be £305 all in.', built)
check('hallucinated figure blocked', !badFigure.ok)

const badUrl = runGuardrails('See https://plasma-deals.example.com for prices.', built)
check('unapproved URL blocked', !badUrl.ok)

const multiBad = runGuardrails('£123.45 — see https://evil.example.com', built)
check(
  'multiple reasons reported',
  !multiBad.ok && 'reasons' in multiBad && multiBad.reasons.length === 2,
)

// ── renderThread ─────────────────────────────────────────────────────────────

const longThread: ThreadMessage[] = [
  { role: 'customer', createdAt: '2026-06-01T00:00:00Z', author: 'A', body: 'x'.repeat(30000) },
  { role: 'customer', createdAt: '2026-06-02T00:00:00Z', author: 'A', body: 'THE RECENT QUESTION' },
]
const rendered = renderThread(longThread)
check('truncation keeps the most recent content', rendered.includes('THE RECENT QUESTION'))
check('truncation is flagged', rendered.includes('[earlier messages truncated]'))
check('roles labelled', renderThread(thread).includes('CUSTOMER (Sam)'))

// ── Result ───────────────────────────────────────────────────────────────────

console.log(`\n${passes} passed, ${failures} failed`)
if (failures > 0) process.exit(1)
