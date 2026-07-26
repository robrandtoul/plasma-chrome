// Proof annotations — data access.
//
// Coordinate-anchored notes on a proof image, in two directions:
//   • designer callouts — written for the CUSTOMER to read, shown as a quiet
//     "A note from <first name>" strip beside the card.
//   • customer pins     — an optional "point at it" alongside a change request,
//     written by the proof-action edge function.
//
// THE PRESENTATION RULE, because it is easy to undo by accident: the artwork the
// customer is presented with is never drawn on. The overview shows an unmarked
// card plus the strip; a numbered marker appears only inside the zoom view,
// after the customer has deliberately opened a card to inspect it. If you find
// yourself rendering markers on the overview, that is the regression.
//
// The pure half (types, constants, coordinate maths) lives in
// proofAnnotationGeometry.ts and is re-exported here, so callers have one import
// and the maths stays testable without a Supabase client.

import { supabase } from './supabase'
import {
  MAX_ANNOTATION_BODY,
  clampUnit,
  type AnnotationSide,
  type CustomerCallout,
  type ProofAnnotation,
} from './proofAnnotationGeometry'

export * from './proofAnnotationGeometry'

// ── Reads ────────────────────────────────────────────────────────────────────

/** Designer-side read: every annotation on a version, both authors. */
export async function fetchAnnotations(versionId: string): Promise<ProofAnnotation[]> {
  const { data, error } = await supabase
    .from('proof_annotations')
    .select('*')
    .eq('proof_version_id', versionId)
    .order('created_at', { ascending: true })

  if (error) throw error
  return (data ?? []) as ProofAnnotation[]
}

/**
 * Customer-side read: designer callouts only, via the anon RPC.
 *
 * Returns [] when settings.proof_callouts_enabled is off, so the strip
 * disappears everywhere the moment the gate flips without touching any row.
 * Never throws — a proof page must not break because a note failed to load.
 */
export async function fetchCustomerCallouts(versionId: string): Promise<CustomerCallout[]> {
  try {
    const { data, error } = await supabase.rpc('public_get_proof_annotations', {
      p_version_id: versionId,
    })
    if (error) throw error
    return Array.isArray(data) ? (data as CustomerCallout[]) : []
  } catch (err) {
    console.warn('[annotations] could not load designer notes', err)
    return []
  }
}

// ── Writes (designer side; customer pins go through proof-action) ─────────────

export async function createCallout(input: {
  versionId: string
  imageId: string | null
  side: AnnotationSide | null
  associatedName: string | null
  x: number
  y: number
  body: string
  userId: string
}): Promise<ProofAnnotation> {
  const { data, error } = await supabase
    .from('proof_annotations')
    .insert({
      proof_version_id: input.versionId,
      proof_version_image_id: input.imageId,
      side: input.side,
      associated_name: input.associatedName,
      x: input.x,
      y: input.y,
      body: input.body.trim().slice(0, MAX_ANNOTATION_BODY),
      author_kind: 'designer',
      created_by: input.userId,
    })
    .select('*')
    .single()

  if (error) throw error
  return data as ProofAnnotation
}

export async function updateCalloutBody(id: string, body: string): Promise<void> {
  const { error } = await supabase
    .from('proof_annotations')
    .update({ body: body.trim().slice(0, MAX_ANNOTATION_BODY) })
    .eq('id', id)
  if (error) throw error
}

export async function moveAnnotation(id: string, x: number, y: number): Promise<void> {
  const { error } = await supabase
    .from('proof_annotations')
    .update({ x: clampUnit(x), y: clampUnit(y) })
    .eq('id', id)
  if (error) throw error
}

export async function deleteAnnotation(id: string): Promise<void> {
  const { error } = await supabase.from('proof_annotations').delete().eq('id', id)
  if (error) throw error
}

/** Tick a customer pin off, or un-tick it. */
export async function setAnnotationResolved(
  id: string,
  resolved: boolean,
  userId: string,
): Promise<void> {
  const { error } = await supabase
    .from('proof_annotations')
    .update(
      resolved
        ? { resolved_at: new Date().toISOString(), resolved_by: userId }
        : { resolved_at: null, resolved_by: null },
    )
    .eq('id', id)
  if (error) throw error
}
