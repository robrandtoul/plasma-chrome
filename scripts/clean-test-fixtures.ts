#!/usr/bin/env tsx
//
// scripts/clean-test-fixtures.ts
//
// Hard-deletes every contact flagged as is_test_fixture=true, plus
// its proofs (cascading through versions / images / approvals /
// events / views via the existing FK chain) and any referenced
// storage objects.
//
// Asks for explicit "yes" confirmation after listing what will be
// deleted, and prints the Supabase project URL it's about to act on
// so the operator can sanity-check they're not pointing at the
// wrong project.
//
// FK cascade audit (verified before this script was written):
//
//   contacts → proofs                ON DELETE RESTRICT  ← blocks
//   proofs → proof_versions          ON DELETE CASCADE
//   proof_versions → images          ON DELETE CASCADE
//   proof_versions → approvals       ON DELETE CASCADE
//   proof_versions → events          ON DELETE CASCADE
//   proof_versions → views           ON DELETE CASCADE
//
// Direct DELETE FROM contacts would fail because of the RESTRICT on
// proofs.contact_id. The script deletes proofs first (the FK chain
// cascades from there), then contacts, then storage. Same shape as
// ProofDetailPage.handleDelete (src/pages/ProofDetailPage.tsx).
//
// Required env (read from .env via dotenv):
//   VITE_SUPABASE_URL              — same project URL as the app
//   SUPABASE_SERVICE_ROLE_KEY      — admin key, bypasses RLS
//                                    (add to .env as a one-time
//                                    setup step; never commit)
//
// Run via: npm run db:clean-fixtures

import { createClient } from '@supabase/supabase-js'
import { config as loadEnv } from 'dotenv'
import { createInterface } from 'node:readline'

loadEnv()

const url = process.env.VITE_SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !serviceKey) {
  console.error(
    'Missing env. The script needs VITE_SUPABASE_URL and ' +
      'SUPABASE_SERVICE_ROLE_KEY in .env. The service-role key is ' +
      'available in the Supabase dashboard under Project Settings → API.',
  )
  process.exit(1)
}

const sb = createClient(url, serviceKey, {
  // Proof data lives in the `proofs` schema of the shared stock project;
  // table names collide with stock's public schema under one PostgREST.
  db: { schema: 'proofs' },
  auth: { persistSession: false, autoRefreshToken: false },
})

async function main() {
  console.log('')
  console.log(`Project URL: ${url}`)
  console.log('')

  // 1. List flagged contacts.
  const { data: contacts, error: contactsErr } = await sb
    .from('contacts')
    .select('id, full_name, email')
    .eq('is_test_fixture', true)
    .order('full_name')
  if (contactsErr) throw contactsErr
  if (!contacts || contacts.length === 0) {
    console.log('No flagged contacts. Nothing to do.')
    return
  }

  const contactIds = contacts.map((c) => c.id)

  // 2. Find their proofs.
  const { data: proofs, error: proofsErr } = await sb
    .from('proofs')
    .select('id, contact_id')
    .in('contact_id', contactIds)
  if (proofsErr) throw proofsErr
  const proofIds = (proofs ?? []).map((p) => p.id)

  const proofCountByContact = new Map<string, number>()
  for (const p of proofs ?? []) {
    proofCountByContact.set(
      p.contact_id,
      (proofCountByContact.get(p.contact_id) ?? 0) + 1,
    )
  }

  // 3. Collect storage paths via the proof_versions join. Two-hop
  //    because the proof_version_images.proof_version_id FK doesn't
  //    expose proof_id directly through the supabase-js select
  //    syntax we're using; resolving versions first is cheaper than
  //    a fk-traversal join string and easier to read.
  let imagePaths: string[] = []
  if (proofIds.length > 0) {
    const { data: versions, error: versionsErr } = await sb
      .from('proof_versions')
      .select('id')
      .in('proof_id', proofIds)
    if (versionsErr) throw versionsErr
    const versionIds = (versions ?? []).map((v) => v.id)

    if (versionIds.length > 0) {
      const { data: images, error: imagesErr } = await sb
        .from('proof_version_images')
        .select('image_path')
        .in('proof_version_id', versionIds)
      if (imagesErr) throw imagesErr
      imagePaths = (images ?? [])
        .map((r) => r.image_path)
        .filter((p): p is string => !!p)
    }
  }

  // 4. Print the plan.
  console.log('Flagged test fixtures:')
  console.log('')
  console.log(
    '  ' + 'Name'.padEnd(24) + 'Email'.padEnd(40) + 'Proofs',
  )
  console.log('  ' + '-'.repeat(24 + 40 + 6))
  for (const c of contacts) {
    console.log(
      '  ' +
        c.full_name.padEnd(24) +
        c.email.padEnd(40) +
        String(proofCountByContact.get(c.id) ?? 0),
    )
  }
  console.log('')
  console.log(
    `Will delete: ${contacts.length} contacts, ${proofIds.length} proofs, ` +
      `${imagePaths.length} storage objects.`,
  )
  console.log('')

  // 5. Confirmation. Strict equality on "yes" — anything else aborts.
  const answer = await prompt('Type "yes" to delete: ')
  if (answer.trim().toLowerCase() !== 'yes') {
    console.log('Aborted.')
    return
  }

  // 6. Delete proofs first. The FK chain cascades from here:
  //    proof_versions, proof_version_images, proof_name_approvals,
  //    proof_events, and proof_version_views all clear automatically.
  if (proofIds.length > 0) {
    const { error: proofsDeleteErr } = await sb
      .from('proofs')
      .delete()
      .in('id', proofIds)
    if (proofsDeleteErr) throw proofsDeleteErr
    console.log(
      `Deleted ${proofIds.length} proofs ` +
        `(cascade through versions, images, approvals, events, views).`,
    )
  }

  // 7. Delete contacts (no proofs blocking now).
  const { error: contactsDeleteErr } = await sb
    .from('contacts')
    .delete()
    .in('id', contactIds)
  if (contactsDeleteErr) throw contactsDeleteErr
  console.log(`Deleted ${contacts.length} contacts.`)

  // 8. Best-effort storage cleanup. Mirrors the
  //    ProofDetailPage.handleDelete pattern: DB rows are already
  //    gone, so a storage miss leaves orphan files (correctness is
  //    intact; cost is a small amount of unused storage).
  if (imagePaths.length > 0) {
    const unique = [...new Set(imagePaths)]
    const { error: storageErr } = await sb.storage
      .from('proof-images')
      .remove(unique)
    if (storageErr) {
      console.warn(
        `Storage cleanup partial — some objects may persist: ${storageErr.message}`,
      )
    } else {
      console.log(`Removed ${unique.length} storage objects.`)
    }
  }

  console.log('')
  console.log('Done.')
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

main().catch((err) => {
  console.error('Failed:', err)
  process.exit(1)
})
