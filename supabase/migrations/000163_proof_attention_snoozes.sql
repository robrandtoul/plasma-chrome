-- Migration 000163: proof_attention_snoozes
--
-- Lets designers snooze a specific needs-attention rule on a proof
-- for a chosen duration (24 h / 48 h / 1 week or a custom interval).
-- While the snooze is active, proofs_needing_attention() excludes
-- that proof+rule combination so the proof drops out of the NEEDS
-- ATTENTION tile. When the snooze expires the proof resurfaces
-- automatically if the underlying condition is still unresolved.
--
-- One record per (proof_id, rule_code): upsert with ON CONFLICT
-- replaces any previous snooze (e.g. when extending or changing the
-- note). Expired records are kept as an audit trail; all active-snooze
-- queries filter on snoozed_until > now().
--
-- snoozed_by references profiles, not auth.users, so the initials +
-- colour metadata needed by the dashboard are directly joinable.
-- ON DELETE SET NULL preserves the historical record if a designer
-- account is removed.

create table proof_attention_snoozes (
  id            uuid        primary key default gen_random_uuid(),
  proof_id      uuid        not null references proofs(id) on delete cascade,
  rule_code     text        not null,
  snoozed_by    uuid        references profiles(id) on delete set null,
  snoozed_at    timestamptz not null default now(),
  snoozed_until timestamptz not null,
  note          text,
  constraint snooze_duration_positive check (snoozed_until > snoozed_at)
);

-- Enforces one snooze record per proof per rule. The upsert pattern
-- (ON CONFLICT DO UPDATE) means re-snoozing replaces the existing
-- record rather than accumulating rows. The unique constraint covers
-- both active and expired snoozes so there is always at most one
-- canonical record per (proof_id, rule_code).
create unique index proof_attention_snoozes_proof_rule_idx
  on proof_attention_snoozes (proof_id, rule_code);

create index proof_attention_snoozes_until_idx
  on proof_attention_snoozes (proof_id, snoozed_until desc);

alter table proof_attention_snoozes enable row level security;

-- All authenticated designers can read the full snooze log for the
-- audit trail and the dashboard Snoozed section.
create policy "Authenticated designers read snoozes"
  on proof_attention_snoozes for select to authenticated
  using (true);

-- All authenticated designers can create, update, and delete snoozes.
-- Matches the proof_pins pattern (000155): any team member can manage
-- shared state — e.g. a second designer can unsnooze something the
-- first snoozed once the issue has been dealt with.
create policy "Authenticated designers manage snoozes"
  on proof_attention_snoozes for all to authenticated
  using (true) with check (true);

comment on table proof_attention_snoozes is
  'One record per (proof_id, rule_code) — upsert replaces previous '
  'snooze. Expired records kept as audit trail. Active snoozes are '
  'filtered with snoozed_until > now() in proofs_needing_attention() '
  'and public_dashboard_projects. snoozed_by is nullable so the '
  'historical record survives designer account removal.';
