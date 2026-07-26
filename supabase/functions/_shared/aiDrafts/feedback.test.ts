// Tests for the AI-draft feedback measurement: how much a human changed the
// draft (classifyEdit) and whether the reply we scored it against was an edit
// of the draft at all (classifyMatch).
// Run: pnpm test:ai-drafts-feedback
// (Hand-rolled harness convention, same as guardrails.test.ts — no test
// framework in this repo; exits 1 on any failure.)
//
// ── Redaction: what is real in this file and what is not ────────────────────
//
// The message bodies here are real Plasma replies, kept word-for-word because
// the rules key on how our messages are actually shaped. Everything that could
// identify a customer or reach a live record has been replaced throughout the
// WHOLE file — not just the fixture block:
//
//   · customer first names → a fabricated cast (Sam, Alex). Staff names are
//     left alone: "Rob" and "Chris" are the signatures the strip tests exist to
//     remove, so faking them would be testing nothing.
//   · company names → invented ones, checked against live for no match
//   · email addresses → the reserved @example.invalid domain
//   · proof and order ids inside URLs → obviously-patterned fake UUIDs
//   · pay-page tokens → a run of zeroes
//   · ORDER REFERENCES and ORDER NUMBERS → fabricated. These were missed on the
//     first pass and are the reason this note now covers the whole file: a
//     payment reference is the Xero/Stripe reconciliation key printed on a
//     customer's invoice, so it has no business sitting in a git repo.
//
// Every fabricated value below was checked read-only against live (2026-07-26)
// and matches no row. Prices, lead times and dates are kept as-is — they are
// our published figures, not anyone's personal data.

import {
  classifyEdit,
  classifyMatch,
  EDIT_EVIDENCE_FLOOR,
  levenshtein,
  normalise,
  roundedSimilarity,
  similarityRatio,
  stripSignature,
  STALE_DRAFT_HOURS,
} from './feedback.ts'

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

// ── stripSignature ───────────────────────────────────────────────────────────
//
// Help Scout appends the sender's signature on send, so an untouched draft
// comes back with text it never had. Getting this wrong once (PV 2026-06-13)
// made every identical send read as 'discarded', which is why it is pinned
// down here rather than left to the guardrails suite.

eq('empty input', stripSignature(''), '')
eq(
  'trailing "Kind regards, Rob" stripped',
  stripSignature('Body line.\n\nKind regards, Rob').trim(),
  'Body line.',
)
eq(
  'sign-off on its own line stripped',
  stripSignature('Body text\n\nMany thanks\nChris').trim(),
  'Body text',
)
eq(
  'full Help Scout block stripped',
  stripSignature(
    'The cards are ready.\n\nKind regards,\n\nRob - Customer Support\nsupport@example.invalid | +44 (0) 0000 000 000',
  ).trim(),
  'The cards are ready.',
)
check(
  'contact details do not survive the strip',
  !stripSignature('Done.\n\nBest wishes,\nRob\nsupport@example.invalid').includes('@'),
)

// Regression: a BODY line that merely opens with a sign-off word is not a
// signature. Plasma's replies open this way constantly.
const thanksOpener = `Hi Sam,

Thanks for confirming the proof for Alex is all correct.

Could you let me know the quantity and I will send your order link across.`
eq('opener "Thanks for…" is not stripped', stripSignature(thanksOpener), thanksOpener)
check(
  '"Thank you for…" opener keeps its body',
  stripSignature('Hi Sam,\n\nThank you for letting us know.\n\nWe will keep it on file.').includes(
    'keep it on file',
  ),
)
check(
  'a lowercase continuation is a sentence, not a sign-off',
  stripSignature('Cheers for the artwork, it came through fine.').includes('came through fine'),
)
check(
  'a long continuation after a sign-off word is a sentence',
  stripSignature(
    'Body.\n\nRegards the timing, we are quoting twelve to fourteen working days at the moment.',
  ).includes('twelve to fourteen'),
)
// The LAST qualifying sign-off wins, so an early "Many thanks" mid-body does
// not chop the rest of the message.
check(
  'later sign-off wins over an earlier one',
  stripSignature('Many thanks\n\nThe cards ship Friday.\n\nKind regards,\nRob').includes(
    'ship Friday',
  ),
)
// A sign-off on the very first line is not a signature — there would be
// nothing left. cutLine > 0 guards this.
eq('sign-off on line one is left alone', stripSignature('Kind regards, Rob'), 'Kind regards, Rob')

