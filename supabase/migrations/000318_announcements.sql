-- 000318: dashboard announcements — an admin-posted notice banner.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), where
-- proof-viewer lives in the `proofs` schema. Apply by pasting into that
-- project's dashboard SQL editor (or an MCP apply_migration). Do NOT use
-- `supabase db push` — the CLI link points at the retired standalone project.
--
-- Applied to live (merged stock-control project bjvinrzbdrwebylkmbwy) via MCP
-- apply_migration on 2026-07-16. Verified: table + 4 policies + RLS on,
-- authenticated CRUD grants, trigger present; security advisors clean.
--
-- The four of us work in different locations and live in the dashboard all day.
-- This is the one place to post something everyone should see — e.g. "10% off
-- Steel cards until Friday" — instead of telling each colleague individually.
--
-- Design decisions:
--   * ADMIN-POSTED ONLY. Any signed-in user READS the banner (for select
--     using true); only an admin can INSERT / UPDATE / DELETE (gated on the
--     house helper proofs.is_admin(), exactly like the feedback board's admin
--     policies in 000271). This keeps a clean line between "an official notice"
--     and ordinary chatter (which is what the team_messages chat is for).
--   * SELF-EXPIRING. `expires_at` is nullable; the banner shows a row only while
--     now() is within [starts_at, coalesce(expires_at, 'infinity')) and it is
--     not archived. Rob's 7-day offer takes itself down on day 8 — nobody has
--     to remember to remove it.
--   * SOFT REMOVE. "Remove" stamps `archived_at` rather than deleting, so a
--     notice can be brought back and the history survives. A hard DELETE policy
--     also exists for genuine clean-up.
--   * DENORMALISED POSTER. profiles is self-read-only under RLS, so the poster's
--     name/initials/colour are copied onto the row by a SECURITY DEFINER BEFORE
--     INSERT trigger (same idiom as feedback_items_set_author, 000271) — the
--     client can't spoof who posted it.
--
-- No realtime here: the banner is a fetch-on-mount read (like the feedback
-- board) and everyone reloads the dashboard through the day. Live chat is the
-- one surface that gets a realtime subscription (migration 000319).

begin;

create table proofs.announcements (
  id                   uuid        primary key default gen_random_uuid(),
  -- Attribution: FK for the insert RLS check; nullable so the row survives
  -- account removal (ON DELETE SET NULL), matching feedback_items.created_by.
  created_by           uuid        references proofs.profiles(id) on delete set null,
  -- Denormalised poster, for the manage list's "— Rob, 16 Jul" attribution.
  created_by_name      text,
  created_by_initials  text,
  created_by_colour    text,
  -- Visual treatment of the banner strip. 'offer' is the promo case Rob asked
  -- for; 'info' is the neutral default; 'warning' is for time-sensitive alerts.
  tone                 text        not null default 'info'
                         check (tone in ('info', 'offer', 'warning')),
  -- The message itself. One prominent line on the banner.
  body                 text        not null,
  -- Scheduling window. starts_at defaults to now() (posts immediately); it's a
  -- column so a future "schedule for later" is additive. expires_at null = runs
  -- until an admin removes it.
  starts_at            timestamptz not null default now(),
  expires_at           timestamptz,
  -- Soft-remove marker. Non-null = an admin took it down early; the banner
  -- filters these out.
  archived_at          timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- Newest-first for the manage list; the active-window filter is applied in the
-- query (a tiny table, so no partial index needed).
create index announcements_created_idx on proofs.announcements (created_at desc);

alter table proofs.announcements enable row level security;

-- Everyone signed in sees the banner.
create policy announcements_select on proofs.announcements
  for select to authenticated using (true);

-- Only an admin can post, and only as themselves (created_by = auth.uid()
-- blocks spoofing another person's attribution via a direct REST insert).
create policy announcements_admin_insert on proofs.announcements
  for insert to authenticated
  with check (proofs.is_admin() and created_by = auth.uid());

-- Only an admin can edit a notice or archive it.
create policy announcements_admin_update on proofs.announcements
  for update to authenticated
  using (proofs.is_admin())
  with check (proofs.is_admin());

-- Only an admin can hard-delete a notice.
create policy announcements_admin_delete on proofs.announcements
  for delete to authenticated
  using (proofs.is_admin());

-- Stamp the poster's display fields server-side (profiles is self-read-only, so
-- the shared banner can't join them back later). SECURITY DEFINER with a pinned
-- search_path; EXECUTE revoked from callers (a trigger fires regardless of
-- EXECUTE — the same hardening as 000182 / the feedback trigger).
create or replace function proofs.announcements_set_author()
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
  return new;
end;
$$;

revoke execute on function proofs.announcements_set_author() from public, anon, authenticated;
grant execute on function proofs.announcements_set_author() to service_role;

create trigger announcements_set_author
  before insert on proofs.announcements
  for each row execute function proofs.announcements_set_author();

-- Grant matrix — explicit because the proofs schema has NO default privileges
-- (a new table is born with no grants at all, service_role included).
revoke all on proofs.announcements from anon, public;
grant select, insert, update, delete on proofs.announcements to authenticated;
grant all on proofs.announcements to service_role;

commit;
