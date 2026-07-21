// Tests for the artwork check's pure logic: print-file selection, thread
// flattening, verdict derivation and context building. The multimodal call
// and the gather I/O are exercised in shadow mode against real orders — this
// harness covers everything decidable without the network.
//
// Run: npx tsx supabase/functions/_shared/artworkCheck/artworkCheck.test.ts
// (same hand-rolled harness convention as nudgeDecision.test.ts — no test
// framework in this repo; exits 1 on any failure.)

import {
  isCutThroughMaterial,
  looksLikePdf,
  pickPrintFiles,
  PRINT_FILE_MAX_BYTES,
  PRINT_FILES_MAX_COUNT,
  type FolderEntry,
} from './printFiles.ts'
import { MESSAGE_CHAR_CAP, THREAD_CHAR_CAP, threadToText, type ThreadLike } from './threadText.ts'
import { buildErrorReport, buildReport, countCheckedFields, countFlags, deriveVerdict } from './report.ts'
import { buildContextText, buildInputs, type CheckContext } from './prompts.ts'
import type { ModelReport } from './types.ts'

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
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

// ── pickPrintFiles ───────────────────────────────────────────────────────────

function entry(name: string, size = 1024, is_folder = false): FolderEntry {
  return { name, is_folder, path: `/${name}`, size }
}

{
  const { files, skipped } = pickPrintFiles([
    entry('Proof01_DaveAllen.jpg'),
    entry('02_Back.ai'),
    entry('01_Front.ai'),
    entry('notes.txt'),
    entry('old-logo.eps'),
    entry('Subfolder', 0, true),
  ])
  eq('picks pdf/ai only, name-ordered', files.map((f) => f.name).join(','), '01_Front.ai,02_Back.ai')
  eq('eps skipped with reason', skipped.length, 1)
  check('eps reason mentions EPS', skipped[0]?.name === 'old-logo.eps' && /EPS/.test(skipped[0]?.reason ?? ''))
}

{
  // Numeric-aware ordering: 10_ sorts after 2_.
  const { files } = pickPrintFiles([entry('10_Extra.pdf'), entry('2_Back.pdf'), entry('1_Front.pdf')])
  eq('numeric name order', files.map((f) => f.name).join(','), '1_Front.pdf,2_Back.pdf,10_Extra.pdf')
}

{
  const { files, skipped } = pickPrintFiles([
    entry('01_Front.ai', PRINT_FILE_MAX_BYTES + 1),
    entry('02_Back.ai', 1024),
  ])
  eq('oversize file skipped', files.map((f) => f.name).join(','), '02_Back.ai')
  check('oversize reason recorded', skipped.some((s) => s.name === '01_Front.ai' && /size/.test(s.reason)))
}

{
  const many = Array.from({ length: PRINT_FILES_MAX_COUNT + 3 }, (_, i) => entry(`${String(i + 1).padStart(2, '0')}_Card.pdf`))
  const { files, skipped } = pickPrintFiles(many)
  eq('count cap respected', files.length, PRINT_FILES_MAX_COUNT)
  eq('overflow skipped with reason', skipped.filter((s) => /file limit/.test(s.reason)).length, 3)
}

{
  // Total-size cap: three 7 MB files fit two (14 MB), the third would pass 20 MB.
  const seven = 7 * 1024 * 1024
  const { files, skipped } = pickPrintFiles([entry('a.pdf', seven), entry('b.pdf', seven), entry('c.pdf', seven)])
  eq('total cap keeps first two', files.map((f) => f.name).join(','), 'a.pdf,b.pdf')
  check('total cap reason recorded', skipped.some((s) => s.name === 'c.pdf' && /total size/.test(s.reason)))
}

// ── looksLikePdf ─────────────────────────────────────────────────────────────

eq('pdf header true', looksLikePdf(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])), true)
eq('jpeg header false', looksLikePdf(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), false)
eq('short bytes false', looksLikePdf(new Uint8Array([0x25, 0x50])), false)

// ── isCutThroughMaterial ─────────────────────────────────────────────────────

eq('metal is cut-through', isCutThroughMaterial('metal_matte_black'), true)
eq('acrylic is cut-through', isCutThroughMaterial('acrylic'), true)
eq('wood is cut-through', isCutThroughMaterial('wood'), true)
eq('carbon fibre is cut-through', isCutThroughMaterial('carbon_fibre'), true)
eq('carbon fibre CNC is cut-through', isCutThroughMaterial('carbon_fibre_cnc'), true)
eq('full colour plastic is not', isCutThroughMaterial('plastic_full_colour'), false)
eq('letterpress is not', isCutThroughMaterial('paper_letterpress'), false)
eq('null is not', isCutThroughMaterial(null), false)

