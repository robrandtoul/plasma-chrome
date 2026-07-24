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
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENTS_MAX_COUNT,
  attachmentBudget,
  parseSpreadsheet,
  pickAttachments,
  routeAttachment,
  routedToBlocks,
  type AttachmentMeta,
} from './attachments.ts'
import {
  APPROVED_IMAGE_MAX_BYTES,
  APPROVED_IMAGES_MAX_COUNT,
  approvedImageBudget,
  pickApprovedImages,
  PROOF_IMAGES_TOTAL_MAX_BYTES,
  type ApprovedImageRow,
} from './approvedProof.ts'
import {
  buildInvestigationContext,
  INVESTIGATION_IMAGES_MAX,
  investigationKey,
  matchCardToRecipient,
  pickInvestigationImages,
  type VersionImageRowLite,
  type VersionRowLite,
} from './investigate.ts'
import { classifyQrPayload } from './qrDecode.ts'
import { buildErrorReport, buildReport, countCheckedFields, countDefects, countFlags, deriveVerdict } from './report.ts'
import {
  buildContextText,
  buildInputs,
  buildProofContextText,
  buildProofInputs,
  PROOF_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
  type CheckContext,
  type ProofCheckContext,
} from './prompts.ts'
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

// The red tier: defect-grade flags/corrections outrank flagged.
const defectFinding = { ...flagFinding, severity: 'defect' as const }
eq('defect flag → defect', deriveVerdict(report({ cards: [{ label: 'Jo', findings: [matchFinding, defectFinding] }] })), 'defect')
eq('review flag stays flagged', deriveVerdict(report({ cards: [{ label: 'Jo', findings: [{ ...flagFinding, severity: 'review' as const }] }] })), 'flagged')
eq('defect unresolved correction → defect', deriveVerdict(report({ corrections: [{ quote: 'should be X', resolved: false, severity: 'defect' as const, note: '' }] })), 'defect')
eq('defect on a RESOLVED correction is inert', deriveVerdict(report({ corrections: [{ quote: 'should be X', resolved: true, severity: 'defect' as const, note: '' }] })), 'clear')
eq('defect on a match finding is inert', deriveVerdict(report({ cards: [{ label: 'Jo', findings: [{ ...matchFinding, severity: 'defect' as const }] }] })), 'clear')
eq('countDefects sums flags + unresolved corrections', countDefects(report({
  cards: [{ label: 'Jo', findings: [defectFinding, flagFinding, { ...matchFinding, severity: 'defect' as const }] }],
  corrections: [
    { quote: 'q', resolved: false, severity: 'defect' as const, note: '' },
    { quote: 'q2', resolved: false, note: '' },
    { quote: 'q3', resolved: true, severity: 'defect' as const, note: '' },
  ],
})), 2)
eq('pre-tier report (no severity) never defects', deriveVerdict(report({ cards: [{ label: 'Jo', findings: [flagFinding] }], corrections: [{ quote: 'q', resolved: false, note: '' }] })), 'flagged')
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
  artworkDecodedQrs: [],
  threadText: '— 2026-06-01 · Customer (Jo):\n125 for: Dave Allen',
  threadGapNote: null,
  printFileNames: ['01_Front.ai'],
  skippedFiles: [{ name: 'old.eps', reason: 'EPS — not PDF-readable' }],
  attachmentsRead: [{ name: 'details.xlsx', at: '2026-06-01' }],
  attachmentsSkipped: [{ name: 'source.zip', reason: 'not a readable type' }],
  approvedRead: ['Dave Allen — front'],
  approvedSkipped: [{ name: 'weird.tiff', reason: 'not a readable image type' }],
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
  const gapCtx: CheckContext = { ...ctx, threadText: '', threadGapNote: 'this proof has no linked Help Scout conversation', qrs: [], artworkDecodedQrs: [], recipients: [], attachmentsRead: [], attachmentsSkipped: [], approvedRead: [], approvedSkipped: [] }
  const text = buildContextText(gapCtx)
  check('gap note rendered', text.includes('this proof has no linked Help Scout conversation'))
  check('gap framed as not-evidence', text.includes('not as evidence of error'))
  check('no recipients line', text.includes('No named recipients'))
  check('no qr line', text.includes('No QR codes'))
  check('no-attachments line', text.includes('No customer attachments were readable'))
}

