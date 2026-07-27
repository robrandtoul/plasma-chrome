// Offline batch runner for the cut-through dropout check.
//
// Nothing here touches the live check, the edge function or a customer. It
// points the detector at print files already on disk and prints what it would
// have said, so the rule can be earned against real orders the way every other
// artwork-check rule was — a predicted outcome, then a confirmed split.
//
// Usage:
//   pnpm check:cut-through <dir>                 # every card in a folder
//   pnpm check:cut-through <dir> --json          # machine-readable
//   pnpm check:cut-through <front.ai> <back.ai>  # one explicit pair
//
// Pairing: files are grouped by their leading order/version token and split
// front vs back on the filename, because the studio's own naming is not
// consistent (02_Front_BM.ai / 02_GianpaoloFrigo_BM.ai, 11_..._Front.ai /
// 10_..._Back.ai — the numbers differ between sides). Anything that cannot be
// paired is reported as uncheckable rather than quietly skipped.

import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import {
  analyseFace,
  describeFace,
  pairPrintFiles,
  parseFace,
  type FaceResult,
  type ParsedFace,
} from '../supabase/functions/_shared/artworkCheck/cutThrough.ts'

interface Card {
  label: string
  frontPath: string
  backPath: string | null
}

/** Group one folder's print files into faces plus the opposite side. */
function pairFiles(names: string[]): Card[] {
  return pairPrintFiles(names).map((p) => ({
    label: basename(p.face),
    frontPath: p.face,
    backPath: p.opposite,
  }))
}

const cache = new Map<string, ParsedFace | null>()
async function load(path: string): Promise<ParsedFace | null> {
  if (cache.has(path)) return cache.get(path) ?? null
  let parsed: ParsedFace | null = null
  try {
    const bytes = new Uint8Array(await readFile(path))
    parsed = await parseFace(bytes)
  } catch {
    parsed = null
  }
  cache.set(path, parsed)
  return parsed
}

async function checkCard(card: Card): Promise<FaceResult> {
  const front = await load(card.frontPath)
  if (!front) {
    return {
      status: 'cannot_check',
      islands: [],
      reason: 'could not read the artwork out of this file',
      cutRegions: 0,
      printedWhiteRegions: 0,
      cardWidthPt: 0,
      cardHeightPt: 0,
    }
  }
  const back = card.backPath ? await load(card.backPath) : null
  // Distinguish "no other side exists" from "the other side would not read" —
  // they need different action from whoever reviews the result.
  const oppositeMissingReason = card.backPath && !back
    ? `the artwork for the other side (${basename(card.backPath)}) could not be read`
    : undefined
  return analyseFace(front, back, { oppositeMissingReason })
}

async function collect(target: string): Promise<{ dir: string; cards: Card[] }[]> {
  const st = await stat(target)
  if (!st.isDirectory()) return []
  const entries = await readdir(target, { withFileTypes: true })
  const files = entries.filter((e) => e.isFile()).map((e) => join(target, e.name))
  const subdirs = entries.filter((e) => e.isDirectory()).map((e) => join(target, e.name))
  const out: { dir: string; cards: Card[] }[] = []
  if (files.some((f) => /\.(ai|pdf)$/i.test(f))) out.push({ dir: target, cards: pairFiles(files) })
  for (const d of subdirs) out.push(...(await collect(d)))
  return out
}

async function main() {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  const paths = args.filter((a) => !a.startsWith('--'))
  if (!paths.length) {
    console.error('usage: pnpm check:cut-through <dir | front.ai back.ai> [--json]')
    process.exit(2)
  }

  let groups: { dir: string; cards: Card[] }[]
  if (paths.length === 2 && (await stat(paths[0])).isFile()) {
    groups = [{
      dir: '.',
      cards: [
        { label: basename(paths[0]), frontPath: resolve(paths[0]), backPath: resolve(paths[1]) },
        { label: basename(paths[1]), frontPath: resolve(paths[1]), backPath: resolve(paths[0]) },
      ],
    }]
  } else {
    groups = []
    for (const p of paths) groups.push(...(await collect(resolve(p))))
  }

  const tally = { clean: 0, dropout: 0, possible_dropout: 0, no_cut_artwork: 0, cannot_check: 0 }
  const rows: Record<string, unknown>[] = []

  for (const g of groups) {
    if (!json) console.log(`\n${g.dir}`)
    for (const card of g.cards) {
      const result = await checkCard(card)
      tally[result.status]++
      rows.push({ dir: g.dir, card: card.label, ...result })
      if (!json) {
        const mark = result.status === 'dropout'
          ? '  ✗'
          : result.status === 'possible_dropout'
            ? '  !'
            : result.status === 'cannot_check'
              ? '  ?'
              : '  ·'
        console.log(mark, describeFace(card.label, result))
      }
    }
  }

  if (json) {
    console.log(JSON.stringify({ tally, rows }, null, 2))
  } else {
    console.log(
      `\n${rows.length} cards: ${tally.dropout} with a loose piece, ${tally.possible_dropout} possibly loose ` +
        `(one side only), ${tally.clean} clean, ${tally.no_cut_artwork} with nothing cut, ` +
        `${tally.cannot_check} not checkable.`,
    )
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
