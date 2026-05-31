import { supabase } from './supabase'
import { logAudit } from './audit'
import type { NeedsAttentionRule } from './dashboardGrouping'

// Snooze a (proof, rule) pair so it drops off the Needs-attention list until the
// timestamp passes. Mirrors the dashboard's handleSnooze upsert (same
// onConflict target + RLS-required snoozed_by = auth.uid()), extracted so the
// resolve popover can auto-snooze after a nudge from either surface.
export async function snoozeProof(
  proofId: string,
  ruleCode: NeedsAttentionRule,
  hours: number,
  note: string | null = null,
): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const snoozedUntil = new Date(Date.now() + hours * 3_600_000).toISOString()
  const { error } = await supabase
    .from('proof_attention_snoozes')
    .upsert(
      {
        proof_id:      proofId,
        rule_code:     ruleCode,
        snoozed_by:    user.id,
        snoozed_until: snoozedUntil,
        note:          note?.trim() || null,
      },
      { onConflict: 'proof_id,rule_code' },
    )
  if (error) throw error

  void logAudit({
    action: 'proof.snoozed',
    targetType: 'proof',
    targetId: proofId,
    metadata: { rule_code: ruleCode, hours, note: note?.trim() || null, source: 'resolve_nudge' },
  })
}
