# Follow-up automation — Phase 1 rollout steps

> **Status: EXECUTED 2026-06-10** (by Claude with Rob's explicit permission,
> while PR #254 was under review). Migration applied via MCP
> (`followup_automation_phase1` in the stock project's migration history),
> all four functions deployed, vault secret + cron job created, first dry
> run verified (9 candidates, dry_run mode, heartbeat clean — zero ledger
> rows is correct while every reply stamp is younger than the 3-working-day
> threshold; rows appear as stamps age). One deviation from the original
> steps: the function's auth gate accepts any platform-verified JWT with the
> `service_role` claim rather than requiring byte-equality with the injected
> env key — the vault key is a differently-minted service-role JWT and the
> first trigger 403'd (fixed, redeployed, re-verified). The steps below stay
> as the reference for re-runs or a rebuild.

Operational companion to `followup-automation-spec.md`. Everything here is
prod-touching, so per the house rule Rob runs each step himself (or
explicitly delegates, as happened above). Every SQL block pastes into the
**stock-control** project's dashboard SQL editor; every shell line is
self-contained and paste-safe.

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

Then the schedule — twice daily on weekdays at 09:00 and 15:00 UTC (09:00 GMT
/ 10:00 BST and 15:00 GMT / 16:00 BST, both inside the send window year-round;
the function also checks the window itself):

```sql
select cron.schedule(
  'proofs-send-nudges',
  '0 9,15 * * 1-5',
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

> **Amended 2026-06-16:** added a second weekday run at 15:00 UTC (16:00 BST /
> 15:00 GMT — the last in-window hour), so the schedule went from `0 9 * * 1-5`
> to `0 9,15 * * 1-5`. Re-running the `cron.schedule(...)` block above updates
> job `proofs-send-nudges` (jobid 8) in place; it does not create a second job.

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
`HELPSCOUT_DEFAULT_USER_ID` is set (step 2 note). The spec's "Deferred to
Phase 2 — must build BEFORE the flip" list is fully built as of 2026-06-12
(PR #283), including the second-nudge-as-new-conversation piece.

## Phase 2a — the allowlisted first week (run BEFORE the flip)

The spec's "first week on an allowlist" has no dedicated mechanism; it is
done with the per-proof opt-out flag. **Run this immediately before flipping
the switch**, with the allowlist emails edited to taste — it opts every
in-progress proof OUT of automation except the contacts you name:

```sql
update proofs.proofs p
set auto_nudge_disabled_at = now()
from proofs.contacts c
where c.id = p.contact_id
  and p.status = 'in_progress'
  and p.auto_nudge_disabled_at is null
  and lower(c.email) not in (
    'allowed.customer@example.com',
    'another.allowed@example.com'
  );
```

The Outbox will show the opted-out proofs as "auto-chasing off for this
proof" — that is the allowlist working. New proofs created during the trial
week are NOT opted out automatically, so either include them deliberately or
re-run the block.

When the trial week looks good, lift the opt-outs:

```sql
update proofs.proofs
set auto_nudge_disabled_at = null
where auto_nudge_disabled_at is not null;
```

⚠ The lift clears EVERY opt-out, including any set deliberately via the
"Stop auto-chasing this proof" button in the meantime. Check what would be
cleared first and re-set any deliberate ones afterwards:

```sql
select co.name, c.full_name, p.auto_nudge_disabled_at
from proofs.proofs p
left join proofs.contacts c on c.id = p.contact_id
left join proofs.companies co on co.id = c.company_id
where p.auto_nudge_disabled_at is not null
order by p.auto_nudge_disabled_at;
```