{
  const text = buildContextText(ctx)
  check('read attachments listed', text.includes('CUSTOMER ATTACHMENTS READ (1') && text.includes('details.xlsx (2026-06-01)'))
  check('skipped attachments listed', text.includes('source.zip — not a readable type'))
  check('approved proofs listed', text.includes('APPROVED PROOF IMAGES (1') && text.includes('Dave Allen — front'))
  check('approved skips listed', text.includes('weird.tiff — not a readable image type'))
  // No artwork-decoded QRs but approved images WERE read → the "scanned, none
  // decoded" signal so the model knows a visible QR is unverified.
  check('no-decode-but-scanned signal', text.includes('scanned for QR codes and none decoded'))
}

{
  const decodedCtx: CheckContext = { ...ctx, artworkDecodedQrs: ['https://qcrd.uk/abc', 'BEGIN:VCARD\nFN:Jo\nEND:VCARD'] }
  const text = buildContextText(decodedCtx)
  check('artwork-decoded QRs listed', text.includes('decoded straight from the approved artwork (2') && text.includes('A1. https://qcrd.uk/abc'))
  check('decode signal replaces the none-decoded line', !text.includes('none decoded'))
}

// ── QR payload classifier (qrDecode) ─────────────────────────────────────────

eq('classify vcard', classifyQrPayload('BEGIN:VCARD\nFN:Jo\nEND:VCARD'), 'vcard')
eq('classify url', classifyQrPayload('https://qcrd.uk/7k2nq8x'), 'url')
eq('classify mailto', classifyQrPayload('mailto:jo@acme.com'), 'email')
eq('classify bare email', classifyQrPayload('jo@acme.com'), 'email')
eq('classify tel', classifyQrPayload('tel:+441234567890'), 'phone')
eq('classify wifi', classifyQrPayload('WIFI:S:net;T:WPA;P:pw;;'), 'wifi')
eq('classify plain text', classifyQrPayload('just some words'), 'text')

// ── approved proof picks (Leg C) ─────────────────────────────────────────────

function approvedRow(overrides: Partial<ApprovedImageRow>): ApprovedImageRow {
  return { image_path: 'proofs/a.jpg', original_filename: 'a.jpg', associated_name: null, side: 'front', is_qr_code: false, ...overrides }
}

{
  const { picks, skipped } = pickApprovedImages([
    approvedRow({ image_path: 'p/dave-back.jpg', associated_name: 'Dave Allen', side: 'back' }),
    approvedRow({ image_path: 'p/shared-front.jpg', associated_name: null, side: 'front' }),
    approvedRow({ image_path: 'p/dave-front.jpg', associated_name: 'Dave Allen', side: 'front' }),
    approvedRow({ image_path: 'p/qr.svg', is_qr_code: true }),
    approvedRow({ image_path: 'p/odd.tiff', original_filename: 'odd.tiff' }),
    approvedRow({ image_path: '' }),
  ])
  eq('gallery order: shared first, then name, front before back',
    picks.map((p) => p.label).join(','), 'Shared — front,Dave Allen — front,Dave Allen — back')
  check('qr rows excluded silently', !picks.some((p) => p.path === 'p/qr.svg') && !skipped.some((s) => s.name.includes('qr')))
  check('non-raster named as skipped', skipped.some((s) => s.name === 'odd.tiff' && /image type/.test(s.reason)))
  check('media types resolved', picks.every((p) => p.mediaType === 'image/jpeg'))
}

{
  const many = Array.from({ length: APPROVED_IMAGES_MAX_COUNT + 2 }, (_, i) =>
    approvedRow({ image_path: `p/${i}.jpg`, original_filename: `${i}.jpg`, associated_name: `P${String(i).padStart(2, '0')}` }))
  const { picks, skipped } = pickApprovedImages(many)
  eq('approved count cap', picks.length, APPROVED_IMAGES_MAX_COUNT)
  eq('approved overflow recorded', skipped.filter((s) => /limit reached/.test(s.reason)).length, 2)
}

