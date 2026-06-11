#!/usr/bin/env tsx
//
// Backtest harness for the AI draft pipeline (docs/ai-draft-pipeline-spec.md).
//
// For every fixture in backtest/fixtures/, cut the thread just before the
// first staff reply, run the pipeline as-if at that moment, and diff the
// generated draft against the reply Chris/Rob actually sent. Writes an HTML
// + JSON report to backtest/reports/<timestamp>/.
//
//   pnpm backtest                  full run (needs ANTHROPIC_API_KEY)
//   pnpm backtest -- --limit 5     first 5 fixtures only
//   pnpm backtest -- --only 123    one conversation id
//   pnpm backtest -- --dry-run     no API calls; checks fixtures + grounding

import { config as loadEnv } from 'dotenv'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fetchGrounding } from '../supabase/functions/_shared/aiDrafts/grounding.ts'
import { runPipeline, type PipelineInput } from '../supabase/functions/_shared/aiDrafts/pipeline.ts'
import { normaliseBody } from '../supabase/functions/_shared/aiDrafts/htmlText.ts'
import type { FixtureConversation, PipelineResult, ThreadMessage } from '../supabase/functions/_shared/aiDrafts/types.ts'

loadEnv()

const FIXTURE_DIR = join(import.meta.dirname, '..', 'backtest', 'fixtures')
const REPORT_ROOT = join(import.meta.dirname, '..', 'backtest', 'reports')

// USD per million tokens [input, output] — cost estimate only. Unknown
// models fall back to Opus 4.8 rates and the report says so.
const PRICING: Record<string, [number, number]> = {
  'claude-opus-4-8': [5, 25],
  'claude-opus-4-7': [5, 25],
  'claude-opus-4-6': [5, 25],
  'claude-fable-5': [10, 50],
  'claude-sonnet-4-6': [3, 15],
  'claude-haiku-4-5': [1, 5],
}

interface Args {
  dryRun: boolean
  limit: number | null
  only: string | null
  resume: string | null
}

function parseArgs(): Args {
  const argv = process.argv.slice(2)
  const limitIx = argv.indexOf('--limit')
  const onlyIx = argv.indexOf('--only')
  const resumeIx = argv.indexOf('--resume')
  let limit: number | null = null
  if (limitIx >= 0) {
    const raw = argv[limitIx + 1]
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 1) {
      console.error(`--limit expects a positive integer, got "${raw ?? ''}"`)
      process.exit(1)
    }
    limit = n
  }
  return {
    dryRun: argv.includes('--dry-run'),
    limit,
    only: onlyIx >= 0 ? (argv[onlyIx + 1] ?? null) : null,
    resume: resumeIx >= 0 ? (argv[resumeIx + 1] ?? null) : null,
  }
}

interface BacktestCase {
  fixture: FixtureConversation
  input: PipelineInput
  actualReply: ThreadMessage
}

function loadCases(): { cases: BacktestCase[]; unusable: { file: string; reason: string }[] } {
  let files: string[] = []
  try {
    files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json'))
  } catch {
    console.error(`No fixture directory at ${FIXTURE_DIR} — run the pull workflow first.`)
    process.exit(1)
  }
  const cases: BacktestCase[] = []
  const unusable: { file: string; reason: string }[] = []
  for (const file of files.sort()) {
    let fixture: FixtureConversation
    try {
      fixture = JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf8')) as FixtureConversation
    } catch (err) {
      unusable.push({ file, reason: `unparseable JSON (${(err as Error).message})` })
      continue
    }
    if (!Array.isArray(fixture.thread) || fixture.thread.length === 0) {
      unusable.push({ file, reason: 'empty thread' })
      continue
    }
    const sorted = [...fixture.thread].sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
    )
    // Cut point: the first staff reply that ANSWERS a customer message — i.e.
    // the first staff message with at least one customer message before it.
    // (Threads can open with an outbound staff email; those earlier staff
    // messages become input context, not the reply under test.)
    const firstCustomerIx = sorted.findIndex((m) => m.role === 'customer')
    if (firstCustomerIx === -1) {
      unusable.push({ file, reason: 'no customer message in thread' })
      continue
    }
    const replyIx = sorted.findIndex((m, ix) => ix > firstCustomerIx && m.role === 'staff')
    if (replyIx === -1) {
      unusable.push({ file, reason: 'no staff reply after a customer message' })
      continue
    }
    const inputThread = sorted.slice(0, replyIx)
    cases.push({
      fixture,
      input: {
        conversationId: fixture.conversationId,
        subject: fixture.subject,
        customerFirstName: fixture.customerFirstName,
        thread: inputThread,
      },
      actualReply: sorted[replyIx],
    })
  }
  return { cases, unusable }
}

