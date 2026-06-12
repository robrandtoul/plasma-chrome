-- 000220_auto_wake_sent_never_viewed_snooze_on_view.sql
--
-- Auto-wake a "not viewed yet" snooze the moment the customer actually
-- views the proof.
--
-- Background. A snooze is a purely time-based mute keyed on
-- (proof_id, rule_code): it hides the proof from Needs-attention until
-- snoozed_until passes, and nothing clears it early — not even the
-- customer doing the very thing the snooze was waiting for. So a designer
-- who snoozes a "sent_never_viewed" flag (typically after sending a
-- reminder) keeps seeing the proof as Snoozed even after the customer
-- opens it; it only re-surfaces as "Awaiting customer" when the timer
-- lapses. Real case that prompted this: Cordale's Custom Coating, snoozed
-- 12 Jun 13:42, viewed 93 seconds later, still snoozed.
--
-- Fix. record_proof_view() is the single chokepoint every customer view
-- flows through. After it records the view, if the view is a genuine
-- (non-bot) view of the proof's CURRENT version and there is still an
-- active sent_never_viewed snooze on that proof, expire the snooze by
-- setting snoozed_until = now().
--
-- Why expire rather than DELETE the row. Setting snoozed_until = now()
--   * makes isCurrentlySnoozed() false  -> drops out of the Snoozed
--     section immediately, and
--   * makes recentlyAwakened() true (expiry within the last 24h) -> the
--     dashboard boosts the proof into the Today bucket, where it reads as
--     "Awaiting customer".
-- That Today-boost depends on snoozed_until being carried forward for 24h
-- in public_dashboard_projects (migration 000186); a DELETE would skip the
-- boost and the proof could land in This week / Older instead. Keeping the
-- row also preserves the snooze/woken history.
--
-- Scope is deliberately tight:
--   * only the sent_never_viewed rule (a view does NOT resolve
--     viewed_not_actioned, request_changes_no_version, approaching_dormant,
--     etc. — those aren't satisfied by a view);
--   * only non-bot views (link-scanners like Mimecast/Outlook don't count);
--   * only a view of the current version (viewing a superseded version
--     must not clear a flag that's about the current one);
--   * only snoozes still active (snoozed_until > now()).
--
-- This is a CREATE OR REPLACE of an existing SECURITY DEFINER function, so
-- its EXECUTE grant to anon is preserved. The body below is verbatim from
-- the live definition plus the new "auto-wake" block at the end.

begin;

create or replace function proofs.record_proof_view(
  p_version_id uuid,
  p_user_agent text,
  p_ip inet default null::inet
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

  insert into proof_version_views (proof_version_id, viewed_at, ip_address, user_agent, is_bot)
  values (p_version_id, now(), client_ip, p_user_agent, bot);

  -- Auto-wake a "not viewed yet" snooze now that the customer has
  -- genuinely viewed the current version. See file header for the
  -- expire-not-delete rationale and the tight scope.
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

commit;