eq('approved budget caps at 6MB', approvedImageBudget(0, 0), 6 * 1024 * 1024)
eq('approved budget shrinks', approvedImageBudget(20 * 1024 * 1024, 2 * 1024 * 1024), 2 * 1024 * 1024)
eq('approved budget floors at zero', approvedImageBudget(20 * 1024 * 1024, 8 * 1024 * 1024), 0)

// ── attachments: pickAttachments ─────────────────────────────────────────────

function attachThread(overrides: Partial<ThreadLike>, atts: { id?: number; filename?: string; mimeType?: string; size?: number }[]): ThreadLike {
  return {
    type: 'customer',
    state: 'published',
    body: 'see attached',
    createdAt: '2026-06-01T10:00:00Z',
    createdBy: { type: 'customer', first: 'Jo' },
    _embedded: { attachments: atts },
    ...overrides,
  }
}

{
  const { picks, skipped } = pickAttachments([
    attachThread({}, [
      { id: 1, filename: 'roster.xlsx', mimeType: 'application/vnd.ms-excel', size: 1000 },
      { id: 2, filename: 'source.zip', mimeType: 'application/zip', size: 1000 },
      { id: 3, filename: 'too-big.pdf', mimeType: 'application/pdf', size: ATTACHMENT_MAX_BYTES + 1 },
    ]),
    // Staff attachment (our own proof export) — excluded entirely, no skip entry.
    attachThread({ createdBy: { type: 'user', first: 'Rob' } }, [
      { id: 4, filename: 'Proof01.jpg', mimeType: 'image/jpeg', size: 1000 },
    ]),
    // Draft thread — excluded.
    attachThread({ state: 'draft' }, [{ id: 5, filename: 'draft.pdf', mimeType: 'application/pdf', size: 100 }]),
  ], 0)
  eq('customer readable picked', picks.map((p) => p.filename).join(','), 'roster.xlsx')
  check('zip skipped by type', skipped.some((s) => s.name === 'source.zip' && /readable type/.test(s.reason)))
  check('oversize skipped', skipped.some((s) => s.name === 'too-big.pdf' && /size limit/.test(s.reason)))
  check('staff attachment silently excluded', !picks.some((p) => p.filename === 'Proof01.jpg') && !skipped.some((s) => s.name === 'Proof01.jpg'))
  check('draft attachment excluded', !picks.some((p) => p.filename === 'draft.pdf'))
}

{
  // Priority: spreadsheets before PDFs before images; date ascending within kind.
  const { picks } = pickAttachments([
    attachThread({ createdAt: '2026-06-03T10:00:00Z' }, [{ id: 1, filename: 'photo.jpg', mimeType: 'image/jpeg', size: 10 }]),
    attachThread({ createdAt: '2026-06-02T10:00:00Z' }, [{ id: 2, filename: 'form.pdf', mimeType: 'application/pdf', size: 10 }]),
    attachThread({ createdAt: '2026-06-05T10:00:00Z' }, [{ id: 3, filename: 'late.csv', mimeType: 'text/csv', size: 10 }]),
    attachThread({ createdAt: '2026-06-01T10:00:00Z' }, [{ id: 4, filename: 'early.csv', mimeType: 'text/csv', size: 10 }]),
  ], 0)
  eq('priority + date order', picks.map((p) => p.filename).join(','), 'early.csv,late.csv,form.pdf,photo.jpg')
}

{
  const many = Array.from({ length: ATTACHMENTS_MAX_COUNT + 2 }, (_, i) =>
    attachThread({}, [{ id: i + 1, filename: `f${String(i).padStart(2, '0')}.csv`, mimeType: 'text/csv', size: 10 }]))
  const { picks, skipped } = pickAttachments(many, 0)
  eq('attachment count cap', picks.length, ATTACHMENTS_MAX_COUNT)
  eq('count-cap overflow recorded', skipped.filter((s) => /attachment limit/.test(s.reason)).length, 2)
}

