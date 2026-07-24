#!/usr/bin/env tsx
//
// scripts/run-tests.ts
//
// Runs EVERY unit test in the repo, discovered from disk rather than from a
// hand-maintained list.
//
// Why discovery and not another `pnpm test:*` entry per file: the per-file
// scripts drifted. A bug hunt on 2026-07-24 found nine `*.test.ts` files with
// no script pointing at them, so nothing had run them since they were written
// — and two were failing. The Admin → Activity taxonomy guard was one of them,
// which is precisely why 24 audit action codes had gone missing from the
// filter dropdowns unnoticed. A list you must remember to update is a list
// that goes stale; walking the tree can't.
//
// The individual `pnpm test:<name>` scripts stay — they're the fast loop while
// working on one area. This is the "is everything green?" sweep.
//
// Run via: pnpm test

import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..')

// Roots to sweep. Anything matching *.test.ts / *.test.tsx under these is run.
const ROOTS = ['src', 'supabase/functions', 'scripts']

// Tests that genuinely cannot run under plain tsx, with the reason. Kept
// explicit and PRINTED on every run — a silent skip is how the orphaned
// tests hid in the first place.
const CANNOT_RUN_HEADLESS: Record<string, string> = {
  'src/lib/qrCodes.test.ts':
    'imports the zxing-wasm binary through Vite\'s `?url` asset handling, which only resolves in a Vite/browser build',
}

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.claude'])

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out // a root that doesn't exist is not an error
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.test\.tsx?$/.test(full)) out.push(full)
  }
  return out
}

const found = ROOTS.flatMap((r) => walk(join(repoRoot, r)))
  .map((f) => relative(repoRoot, f))
  .sort()

const skipped = found.filter((f) => f in CANNOT_RUN_HEADLESS)
const toRun = found.filter((f) => !(f in CANNOT_RUN_HEADLESS))

console.log(`Running ${toRun.length} test file(s)\n`)

const failures: string[] = []
for (const file of toRun) {
  const result = spawnSync('tsx', [file], { cwd: repoRoot, encoding: 'utf8' })
  const ok = result.status === 0
  console.log(`${ok ? '✓' : '✗'} ${file}`)
  if (!ok) {
    failures.push(file)
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trimEnd()
    if (output) console.log(output.split('\n').map((l) => `    ${l}`).join('\n'))
  }
}

if (skipped.length > 0) {
  console.log(`\nSkipped (cannot run headless):`)
  for (const f of skipped) console.log(`  - ${f}: ${CANNOT_RUN_HEADLESS[f]}`)
}

console.log(
  `\n${toRun.length - failures.length}/${toRun.length} passed` +
    (failures.length > 0 ? `, ${failures.length} failed` : ''),
)
process.exit(failures.length > 0 ? 1 : 0)