// ── normalise ────────────────────────────────────────────────────────────────

eq('lowercased, punctuation dropped, whitespace collapsed', normalise('  Hello,   WORLD!  '), 'hello world')
eq('money symbols survive', normalise('£329 inc VAT'), '£329 inc vat')
eq('urls survive intact', normalise('See https://example.invalid/a-b.'), 'see https://example.invalid/a-b')
eq('null-ish input', normalise(undefined as unknown as string), '')
check('capped at 4000 characters', normalise('a '.repeat(5000)).length <= 4000)

// ── levenshtein / similarityRatio ────────────────────────────────────────────

eq('classic distance', levenshtein('kitten', 'sitting'), 3)
eq('identical is zero', levenshtein('abc', 'abc'), 0)
eq('empty against text', levenshtein('', 'abc'), 3)
eq('identical strings score 1', similarityRatio('abc', 'abc'), 1)
eq('both empty score 1', similarityRatio('', ''), 1)
eq('one empty scores 0', similarityRatio('abc', ''), 0)
// Case, commas and runs of whitespace are normalised away; a full stop is NOT
// (it is kept, so "£329." and "£329" are genuinely different strings).
check(
  'case/comma/whitespace differences score 1',
  similarityRatio('Hi Sam, that is £329', 'hi sam   that is  £329') === 1,
)
check(
  'a kept full stop is a real difference',
  similarityRatio('that is £329.', 'that is £329') < 1,
)

// ── classifyEdit thresholds ──────────────────────────────────────────────────

const draftEx = `Hi Sam,

Happy to help. 100 stainless steel cards at 500 micron come to £329 inc VAT.

We are currently quoting 12-14 working days. Please let me know if any further information would help.`

const sentUntouched = `${draftEx}

Kind regards,

Rob - Customer Support`
eq('untouched send (+signature) is sent_as_is', classifyEdit(draftEx, sentUntouched).editClass, 'sent_as_is')
eq('identical strings similarity 1', classifyEdit('abc', 'abc').similarity, 1)

const sentLightlyEdited = `Hi Sam,

Happy to help. 100 stainless steel cards at 500 micron come to £329 including VAT.

We are currently quoting around 12-14 working days. Do let me know if anything else would help.

Kind regards, Rob`
eq('small tweak is lightly_edited', classifyEdit(draftEx, sentLightlyEdited).editClass, 'lightly_edited')

const sentRewritten = `Hi Sam, thanks for your patience. For a run of 100 in 500 micron stainless the cost works out at £329 with VAT included, and our current lead time is roughly two to three weeks. Shout if you need anything else. Rob`
check(
  'heavy rework is rewritten or discarded',
  ['rewritten', 'discarded'].includes(classifyEdit(draftEx, sentRewritten).editClass),
)

const sentDiscarded = `Hi Sam, unfortunately we can't help with this enquiry as it falls outside what we offer. Best of luck finding a supplier. Rob`
eq('unrelated reply is discarded', classifyEdit(draftEx, sentDiscarded).editClass, 'discarded')

check('similarity is bounded 0..1', (() => {
  const s = classifyEdit(draftEx, sentLightlyEdited).similarity
  return s >= 0 && s <= 1
})())
check('similarity is rounded to 3dp', (() => {
  const s = classifyEdit(draftEx, sentRewritten).similarity
  return Math.round(s * 1000) === s * 1000
})())

// ── classifyMatch: real live pairs ───────────────────────────────────────────
//
// Every fixture below is a real draft/sent pair from proofs.ai_drafts, kept
// word-for-word except for the substitutions listed at the top of this file.
// The shape is what the rules key on, and the shape is preserved: a fake UUID
// is still a UUID in a /p/ path, a fake reference still matches ORDER_REF_RE.

