import { supabase } from './supabase'
import { logAudit } from './audit'
import type { NeedsAttentionRule } from './dashboardGrouping'

// Snooze a (proof, rule) pair so it drops off the Needs-attention list until the
// timestamp passes. Mirrors the dashboard's handleSnooze upsert (same
// onConflict target + RLS-required snoozed_by = auth.uid()), extracted so the
// resolve popover can auto-snooze after a nudge from either surface. `source`
// is recorded on the audit row so a snooze can be traced back to where it was
// triggered (the auto-snooze after a nudge vs a manual snooze on the detail page).
export async function snoozeProof(
  proofId: string,
  ruleCode: NeedsAttentionRule,
  hours: number,
  note: string | null = null,
  source: string = 'resolve_nudge',
  opts: {
    /** True when the app is snoozing on its own initiative rather than because
     *  a designer clicked snooze. Stores snoozed_by = null, so the dashboard
     *  shows the note's reason instead of blaming whoever happened to be
     *  logged in. The 000167 RLS policy allows null for exactly this. */
    system?: boolean
  } = {},
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
        // ⚠ null on a system snooze. A designer creating a Reorder-desk
        // outreach project has four chase rules snoozed on their behalf;
        // stamping their id makes the dashboard read as though they went and
        // silenced four flags by hand.
        snoozed_by:    opts.system ? null : user.id,
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
    metadata: {
      rule_code: ruleCode, hours, note: note?.trim() || null, source,
      // The audit row still records WHO was signed in, even when the snooze
      // itself is unattributed — the action was theirs, the decision wasn't.
      ...(opts.system ? { system: true } : {}),
    },
  })
}

// Clear an active snooze on a (proof, rule) pair, bringing it back onto the
// Needs-attention list immediately. Mirrors the dashboard's handleUnsnooze
// delete, extracted so the proof detail page can unsnooze too.
export async function unsnoozeProof(
  proofId: string,
  ruleCode: NeedsAttentionRule,
  source: string = 'detail_page',
): Promise<void> {
  const { error } = await supabase
    .from('proof_attention_snoozes')
    .delete()
    .eq('proof_id', proofId)
    .eq('rule_code', ruleCode)
  if (error) throw error

  void logAudit({
    action: 'proof.unsnoozed',
    targetType: 'proof',
    targetId: proofId,
    metadata: { rule_code: ruleCode, source },
  })
}
