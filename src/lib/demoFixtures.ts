// Demo-data fixtures: putting the test projects back into a known state.
//
// Why this exists: three separate test failures in one afternoon traced to the
// fixture drifting under whoever was using it — notes stranded on v1 after
// someone added a v2, then specs matching note wording that had since been
// rewritten by hand. A demo needs a known starting point, and so does a test.
//
// ── Two deliberate limits ───────────────────────────────────────────────────
//
// 1. IT CAN ONLY EVER TOUCH THE FIXTURES. Every write is scoped to proofs whose
//    company matches FIXTURE_COMPANY, re-checked against the database at call
//    time rather than trusted from the caller. A reset button that could be
//    pointed at a real customer's project is not worth having.
//
// 2. IT DOES NOT ERASE AUDIT HISTORY. proof_events and proof_version_views are
//    append-only by design — authenticated sessions hold SELECT only (000176),
//    and that is correct: a button that could rewrite who approved what would
//    undermine the record the whole app relies on. So a reset clears STATE
//    (status, per-recipient approvals, annotations), and leaves the trail. A
//    fixture that has been approved before will still show that history, and
//    that is honest rather than a shortcoming.

import { supabase } from './supabase'

/** The standing test customer. Not a real company. */
export const FIXTURE_COMPANY = 'Atari Corp'

export interface FixtureProof {
  id: string
  status: string
  contactName: string
  materialDisplay: string | null
  currentVersionId: string | null
  currentVersionNumber: number | null
  versionCount: number
  noteCount: number
  pinCount: number
  approvalCount: number
}

/** Everything the panel shows, in one round trip per table. */
export async function loadFixtures(): Promise<FixtureProof[]> {
  const { data: proofs, error } = await supabase
    .from('proofs')
    .select(
      'id, status, contacts!inner(full_name, companies!inner(name)), proof_versions(id, version_number, is_current, material_id, materials(display_name))',
    )
    .eq('contacts.companies.name', FIXTURE_COMPANY)

  if (error) throw error

  const rows = (proofs ?? []) as unknown as {
    id: string
    status: string
    contacts: { full_name: string } | null
    proof_versions: {
      id: string
      version_number: number
      is_current: boolean
      materials: { display_name: string } | null
    }[]
  }[]

  if (rows.length === 0) return []

  const versionIds = rows.flatMap((p) => p.proof_versions.map((v) => v.id))

  const [{ data: notes }, { data: approvals }] = await Promise.all([
    supabase
      .from('proof_annotations')
      .select('id, proof_version_id, author_kind')
      .in('proof_version_id', versionIds),
    supabase
      .from('proof_name_approvals')
      .select('id, proof_version_id')
      .in('proof_version_id', versionIds),
  ])

  return rows
    .map((p) => {
      const ids = new Set(p.proof_versions.map((v) => v.id))
      const current = p.proof_versions.find((v) => v.is_current) ?? null
      const mine = (notes ?? []).filter((n) => ids.has(n.proof_version_id as string))
      return {
        id: p.id,
        status: p.status,
        contactName: p.contacts?.full_name ?? 'Unknown',
        materialDisplay: current?.materials?.display_name ?? null,
        currentVersionId: current?.id ?? null,
        currentVersionNumber: current?.version_number ?? null,
        versionCount: p.proof_versions.length,
        noteCount: mine.filter((n) => n.author_kind === 'designer').length,
        pinCount: mine.filter((n) => n.author_kind === 'customer').length,
        approvalCount: (approvals ?? []).filter((a) => ids.has(a.proof_version_id as string)).length,
      }
    })
    .sort((a, b) => a.contactName.localeCompare(b.contactName))
}

/**
 * Re-read the proof from the database and refuse unless it really is a fixture.
 * The caller passing an id is not evidence of anything.
 */