const FAKE_PROOF_ID = '11111111-2222-4333-8444-555555555555'
const FAKE_ORDER_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa'
// Shaped like a real payment reference (ORD- plus 8+ upper-case alphanumerics,
// which is what ORDER_REF_RE looks for) while reading as an obvious stand-in.
const FAKE_ORDER_REF = 'ORD-EXAMPLE01'
// Our stock order numbers are six digits in the 403xxx range; all-zeroes is not
// a number the sequence can ever reach.
const FAKE_ORDER_NUMBER = '000000'

interface Fixture {
  name: string
  draft: string
  sent: string
  draftCreatedAt?: string
  sentAt?: string
  quality: 'edit' | 'unrelated'
  reason: string | null
}

const FIXTURES: Fixture[] = [
  // 1. Proof delivery. The draft promised the graphics team would pick the job
  // up; the next staff message hands over v5. Nothing to learn from the pair.
  {
    name: 'proof delivery after a holding reply → unrelated',
    draft:
      'Hi Sam,\n\nNo problem at all, we will get that added to the list.\n\nOur graphics team will pick this up now and send an updated proof shortly for you to check over.',
    sent:
      `Hi Sam,\n\nThanks for your patience. Here's v5 of your cards for Northgate Training with the changes you asked for.\n\nhttps://proofs.plasmadesign.co.uk/p/${FAKE_PROOF_ID}\n\nPlease take a look when you have a moment. We'll be happy to carry out further revisions if required.`,
    quality: 'unrelated',
    reason: 'proof_delivery',
  },
  // 2. An automated-style chase that happens to carry the proof link. Same
  // rule, different message type — this is the "Celia 24 Jul" row in the review.
  {
    name: 'follow-up nudge carrying a proof link → unrelated',
    draft:
      'Hi Sam,\n\nThat is great to hear, thank you. I am glad v3 hits the mark.\n\nWhenever you are ready to approve and let us know the quantity for each version, just say the word and we will take it from there.',
    sent:
      `Hi Sam,\n\nI hope you are keeping well. I am just following up on your cards, as I know how busy things can get.\n\nYour v3 proofs are ready to view, with both versions included. Whenever you have a moment, you can approve them directly in the proof viewer here:\n\nhttps://proofs.plasmadesign.co.uk/p/${FAKE_PROOF_ID}\n\nTo move everything into production, all we need is your approval of both versions, along with the final quantity you would like for each one.\n\nKind regards,`,
    quality: 'unrelated',
    reason: 'proof_delivery',
  },
  // 3. The draft ALREADY carried the proof link and the team trimmed the reply
  // hard around it. Similarity is only 0.33, so the gate does not save it —
  // the "did the draft have one too?" test does. This is the pair the naive
  // "reply contains a proof URL" rule would have got wrong.
  {
    name: 'trimmed reply that keeps the draft own proof link → edit',
    draft:
      `Hi Sam,\n\nHappy to sort another set of your satin black plastic cards, in the same specification as before.\n\nPricing for the various quantities is shown on the left side of your 2023 proof, which we linked earlier:\n\nhttps://proofs.plasmadesign.co.uk/p/${FAKE_PROOF_ID}\n\nThe current turnaround for the satin plastic range is 18 to 20 working days.\n\nJust let me know which quantity you would like to go with, and we can get a fresh proof across for approval.`,
    sent:
      `Hi Sam,\n\nNo problem. Your most recent proofs and pricing for various quantities can be found by clicking the link below.\n\nhttps://proofs.plasmadesign.co.uk/p/${FAKE_PROOF_ID}`,
    quality: 'edit',
    reason: null,
  },
  // 4. The automated order-link email. Note it does not even greet by name.
  {
    name: 'order-link email → unrelated',
    draft:
      'Hi Sam,\n\nGlad that helps. Whenever you are ready, just approve the proof and we will get things moving.\n\nPlease let me know if any further information would help in the meantime.',
    sent:
      `Hi,\n\nThanks for working with us and approving your card design. You can now choose your quantity, confirm delivery, and pay securely here:\n\nhttps://proofs.plasmadesign.co.uk/order/${FAKE_ORDER_ID}?token=0000000000000000000000000000000f\n\nIf you have any questions, just reply to this email.`,
    quality: 'unrelated',
    reason: 'order_message',
  },
  // 5. The payment confirmation. Caught by the ORD- reference rather than a
  // URL: the drafter cannot know a reference that is minted at payment time.
  {
    name: 'payment confirmation with an ORD- reference → unrelated',
    draft:
      'Hi Sam,\n\nThank you, and thanks for approving both versions.\n\nYour order link is already on its way, so you can complete everything there whenever you are ready. We will get the proofs into production once that is done, and we will check the QR codes scan correctly before anything goes to print.\n\nPlease let me know if any further information would help.',
    sent:
      `Hi Sam,\n\nThank you — we've received your payment and your cards are now in production. Your order reference is ${FAKE_ORDER_REF}.\n\nWe'll be in touch with an estimated ship date shortly and we will email you dispatch details as soon as your cards are on their way.\n\nYour VAT invoice will arrive in a separate email shortly.`,
    quality: 'unrelated',
    reason: 'order_message',
  },
  // 6. The pattern from review §2.1: the team keeps the draft and pastes the
  // live order URL into it. A genuine, valuable edit that the order rule would
  // wreck; the similarity gate is the only thing standing between them.
  {
    name: 'order link pasted into an otherwise-kept draft → edit',
    draft:
      'Hi Sam,\n\nThank you for confirming, happy to get this moving.\n\nFor 200 of your original translucent cards in white and metallic silver, the cost is £178 inc VAT (£148.33 ex VAT). This excludes shipping.\n\nCurrent turnaround is 18 to 20 working days from proof approval.\n\nI will send your order link across shortly. Please let me know if any further information would help.',
    sent:
      `Hi Sam,\n\nThank you for confirming, happy to get this moving.\n\nFor 200 of your original translucent cards in white and metallic silver, the cost is £178 inc VAT (£148.33 ex VAT). This excludes shipping.\n\nCurrent turnaround is 16-18 business days from proof approval.\n\nIf you're happy to move forward on this basis, the order can be placed by clicking the link below.\n\nhttps://proofs.plasmadesign.co.uk/order/${FAKE_ORDER_ID}?token=0000000000000000000000000000000f`,
    quality: 'edit',
    reason: null,
  },
  // 7. Nearly four days later, on a thread that had moved on. Note "view
  // proofs" where a URL should be: the reply DID carry a proof link, but it was
  // written as anchor text and normaliseBody() stripped the href before this
  // ever saw it (see the caveat above PROOF_LINK_RE). So the link rules are
  // blind here and the staleness rule is the only thing that catches it.
  {
    name: 'reply sent four days after the draft → unrelated',
    draft:
      "Hi Sam,\n\nNo problem at all, take your time.\n\nWhenever you are ready to send your colleague's details, or if you have any thoughts on the revised proofs, just let us know and we will pick things up from there.",
    sent:
      `Hi Sam,\n\nJust a gentle check-in on order ${FAKE_ORDER_NUMBER}. No rush at all from our side, we would simply like to make sure nothing has slipped through the gaps.\n\nWe sent the revised proofs across on 20 July, with the changes you asked for. In case it helps to have them in one place:\n\nCarbon fibre and matte black cards: view proofs\n\nWhenever you get a chance to look, just let us know if they are good to proceed or if there is anything you would like changed, and we will pick production straight back up.`,
    draftCreatedAt: '2026-07-20T16:12:19Z',
    sentAt: '2026-07-24T13:47:11Z',
    quality: 'unrelated',
    reason: 'stale_draft',
  },
  // 8. A one-line correction to something else entirely, against a long draft.
  {
    name: 'one-line message with nothing of the draft in it → unrelated',
    draft:
      'Hi Sam,\n\nGreat to have version 2 approved — your matte black metal cards are ready to move forward.\n\nTo raise your order, could you let me know the quantity you would like, along with the billing and delivery addresses?\n\nOn your earlier question, the digital proof you approved is an accurate guide to the finished card. Printed inks on matte black metal carry a slightly textured matte feel that a screen cannot quite convey. We do not send a physical sample of your own design ahead of the run as standard.\n\nOnce I have the quantity and addresses, I will send your order link across.',
    sent: 'Hi Sam,\n\nMy sincere apologies. The dates should read 1st-3rd July.',
    quality: 'unrelated',
    reason: 'different_message',
  },
  // 9. The conservative half of the terse rule. The team cut a 500-character
  // draft down to one sentence, but it is the SAME answer in the draft's own
  // words — the most valuable kind of edit to learn from, so it must survive.
  {
    name: 'hard trim that reuses the draft wording → edit',
    draft:
      'Hi Sam,\n\nThanks for setting that out, it makes things clear.\n\nWith one side identical across all 250 and only the number changing on the reverse, that falls under what we call personalisation. There is a set-up charge for this, which for 250 cards comes to £50 inc VAT. That covers preparing all 250 numbered versions from the artwork you supply.\n\nThe engraving itself, on both sides, stays included in the card price, so there is nothing extra there.\n\nPlease let me know if any further information would help.',
    sent:
      'Hi Sam,\n\nThanks for clarifying. The unique numbering would increase the advertised price of 250 cards by £50.',
    quality: 'edit',
    reason: null,
  },
  // 10. Another real hard trim, this one answering a yes/no question. Kept as a
  // second guard because a one-sentence reply is the shape most at risk of a
  // wrong 'unrelated'.
  {
    name: 'one-sentence yes/no answer → edit',
    draft:
      'Hi Sam,\n\nYes, our letterpress cards can be printed on both sides. The second side is included in the price you have, so there is nothing extra to add for it.\n\nThe only thing worth knowing is that heavy coverage on both sides can show through very slightly on the cotton stock, so we usually keep the reverse a little lighter.\n\nPlease let me know if any further information would help.',
    sent:
      'Hi Sam,\n\nYes, our letterpress cards can be printed on both sides.\n\nPlease let me know if any further information would help.',
    quality: 'edit',
    reason: null,
  },
]

