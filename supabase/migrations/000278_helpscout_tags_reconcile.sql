-- 000278_helpscout_tags_reconcile.sql
--
-- Fix the helpscout_tags sync gap (audited 2026-06-27: only ~36% of proofs had
-- their Help Scout tags mirrored). Root cause: the convo.tags webhook only
-- updates a proof that ALREADY exists, but Graphics tags the conversation when
-- it's pushed to Graphics — before the proof is created — so the first tag event
-- matches nothing and is lost.
--
-- The fix is the `reconcile-helpscout-tags` edge function on a 15-minute cron,
-- which pulls current tags for proofs the webhook never synced (this column IS
-- NULL) and refreshes active proofs. This migration adds the tracking column,
-- marks the current population as synced (the 2026-06-27 one-off backfill
-- already pulled every linked conversation), and schedules the cron.

alter table proofs.proofs
  add column if not exists helpscout_tags_synced_at timestamptz;

comment on column proofs.proofs.helpscout_tags_synced_at is
  'When helpscout_tags was last pulled from Help Scout (reconcile-helpscout-tags cron, or the 2026-06-27 one-off backfill). NULL = never synced -> the reconcile job pulls it next run.';

-- Mark the current population as freshly synced: every linked proof had its tags
-- pulled in the 2026-06-27 backfill, so only NEW proofs (NULL) and the 12h
-- active-refresh need pulling going forward. Without this every existing proof
-- would be re-pulled on the first cron run.
update proofs.proofs
  set helpscout_tags_synced_at = now()
  where helpscout_conversation_id is not null;

-- pg_cron: reconcile every 15 minutes. Reuses the proofs_send_nudges_key vault
-- secret (the service-role key) like the other proofs cron jobs
-- (proofs-send-nudges, proofs-send-order-reminders). cron.schedule upserts by
-- job name, so re-applying this migration is idempotent.
select cron.schedule(
  'proofs-reconcile-helpscout-tags',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://bjvinrzbdrwebylkmbwy.supabase.co/functions/v1/reconcile-helpscout-tags',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'proofs_send_nudges_key')
    ),
    body := '{}'::jsonb
  );
  $$
);