{
  // The same file riding two messages (re-send / quoted reply) reads once.
  const { picks, skipped } = pickAttachments([
    attachThread({ createdAt: '2026-06-01T10:00:00Z' }, [{ id: 1, filename: 'design.pdf', mimeType: 'application/pdf', size: 500 }]),
    attachThread({ createdAt: '2026-06-02T10:00:00Z' }, [{ id: 2, filename: 'design.pdf', mimeType: 'application/pdf', size: 500 }]),
  ], 0)
  eq('duplicate read once', picks.length, 1)
  check('duplicate recorded as such', skipped.some((s) => s.name === 'design.pdf' && /duplicate/.test(s.reason)))
}

{
  // Budget: prints already used 22 MB of the 24 MB shared pool → 2 MB left.
  const twoMb = 2 * 1024 * 1024
  const { picks, skipped } = pickAttachments([
    attachThread({}, [
      { id: 1, filename: 'a.pdf', mimeType: 'application/pdf', size: twoMb - 1 },
      { id: 2, filename: 'b.pdf', mimeType: 'application/pdf', size: twoMb },
    ]),
  ], 22 * 1024 * 1024)
  eq('budget keeps what fits', picks.map((p) => p.filename).join(','), 'a.pdf')
  check('budget overflow recorded', skipped.some((s) => s.name === 'b.pdf' && /budget/.test(s.reason)))
}

eq('budget caps at 8MB', attachmentBudget(0), 8 * 1024 * 1024)
eq('budget shrinks with prints', attachmentBudget(20 * 1024 * 1024), 4 * 1024 * 1024)
eq('budget floors at zero', attachmentBudget(30 * 1024 * 1024), 0)

// ── attachments: routing + parsing ───────────────────────────────────────────

const enc = new TextEncoder()
function meta(filename: string): AttachmentMeta {
  return { id: 1, filename, mimeType: '', size: 10, at: '2026-06-01T10:00:00Z' }
}

await (async () => {
  const csv = await routeAttachment(meta('roster.csv'), enc.encode('name,email\nDave,dave@a.com'))
  check('csv routes to text', csv?.kind === 'text' && csv.text.includes('dave@a.com'))

  const pdf = await routeAttachment(meta('form.pdf'), enc.encode('%PDF-1.4 rest'))
  check('pdf routes to document', pdf?.kind === 'document')

  const badPdf = await routeAttachment(meta('form.pdf'), enc.encode('not a pdf'))
  eq('non-pdf bytes rejected', badPdf, null)

  const ai = await routeAttachment(meta('art.ai'), enc.encode('%PDF-1.6 rest'))
  check('pdf-compatible ai routes to document', ai?.kind === 'document')

  const img = await routeAttachment(meta('photo.JPG'), enc.encode('xx'))
  check('jpg routes to image with media type', img?.kind === 'image' && img.mediaType === 'image/jpeg')

  const zip = await routeAttachment(meta('stuff.zip'), enc.encode('xx'))
  eq('unknown type unroutable', zip, null)

  // Real xlsx round-trip through SheetJS (the same library the runtime loads).
  const XLSX = await import('xlsx')
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['name', 'email'], ['Kamran Randhawa', 'kamran@fish.com']]), 'Cards')
  const xlsxBytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
  const parsed = await parseSpreadsheet('Book1.xlsx', xlsxBytes)
  check('xlsx parses to csv text', !!parsed && parsed.includes('Kamran Randhawa') && parsed.includes('kamran@fish.com'))

  const blocks = routedToBlocks([
    { kind: 'text', name: 'roster.csv', at: '2026-06-01T10:00:00Z', text: 'name,email' },
    { kind: 'document', name: 'form.pdf', at: '2026-06-02T10:00:00Z', bytes: enc.encode('%PDF-1.4') },
    { kind: 'image', name: 'photo.jpg', at: '2026-06-03T10:00:00Z', mediaType: 'image/jpeg', bytes: enc.encode('xx') },
  ])
  eq('blocks: text folds label+content, doc/image get label blocks', blocks.length, 5)
  check('text block labelled', blocks[0].type === 'text' && (blocks[0] as { text: string }).text.includes('roster.csv') && (blocks[0] as { text: string }).text.includes('2026-06-01'))
  check('document titled', blocks[2].type === 'document' && (blocks[2] as { title?: string }).title === 'form.pdf')
  check('image block present', blocks[4].type === 'image')
})()