interface CaseResult {
  conversationId: number
  subject: string
  slice: string
  heuristicCategory: string | null
  customerFirstName: string
  inputThread: { role: string; author: string; body: string }[]
  actualReply: string
  pipeline: PipelineResult | null
  error: string | null
}

async function main(): Promise<void> {
  const args = parseArgs()
  let { cases, unusable } = loadCases()
  if (args.only) cases = cases.filter((c) => String(c.fixture.conversationId) === args.only)
  if (args.limit) cases = cases.slice(0, args.limit)

  console.log(`Fixtures usable: ${cases.length}, unusable: ${unusable.length}`)
  for (const u of unusable) console.log(`  skip ${u.file}: ${u.reason}`)
  if (cases.length === 0) process.exit(1)

  console.log('Fetching grounding (live pricing + lead times)...')
  const grounding = await fetchGrounding()
  console.log(
    `Grounded: ${grounding.byCurrency.GBP.length} materials, ${grounding.figures.length} figures, ${grounding.leadTimes.length} lead times`,
  )

  if (args.dryRun) {
    for (const c of cases) {
      const preview = normaliseBody(c.input.thread.find((m) => m.role === 'customer')?.body ?? '').slice(0, 120)
      console.log(
        `DRY ${c.fixture.conversationId} [${c.fixture.slice}] ${c.fixture.heuristicCategory ?? '?'} — "${c.fixture.subject}" — ${preview.replace(/\n/g, ' ')}`,
      )
    }
    console.log(`\nDry run complete: ${cases.length} cases ready. Set ANTHROPIC_API_KEY and run without --dry-run.`)
    return
  }

  // --resume <reportDir>: continue an interrupted run in place, re-running
  // only cases that have no saved result (or errored).
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const reportDir = args.resume ?? join(REPORT_ROOT, stamp)
  mkdirSync(reportDir, { recursive: true })
  let results: CaseResult[] = []
  if (args.resume) {
    try {
      const saved = JSON.parse(readFileSync(join(reportDir, 'results.json'), 'utf8')) as CaseResult[]
      results = saved.filter((r) => r.error === null)
      const done = new Set(results.map((r) => r.conversationId))
      cases = cases.filter((c) => !done.has(c.fixture.conversationId))
      console.log(`Resuming: ${results.length} saved results, ${cases.length} cases left`)
    } catch {
      console.error(`--resume: no readable results.json in ${reportDir}`)
      process.exit(1)
    }
  }

  let totalIn = results.reduce((n, r) => n + (r.pipeline?.usage.inputTokens ?? 0), 0)
  let totalOut = results.reduce((n, r) => n + (r.pipeline?.usage.outputTokens ?? 0), 0)
  let totalCacheWrite = results.reduce((n, r) => n + (r.pipeline?.usage.cacheWriteTokens ?? 0), 0)
  let totalCacheRead = results.reduce((n, r) => n + (r.pipeline?.usage.cacheReadTokens ?? 0), 0)

  for (const [i, c] of cases.entries()) {
    process.stdout.write(`[${i + 1}/${cases.length}] ${c.fixture.conversationId} "${c.fixture.subject.slice(0, 50)}" ... `)
    // Everything per-case — including body normalisation — stays inside the
    // try so one malformed fixture becomes an error row, not a dead run.
    try {
      const base = {
        conversationId: c.fixture.conversationId,
        subject: c.fixture.subject,
        slice: c.fixture.slice,
        heuristicCategory: (c.fixture.heuristicCategory as string | null) ?? null,
        customerFirstName: c.fixture.customerFirstName,
        inputThread: c.input.thread.map((m) => ({ role: m.role, author: m.author, body: normaliseBody(m.body) })),
        actualReply: normaliseBody(c.actualReply.body),
      }
      try {
        const pipeline = await runPipeline(c.input, grounding)
        totalIn += pipeline.usage.inputTokens
        totalOut += pipeline.usage.outputTokens
        totalCacheWrite += pipeline.usage.cacheWriteTokens
        totalCacheRead += pipeline.usage.cacheReadTokens
        results.push({ ...base, pipeline, error: null })
        console.log(`${pipeline.outcome} (${pipeline.classification.category}/${pipeline.classification.confidence})`)
      } catch (err) {
        results.push({ ...base, pipeline: null, error: (err as Error).message })
        console.log(`ERROR ${(err as Error).message}`)
      }
    } catch (err) {
      results.push({
        conversationId: c.fixture.conversationId,
        subject: String(c.fixture.subject ?? ''),
        slice: String(c.fixture.slice ?? '?'),
        heuristicCategory: null,
        customerFirstName: '',
        inputThread: [],
        actualReply: '',
        pipeline: null,
        error: `fixture preparation failed: ${(err as Error).message}`,
      })
      console.log(`ERROR (fixture) ${(err as Error).message}`)
    }
    // Checkpoint every 10 so a crash keeps partial results.
    if ((i + 1) % 10 === 0 || i === cases.length - 1) {
      writeFileSync(join(reportDir, 'results.json'), JSON.stringify(results, null, 2))
    }
  }

  const model = process.env.AI_DRAFT_MODEL || 'claude-opus-4-8'
  const [inRate, outRate] = PRICING[model] ?? PRICING['claude-opus-4-8']
  const pricingNote = PRICING[model] ? model : `unknown model ${model} — Opus 4.8 rates assumed`
  // Cache reads bill ~0.1x input; cache writes ~1.25x input.
  const costUsd =
    (totalIn / 1e6) * inRate +
    (totalOut / 1e6) * outRate +
    (totalCacheRead / 1e6) * inRate * 0.1 +
    (totalCacheWrite / 1e6) * inRate * 1.25
  writeFileSync(join(reportDir, 'results.json'), JSON.stringify(results, null, 2))
  writeFileSync(join(reportDir, 'report.html'), buildHtmlReport(results, costUsd, pricingNote))

  const tally = new Map<string, number>()
  for (const r of results) {
    const key = r.error ? 'error' : r.pipeline!.outcome
    tally.set(key, (tally.get(key) ?? 0) + 1)
  }
  console.log('\n── Summary ──')
  for (const [k, v] of [...tally.entries()].sort()) console.log(`  ${k}: ${v}`)
  console.log(`  tokens: ${totalIn.toLocaleString()} in / ${totalOut.toLocaleString()} out · cache ${totalCacheRead.toLocaleString()} read / ${totalCacheWrite.toLocaleString()} write (≈ $${costUsd.toFixed(2)} at ${pricingNote} rates)`)
  console.log(`\nReport: ${join(reportDir, 'report.html')}`)
}

