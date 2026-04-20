// Edge-function audit helper. Edge functions have service role access
// and can write to audit_log directly (bypassing RLS). Wrapping the
// insert here keeps the call shape consistent across the create-user /
// deactivate-user / reactivate-user / import-pricing handlers.
//
// Sync (awaited) but non-fatal: any write failure is logged to the
// function's stdout (surfaced in Supabase logs) and the caller's
// mutation carries on regardless. Missing a log entry is strictly worse
// than breaking a user-facing action, per the spec.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

export interface AuditArgs {
  actorId?: string | null
  actorEmail?: string | null
  actorLabel?: string | null
  action: string
  targetType?: string | null
  targetId?: string | null
  targetLabel?: string | null
  beforeValue?: unknown
  afterValue?: unknown
  metadata?: unknown
}

export async function logAudit(admin: SupabaseClient, args: AuditArgs): Promise<void> {
  try {
    const { error } = await admin.from('audit_log').insert({
      actor_id: args.actorId ?? null,
      actor_email: args.actorEmail ?? null,
      actor_label: args.actorLabel ?? null,
      action: args.action,
      target_type: args.targetType ?? null,
      target_id: args.targetId ?? null,
      target_label: args.targetLabel ?? null,
      before_value: args.beforeValue ?? null,
      after_value: args.afterValue ?? null,
      metadata: args.metadata ?? null,
    })
    if (error) console.warn('[audit]', args.action, 'failed:', error.message)
  } catch (e) {
    console.warn('[audit]', args.action, 'threw:', (e as Error).message)
  }
}