// ── flag investigation (history walk) ────────────────────────────────────────

eq('investigation key', investigationKey('Derrick Smith — back', 'tel'), 'Derrick Smith — back::tel')

eq('recipient matched from label', matchCardToRecipient('Christine Davis — front', ['Thomas I. Joles', 'Christine Davis']), 'Christine Davis')
eq('match is case-insensitive', matchCardToRecipient('CHRISTINE DAVIS — card', ['Christine Davis']), 'Christine Davis')
eq('longest name wins', matchCardToRecipient('Dave Allen-Smith — front', ['Dave Allen', 'Dave Allen-Smith']), 'Dave Allen-Smith')
eq('shared card matches nobody', matchCardToRecipient('Shared front card', ['Christine Davis']), null)

{
  const versions: VersionRowLite[] = [
    { id: 'v1', version_number: 1, created_at: '2026-07-01T10:00:00Z', material_display: 'Letterpress' },
    { id: 'v2', version_number: 2, created_at: '2026-07-05T10:00:00Z', material_display: 'Letterpress' },
  ]
  const images: VersionImageRowLite[] = [
    { proof_version_id: 'v2', image_path: 'p/v2-chris-back.jpg', associated_name: 'Christine Davis', side: 'back' },
    { proof_version_id: 'v1', image_path: 'p/v1-chris-front.jpg', associated_name: 'Christine Davis', side: 'front' },
    { proof_version_id: 'v2', image_path: 'p/v2-chris-front.jpg', associated_name: 'Christine Davis', side: 'front' },
    { proof_version_id: 'v1', image_path: 'p/v1-shared.jpg', associated_name: null, side: 'front' },
    { proof_version_id: 'v1', image_path: 'p/v1-qr.jpg', associated_name: 'Christine Davis', side: 'front', is_qr_code: true },
    { proof_version_id: 'v1', image_path: 'p/v1-odd.svg', associated_name: 'Christine Davis', side: 'front' },
    { proof_version_id: 'ghost', image_path: 'p/ghost.jpg', associated_name: 'Christine Davis', side: 'front' },
  ]
  const picks = pickInvestigationImages(versions, images, 'Christine Davis')
  eq('walk order: rounds ascending, front before back',
    picks.map((p) => p.label).join(','), 'v1 — front,v2 — front,v2 — back')
  check('shared/qr/non-raster/ghost excluded',
    !picks.some((p) => p.path.includes('shared') || p.path.includes('qr') || p.path.includes('odd') || p.path.includes('ghost')))

  const shared = pickInvestigationImages(versions, images, null)
  eq('null recipient walks the shared artwork', shared.map((p) => p.path).join(','), 'p/v1-shared.jpg')
}

{
  const versions: VersionRowLite[] = [{ id: 'v1', version_number: 1, created_at: '2026-07-01T10:00:00Z', material_display: null }]
  const many: VersionImageRowLite[] = Array.from({ length: INVESTIGATION_IMAGES_MAX + 5 }, (_, i) => ({
    proof_version_id: 'v1', image_path: `p/${i}.jpg`, associated_name: 'A', side: 'front',
  }))
  eq('investigation image cap', pickInvestigationImages(versions, many, 'A').length, INVESTIGATION_IMAGES_MAX)
}

