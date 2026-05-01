#!/usr/bin/env tsx
//
// scripts/db-push-confirm.ts
//
// Push pending migrations to the linked Supabase project, with an
// explicit "yes" confirmation step before any state change.
//
// Sequence:
//   1. List local-only migrations via `supabase migration list
//      --linked`.
//   2. If zero pending, exit cleanly — nothing to push.
//   3. If MORE than one pending, bail out. The project mixes
//      000NNN_… and 20260419000NNN_… naming conventions; multiple
//      pending may indicate drift between local and remote state.
//      Pushing blindly is unsafe — the operator should investigate
//      before bypassing the safety net (with a direct
//      `npx supabase db push --include-all`, which the script is
//      explicitly NOT replicating in that case).
//   4. Print the project URL + the pending migration name. Prompt
//      for "yes".
//   5. If confirmed, run `supabase db push --include-all --yes`.
//      The CLI's own prompt is bypassed via --yes (we already got
//      explicit confirmation in step 4).
//   6. Re-run the list. Confirm the migration is now on both sides
//      and exit clean; if the list still shows local-only entries
//      after a successful-looking push, surface that as an error.
//
// Run via: pnpm db:push:confirm

import { spawnSync } from 'node:child_process'
import { config as loadEnv } from 'dotenv'
import { createInterface } from 'node:readline'

loadEnv()

const url = process.env.VITE_SUPABASE_URL ?? ''

interface Row {
  local: string
  remote: string
  time: string
}

function parseMigrationList(stdout: string): Row[] {
  const rows: Row[] = []
  for (const raw of stdout.split('\n')) {
    if (!raw.includes('|')) continue
    if (raw.includes('---')) continue
    if (raw.includes('Local') && raw.includes('Remote')) continue
    const cells = raw.split('|').map((c) => c.trim())
    if (cells.length < 3) continue
    const [local, remote, time] = cells
    if (!local && !remote) continue
    rows.push({ local, remote, time })
  }
  return rows
}

function listLocalOnly(): Row[] {
  const result = spawnSync(
    'npx',
    ['supabase', 'migration', 'list', '--linked'],
    { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  if (result.status !== 0) {
    console.error('supabase migration list failed:')
    if (result.stderr) console.error(result.stderr)
    process.exit(result.status ?? 1)
  }
  return parseMigrationList(result.stdout).filter(
    (r) => r.local && !r.remote,
  )
}

function prompt(q: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  return new Promise((resolve) =>
    rl.question(q, (ans) => {
      rl.close()
      resolve(ans)
    }),
  )
}

async function main() {
  console.log('')
  if (url) console.log(`Project URL: ${url}`)
  console.log('')

  // Step 1 + 2: list pending.
  const pending = listLocalOnly()
  if (pending.length === 0) {
    console.log('No local-only migrations. Nothing to push.')
    console.log('')
    return
  }

  // Step 3: bail-on-multiple.
  if (pending.length > 1) {
    console.error(
      `Refusing to push: ${pending.length} migrations are local-only.`,
    )
    console.error('')
    console.error('Pending:')
    for (const row of pending) console.error(`  ${row.local}`)
    console.error('')
    console.error(
      'The project mixes 000NNN_… and 20260419000NNN_… naming; ' +
        'multiple pending may indicate drift between local and remote ' +
        'state. Investigate before pushing.',
    )
    console.error('')
    console.error(
      'If you intentionally want to push all of them, run ' +
        '`npx supabase db push --include-all` directly (this script ' +
        'is the safety net you would be bypassing).',
    )
    process.exit(1)
  }

  // Step 4: prompt.
  const [pendingRow] = pending
  console.log('1 migration pending:')
  console.log('')
  console.log(`  ${pendingRow.local}`)
  console.log('')
  const answer = await prompt('Type "yes" to push: ')
  if (answer.trim().toLowerCase() !== 'yes') {
    console.log('Aborted.')
    return
  }

  // Step 5: push (CLI's own prompt bypassed via --yes; explicit-yes
  // already taken above).
  console.log('')
  console.log('Pushing…')
  const push = spawnSync(
    'npx',
    ['supabase', 'db', 'push', '--include-all', '--yes'],
    { encoding: 'utf-8', stdio: 'inherit' },
  )
  if (push.status !== 0) {
    console.error('')
    console.error(`Push failed (exit ${push.status}).`)
    process.exit(push.status ?? 1)
  }

  // Step 6: re-verify.
  console.log('')
  console.log('Verifying…')
  const stillPending = listLocalOnly()
  if (stillPending.length === 0) {
    console.log(
      `${pendingRow.local} now applied on both sides. Done.`,
    )
    console.log('')
    return
  }
  console.error('')
  console.error(
    'Push reported success but the migration list still shows ' +
      'local-only entries:',
  )
  for (const row of stillPending) console.error(`  ${row.local}`)
  console.error('')
  console.error('Investigate before assuming the push completed.')
  process.exit(1)
}

main().catch((err) => {
  console.error('Failed:', err)
  process.exit(1)
})
