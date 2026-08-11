// Run the panel detector over a hand-labelled corpus of REAL proof JPEGs and
// print an honest confusion matrix.
//
// Why this exists separately from proofPanelCrop.test.ts: that file tests the
// decision logic against synthetic profiles, which proves the code does what it
// was written to do — not that what it was written to do is right. The claim
// worth making is "this finds the panel on real proofs, including the coloured-
// background ones that defeated the previous attempt", and only real files can
// support it. Two earlier approaches (a 16:9 shape test, and a dark-gutter
// search) both looked fine in the abstract and failed on real images.
//
// It imports the SAME functions the browser runs, so this measures what ships.
//
// Usage:
//   npx tsx scripts/check-panel-crop.ts <corpus-dir> [labels.json]
//
// The corpus directory holds one subfolder per slice, each with proof images.
// labels.json (defaults to <corpus-dir>/labels.json) is an array of:
//   { slice, file, hasPanel, panelEndFrac?, productType, bgDescription? }
// where panelEndFrac is a VERIFIED good cut point — the labeller cropped there
// and confirmed the result was clean.
//
// ⚠ A file present in the corpus but absent from labels.json is REPORTED, never
// skipped silently. An unlabelled image is missing evidence, and quietly
// dropping it would flatter every rate below.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { decode } from 'imagescript'
import { columnProfiles, detectPanelFromProfiles } from '../src/lib/proofPanelCrop'

interface Label {
  slice: string
  file: string
  hasPanel: boolean
  panelEndFrac?: number
  productType?: string
  bgDescription?: string
  orderFolder?: string
}

// Matches WORK_WIDTH in proofPanelCrop.ts. The browser downsamples via canvas
// and this via imagescript, so the pixels are not bit-identical — which is
// fine and worth stating: the detector measures detail statistics over hundreds
// of columns, not individual pixels. If a result ever hinged on the resampler,
// that would itself be the bug.
const WORK_WIDTH = 1400

const corpusDir = process.argv[2]
if (!corpusDir) {
  console.error('Usage: npx tsx scripts/check-panel-crop.ts <corpus-dir> [labels.json]')
  process.exit(1)
}
const labelsPath = process.argv[3] ?? join(corpusDir, 'labels.json')
if (!existsSync(labelsPath)) {
  console.error(`No labels at ${labelsPath}`)
  process.exit(1)
}

const labels: Label[] = JSON.parse(readFileSync(labelsPath, 'utf8'))
const byKey = new Map(labels.map((l) => [`${l.slice}/${l.file}`, l]))

async function profileOf(path: string): Promise<{ profiles: ReturnType<typeof columnProfiles>; width: number } | null> {
  try {
    const img = await decode(readFileSync(path))
    const w = Math.min(WORK_WIDTH, img.width)
    const h = Math.max(1, Math.round((img.height / img.width) * w))
    const small = w === img.width ? img : img.clone().resize(w, h)
    return { profiles: columnProfiles(small.bitmap, small.width, small.height), width: small.width }
  } catch {
    return null
  }
}

interface Row {
  key: string
  label: Label
  said: boolean
  cutFrac: number | null
  confidence: string
  reason: string
}

const rows: Row[] = []
const unreadable: string[] = []
const unlabelled: string[] = []