for (const f of FIXTURES) {
  const verdict = classifyMatch(f.draft, f.sent, {
    draftCreatedAt: f.draftCreatedAt,
    sentAt: f.sentAt,
  })
  eq(f.name, verdict, { quality: f.quality, reason: f.reason })
}

// ── The invariant the whole design rests on ──────────────────────────────────
//
// Anything classifyEdit still counts as an edit (rewritten or better) can never
// be called 'unrelated'. If this ever fails, the acceptance metric and the
// miner have started disagreeing about what an edit is.
//
// Sweeping the fixtures is a weak test of it — nine of the ten are 'discarded'
// and skip straight past, so the loop below really only checks one pair, and
// that pair sits at 0.60, miles clear of the 0.45 floor. It is kept as a
// regression net, but the cases that actually exercise the boundary are
// constructed underneath.

let gateChecked = 0
for (const f of FIXTURES) {
  const { editClass, similarity } = classifyEdit(f.draft, f.sent)
  if (editClass === 'discarded') continue
  gateChecked++
  const verdict = classifyMatch(f.draft, f.sent, {
    draftCreatedAt: f.draftCreatedAt,
    sentAt: f.sentAt,
  })
  check(
    `similarity gate holds for "${f.name}"`,
    verdict.quality === 'edit',
    `similarity ${similarity} is >= ${EDIT_EVIDENCE_FLOOR} but the verdict was ${verdict.quality}`,
  )
}
check(
  'the fixture sweep exercises the gate at all',
  gateChecked > 0,
  'every fixture classified as discarded, so the invariant was never tested',
)