// ── threadToText ─────────────────────────────────────────────────────────────

function thread(overrides: Partial<ThreadLike> & { body?: string }): ThreadLike {
  return {
    type: 'customer',
    state: 'published',
    body: 'hello',
    createdAt: '2026-06-01T10:00:00Z',
    createdBy: { type: 'customer', first: 'Jo', last: 'Bloggs' },
    ...overrides,
  }
}

{
  // Help Scout returns newest-first; output must be oldest-first.
  const { text, messageCount } = threadToText([
    thread({ body: 'third', createdAt: '2026-06-03T10:00:00Z' }),
    thread({ body: 'first — 125 for: Dave Allen', createdAt: '2026-06-01T10:00:00Z' }),
    thread({ body: 'second', createdAt: '2026-06-02T10:00:00Z' }),
  ])
  eq('three messages kept', messageCount, 3)
  check('chronological order', text.indexOf('first') < text.indexOf('second') && text.indexOf('second') < text.indexOf('third'))
  check('customer labelled with name', text.includes('Customer (Jo Bloggs)'))
}

{
  const { text, messageCount } = threadToText([
    thread({ type: 'lineitem', body: 'Status changed' }),
    thread({ type: 'reply', state: 'draft', body: 'unsent draft', createdBy: { type: 'user' } }),
    thread({ type: 'note', body: 'phoned in: mobile is 07700 900123', createdBy: { type: 'user', first: 'Rob' } }),
    thread({ type: 'reply', body: 'staff reply', createdBy: { type: 'user', first: 'Chris' } }),
  ])
  eq('lineitem + draft excluded', messageCount, 2)
  check('note labelled internal', text.includes('Internal note (Rob)'))
  check('staff labelled', text.includes('Staff (Chris)'))
}

{
  const { text } = threadToText([
    thread({ body: '<p>Here are the details</p><br><div>Tel: 01234 567890</div>' }),
  ])
  check('html stripped', !text.includes('<p>') && text.includes('Tel: 01234 567890'))
}

{
  const { text, messageCount } = threadToText([
    thread({ body: '', _embedded: { attachments: [{ filename: 'details.xlsx' }, { filename: 'logo.ai' }] } }),
  ])
  eq('attachment-only message kept', messageCount, 1)
  check('attachments listed by name', text.includes('[attachments: details.xlsx, logo.ai]'))
}

{
  const { text } = threadToText([thread({ body: 'x'.repeat(MESSAGE_CHAR_CAP + 500) })])
  check('long message truncated with marker', text.includes('[… message truncated]'))
  check('long message capped', text.length < MESSAGE_CHAR_CAP + 200)
}

{
  // Overflowing trail: oldest and newest survive, middle elided with a marker.
  const big = 'y'.repeat(Math.floor(MESSAGE_CHAR_CAP * 0.9))
  const threads: ThreadLike[] = Array.from({ length: 20 }, (_, i) =>
    thread({ body: `msg${i} ${big}`, createdAt: `2026-06-${String(i + 1).padStart(2, '0')}T10:00:00Z` }))
  const { text } = threadToText(threads)
  check('thread capped under limit', text.length <= THREAD_CHAR_CAP + 200)
  check('oldest kept', text.includes('msg0 '))
  check('newest kept', text.includes('msg19 '))
  check('elision marker present', /\[… \d+ messages? omitted for length …\]/.test(text))
}

eq('empty thread', threadToText([]).messageCount, 0)

// ── verdict derivation ───────────────────────────────────────────────────────

function report(overrides: Partial<ModelReport>): ModelReport {
  return {
    summary: 'test',
    cards: [],
    corrections: [],
    notes: [],
    reference_gaps: [],
    ...overrides,
  }
}

const matchFinding = { field: 'email' as const, supplied: 'a@b.com (request form)', printed: 'a@b.com', status: 'match' as const, note: '' }
const flagFinding = { ...matchFinding, printed: 'a@bb.com', status: 'flag' as const, note: 'domain differs' }