for (const slice of readdirSync(corpusDir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
  for (const file of readdirSync(join(corpusDir, slice.name)).filter((f) => /\.(jpe?g|png)$/i.test(f))) {
    const key = `${slice.name}/${file}`
    const label = byKey.get(key)
    if (!label) {
      unlabelled.push(key)
      continue
    }
    const p = await profileOf(join(corpusDir, slice.name, file))
    if (!p) {
      unreadable.push(key)
      continue
    }
    const d = detectPanelFromProfiles(p.profiles, p.width)
    rows.push({ key, label, said: d.hasPanel, cutFrac: d.cutFraction, confidence: d.confidence, reason: d.reason })
  }
}

// ── Confusion matrix ────────────────────────────────────────────────────────

const cards = rows.filter((r) => (r.label.productType ?? 'card') === 'card')
const truePos = cards.filter((r) => r.label.hasPanel && r.said)
const falseNeg = cards.filter((r) => r.label.hasPanel && !r.said)
const trueNeg = cards.filter((r) => !r.label.hasPanel && !r.said)
const falsePos = cards.filter((r) => !r.label.hasPanel && r.said)

const pct = (n: number, d: number) => (d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`)

console.log(`\n=== Panel detector vs ${rows.length} labelled real proofs (${cards.length} cards) ===\n`)
console.log(`                     detector: panel    no panel`)
console.log(`  truth: panel            ${String(truePos.length).padStart(5)}       ${String(falseNeg.length).padStart(5)}   <- misses are the dangerous ones`)
console.log(`  truth: no panel         ${String(falsePos.length).padStart(5)}       ${String(trueNeg.length).padStart(5)}`)
console.log(
  `\n  recall (panels found):   ${pct(truePos.length, truePos.length + falseNeg.length)}` +
    `   <- a miss puts a stale price grid in front of a customer`,
)
console.log(`  precision:               ${pct(truePos.length, truePos.length + falsePos.length)}   <- a false alarm only costs a rejected suggestion`)

// ── The dangerous column, named ─────────────────────────────────────────────

if (falseNeg.length > 0) {
  console.log(`\n--- MISSED PANELS (${falseNeg.length}) — each of these would ship a price grid ---`)
  for (const r of falseNeg) {
    console.log(`  ${r.key}`)
    console.log(`     bg: ${r.label.bgDescription ?? '?'}   said: ${r.reason}`)
  }
}

if (falsePos.length > 0) {
  console.log(`\n--- FALSE ALARMS (${falsePos.length}) — offered a crop on an already-clean proof ---`)
  for (const r of falsePos) console.log(`  ${r.key}  cut@${r.cutFrac?.toFixed(3)}  ${r.reason}`)
}

// ── Where the cut lands ─────────────────────────────────────────────────────
// The label's panelEndFrac is a cut the labeller verified by eye. Cutting a
// little to the right of it only keeps background; cutting to the LEFT leaves a
// sliver of the panel, which is the quiet failure — a few pixels of price grid
// is not obvious at a glance the way a whole one is.

const measurable = truePos.filter((r) => typeof r.label.panelEndFrac === 'number' && r.cutFrac != null)
if (measurable.length > 0) {
  const deltas = measurable.map((r) => r.cutFrac! - r.label.panelEndFrac!)
  const sorted = [...deltas].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const slivers = measurable.filter((r) => r.cutFrac! < r.label.panelEndFrac! - 0.01)
  const overshoot = measurable.filter((r) => r.cutFrac! > r.label.panelEndFrac! + 0.05)
  console.log(`\n--- Cut accuracy over ${measurable.length} panels with a verified edge ---`)
  console.log(`  delta vs verified cut:  min ${sorted[0].toFixed(3)}  median ${median.toFixed(3)}  max ${sorted[sorted.length - 1].toFixed(3)}`)
  console.log(`  left a panel sliver (>1% short):  ${slivers.length}`)
  for (const r of slivers) console.log(`     ${r.key}  cut@${r.cutFrac!.toFixed(3)} vs verified ${r.label.panelEndFrac!.toFixed(3)}`)
  console.log(`  cut >5% past the edge (may eat card): ${overshoot.length}`)
  for (const r of overshoot) console.log(`     ${r.key}  cut@${r.cutFrac!.toFixed(3)} vs verified ${r.label.panelEndFrac!.toFixed(3)}`)

  // What a single fixed cut would have done, for comparison — this is the
  // approach being replaced, so the number is worth printing rather than
  // asserting.
  const fixedSlivers = measurable.filter((r) => 0.362 < r.label.panelEndFrac! - 0.01).length
  const fixedOver = measurable.filter((r) => 0.362 > r.label.panelEndFrac! + 0.05).length
  console.log(`  (a fixed 0.362 cut on these same images: ${fixedSlivers} slivers, ${fixedOver} overshoots)`)
}

// ── Confidence flag usefulness ──────────────────────────────────────────────

const unsureRows = rows.filter((r) => r.said && r.confidence === 'unsure')
console.log(`\n--- Flagged 'unsure' (a human must look): ${unsureRows.length} of ${rows.filter((r) => r.said).length} crops offered ---`)

// ── Non-cards ───────────────────────────────────────────────────────────────

const nonCards = rows.filter((r) => (r.label.productType ?? 'card') !== 'card')
if (nonCards.length > 0) {
  console.log(`\n--- Non-cards in corpus (${nonCards.length}) — detector has no opinion on product type ---`)
  for (const r of nonCards) console.log(`  [${r.label.productType}] ${r.key}  detector said panel=${r.said}`)
}

// ── Coverage gaps, stated not hidden ────────────────────────────────────────

if (unlabelled.length > 0) {
  console.log(`\n⚠ ${unlabelled.length} image(s) in the corpus with NO label — excluded from every rate above:`)
  for (const k of unlabelled.slice(0, 20)) console.log(`   ${k}`)
  if (unlabelled.length > 20) console.log(`   … and ${unlabelled.length - 20} more`)
}
if (unreadable.length > 0) {
  console.log(`\n⚠ ${unreadable.length} image(s) could not be decoded: ${unreadable.join(', ')}`)
}

console.log()
if (falseNeg.length > 0) {
  console.log(`FAIL: ${falseNeg.length} missed panel(s). That is the failure that reaches a customer.`)
  process.exit(1)
}
console.log('OK: no missed panels.')