// The boundary itself. classifyEdit stores the similarity ROUNDED to 3dp and
// thresholds that rounded number; classifyMatch has to gate on the same one.
// Round in one place and not the other and a thin band opens up — raw 0.4495 to
// 0.4499 — where the row is written down as 0.45 / 'rewritten' while the gate
// reads it as below the floor and lets a rule call the same pair 'unrelated'.
//
// The band is only wide enough to land in on long bodies, which is why no live
// row has ever fallen in it, so it has to be built by hand: two ~2,000-character
// strings differing in a measured number of characters, with a proof link on the
// sent side and none on the draft, so the proof_delivery rule is primed to fire
// the moment the gate lets it.
//
// The 1,070 below was derived by walking the difference count until the raw
// ratio and the rounded one straddled 0.45. It is pinned to EDIT_EVIDENCE_FLOOR
// being 0.45: change the floor and the premise check underneath fails loudly,
// which is the signal to re-derive it rather than delete it.
const BOUNDARY_FILLER = 2000
const BOUNDARY_DIFFERENCE = 1070
const boundaryDraft = 'a'.repeat(BOUNDARY_FILLER)
const boundarySent =
  'a'.repeat(BOUNDARY_FILLER - BOUNDARY_DIFFERENCE) +
  'b'.repeat(BOUNDARY_DIFFERENCE) +
  `\n\nhttps://proofs.plasmadesign.co.uk/p/${FAKE_PROOF_ID}`