{
  const text = buildInvestigationContext(
    { card: 'Derrick Smith — back', field: 'tel', printed: '0207 288 8008', supplied: '020 7288 8008 (15 Jul)', note: 'superseded grouping' },
    [{ id: 'v1', version_number: 1, created_at: '2026-07-01T10:00:00Z', material_display: 'Gun Metal' }],
    'Derrick Smith',
    '— 2026-07-15 · Customer:\nshould read 020 7288 8008',
    null,
  )
  check('investigation context carries flag', text.includes('Field: tel') && text.includes('0207 288 8008'))
  check('investigation context carries rounds', text.includes('v1 — created 2026-07-01') && text.includes('Gun Metal'))
  check('investigation context carries thread', text.includes('should read 020 7288 8008'))
  const gapText = buildInvestigationContext(
    { card: 'X', field: 'tel', printed: 'p', supplied: '', note: '' },
    [], null, '', 'no linked conversation',
  )
  check('investigation gap note rendered', gapText.includes('no linked conversation') && gapText.includes('undetermined'))
}

// ── Pre-send proof check (000343) ────────────────────────────────────────────
// The proof-mode prompt + context builder. The ORDER prompt's stability is
// asserted alongside: the two are separate literals by design, and an edit
// meant for one must not silently reshape the other.

{
  check('proof prompt: pre-send framing', PROOF_SYSTEM_PROMPT.includes('BEFORE the customer sees this proof'))
  check('proof prompt: walks change requests', PROOF_SYSTEM_PROMPT.includes('un-actioned revisions'))
  check('proof prompt: partial actioning flagged', PROOF_SYSTEM_PROMPT.includes('only partly carried out'))
  check('proof prompt: latest-wins retained', PROOF_SYSTEM_PROMPT.includes('LAST-supplied value'))
  check('proof prompt: no approved-proof section', !PROOF_SYSTEM_PROMPT.includes('APPROVED PROOF RULES'))
  check('proof prompt: no drift category', !PROOF_SYSTEM_PROMPT.includes('post-approval DRIFT'))
  check('proof prompt: two defect categories only', PROOF_SYSTEM_PROMPT.includes('ONLY two categories qualify'))
  check('proof prompt: choose-review-when-torn retained', PROOF_SYSTEM_PROMPT.includes('choose review'))
  check('proof prompt: redesign-not-a-flag rule', PROOF_SYSTEM_PROMPT.includes('deliberate redesign is not a flag'))
  check('proof prompt: proof image is the truth', PROOF_SYSTEM_PROMPT.includes('The proof image is the truth'))

  // Guard the live ORDER prompt against cross-contamination.
  check('order prompt: approved-proof section intact', SYSTEM_PROMPT.includes('APPROVED PROOF RULES'))
  check('order prompt: three defect categories intact', SYSTEM_PROMPT.includes('ONLY three categories qualify'))
  check('order prompt: drift category intact', SYSTEM_PROMPT.includes('post-approval DRIFT'))
  check('order prompt: print-file framing intact', SYSTEM_PROMPT.includes('The print file is the truth'))

  // Notes discipline (Rob's 2026-07-24 report review): both prompts demand
  // few, plain-English notes and jargon-free gaps; the loose old wording is
  // gone from both.
  for (const [name, prompt] of [['order', SYSTEM_PROMPT], ['proof', PROOF_SYSTEM_PROMPT]] as const) {
    check(`${name} prompt: notes capped and plain`, prompt.includes('at most three, often none') && prompt.includes('plain English a non-specialist'))
    check(`${name} prompt: notes never restate the table`, prompt.includes('never restate what the field table'))
    check(`${name} prompt: gaps jargon-free`, prompt.includes('no pipeline jargon'))
    check(`${name} prompt: old notes wording gone`, !prompt.includes('expected/no-action observations'))
  }
}

const proofCtx: ProofCheckContext = {
  proofLabel: 'The Boat Shack',
  versionNumber: 3,
  materialDisplay: 'Matte Black Metal',
  materialCode: 'metal_matte_black',
  cutThrough: true,
  recipients: ['Chris Azevedo'],
  accountContact: { name: 'Chris Azevedo', email: 'chrisazevedo8@gmail.com', company: 'The Boat Shack' },
  qrs: [{ kind: 'url', decoded: 'https://qcrd.uk/abc', associatedName: null, side: 'back' }],
  artworkDecodedQrs: [],
  threadText: '— 2026-07-10 · Customer:\nPlease keep the full card intact.',
  threadGapNote: null,
  proofImagesRead: ['Chris Azevedo — front', 'Chris Azevedo — back'],
  proofImagesSkipped: [{ name: 'odd.tiff', reason: 'not a readable image type' }],
  attachmentsRead: [{ name: 'details.xlsx', at: '2026-07-09' }],
  attachmentsSkipped: [{ name: 'source.zip', reason: 'not a readable type' }],
}

