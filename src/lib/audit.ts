// Client-side audit logging wrapper. Fire-and-forget from the caller's
// perspective — the promise resolves (never rejects) regardless of
// success, so user-facing mutations are never gated on the log write.
//
// Single entry point:
//   logAudit  — signed-in designer/admin actions. The RPC stamps
//               actor_id from auth.uid() server-side (can't be
//               spoofed).
//
// The previous logCustomerEvent wrapper was removed alongside the
// log_customer_event RPC (migration 000101) — that anon-write surface
// had no input validation and the only customer-side use
// (`version.viewed` audit on page load) was redundant with the
// dedicated proof_version_views table populated via record_proof_view.

import { supabase } from './supabase'

type JsonLike = Record<string, unknown> | unknown[] | string | number | boolean | null

export interface AuditArgs {
  action: string
  targetType?: string
  targetId?: string | null
  targetLabel?: string
  beforeValue?: JsonLike
  afterValue?: JsonLike
  metadata?: JsonLike
}

export async function logAudit(args: AuditArgs): Promise<void> {
  try {
    const { error } = await supabase.rpc('log_audit_event', {
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