// Premise: this pair really does sit in the band. Raw below the floor, rounded
// on it. Without this the case could silently drift into being an ordinary
// above-the-floor pair and prove nothing.
check(
  'the constructed pair straddles the rounding boundary',
  similarityRatio(boundaryDraft, boundarySent) < EDIT_EVIDENCE_FLOOR &&
    roundedSimilarity(boundaryDraft, boundarySent) === EDIT_EVIDENCE_FLOOR,
  `raw ${similarityRatio(boundaryDraft, boundarySent)}, rounded ${roundedSimilarity(boundaryDraft, boundarySent)} — re-derive BOUNDARY_DIFFERENCE`,
)
eq(
  'the boundary pair is recorded as rewritten, not discarded',
  classifyEdit(boundaryDraft, boundarySent).editClass,
  'rewritten',
)
eq(
  'rounding up to the floor keeps the pair an edit',
  classifyMatch(boundaryDraft, boundarySent),
  { quality: 'edit', reason: null },
)

// One character further apart and BOTH functions must agree the other way:
// 'discarded', and free for the proof-delivery rule to fire. This is the half
// that proves the fix did not simply nail the gate open.
const belowSent =
  'a'.repeat(BOUNDARY_FILLER - BOUNDARY_DIFFERENCE - 1) +
  'b'.repeat(BOUNDARY_DIFFERENCE + 1) +
  `\n\nhttps://proofs.plasmadesign.co.uk/p/${FAKE_PROOF_ID}`
eq(
  'a hair below the floor is discarded',
  classifyEdit(boundaryDraft, belowSent).editClass,
  'discarded',
)
eq(
  'a hair below the floor lets the proof rule fire',
  classifyMatch(boundaryDraft, belowSent),
  { quality: 'unrelated', reason: 'proof_delivery' },
)

// And the same agreement stated as a rule rather than a pair: across a spread
// of difference counts either side of the boundary, a non-discarded class must
// always come back 'edit'. Cheap belt-and-braces over the one hand-picked
// number above.
for (const d of [900, 1000, 1050, 1069, BOUNDARY_DIFFERENCE, 1071, 1100, 1300]) {
  const sent =
    'a'.repeat(BOUNDARY_FILLER - d) +
    'b'.repeat(d) +
    `\n\nhttps://proofs.plasmadesign.co.uk/p/${FAKE_PROOF_ID}`
  const { editClass, similarity } = classifyEdit(boundaryDraft, sent)
  if (editClass === 'discarded') continue
  check(
    `gate and class agree at ${d} differing characters`,
    classifyMatch(boundaryDraft, sent).quality === 'edit',
    `stored as ${editClass} (${similarity}) but the match verdict was 'unrelated'`,
  )
}

// ── classifyMatch: the conservative fallbacks ────────────────────────────────

