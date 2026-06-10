# Follow-up automation — Phase 1 rollout steps

Operational companion to `followup-automation-spec.md`. Everything here is
prod-touching, so per the house rule Rob runs each step himself. Every SQL
block pastes into the **stock-control** project's dashboard SQL editor;
every shell line is self-contained and paste-safe.

The result of Phase 1: the pipeline runs every weekday morning in **dry-run**
(nothing sends — `auto_nudges_enabled` defaults to off), and the dashboard
Outbox shows what it would have sent and why it skipped the rest. Watch it
for a week; Phase 2 is one switch on the admin page.

## 1. Apply migration 000214

Stock-control project → SQL editor → paste the full contents of
`supabase/migrations/000214_followup_automation_phase1.sql` → Run.

Expect "Success. No rows returned". Safe to re-run only the
`update proofs.site_settings…` statement (it is guarded); the CREATEs are
one-shot — if a partial apply ever leaves it half-done, tell Claude rather
than re-running blind.

## 2. Deploy the edge functions

Four functions changed (one new, three modified — the modified ones share
the extracted template renderer). From Terminal, one line at a time:

```
cd /Users/robrandtoul/proof-viewer && supabase functions deploy send-nudges --project-ref bjvinrzbdrwebylkmbwy
```

```
cd /Users/robrandtoul/proof-viewer && supabase functions deploy proof-action --project-ref bjvinrzbdrwebylkmbwy
```

```
cd /Users/robrandtoul/proof-viewer && supabase functions deploy fetch-helpscout-conversation-context --project-ref bjvinrzbdrwebylkmbwy
```

```
cd /Users/robrandtoul/proof-viewer && supabase functions deploy send-helpscout-reply --project-ref bjvinrzbdrwebylkmbwy
```

No new secrets needed: send-nudges uses the same HELPSCOUT_* +
PROOF_VIEWER_BASE_URL secrets the existing functions already have.
(Precondition 3 — confirm `HELPSCOUT_DEFAULT_USER_ID` exists under
Edge Functions → Secrets — matters before Phase 2, not today.)

## 3. Create the cron job

SQL editor again. First the vault secret — this copies the service-role key
from the secret the existing tracking cron already uses, so no key ever
needs pasting:

```sql
select vault.create_secret(
  (select decrypted_secret from vault.decrypted_secrets where name = 'fedex_track_service_role_key'),
  'proofs_send_nudges_key'
);
```

Then the schedule — 09:00 UTC weekdays (09:00 GMT / 10:00 BST, inside the
send window year-round; the function also checks the window itself):

```sql
select cron.schedule(
  'proofs-send-nudges',
  '0 9 * * 1-5',
  $$
  select net.http_post(
    url := 'https://bjvinrzbdrwebylkmbwy.supabase.co/functions/v1/send-nudges',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'proofs_send_nudges_key')
    ),
    body := '{}'::jsonb
  );
  $$
);
```

## 4. Trigger the first dry run now (optional but recommended)

Rather than waiting for tomorrow 9am — paste this once:

```sql
select net.http_post(
  url := 'https://bjvinrzbdrwebylkmbwy.supabase.co/functions/v1/send-nudges',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'proofs_send_nudges_key')
  ),
  body := '{}'::jsonb
);
```

Then open the proof-viewer dashboard: the Outbox panel (right-hand side)
should show "Last run: just now · dry run" with the would-send list and
skip reasons. That is the whole Phase 1 loop working.

## 5. The week of watching

- The Outbox updates every weekday morning. Read the would-send bodies —
  wording problems are template edits in Admin → Templates.
- "Email mismatch — review" entries are real findings: the Help Scout
  conversation's customer differs from the proof's contact. Fix the link in
  /admin/customers.
- Sanity check (Phase 1 acceptance): proofs flagged "Sent, never opened" on
  the dashboard should appear in the Outbox as either would-send or an
  explained skip. A proof flagged there but absent here is a bug — tell
  Claude.
- The admin page (Admin → Needs-attention → Automated reminders) shows the
  dials: all editable during the dry week, nothing sends regardless.

## Phase 2 (after the week, deliberately)

Admin → Needs-attention → Automated reminders → switch **Automated
reminders** on. First week against real customers: watch the Outbox daily;
the kill switches are the same toggle (off = back to dry-run) and the
existing Customer-replies pause (master gate). Before flipping: confirm
`HELPSCOUT_DEFAULT_USER_ID` is set (step 2 note), and check the spec's
"Deferred to Phase 2 — must build BEFORE the flip" list — the
second-nudge-as-new-conversation piece is needed within days of flipping.
