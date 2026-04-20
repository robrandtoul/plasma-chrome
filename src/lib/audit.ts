// Client-side audit logging wrapper. Fire-and-forget from the caller's
// perspective — the promise resolves (never rejects) regardless of
// success, so user-facing mutations are never gated on the log write.
//
// Two entry points:
//   logAudit            — signed-in designer/admin actions. The RPC
//                         stamps actor_id from auth.uid() server-side
//                         (can't be spoofed).
//   logCustomerEvent    — anon customer actions. Caller provides the
//                         customer's email for attribution; actor_id
//                         is left null.

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

export interface CustomerAuditArgs {
  action: string
  targetType?: string
  targetId?: string | null
  targetLabel?: string
  actorEmail?: string
  actorLabel?: string
  metadata?: JsonLike
}

export async function logCustomerEvent(args: CustomerAuditArgs): Promise<void> {
  try {
    const { error } = await supabase.rpc('log_customer_event', {
      action: args.action,
      target_type: args.targetType ?? null,
      target_id: args.targetId ?? null,
      target_label: args.targetLabel ?? null,
      actor_email: args.actorEmail ?? null,
      actor_label: args.actorLabel ?? null,
      metadata: args.metadata ?? null,
    })
    if (error) console.warn('[audit]', args.action, 'failed:', error.message)
  } catch (e) {
    console.warn('[audit]', args.action, 'threw:', (e as Error).message)
  }
}