// ── HTML report ──────────────────────────────────────────────────────────────

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function pre(text: string): string {
  return `<pre>${esc(text)}</pre>`
}

function buildHtmlReport(results: CaseResult[], costUsd: number, pricingNote: string): string {
  const byCategory = new Map<string, CaseResult[]>()
  for (const r of results) {
    const cat = r.pipeline?.classification.category ?? 'error'
    if (!byCategory.has(cat)) byCategory.set(cat, [])
    byCategory.get(cat)!.push(r)
  }

  const summaryRows = [...byCategory.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([cat, rows]) => {
      const outcomes = new Map<string, number>()
      for (const r of rows) {
        const key = r.error ? 'error' : r.pipeline!.outcome
        outcomes.set(key, (outcomes.get(key) ?? 0) + 1)
      }
      const cells = ['drafted', 'abstained', 'blocked', 'skipped', 'error']
        .map((o) => `<td>${outcomes.get(o) ?? 0}</td>`)
        .join('')
      return `<tr><td>${esc(cat)}</td><td>${rows.length}</td>${cells}</tr>`
    })
    .join('\n')

  const cards = results
    .map((r) => {
      const p = r.pipeline
      const header = `#${r.conversationId} — ${esc(r.subject)} <span class="meta">[${esc(r.slice)}] pull-guess: ${esc(r.heuristicCategory ?? '?')}</span>`
      const inputHtml = r.inputThread
        .map((m) => `<div class="msg"><span class="who">${esc(m.author)} (${esc(m.role)})</span>${pre(m.body)}</div>`)
        .join('')
      if (!p) {
        return `<details class="card error"><summary>${header} — ERROR</summary>${inputHtml}<p class="reason">${esc(r.error ?? '')}</p></details>`
      }
      const klass = p.outcome
      const badge = `${p.outcome.toUpperCase()} · ${p.classification.category}/${p.classification.confidence}`
      const draftHtml = p.draft?.draft_body
        ? `<div class="col"><h4>AI draft</h4>${pre(p.draft.draft_body)}</div>`
        : `<div class="col"><h4>AI draft</h4><p class="reason">${esc(p.abstainOrBlockReason ?? 'no draft')}</p></div>`
      const noteWarn = p.noteWarnings.length
        ? `<p class="reason">Unvalidated in note: ${p.noteWarnings.map(esc).join('; ')}</p>`
        : ''
      const noteHtml = p.draft?.note_body
        ? `<h4>Internal note (working — figures/links unvalidated)</h4>${pre(p.draft.note_body)}${noteWarn}`
        : ''
      const guardHtml =
        p.guardrails && !p.guardrails.ok
          ? `<h4>Guardrail block</h4><ul>${p.guardrails.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`
          : ''
      return `<details class="card ${klass}"><summary>${header} — <b>${badge}</b></summary>
<h4>Customer wrote</h4>${inputHtml}
<div class="cols">${draftHtml}<div class="col"><h4>Actually sent</h4>${pre(r.actualReply)}</div></div>
${noteHtml}${guardHtml}
<p class="meta">summary: ${esc(p.classification.summary)} · currency hint: ${esc(p.classification.currency_hint)} · tokens ${p.usage.inputTokens}/${p.usage.outputTokens}</p>
</details>`
    })
    .join('\n')

  return `<!doctype html><html><head><meta charset="utf-8"><title>AI draft backtest</title>
<style>
body{font-family:-apple-system,Segoe UI,sans-serif;margin:2rem auto;max-width:1100px;padding:0 1rem;color:#1a1a1a}
table{border-collapse:collapse;margin:1rem 0}td,th{border:1px solid #ccc;padding:.35rem .7rem;text-align:left}
.card{border:1px solid #ddd;border-radius:8px;margin:.6rem 0;padding:.4rem .8rem;background:#fafafa}
.card.drafted{border-left:5px solid #2e7d32}.card.abstained{border-left:5px solid #9e9e9e}
.card.blocked{border-left:5px solid #e65100}.card.skipped{border-left:5px solid #bdbdbd}.card.error{border-left:5px solid #b71c1c}
summary{cursor:pointer;font-weight:600;padding:.3rem 0}
pre{white-space:pre-wrap;background:#fff;border:1px solid #eee;border-radius:6px;padding:.6rem;font-family:inherit;font-size:.92rem}
.cols{display:flex;gap:1rem}.col{flex:1;min-width:0}
.msg .who{font-size:.8rem;color:#666}.meta{color:#777;font-size:.85rem;font-weight:400}
.reason{color:#a33;font-style:italic}h4{margin:.7rem 0 .2rem}
</style></head><body>
<h1>AI draft backtest</h1>
<p>${results.length} conversations · estimated API cost $${costUsd.toFixed(2)} (${esc(pricingNote)}) ·
green = drafted &amp; passed guardrails, grey = abstained (often correct behaviour), orange = guardrail blocked, red = pipeline error.</p>
<table><tr><th>category</th><th>n</th><th>drafted</th><th>abstained</th><th>blocked</th><th>skipped</th><th>error</th></tr>
${summaryRows}</table>
<p><b>How to review:</b> open each card, read the customer email, then judge: "would I have sent the AI draft (left), compared with what we actually sent (right)?" Note anything wrong or off-voice — those observations become house-rule/exemplar edits for the next cycle.</p>
${cards}
</body></html>`
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
