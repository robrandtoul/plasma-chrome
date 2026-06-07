#!/usr/bin/env tsx
//
// scripts/list-hosted-vcard-proofs.ts
//
// One-off audit script. Lists every proof that has at least one
// proof_version_images row with is_qr_code = true and qr_kind =
// 'hosted_vcard'. Used for the hosted-vCard QR feature roll-out
// cleanup — finds the test proofs created during phases 1-3 so
// they can be reviewed and removed.
//
// READ-ONLY. Prints. Does not delete. Pure precedent on env-loading
// is scripts/clean-test-fixtures.ts (same VITE_SUPABASE_URL +
// SUPABASE_SERVICE_ROLE_KEY in .env).
//
// Run via: npx tsx scripts/list-hosted-vcard-proofs.ts

import { createClient } from '@supabase/supabase-js'
import { config as loadEnv } from 'dotenv'

loadEnv()

const url = process.env.VITE_SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !serviceKey) {
  console.error(
    'Missing env. The script needs VITE_SUPABASE_URL and ' +
      'SUPABASE_SERVICE_ROLE_KEY in .env.',
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

  // Find every hosted-vCard QR row, then resolve to proofs via versions.
  const { data: qrRows, error: qrErr } = await sb
    .from('proof_version_images')
    .select('id, proof_version_id, qr_vcard_slug, qr_decoded_data, associated_name, sort_order')
    .eq('is_qr_code', true)
    .eq('qr_kind', 'hosted_vcard')
  if (qrErr) throw qrErr
  if (!qrRows || qrRows.length === 0) {
    console.log('No hosted-vCard QR rows found.')
    return
  }

  const versionIds = Array.from(new Set(qrRows.map((r) => r.proof_version_id)))
  const { data: versions, error: versionsErr } = await sb
    .from('proof_versions')
    .select('id, proof_id, version_number')
    .in('id', versionIds)
  if (versionsErr) throw versionsErr

  const proofIds = Array.from(new Set((versions ?? []).map((v) => v.proof_id)))
  const { data: proofs, error: proofsErr } = await sb
    .from('proofs')
    .select('id, status, created_at, contact_id')
    .in('id', proofIds)
    .order('created_at', { ascending: false })
  if (proofsErr) throw proofsErr

  const contactIds = Array.from(
    new Set((proofs ?? []).map((p) => p.contact_id).filter((c): c is string => !!c)),
  )
  const { data: contacts } = contactIds.length
    ? await sb
        .from('contacts')
        .select('id, full_name, email, is_test_fixture, company_id, companies(name)')
        .in('id', contactIds)
    : { data: [] as Array<{
        id: string
        full_name: string | null
        email: string | null
        is_test_fixture: boolean | null
        company_id: string | null
        companies: { name: string } | { name: string }[] | null
      }> }

  const contactsById = new Map(
    (contacts ?? []).map((c) => [c.id, c]),
  )
  const versionsByProof = new Map<string, Array<{ id: string; version_number: number }>>()
  for (const v of versions ?? []) {
    const list = versionsByProof.get(v.proof_id) ?? []
    list.push({ id: v.id, version_number: v.version_number })
    versionsByProof.set(v.proof_id, list)
  }
  const qrRowsByVersion = new Map<string, typeof qrRows>()
  for (const r of qrRows) {
    const list = (qrRowsByVersion.get(r.proof_version_id) as typeof qrRows | undefined) ?? []
    list.push(r)
    qrRowsByVersion.set(r.proof_version_id, list)
  }

  console.log(`Found ${proofs?.length ?? 0} proof(s) carrying a hosted-vCard QR:`)
  console.log('')

  for (const p of proofs ?? []) {
    const c = p.contact_id ? contactsById.get(p.contact_id) : null
    const companyName = (() => {
      const co = c?.companies
      if (!co) return null
      return Array.isArray(co) ? (co[0]?.name ?? null) : co.name
    })()
    const created = new Date(p.created_at).toLocaleString('en-GB')
    console.log(`Proof ${p.id}`)
    console.log(`  Customer:   ${c?.full_name ?? '(unknown)'}${companyName ? ' — ' + companyName : ''}`)
    console.log(`  Email:      ${c?.email ?? '(unknown)'}`)
    console.log(`  Test flag:  ${c?.is_test_fixture ? 'YES (is_test_fixture)' : 'no'}`)
    console.log(`  Status:     ${p.status}`)
    console.log(`  Created:    ${created}`)
    const pvs = versionsByProof.get(p.id) ?? []
    for (const v of pvs.sort((a, b) => a.version_number - b.version_number)) {
      const rows = qrRowsByVersion.get(v.id) ?? []
      if (rows.length === 0) continue
      console.log(`  v${v.version_number} (${v.id}):`)
      for (const r of rows) {
        console.log(
          `    - row ${r.id}` +
            `, slug "${r.qr_vcard_slug ?? '(null)'}"` +
            `, slot ${r.associated_name ?? '__shared__'}` +
            `, decoded ${r.qr_decoded_data}`,
        )
      }
    }
    console.log('')
  }
}

main().catch((err) => {
  console.error('Failed:', err)
  process.exit(1)
})
