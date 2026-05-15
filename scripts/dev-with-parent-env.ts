#!/usr/bin/env tsx
//
// scripts/dev-with-parent-env.ts
//
// Launches `vite` with VITE_SUPABASE_* loaded from the parent
// repository's .env. Used only by the cowork worktree to spin up the
// price-list preview harness without copying .env into the worktree
// (which would risk credential leakage via subsequent git ops).
//
// Run via: pnpm dev:with-parent-env

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const PARENT_ENV = '/Users/robrandtoul/proof-viewer/.env'

function readEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {}
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return out
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    const val = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '')
    if (key.startsWith('VITE_')) out[key] = val
  }
  return out
}

const env = { ...process.env, ...readEnv(PARENT_ENV) }
const args = process.argv.slice(2)
const child = spawn('npx', ['vite', ...args], {
  cwd: resolve(process.cwd()),
  env,
  stdio: 'inherit',
})
child.on('exit', (code) => process.exit(code ?? 0))
