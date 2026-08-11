// Unit tests for dropboxProofFiles.ts
// Run with: npx tsx supabase/functions/_shared/dropboxProofFiles.test.ts
//
// The cases here are drawn from real order folders, including the awkward ones
// found while surveying the archive: the 2008 folders that use no naming
// convention at all, folders whose images sit loose rather than in JPGs, and
// the print files that must never be offered as artwork.
//
// The property under test throughout is FAIL OPEN, NEVER SILENT: a convention
// that matches nothing must widen the shortlist rather than empty it, and
// anything left out must come back with a reason.

import { selectProofImages, parseFolderInput, MAX_PROOF_FILES } from './dropboxProofFiles'
import type { DropboxEntry } from './dropboxProofFiles'

// ── Harness ─────────────────────────────────────────────────────────────────

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

function assertEqual<T>(actual: T, expected: T, message?: string) {
  if (actual !== expected) {
    throw new Error(message ?? `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

const file = (path: string, size = 300_000): DropboxEntry => ({
  name: path.split('/').pop()!,
  path,
  is_folder: false,
  size,
})
const folder = (path: string): DropboxEntry => ({ name: path.split('/').pop()!, path, is_folder: true })

const names = (sel: { chosen: { name: string }[] }) => sel.chosen.map((c) => c.name).sort()

// ── The house convention ────────────────────────────────────────────────────

test('picks the Proof files out of a modern order folder', () => {
  const sel = selectProofImages([
    folder('/JPGs'),
    file('/JPGs/Proof01_Alice.jpg'),
    file('/JPGs/Proof02_Bob.jpg'),
    file('/01_Alice.ai', 4_000_000),
    file('/01_Alice.pdf', 900_000),
    file('/PRINT ME.rtf', 2_000),
  ])
  assertEqual(names(sel).join(','), 'Proof01_Alice.jpg,Proof02_Bob.jpg')
})

test('print files and the workshop note are excluded WITH a reason', () => {
  const sel = selectProofImages([
    file('/JPGs/Proof01.jpg'),
    file('/01_Alice.ai'),
    file('/PRINT ME.rtf'),
  ])
  assertEqual(sel.skipped.length, 2)
  const ai = sel.skipped.find((s) => s.name.endsWith('.ai'))
  if (!ai || !ai.reason.includes('print')) throw new Error(`unhelpful reason: ${JSON.stringify(ai)}`)
  // Nothing may be dropped without saying so.
  for (const s of sel.skipped) if (!s.reason.trim()) throw new Error(`no reason given for ${s.name}`)
})

// ── Failing open, which is the whole point ──────────────────────────────────

test('a 2008-style folder with no Proof naming still returns its images', () => {
  // A recursive listing of 2008 found 0 of 207 JPEGs named Proof*. A filter
  // that returned nothing here would tell the designer the folder is empty.
  const sel = selectProofImages([file('/MichaelB.jpg'), file('/MichaelB_back.jpg'), file('/artwork.ai')])
  assertEqual(sel.chosen.length, 2)
  if (!/does not use the usual naming/i.test(sel.basis)) throw new Error(`basis should warn: ${sel.basis}`)
})

test('images loose in the folder are found when there is no JPGs subfolder', () => {
  const sel = selectProofImages([file('/Proof01_Alice.jpg'), file('/Proof02_Bob.jpg')])
  assertEqual(sel.chosen.length, 2)
})

test('the JPGs folder wins when it exists, and the rest is explained', () => {
  const sel = selectProofImages([
    file('/JPGs/Proof01_Alice.jpg'),
    file('/mockup.jpg'), // a stray image outside JPGs
  ])
  assertEqual(names(sel).join(','), 'Proof01_Alice.jpg')
  const stray = sel.skipped.find((s) => s.name === 'mockup.jpg')
  if (!stray) throw new Error('the stray image must be reported, not dropped')
})

test('an empty folder says so rather than looking like a clean result', () => {
  const sel = selectProofImages([folder('/JPGs')])
  assertEqual(sel.chosen.length, 0)
  if (!/no images/i.test(sel.basis)) throw new Error(sel.basis)
})

test('a folder of only print files reports no images', () => {
  const sel = selectProofImages([file('/01.ai'), file('/01.pdf')])
  assertEqual(sel.chosen.length, 0)
  assertEqual(sel.skipped.length, 2)
})

// ── The cap is stated, not silent ───────────────────────────────────────────

test('a large job is capped and says how many it left out', () => {
  const many = Array.from({ length: MAX_PROOF_FILES + 5 }, (_, i) =>
    file(`/JPGs/Proof${String(i + 1).padStart(2, '0')}_Person.jpg`),
  )
  const sel = selectProofImages(many)
  assertEqual(sel.chosen.length, MAX_PROOF_FILES)
  assertEqual(sel.skipped.filter((s) => /limit/.test(s.reason)).length, 5)
})

test('the order offered is stable', () => {
  const entries = [file('/JPGs/Proof03_C.jpg'), file('/JPGs/Proof01_A.jpg'), file('/JPGs/Proof02_B.jpg')]
  const a = selectProofImages(entries).chosen.map((c) => c.name)
  const b = selectProofImages([...entries].reverse()).chosen.map((c) => c.name)
  assertEqual(a.join(','), b.join(','))
  assertEqual(a.join(','), 'Proof01_A.jpg,Proof02_B.jpg,Proof03_C.jpg')
})

// ── Reaching the folder ─────────────────────────────────────────────────────

test('a shared link is recognised', () => {
  const r = parseFolderInput('https://www.dropbox.com/scl/fo/abc123/xyz?rlkey=k&dl=0')
  assertEqual(r?.kind, 'shared')
})

test('a web address becomes a path, decoded and without its query', () => {
  const r = parseFolderInput('https://www.dropbox.com/home/Orders/Order%2038294%20-%20Norwood?role=personal')
  assertEqual(r?.kind, 'path')
  assertEqual((r as { path: string }).path, '/Orders/Order 38294 - Norwood')
})

test('a plain path is taken as a path', () => {
  const r = parseFolderInput('/Orders/Order 38294 - Norwood/')
  assertEqual(r?.kind, 'path')
  assertEqual((r as { path: string }).path, '/Orders/Order 38294 - Norwood')
})

test('a bare folder name is taken as something to search for', () => {
  // The path route is preferred precisely because an archived order folder has
  // never been shared, and creating a link for one would publish a decade of
  // customers' artwork on permanent public URLs.
  const r = parseFolderInput('Order 38294 - Norwood')
  assertEqual(r?.kind, 'name')
})

test('empty and non-Dropbox input is refused rather than guessed at', () => {
  assertEqual(parseFolderInput(''), null)
  assertEqual(parseFolderInput('   '), null)
  assertEqual(parseFolderInput('https://example.com/whatever'), null)
})

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