eq('empty draft → edit', classifyMatch('', 'Hi Sam,\n\nAnything at all.'), {
  quality: 'edit',
  reason: null,
})
eq('empty sent → edit', classifyMatch('Hi Sam,\n\nAnything at all.', ''), {
  quality: 'edit',
  reason: null,
})
eq('whitespace-only sent → edit', classifyMatch('A real draft body here.', '   \n  '), {
  quality: 'edit',
  reason: null,
})
eq('identical bodies → edit', classifyMatch(draftEx, draftEx), { quality: 'edit', reason: null })

const staleDraft = FIXTURES[6].draft
const staleSent = FIXTURES[6].sent
eq(
  'no timestamps → the staleness rule cannot fire',
  classifyMatch(staleDraft, staleSent),
  { quality: 'edit', reason: null },
)
eq(
  'only one timestamp → the staleness rule cannot fire',
  classifyMatch(staleDraft, staleSent, { draftCreatedAt: '2026-07-20T16:12:19Z' }),
  { quality: 'edit', reason: null },
)
eq(
  'unparseable timestamps are ignored',
  classifyMatch(staleDraft, staleSent, { draftCreatedAt: 'not a date', sentAt: 'nor this' }),
  { quality: 'edit', reason: null },
)
eq(
  'Date objects work as well as ISO strings',
  classifyMatch(staleDraft, staleSent, {
    draftCreatedAt: new Date('2026-07-20T16:12:19Z'),
    sentAt: new Date('2026-07-24T13:47:11Z'),
  }),
  { quality: 'unrelated', reason: 'stale_draft' },
)
// Just inside the window stays an edit; just outside does not. Guards the
// boundary against an off-by-one in the hours-to-milliseconds conversion.
const t0 = Date.parse('2026-07-20T09:00:00Z')
const justInside = new Date(t0 + STALE_DRAFT_HOURS * 3600_000 - 60_000).toISOString()
const justOutside = new Date(t0 + STALE_DRAFT_HOURS * 3600_000 + 60_000).toISOString()
eq(
  `a minute inside ${STALE_DRAFT_HOURS}h → edit`,
  classifyMatch(staleDraft, staleSent, { draftCreatedAt: new Date(t0), sentAt: justInside }),
  { quality: 'edit', reason: null },
)
eq(
  `a minute outside ${STALE_DRAFT_HOURS}h → unrelated`,
  classifyMatch(staleDraft, staleSent, { draftCreatedAt: new Date(t0), sentAt: justOutside }),
  { quality: 'unrelated', reason: 'stale_draft' },
)

// A stale gap on a reply that plainly IS the draft must still be an edit —
// the gate runs before every rule, staleness included.
eq(
  'a sent-as-is reply four days later is still an edit',
  classifyMatch(draftEx, sentUntouched, {
    draftCreatedAt: '2026-07-20T09:00:00Z',
    sentAt: '2026-07-24T09:00:00Z',
  }),
  { quality: 'edit', reason: null },
)

// A signature alone must not make a reply look like a different message: the
// sent side is signature-stripped before any of this runs.
eq(
  'appended signature does not change the verdict',
  classifyMatch(draftEx, `${draftEx}\n\nKind regards,\n\nRob - Customer Support`),
  { quality: 'edit', reason: null },
)

// Precedence: a reply carrying BOTH a new proof link and a stale gap reports
// the more specific reason, because that is the one a human can act on.
eq(
  'proof delivery wins over staleness',
  classifyMatch(FIXTURES[0].draft, FIXTURES[0].sent, {
    draftCreatedAt: '2026-07-20T09:00:00Z',
    sentAt: '2026-07-30T09:00:00Z',
  }),
  { quality: 'unrelated', reason: 'proof_delivery' },
)

// A plain word that merely looks reference-ish must not trip the order rule —
// the pattern is anchored and case-sensitive for exactly this reason.
eq(
  'ordinary prose does not look like an order reference',
  classifyMatch(
    'Hi Sam,\n\nWe can record-keep the artwork for you and reorder from it whenever you need more.',
    'Hi Sam,\n\nNothing here resembles a reference: recordkeeping, reordering, wordcount.',
  ),
  { quality: 'edit', reason: null },
)

// ── Result ───────────────────────────────────────────────────────────────────

console.log(`\n${passes} passed, ${failures} failed`)
if (failures > 0) process.exit(1)