eq('all matches → clear', deriveVerdict(report({ cards: [{ label: 'Jo', findings: [matchFinding] }] })), 'clear')
eq('one flag → flagged', deriveVerdict(report({ cards: [{ label: 'Jo', findings: [matchFinding, flagFinding] }] })), 'flagged')
eq('not_supplied alone → clear', deriveVerdict(report({ cards: [{ label: 'Jo', findings: [{ ...matchFinding, status: 'not_supplied' as const }] }] })), 'clear')
eq('unresolved correction → flagged', deriveVerdict(report({ corrections: [{ quote: 'should be Jon', resolved: false, note: '' }] })), 'flagged')
eq('resolved correction → clear', deriveVerdict(report({ corrections: [{ quote: 'should be Jon', resolved: true, note: '' }] })), 'clear')
eq('flag count sums findings + corrections', countFlags(report({
  cards: [{ label: 'Jo', findings: [flagFinding, matchFinding] }],
  corrections: [{ quote: 'q', resolved: false, note: '' }, { quote: 'q2', resolved: true, note: '' }],
})), 2)
eq('checked fields counted', countCheckedFields(report({ cards: [{ label: 'A', findings: [matchFinding] }, { label: 'B', findings: [matchFinding, flagFinding] }] })), 3)

// ── report assembly ──────────────────────────────────────────────────────────

const ctx: CheckContext = {
  orderLabel: 'Order 403902 — Snap-on',
  materialDisplay: 'Matte Black Metal',
  materialCode: 'metal_matte_black',
  cutThrough: true,
  recipients: ['Dave Allen', 'Scott Worsley'],
  quantitySplit: ['Dave Allen — 75', 'Scott Worsley — 50'],
  accountContact: { name: 'Parissa Mobasher', email: 'pm@gmail.com', company: 'Plak8.com' },
  qrs: [{ kind: 'vcard', decoded: 'BEGIN:VCARD…', associatedName: null, side: 'back' }],
  threadText: '— 2026-06-01 · Customer (Jo):\n125 for: Dave Allen',
  threadGapNote: null,
  printFileNames: ['01_Front.ai'],
  skippedFiles: [{ name: 'old.eps', reason: 'EPS — not PDF-readable' }],
}

{
  const built = buildReport('claude-opus-4-8', report({ cards: [{ label: 'Jo', findings: [flagFinding] }] }), buildInputs(ctx, 5, true), {
    input_tokens: 1000, output_tokens: 200, cache_write_tokens: 0, cache_read_tokens: 0,
  }, new Date('2026-07-21T12:00:00Z'))
  eq('built verdict derived', built.verdict, 'flagged')
  eq('built stamp', built.checked_at, '2026-07-21T12:00:00.000Z')
  eq('inputs thread count', built.inputs.thread_messages, 5)
  eq('inputs recipients', built.inputs.recipients.join(','), 'Dave Allen,Scott Worsley')
}

{
  const err = buildErrorReport('claude-opus-4-8', 'Dropbox is not connected', buildInputs(ctx, 0, false))
  eq('error verdict', err.verdict, 'error')
  check('error summary carries reason', err.summary.includes('Dropbox is not connected'))
  eq('error field set', err.error, 'Dropbox is not connected')
}

// ── context text ─────────────────────────────────────────────────────────────

{
  const text = buildContextText(ctx)
  check('order label present', text.includes('Order 403902 — Snap-on'))
  check('cut-through called out', text.includes('cut-through construction: YES'))
  check('recipients listed', text.includes('- Dave Allen') && text.includes('- Scott Worsley'))
  check('account marked weak', text.includes('WEAK reference'))
  check('qr payload present', text.includes('BEGIN:VCARD…'))
  check('shared qr labelled', text.includes('shared (prints on every card)'))
  check('thread section present', text.includes('CUSTOMER THREAD (Help Scout, oldest → newest'))
  check('print files listed', text.includes('1. 01_Front.ai'))
  check('skipped files listed', text.includes('old.eps — EPS — not PDF-readable'))
}

{
  const gapCtx: CheckContext = { ...ctx, threadText: '', threadGapNote: 'this proof has no linked Help Scout conversation', qrs: [], recipients: [] }
  const text = buildContextText(gapCtx)
  check('gap note rendered', text.includes('this proof has no linked Help Scout conversation'))
  check('gap framed as not-evidence', text.includes('not as evidence of error'))
  check('no recipients line', text.includes('No named recipients'))
  check('no qr line', text.includes('No QR codes'))
}

// ── summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passes} passed, ${failures} failed`)
if (failures > 0) process.exit(1)
