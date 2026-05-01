#!/usr/bin/env tsx
//
// scripts/db-diff.ts
//
// Read-only dry-run check before pushing migrations. Lists every
// migration whose file exists in supabase/migrations/ but hasn't
// been applied to the linked Supabase project.
//
// Wraps `npx supabase migration list --linked` and parses its
// table output. Prints just the local-only rows (the actionable
// signal); reports "in sync" when there's nothing pending.
//
// Run via: pnpm db:diff
//
// This is the "look before you leap" half of the dry-run reflex
// added in Option B (lightweight dev/prod isolation). Its
// counterpart, pnpm db:push:confirm, runs this same parse + a
// confirmation prompt before issuing the push.
//
// Required env (read from .env via dotenv):
//   VITE_SUPABASE_URL              — printed at the top so the
//                                    operator can sanity-check
//                                    they're not pointing at the
//                                    wrong project. Read-only or
//                                    not, "you're about to act on
//                                    project X" catches the rare
//                                    misconfig.

import { spawnSync } from 'node:child_process'
import { config as loadEnv } from 'dotenv'

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

function main() {
  console.log('')
  if (url) console.log(`Project URL: ${url}`)
  console.log('')
  console.log('Checking migration state vs the linked Supabase project…')
  console.log('')

  const pending = listLocalOnly()

  if (pending.length === 0) {
    console.log('No local-only migrations. Local and remote are in sync.')
    console.log('')
    return
  }

  console.log(
    `${pending.length} migration${pending.length === 1 ? '' : 's'} pending:`,
  )
  console.log('')
  for (const row of pending) {
    console.log(`  ${row.local}`)
  }
  console.log('')
  console.log(
    'To apply: pnpm db:push:confirm (with explicit-yes confirmation).',
  )
  console.log('')
}

main()