{
  const text = buildProofContextText(proofCtx)
  check('proof ctx: labelled as unsent', text.includes('PROOF: The Boat Shack — version 3 (NOT yet sent to the customer)'))
  check('proof ctx: cut-through called out', text.includes('cut-through construction: YES'))
  check('proof ctx: recipients listed', text.includes('- Chris Azevedo'))
  check('proof ctx: account marked weak', text.includes('WEAK reference'))
  check('proof ctx: qr payload present', text.includes('https://qcrd.uk/abc'))
  check('proof ctx: thread section present', text.includes('CUSTOMER THREAD (Help Scout, oldest → newest'))
  check('proof ctx: images listed as the artwork', text.includes('PROOF IMAGES (2') && text.includes('1. Chris Azevedo — front'))
  check('proof ctx: image skips listed', text.includes('odd.tiff — not a readable image type'))
  check('proof ctx: attachments listed', text.includes('details.xlsx (2026-07-09)'))
  check('proof ctx: no print-file section', !text.includes('PRINT FILES'))
  check('proof ctx: no approved-proof section', !text.includes('APPROVED PROOF IMAGES'))
  // Images read but nothing decoded → the unverified-QR signal.
  check('proof ctx: none-decoded signal', text.includes('scanned for QR codes and none decoded'))
}

{
  const decoded = buildProofContextText({ ...proofCtx, artworkDecodedQrs: ['https://qcrd.uk/abc'] })
  check('proof ctx: decoded QRs listed A-numbered', decoded.includes('decoded straight from the proof images (1') && decoded.includes('A1. https://qcrd.uk/abc'))
  check('proof ctx: decode replaces none-decoded line', !decoded.includes('none decoded'))
  const gap = buildProofContextText({ ...proofCtx, threadText: '', threadGapNote: 'this proof has no linked Help Scout conversation', recipients: [], qrs: [], proofImagesRead: [], proofImagesSkipped: [], attachmentsRead: [] })
  check('proof ctx: gap note rendered', gap.includes('this proof has no linked Help Scout conversation') && gap.includes('not as evidence of error'))
  check('proof ctx: no recipients line', gap.includes('No named recipients'))
}

{
  const inputs = buildProofInputs(proofCtx, 4, true)
  eq('proof inputs: kind stamped', inputs.check_kind, 'proof')
  eq('proof inputs: no print files', inputs.print_files.length, 0)
  eq('proof inputs: images recorded', (inputs.proof_images_read ?? []).join(','), 'Chris Azevedo — front,Chris Azevedo — back')
  eq('proof inputs: image skips recorded', inputs.proof_images_skipped?.[0]?.name, 'odd.tiff')
  eq('proof inputs: thread stats', inputs.thread_messages, 4)
  eq('proof inputs: qr count', inputs.qr_count, 1)
  // The report machinery is shared — a proof-mode report derives its verdict
  // exactly like an order-mode one.
  const flagged: ModelReport = { summary: 's', cards: [{ label: 'Chris Azevedo — front/back', findings: [{ field: 'email', supplied: 'a@b.com', printed: 'a@bb.com', status: 'flag', severity: 'review', note: '' }] }], corrections: [], notes: [], reference_gaps: [] }
  eq('proof report verdict via shared derivation', buildReport('m', flagged, inputs, null).verdict, 'flagged')
}

check('proof image pool exceeds a single image cap', PROOF_IMAGES_TOTAL_MAX_BYTES > APPROVED_IMAGE_MAX_BYTES)
check('proof image pool leaves attachment headroom', PROOF_IMAGES_TOTAL_MAX_BYTES < 24 * 1024 * 1024)

// ── summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passes} passed, ${failures} failed`)
if (failures > 0) process.exit(1)