async function assertFixture(proofId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('proofs')
    .select('id, contacts!inner(companies!inner(name)), proof_versions(id)')
    .eq('id', proofId)
    .single()
  if (error) throw error

  const row = data as unknown as {
    contacts: { companies: { name: string } | null } | null
    proof_versions: { id: string }[]
  }
  const company = row.contacts?.companies?.name
  if (company !== FIXTURE_COMPANY) {
    throw new Error(
      `Refusing to touch this project: it belongs to "${company ?? 'no company'}", not ${FIXTURE_COMPANY}.`,
    )
  }
  return row.proof_versions.map((v) => v.id)
}

export interface ResetResult {
  notesCleared: number
  approvalsCleared: number
  statusChanged: boolean
}

/**
 * Put a fixture back to "ready to send": in progress, nobody has approved, no
 * notes or pins. Audit history is deliberately left alone — see the header.
 */
export async function resetFixture(proofId: string): Promise<ResetResult> {
  const versionIds = await assertFixture(proofId)

  let notesCleared = 0
  let approvalsCleared = 0

  if (versionIds.length > 0) {
    const { data: notes, error: noteErr } = await supabase
      .from('proof_annotations')
      .delete()
      .in('proof_version_id', versionIds)
      .select('id')
    if (noteErr) throw noteErr
    notesCleared = notes?.length ?? 0

    const { data: apps, error: appErr } = await supabase
      .from('proof_name_approvals')
      .delete()
      .in('proof_version_id', versionIds)
      .select('id')
    if (appErr) throw appErr
    approvalsCleared = apps?.length ?? 0
  }

  const { data: updated, error: statusErr } = await supabase
    .from('proofs')
    .update({ status: 'in_progress', approved_at: null, abandoned_at: null })
    .eq('id', proofId)
    .neq('status', 'in_progress')
    .select('id')
  if (statusErr) throw statusErr

  return { notesCleared, approvalsCleared, statusChanged: (updated?.length ?? 0) > 0 }
}

/** The sample notes. Wording mirrors the guidance in the designer guide. */
const SAMPLE_NOTES: { x: number; y: number; body: string }[] = [
  {
    x: 0.25,
    y: 0.8,
    body:
      'Your logo sits a little smaller here than in your file — that is the finest detail the engraving holds cleanly at this size.',
  },
  {
    x: 0.75,
    y: 0.3,
    body:
      'Everything sits 3 mm in from the edge. Any closer and the engraved edge can chip when the cards are cut.',
  },
]

/**
 * Put two designer notes on the fixture's CURRENT version — always resolved at
 * call time, never a hardcoded version id. Stranding notes on an old version is
 * exactly what went wrong before.
 */
export async function seedFixtureNotes(proofId: string, userId: string): Promise<number> {
  await assertFixture(proofId)

  const { data: version, error: vErr } = await supabase
    .from('proof_versions')
    .select('id, proof_version_images(id, side, associated_name, is_qr_code, sort_order)')
    .eq('proof_id', proofId)
    .eq('is_current', true)
    .single()
  if (vErr) throw vErr

  const v = version as unknown as {
    id: string
    proof_version_images: {
      id: string
      side: 'front' | 'back' | null
      associated_name: string | null
      is_qr_code: boolean
      sort_order: number | null
    }[]
  }

  const target =
    v.proof_version_images
      .filter((i) => !i.is_qr_code)
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .find((i) => i.side === 'front') ?? v.proof_version_images.find((i) => !i.is_qr_code)

  if (!target) throw new Error('That fixture has no artwork to attach a note to.')

  const { data, error } = await supabase
    .from('proof_annotations')
    .insert(
      SAMPLE_NOTES.map((n) => ({
        proof_version_id: v.id,
        proof_version_image_id: target.id,
        side: target.side,
        associated_name: target.associated_name,
        x: n.x,
        y: n.y,
        body: n.body,
        author_kind: 'designer' as const,
        created_by: userId,
      })),
    )
    .select('id')
  if (error) throw error
  return data?.length ?? 0
}
