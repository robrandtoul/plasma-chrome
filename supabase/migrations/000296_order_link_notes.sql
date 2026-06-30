-- 000296: Order-link notes — a short, shared "why this is still here" note on a
-- Links-to-send card.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration. Do NOT
-- use `supabase db push`.
--
-- A project often sits in "Links to send" (approved, no order link sent yet)
-- because we're waiting on the customer for something — the metal thickness, a
-- final headcount, an address. This table lets one staffer pin a short note to
-- the card ("waiting on metal thickness — chased 28 Jun") so anyone else picking
-- it up understands why, without digging through the Help Scout thread.
--
-- One note per proof (proof_id is the PK), editable by anyone signed in — it's a
-- shared ops note, not an admin-gated one. Same collaborative model as the watch
-- board (000290): all-staff read + write, author display fields denormalised and
-- stamped server-side so they can't be spoofed.
--
-- "Discarded once the order link is sent": create-order DELETEs the row when it
-- creates the order, and the card itself drops out of Links-to-send the moment an
-- order of any status exists for the proof (keepApprovedNoOrder), so a sent
-- proof never shows a stale note. The ON DELETE CASCADE also clears the note if
-- the proof is deleted.
--
-- ⚠ Grants note (the proofs schema has NO default privileges — a new table is
-- born with no grants at all, service_role included): every grant below is
-- explicit. create-order clears the note via service_role, so that grant matters.

begin;

create table proofs.order_link_notes (
  -- One note per proof. CASCADE so deleting a proof (delete_proof_cascade,
  -- 000243) takes its note with it.
  proof_id            uuid        primary key references proofs.proofs(id) on delete cascade,
  -- A SHORT note. Length + non-empty enforced at the DB so a raw REST upsert
  -- can't bypass the form's 500-char cap / trim (the UI is the normal path; this
  -- is the back-stop). Client always stores trimmed text, so the floor is 1.
  note                text        not null check (char_length(btrim(note)) between 1 and 500),
  -- Who last wrote the note. FK for the insert/update RLS check + attribution;
  -- nullable so the row survives account removal. The *_name/_initials/_colour
  -- copies are display fields stamped server-side from the editor's own profile
  -- (profiles is self-read-only under RLS, so a join can't show "— Chris").
  created_by          uuid        references proofs.profiles(id) on delete set null,
  created_by_name     text,
  created_by_initials text,
  created_by_colour   text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

alter table proofs.order_link_notes enable row level security;

-- Everyone signed in sees the note.
create policy order_link_notes_select on proofs.order_link_notes
  for select to authenticated using (true);

-- Anyone signed in can add a note, but only as themselves (created_by =
-- auth.uid() blocks spoofing another person's attribution). The upsert below
-- relies on both the insert and update checks passing.
create policy order_link_notes_insert on proofs.order_link_notes
  for insert to authenticated
  with check (created_by = auth.uid());

-- Collaborative: anyone can replace the note, but the editor must stamp
-- themselves as the new author (same anti-spoof check as the snooze table, 000167).
create policy order_link_notes_update on proofs.order_link_notes
  for update to authenticated
  using (true) with check (created_by = auth.uid());

-- Anyone can clear an obsolete note — it's a transient, shared annotation.
create policy order_link_notes_delete on proofs.order_link_notes
  for delete to authenticated
  using (true);

revoke all on proofs.order_link_notes from anon, public;
grant select, insert, update, delete on proofs.order_link_notes to authenticated;
grant all on proofs.order_link_notes to service_role;

comment on table proofs.order_link_notes is
  'Short shared note on a Links-to-send card explaining why a proof is still '
  'awaiting an order link (usually waiting on the customer). One per proof; '
  'all-staff read + write; author display fields stamped by '
  'order_link_notes_set_author. Cleared by create-order when the link is sent.';

-- Stamp the editor''s display identity + bump updated_at on every write. created_by
-- is forced to auth.uid() by the RLS checks; the client never supplies the display
-- copies. SECURITY DEFINER so it can read profiles regardless of profiles'' own
-- self-read-only RLS; EXECUTE revoked from callers (a trigger fires regardless of
-- EXECUTE — same hardening as 000182 / 000290).
create or replace function proofs.order_link_notes_set_author()
  returns trigger
  language plpgsql
  security definer
  set search_path = proofs, public, extensions, pg_temp
as $$
begin
  select p.full_name, p.designer_initials, p.designer_colour
    into new.created_by_name, new.created_by_initials, new.created_by_colour
  from proofs.profiles p
  where p.id = new.created_by;
  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function proofs.order_link_notes_set_author() from public, anon, authenticated;
grant execute on function proofs.order_link_notes_set_author() to service_role;

create trigger order_link_notes_set_author
  before insert or update on proofs.order_link_notes
  for each row execute function proofs.order_link_notes_set_author();

commit;
