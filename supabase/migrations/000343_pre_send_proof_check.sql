-- Pre-send proof check (docs/artwork-check-spec.md — the designer-triggered
-- sibling of the order-time artwork check).
--
-- The order-time check (000336) guards the LAST gate: print files vs the
-- customer's supplied details, after approval, before production. This adds
-- the FIRST-gate variant: the designer runs the same comparison on a proof
-- version's own images against the Help Scout thread BEFORE the customer ever
-- sees the proof — catching transcription typos and un-actioned change
-- requests (the "complex revisions split across several emails" case) while
-- they're still free to fix. No Dropbox involvement: the card side is the
-- version's proof images in our own storage; there is no approved-proof drift
-- leg because nothing is approved yet.
--
-- Mirrors the 000336 column trio on proof_versions (same names as orders — the
-- table context distinguishes them, and the shared report tooling reads the
-- same field names on both). Verdict CHECK matches the 000338 four-value set.
-- Designer-triggered only (no auto-run trigger, no pg_net): versions are
-- created far more often than orders, so the cost stays where the judgement
-- is — the button.
--
-- Gate: settings.proof_check_enabled (default false). Deliberately a plain
-- boolean, not the order check's off/shadow/live enum — shadow made sense for
-- an auto-running check being tuned invisibly; a manual button is either
-- offered to designers or it isn't.
--
-- No new tables → no grant matrix needed (proof_versions and settings carry
-- their grants already). Apply via MCP / dashboard SQL editor per the house
-- workflow — never CLI push.

alter table proofs.proof_versions
  add column if not exists artwork_check jsonb,
  add column if not exists artwork_checked_at timestamptz,
  add column if not exists artwork_check_verdict text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'proof_versions_artwork_check_verdict_check'
      and conrelid = 'proofs.proof_versions'::regclass
  ) then
    alter table proofs.proof_versions
      add constraint proof_versions_artwork_check_verdict_check
      check (artwork_check_verdict is null or artwork_check_verdict in ('clear', 'flagged', 'defect', 'error'));
  end if;
end $$;

comment on column proofs.proof_versions.artwork_check is
  'Latest pre-send proof-check report (jsonb, same shape as orders.artwork_check): this version''s proof images vs the Help Scout thread + attachments + QR contents. Designer-triggered from the proof page; advisory only.';
comment on column proofs.proof_versions.artwork_checked_at is
  'When the pre-send proof check last ran for this version (success or error alike).';
comment on column proofs.proof_versions.artwork_check_verdict is
  'Code-derived verdict of the latest pre-send proof check: clear | flagged | defect | error.';

alter table proofs.settings
  add column if not exists proof_check_enabled boolean not null default false;

comment on column proofs.settings.proof_check_enabled is
  'Offers the designer-triggered pre-send proof check on the proof page (Admin → Artwork check). Off = the button and any stored reports stay hidden; independent of artwork_check_mode (the order-time check).';
