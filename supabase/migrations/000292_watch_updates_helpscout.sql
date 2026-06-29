-- 000292: weave Help Scout replies into a flagged card's update thread.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via MCP apply_migration. Do NOT use `supabase db push`.
--
-- Lets the helpscout-webhook ingest a reply (customer or staff) on a flagged
-- project's conversation straight into the card's watch_updates thread, so the
-- board becomes one timeline of manual notes + logged calls + actual HS comms.
--
-- Three changes:
--   1. widen the kind CHECK with two HS-sourced kinds
--   2. a helpscout_thread_id dedup key (webhook redelivery is idempotent)
--   3. the author trigger only stamps from a profile when there IS a real author
--      — HS rows are service-role inserts with created_by NULL and a
--      webhook-supplied display name the trigger must not null out.

alter table proofs.watch_updates drop constraint watch_updates_kind_check;
alter table proofs.watch_updates add constraint watch_updates_kind_check
  check (kind in ('note', 'phone_call', 'helpscout_customer', 'helpscout_staff'));

alter table proofs.watch_updates add column helpscout_thread_id text;

-- One ingested row per (card, HS thread): makes a redelivered webhook a no-op.
create unique index watch_updates_hs_thread_uniq
  on proofs.watch_updates (watch_item_id, helpscout_thread_id)
  where helpscout_thread_id is not null;

-- Only stamp the denormalised author from a profile when created_by is set;
-- otherwise (HS ingest) keep the webhook-supplied created_by_name.
create or replace function proofs.watch_updates_set_author()
  returns trigger
  language plpgsql
  security definer
  set search_path = proofs, public, extensions, pg_temp
as $$
begin
  if new.created_by is not null then
    select p.full_name, p.designer_initials, p.designer_colour
      into new.created_by_name, new.created_by_initials, new.created_by_colour
    from proofs.profiles p
    where p.id = new.created_by;
  end if;
  return new;
end;
$$;
