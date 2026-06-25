// Unit tests for auditFilters.ts
// Run with: npx tsx src/pages/admin/auditFilters.test.ts
//
// The critical guard here is the taxonomy-coverage scan: every audit
// action code emitted from src/ via `action: '<code>'` literals must
// appear in ACTION_LABELS. Without this gate, new emit sites ship
// without a human-readable label and fall through to the raw code in
// the admin Activity page dropdown (PV-2026W21-041).
//
// The same scan runs for `targetType: '<code>'` literals against
// TARGET_TYPE_OPTIONS, so a new target type can't ship without a
// filterable dropdown entry either (PV-2026W22-081).
//
// Codes built from variables, ternaries, or lookup maps can't be
// extracted statically — those are audited by hand whenever new ones
// land. This test catches the easy 95% case: a plain string literal
// next to `action:` / `targetType:` inside a logAudit({ ... }) call.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ACTION_LABELS, TARGET_TYPE_OPTIONS } from './auditFilters.ts'

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

// Capture the argument text of every `logAudit(...)` call, tracking paren
// depth (and skipping string contents, so a stray `(`/`)` inside a label or
// reason can't unbalance the scan) so a multi-line call is grabbed whole.
// All audit writes in src/ go through logAudit; scoping extraction to these
// calls is what stops a non-audit `action:` key — e.g. an edge-function invoke
// body `{ action: 'run' }` or `{ action: 'cancel' }` — from being mistaken for
// an audit action code (the original whole-file scan flagged exactly those).
function extractLogAuditCalls(body: string): string[] {
  const calls: string[] = []
  const NEEDLE = 'logAudit('
  let idx = 0
  while ((idx = body.indexOf(NEEDLE, idx)) !== -1) {
    let i = idx + NEEDLE.length - 1 // sits on the opening '('
    const start = i
    let depth = 0
    let quote: string | null = null
    for (; i < body.length; i++) {
      const ch = body[i]
      if (quote) {
        if (ch === '\\') { i++; continue } // skip the escaped char
        if (ch === quote) quote = null
        continue
      }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue }
      if (ch === '(') depth++
      else if (ch === ')') { depth--; if (depth === 0) { i++; break } }
    }
    calls.push(body.slice(start, i))
    idx = Math.max(i, idx + NEEDLE.length)
  }
  return calls
}

function collectKeyLiteralsFromSrc(key: 'action' | 'targetType'): Set<string> {
  // Resolve src/ relative to this test file so the script is robust
  // to where it's launched from.
  const here = new URL(import.meta.url).pathname
  // here = .../src/pages/admin/auditFilters.test.ts -> go up three.
  const srcDir = join(here, '..', '..', '..')
  const files = walk(srcDir)
  const codes = new Set<string>()
  // Match `<key>: 'code'` or `<key>: "code"` WITHIN a logAudit(...) call.
  // Dynamic codes (variables / ternaries) can't be extracted statically and
  // are audited by hand, per the file header.
  const re = new RegExp(`${key}:\\s*['"]([a-zA-Z0-9_.]+)['"]`, 'g')
  for (const f of files) {
    // Skip self to avoid the test's own literals.
    if (f.endsWith('auditFilters.test.ts')) continue
    const body = readFileSync(f, 'utf8')
    for (const call of extractLogAuditCalls(body)) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(call)) !== null) {
        codes.add(m[1])
      }
    }
  }
  return codes
}

console.log('\nauditFilters taxonomy coverage')

test('every action code literal emitted from src/ appears in ACTION_LABELS', () => {
  const emitted = collectKeyLiteralsFromSrc('action')
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

test('every target type literal emitted from src/ appears in TARGET_TYPE_OPTIONS', () => {
  const known = new Set(TARGET_TYPE_OPTIONS.map((o) => o.code))
  const emitted = collectKeyLiteralsFromSrc('targetType')
  const missing: string[] = []
  for (const code of emitted) {
    if (!known.has(code)) missing.push(code)
  }
  if (missing.length > 0) {
    throw new Error(
      `${missing.length} target type(s) emitted from src/ but absent from TARGET_TYPE_OPTIONS:\n  ${missing.sort().join('\n  ')}\n\n` +
        'Add an entry to src/pages/admin/auditFilters.ts TARGET_TYPE_OPTIONS.',
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
