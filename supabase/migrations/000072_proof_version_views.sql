-- Migration 000072: customer-side proof view tracking
--
-- New table proof_version_views records each real customer visit
-- to the proof page. Inserts happen only via the
-- record_proof_view() RPC (SECURITY DEFINER, bypasses RLS), which
-- classifies the user-agent string against a short list of known
-- bots so designers can filter out link-preview hits.
--
-- The designer UI reads this table to surface a simple per-project
-- state: unviewed / viewed_stale (some prior version viewed, but
-- not the current) / viewed_current.
--
-- No user-facing customer feedback. No emails, no geolocation.
-- IP is captured for audit sanity, not surfaced in the UI.

begin;

-- ── Table ───────────────────────────────────────────────────────────────────

create table proof_version_views (
  id uuid primary key default gen_random_uuid(),
  proof_version_id uuid not null references proof_versions(id) on delete cascade,
  viewed_at timestamptz not null default now(),
  ip_address inet null,
  user_agent text null,
  is_bot boolean not null default false
);

comment on table proof_version_views is
  'One row per customer page load on the public proof view. Inserted '
  'by the record_proof_view() RPC; is_bot is set server-side from a '
  'user-agent regex so link-preview hits (Slack, WhatsApp, outlook '
  'SafeLinks, Proofpoint, etc.) can be filtered out in the designer '
  'UI. Designers read via RLS; anon writes via SECURITY DEFINER RPC.';

-- Latest-view queries per version drive every dashboard and detail
-- page render; a composite index keyed on the version + descending
-- time makes "max viewed_at where is_bot = false" cheap.
create index proof_version_views_version_time_idx
  on proof_version_views (proof_version_id, viewed_at desc);

-- ── RLS ────────────────────────────────────────────────────────────────────

alter table proof_version_views enable row level security;

-- Authenticated designers can read every view row. No INSERT /
-- UPDATE / DELETE policies — mutations are limited to the
-- record_proof_view() RPC below, which bypasses RLS.
create policy "proof_version_views: authenticated read"
  on proof_version_views for select
  to authenticated
  using (true);

-- ── RPC ────────────────────────────────────────────────────────────────────
--
-- The customer page is served to anonymous users, so this function
-- has to be callable by anon. It's SECURITY DEFINER so the INSERT
-- doesn't require a policy on the table. Signature keeps p_ip as an
-- explicit arg with a default — the client passes null today and
-- the function falls back to the PostgREST-injected request headers
-- (x-forwarded-for / x-real-ip). Admin tooling could pass an
-- explicit IP later.

create or replace function record_proof_view(
  p_version_id  uuid,
  p_user_agent  text,
  p_ip          inet default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  bot boolean := false;
  headers json;
  client_ip inet := p_ip;
begin
  -- Bot classification. Case-insensitive match against a short
  -- allow-list of strings that appear in known scanning / preview
  -- user-agent strings. Keep this tight — aggressive matching
  -- would let real customer views slip into the is_bot bucket.
  if p_user_agent is not null and p_user_agent ~* 'googlebot|bingbot|slackbot|facebookexternalhit|twitterbot|linkedinbot|whatsapp|outlook\.office|safelinks|mimecast|proofpointurlisolation' then
    bot := true;
  end if;

  -- Fall back to PostgREST-injected request headers when the caller
  -- didn't pass an explicit IP. Prefer x-forwarded-for's first
  -- entry, then x-real-ip. Wrap in exception so a malformed header
  -- can't tank the insert.
  if client_ip is null then
    begin
      headers := nullif(current_setting('request.headers', true), '')::json;
      if headers is not null then
        client_ip := nullif(trim(split_part(coalesce(headers->>'x-forwarded-for', headers->>'x-real-ip', ''), ',', 1)), '')::inet;
      end if;
    exception
      when others then
        client_ip := null;
    end;
  end if;

  insert into proof_version_views (proof_version_id, viewed_at, ip_address, user_agent, is_bot)
  values (p_version_id, now(), client_ip, p_user_agent, bot);
end;
$$;

-- Callable by anon (the customer page) and authenticated (for
-- completeness — admins previewing a customer URL shouldn't get a
-- 401 from this call).
grant execute on function record_proof_view(uuid, text, inet) to anon, authenticated;

commit;
