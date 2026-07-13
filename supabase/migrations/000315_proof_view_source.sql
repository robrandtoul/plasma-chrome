-- 000315_proof_view_source.sql
-- Attribute customer proof views to the link that brought them.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via an MCP apply_migration Rob approves / the dashboard SQL
-- editor. Do NOT use `supabase db push`.
--
-- Auto-chase review (2026-07-13): reminder effectiveness has so far been
-- inferred from timing windows ("a view within 7 days of a send"), because
-- reminder links were indistinguishable from the original send or a bookmark.
-- send-nudges now appends ?from=reminder-N to the proof links it emails; the
-- customer page passes that through to record_proof_view, landing here as
-- proof_version_views.source ('reminder-2' etc., null for organic visits).
--
-- The column is additive (no view exposes proof_version_views wholesale;
-- dashboard_latest_events selects named columns). The function gains a
-- DEFAULTED p_source parameter — signature change, so DROP + CREATE, grants
-- re-stated (anon: the customer page calls this; same set as live before the
-- change). Old frontends calling with three named params keep resolving
-- because the new parameter defaults; the new frontend only includes p_source
-- when a from= param is present, so organic views record even against an
-- unmigrated database. p_source is anon-writable text: allow-list the
-- characters and cap the length before storing.

alter table proofs.proof_version_views
  add column if not exists source text;

drop function if exists proofs.record_proof_view(uuid, text, inet);

create function proofs.record_proof_view(
  p_version_id uuid,
  p_user_agent text,
  p_ip inet default null,
  p_source text default null
)
returns void
language plpgsql
security definer
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $function$
declare
  bot boolean := false;
  headers json;
  client_ip inet := p_ip;
  v_source text;
begin
  -- Bot classification. Case-insensitive match against a short
  -- allow-list of strings that appear in known scanning / preview
  -- user-agent strings. Keep this tight - aggressive matching
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

  -- Link attribution, anon-supplied: strip anything outside [A-Za-z0-9_-]
  -- and cap at 40 chars so the column can only ever hold a short tag like
  -- 'reminder-2', never free text.
  v_source := nullif(left(regexp_replace(coalesce(p_source, ''), '[^A-Za-z0-9_-]', '', 'g'), 40), '');

  insert into proof_version_views (proof_version_id, viewed_at, ip_address, user_agent, is_bot, source)
  values (p_version_id, now(), client_ip, p_user_agent, bot, v_source);

  -- Auto-wake a "not viewed yet" snooze now that the customer has
  -- genuinely viewed the current version (migration 000220). Expire
  -- rather than delete so the dashboard's recentlyAwakened() path
  -- boosts the proof into Today as "Awaiting customer".
  if not bot then
    update proof_attention_snoozes s
       set snoozed_until = now()
      from proof_versions v
     where v.id = p_version_id
       and v.is_current = true
       and s.proof_id = v.proof_id
       and s.rule_code = 'sent_never_viewed'
       and s.snoozed_until > now();
  end if;
end;
$function$;

-- Grants: DROP wiped the old set; mirror live before the change. The
-- customer page calls this anonymously — anon EXECUTE is deliberate.
revoke all on function proofs.record_proof_view(uuid, text, inet, text) from public;
grant execute on function proofs.record_proof_view(uuid, text, inet, text) to anon, authenticated, service_role;
