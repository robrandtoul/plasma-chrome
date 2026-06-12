-- 000222 — auto-wake chase-rule snoozes when the customer ACTS on the proof.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply by pasting into that project's dashboard SQL editor (or MCP
-- apply_migration). Do NOT use supabase db push.
--
-- Companion to 000220, which wakes a sent_never_viewed snooze when the
-- customer VIEWS the proof. This closes the remaining gap: a designer who
-- snoozes viewed_not_actioned / stuck_in_progress (typically after sending a
-- reminder) keeps seeing the proof as Snoozed even after the customer
-- approves or requests changes — the very response the snooze was waiting
-- for stays hidden until the timer lapses.
--
-- Fix: an AFTER INSERT trigger on proof_events. When a customer approve or
-- request_changes lands (designer_override_approve is excluded — that's the
-- designer's own action, nothing to wake them up about), expire every active
-- snooze on that proof for the rules that exist because the customer was
-- quiet: the four chase rules plus nudges_exhausted (000221). Snoozes on
-- request_changes_no_version and approved_earlier_version are left alone —
-- those track designer-side work a customer action doesn't resolve.
--
-- Expire (snoozed_until = now()) rather than DELETE, for the same reasons as
-- 000220: isCurrentlySnoozed() flips false immediately, recentlyAwakened()
-- boosts the proof into the dashboard's Today bucket for 24 hours (the
-- public_dashboard_projects snooze lateral carries expired snoozes for 24h,
-- migration 000186), and the snooze history is preserved.
--
-- Any version, not just the current one: an approval of a superseded version
-- is still a customer response the designer needs to see (it's exactly the
-- situation the approved_earlier_version rule exists for).
--
-- SECURITY DEFINER because proof_events rows arrive via the proof-action
-- edge function (service role) and the trigger must be able to update
-- another designer's snooze row regardless of the inserting role's RLS
-- context (the 000167 UPDATE policy's WITH CHECK pins snoozed_by to the
-- caller, which would block an invoker-rights update here). EXECUTE revoked
-- from every client role — trigger invocation ignores EXECUTE, so this stays
-- internal plumbing (the 000182 pattern).

create or replace function proofs.wake_snoozes_on_customer_action()
returns trigger
language plpgsql
security definer
set search_path = proofs, public, extensions, pg_temp
as $$
begin
  update proof_attention_snoozes s
     set snoozed_until = now()
    from proof_versions v
   where v.id = new.proof_version_id
     and s.proof_id = v.proof_id
     and s.rule_code in ('sent_never_viewed', 'viewed_not_actioned',
                         'approaching_dormant', 'stuck_in_progress',
                         'nudges_exhausted')
     and s.snoozed_until > now();
  return null;
end;
$$;

revoke execute on function proofs.wake_snoozes_on_customer_action() from public, anon, authenticated;

drop trigger if exists wake_snoozes_on_customer_action on proofs.proof_events;
create trigger wake_snoozes_on_customer_action
  after insert on proofs.proof_events
  for each row
  when (new.event_type in ('approve', 'request_changes'))
  execute function proofs.wake_snoozes_on_customer_action();
