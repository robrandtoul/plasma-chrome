// Unit tests for auditFilters.ts
// Run with: npx tsx src/pages/admin/auditFilters.test.ts
//
// The critical guard here is the taxonomy-coverage scan: every audit
// action code emitted from src/ via `action: '<code>'` literals must
// appear in ACTION_LABELS. Without this gate, new emit sites ship
// without a human-readable label and fall through to the raw code in
// the admin Activity page dropdown (PV-2026W21-041).
//
// Codes built from variables, ternaries, or lookup maps can't be
// extracted statically — those are audited by hand whenever new ones
// land. This test catches the easy 95% case: a plain string literal
// next to `action:` inside a logAudit({ ... }) call.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ACTION_LABELS } from './auditFilters.ts'

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

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const s = statSync(full)
    if (s.isDirectory()) {
      walk(full, out)
    } else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
      out.push(full)
    }
  }
  return out
}

function collectActionLiteralsFromSrc(): Set<string> {
  // Resolve src/ relative to this test file so the script is robust
  // to where it's launched from.
  const here = new URL(import.meta.url).pathname
  // here = .../src/pages/admin/auditFilters.test.ts -> go up three.
  const srcDir = join(here, '..', '..', '..')
  const files = walk(srcDir)
  const codes = new Set<string>()
  // Match action: 'code'  or  action: "code". Single-line literals
  // only; intentional, since multi-line / template-literal action
  // codes are vanishingly rare and would just be false-positive
  // pollution.
  const re = /action:\s*['"]([a-zA-Z0-9_.]+)['"]/g
  for (const f of files) {
    // Skip self to avoid the test's own literals.
    if (f.endsWith('auditFilters.test.ts')) continue
    const body = readFileSync(f, 'utf8')
    let m: RegExpExecArray | null
    while ((m = re.exec(body)) !== null) {
      codes.add(m[1])
    }
  }
  return codes
}

console.log('\nauditFilters taxonomy coverage')

test('every action code literal emitted from src/ appears in ACTION_LABELS', () => {
  const emitted = collectActionLiteralsFromSrc()
  const missing: string[] = []
  for (const code of emitted) {
    if (!(code in ACTION_LABELS)) missing.push(code)
  }
  if (missing.length > 0) {
    throw new Error(
      `${missing.length} code(s) emitted from src/ but absent from ACTION_LABELS:\n  ${missing.sort().join('\n  ')}\n\n` +
        'Add an entry under the appropriate group in src/pages/admin/auditFilters.ts ACTION_GROUPS.',
    )
  }
})

test('ACTION_LABELS has no empty values', () => {
  const blanks: string[] = []
  for (const [code, label] of Object.entries(ACTION_LABELS)) {
    if (!label || !label.trim()) blanks.push(code)
  }
  if (blanks.length > 0) {
    throw new Error(`Empty labels for: ${blanks.join(', ')}`)
  }
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
