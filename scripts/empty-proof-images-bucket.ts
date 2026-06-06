#!/usr/bin/env tsx
//
// scripts/empty-proof-images-bucket.ts
//
// ⚠️  ONE-TIME, DESTRUCTIVE, GO-LIVE STORAGE SCRUB.  ⚠️
//
// Empties the `proof-images` storage bucket — every uploaded proof artwork
// (JPEG) and every generated hosted-vCard QR (SVG). This is the storage half
// of the go-live scrub; the database half is scripts/scrub-test-data.sql.
// Run AFTER the SQL scrub (or before — order doesn't matter; the whole bucket
// is test data either way).
//
// Why a script and not just `DELETE FROM storage.objects`: deleting the
// metadata rows in SQL leaves the physical files orphaned in the storage
// backend. Going through the Storage API removes both the object and the file.
//
// Touches ONLY `proof-images`. The `avatars` (designer photos) and
// `material-icons` (catalogue icons) buckets are separate and untouched.
//
// Echoes the project URL and asks for an explicit "yes" before deleting, so
// the operator can sanity-check they're not pointed at the wrong project.
//
// SIMPLER FALLBACK (no Terminal): Supabase Dashboard → Storage → proof-images
// → select all of the proof-id folders at the root → Delete. Same result.
//
// Required env (read from .env via dotenv — same as clean-test-fixtures.ts):
//   VITE_SUPABASE_URL           — same project URL as the app
//   SUPABASE_SERVICE_ROLE_KEY   — admin key (Dashboard → Project Settings →
//                                 API). Never commit it.
//
// Run via: pnpm db:empty-proof-images   (or: npx tsx scripts/empty-proof-images-bucket.ts)

import { createClient } from '@supabase/supabase-js'
import { config as loadEnv } from 'dotenv'
import { createInterface } from 'node:readline'

loadEnv()

const BUCKET = 'proof-images'
const PAGE_SIZE = 1000
const REMOVE_BATCH = 1000

const url = process.env.VITE_SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !serviceKey) {
  console.error(
    'Missing env. The script needs VITE_SUPABASE_URL and ' +
      'SUPABASE_SERVICE_ROLE_KEY in .env. The service-role key is in the ' +
      'Supabase dashboard under Project Settings → API.',
  )
  process.exit(1)
}

const sb = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

// Recursively collect every object path under a prefix. Storage `.list()`
// returns one level at a time: folder entries come back with a null `id`,
// real files have a non-null `id`. The proof-images convention is
// `{proof_id}/{uuid}.jpg|.svg` (one level), but the recursion is general so
// any nesting is still swept.
async function listAllPaths(prefix: string): Promise<string[]> {
  const out: string[] = []
  let offset = 0
  for (;;) {
    const { data, error } = await sb.storage.from(BUCKET).list(prefix, {
      limit: PAGE_SIZE,
      offset,
      sortBy: { column: 'name', order: 'asc' },
    })
    if (error) throw error
    const entries = data ?? []
    for (const e of entries) {
      const path = prefix ? `${prefix}/${e.name}` : e.name
      if (e.id === null) {
        // Folder — recurse into it.
        out.push(...(await listAllPaths(path)))
      } else {
        out.push(path)
      }
    }
    if (entries.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }
  return out
}

async function main() {
  console.log('')
  console.log(`Project URL: ${url}`)
  console.log(`Bucket:      ${BUCKET}`)
  console.log('')

  console.log('Scanning bucket…')
  const paths = await listAllPaths('')
  if (paths.length === 0) {
    console.log('Bucket is already empty. Nothing to do.')
    return
  }

  console.log(`Found ${paths.length} object(s) to delete. A few examples:`)
  for (const p of paths.slice(0, 5)) console.log(`  ${p}`)
  if (paths.length > 5) console.log(`  …and ${paths.length - 5} more.`)
  console.log('')

  const answer = await prompt(`Type "yes" to permanently delete all ${paths.length} object(s): `)
  if (answer.trim().toLowerCase() !== 'yes') {
    console.log('Aborted.')
    return
  }

  // Remove in batches.
  let removed = 0
  for (let i = 0; i < paths.length; i += REMOVE_BATCH) {
    const batch = paths.slice(i, i + REMOVE_BATCH)
    const { error } = await sb.storage.from(BUCKET).remove(batch)
    if (error) throw error
    removed += batch.length
    console.log(`Removed ${removed}/${paths.length}…`)
  }

  // Verify.
  const remaining = await listAllPaths('')
  console.log('')
  if (remaining.length === 0) {
    console.log(`Done. ${BUCKET} is now empty.`)
  } else {
    console.warn(
      `Warning: ${remaining.length} object(s) still present after deletion. ` +
        `Re-run the script, or clear them from the Dashboard.`,
    )
  }
}

function prompt(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) =>
    rl.question(q, (ans) => {
      rl.close()
      resolve(ans)
    }),
  )
}

main().catch((err) => {
  console.error('Failed:', err)
  process.exit(1)
})
