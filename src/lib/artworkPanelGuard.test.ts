// Unit tests for artworkPanelGuard.ts
// Run with: npx tsx src/lib/artworkPanelGuard.test.ts
//
// The copy is the substance here. This guard exists because designers were
// forgetting to crop old proofs, so the words have to make a busy person stop —
// which means naming what the CUSTOMER would see, not what the software
// noticed. These pin that, and the singular/plural forms that go with it.

import { panelNoticeForImage, panelNoticeForSave } from './artworkPanelGuard'
import type { PanelDetection } from './proofPanelCrop'

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
function assert(cond: boolean, message: string) {
  if (!cond) throw new Error(message)
}
function assertEqual<T>(a: T, b: T, m?: string) {
  if (a !== b) throw new Error(m ?? `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
}

const det = (confidence: 'clear' | 'unsure'): PanelDetection => ({
  hasPanel: true,
  cutX: 460,
  cutFraction: 0.36,
  confidence,
  reason: 'x',
})

test('nothing to say when nothing is flagged', () => {
  assertEqual(panelNoticeForSave(0), null)
  assertEqual(panelNoticeForSave(-1), null)
})

test('the save notice names the consequence, not the detection', () => {
  const one = panelNoticeForSave(1) ?? ''
  // "Old price panel detected" describes our machinery. What stops a designer
  // mid-save is being told what the customer ends up looking at.
  assert(/customer/i.test(one), `should say what the customer sees: ${one}`)
  assert(/price grid/i.test(one), `should contrast with the live grid: ${one}`)
})

test('save notice is singular for one and plural for more', () => {
  assert(/^One image still has/.test(panelNoticeForSave(1) ?? ''), panelNoticeForSave(1) ?? '')
  assert(/^3 images still have/.test(panelNoticeForSave(3) ?? ''), panelNoticeForSave(3) ?? '')
})

test('an unsure flag hedges; a clear one does not', () => {
  const unsure = panelNoticeForImage(det('unsure'))
  const clear = panelNoticeForImage(det('clear'))
  assert(/might/i.test(unsure), `unsure should hedge: ${unsure}`)
  assert(!/might/i.test(clear), `clear should not hedge: ${clear}`)
  // Roughly one flag in fifty is wrong, so the uncertain wording must not
  // accuse the designer of a mistake they may not have made.
  assert(/worth a look/i.test(unsure), unsure)
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
