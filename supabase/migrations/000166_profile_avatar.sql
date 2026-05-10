-- Migration 000166: profile avatar upload
--
-- Three changes:
--
--   1. profiles.avatar_url (text, nullable) — stores the full public URL
--      of the user's uploaded avatar, including a ?t= cache-buster query
--      parameter so browsers always fetch the latest version after an
--      update. Null = no avatar uploaded; the UI falls back to initials.
--
--   2. avatars storage bucket — public bucket with a 2 MB file-size cap.
--      Object paths are {user_id}/avatar (no extension; content-type is
--      set on upload). Policies gate inserts/updates/deletes to the
--      owning user via the first path segment.
--
--   3. public_dashboard_projects view — drop + recreate to expose
--      pr.avatar_url as designer_avatar_url. All existing columns are
--      preserved in the same order; designer_avatar_url is appended
--      immediately after designer_colour (its natural companion).

begin;

-- ── 1. profiles column ───────────────────────────────────────────────────────

alter table profiles add column if not exists avatar_url text;

-- ── 2. avatars storage bucket ────────────────────────────────────────────────

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars',
  'avatars',
  true,
  2097152,  -- 2 MB
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

-- storage.objects already has RLS enabled globally in Supabase.
-- Drop any prior attempts so this migration is safe to re-run.
drop policy if exists "avatars: public read"         on storage.objects;
drop policy if exists "avatars: owner insert"        on storage.objects;
drop policy if exists "avatars: owner update"        on storage.objects;
drop policy if exists "avatars: owner delete"        on storage.objects;

-- Anyone (including unauthenticated visitors) can read avatars — they
-- are referenced in the designer's own proof pages and could be shared.
create policy "avatars: public read"
  on storage.objects for select
  using (bucket_id = 'avatars');

-- Authenticated users may only write to their own folder
-- ({user_id}/avatar). The first path segment is compared against the
-- caller's auth.uid() so no user can overwrite another's avatar.
create policy "avatars: owner insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "avatars: owner update"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "avatars: owner delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ── 3. public_dashboard_projects view ───────────────────────────────────────
-- Drop + recreate (Postgres won't let us add a column to an existing view).
-- All columns preserved in original order; designer_avatar_url appended
-- after designer_colour. The rest of the view body is identical to 000164.

drop view if exists public_dashboard_projects;

create view public_dashboard_projects as
  with current_versions as (
    select distinct on (pv.proof_id)
      pv.proof_id,
      pv.id              as version_id,
      pv.version_number,
      pv.material_display,
      pv.created_at      as version_created_at,
      pv.created_by      as designer_user_id
    from proof_versions pv
    where pv.is_current
    order by pv.proof_id, pv.version_number desc
  ),
  latest_events as (
    select distinct on (e.proof_id)
      e.proof_id,
      e.created_at    as latest_event_at,
      e.event_type    as latest_event_type,
      e.actor_name    as latest_event_actor
    from dashboard_latest_events e
    order by e.proof_id, e.created_at desc
  ),
  current_view_state as (
    select distinct on (cv.proof_id)
      cv.proof_id,
      v.viewed_at as current_version_viewed_at
    from proof_versions cv
    join proof_version_views v on v.proof_version_id = cv.id
    where cv.is_current and v.is_bot = false
    order by cv.proof_id, v.viewed_at desc
  ),
  na as (
    select * from proofs_needing_attention()
  )
  select
    p.id                                                     as proof_id,
    p.created_at,
    p.last_activity_at,
    p.status,
    p.approved_at,
    p.abandoned_at,
    p.disclaimer_acknowledged_at,
    p.helpscout_conversation_url,
    p.helpscout_conversation_id,
    c.id                                                     as contact_id,
    c.full_name                                              as contact_name,
    c.email                                                  as contact_email,
    co.id                                                    as company_id,
    co.name                                                  as company_name,
    cv.version_id                                            as current_version_id,
    cv.version_number                                        as current_version_number,
    cv.material_display,
    cv.version_created_at,
    cv.designer_user_id,
    pr.full_name                                             as designer_name,
    pr.designer_initials,
    pr.designer_colour,
    pr.avatar_url                                            as designer_avatar_url,
    le.latest_event_at,
    le.latest_event_type,
    le.latest_event_actor,
    cvs.current_version_viewed_at,
    na.rule_code,
    na.rule_meta,
    (
      p.status = 'in_progress'
      and cv.version_id is not null
      and not exists (
        select 1
        from proof_version_views v
        where v.proof_version_id = cv.version_id
          and v.is_bot = false
      )
      and not exists (
        select 1
        from proof_events e
        where e.proof_version_id = cv.version_id
          and e.event_type in ('approve', 'request_changes')
      )
    )                                                        as awaiting_customer,
    -- Snooze columns (unchanged from 000164)
    snz.snooze_rule_code,
    snz.snoozed_until,
    snz.snooze_note,
    snz.snoozed_by_name,
    snz.snoozed_by_initials,
    snz.snoozed_by_colour
  from proofs p
  left join contacts  c   on c.id = p.contact_id
  left join companies co  on co.id = c.company_id
  left join current_versions cv on cv.proof_id = p.id
  left join profiles  pr  on pr.id = cv.designer_user_id
  left join latest_events   le  on le.proof_id = p.id
  left join current_view_state cvs on cvs.proof_id = p.id
  left join na on na.proof_id = p.id
  left join lateral (
    select
      s.rule_code           as snooze_rule_code,
      s.snoozed_until,
      s.note                as snooze_note,
      pr2.full_name         as snoozed_by_name,
      pr2.designer_initials as snoozed_by_initials,
      pr2.designer_colour   as snoozed_by_colour
    from proof_attention_snoozes s
    left join profiles pr2 on pr2.id = s.snoozed_by
    where s.proof_id = p.id
      and s.snoozed_until > now()
    order by s.snoozed_until desc
    limit 1
  ) snz on true;

revoke all on public_dashboard_projects from anon, public;
grant select on public_dashboard_projects to authenticated;

comment on view public_dashboard_projects is
  'One row per proof for the redesigned designer dashboard. Joins '
  'contact, company, latest version (with designer attribution from '
  'profiles including avatar_url since 000166), the latest '
  'dashboard_latest_events row, the highest-priority needs-attention '
  'rule from proofs_needing_attention() (snooze-excluded since 000164), '
  'and the longest-remaining active snooze from proof_attention_snoozes. '
  'View runs as owner so it bypasses admin-only RLS on profiles.';

commit;
