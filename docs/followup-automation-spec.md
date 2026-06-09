# Automated customer follow-ups (nudges) — build brief

Status: **agreed in principle, not yet building**. Blocked on the three
preconditions below. This spec encodes the design decided 2026-06-09 plus every
commitment from the same-day adversarial review (36-agent panel, 26 confirmed
findings, each verified against the code before acceptance). Where this spec
and the review disagree with older docs, this spec wins.

## Why

Proof-viewer already detects stalled proofs live on every dashboard load
(`proofs_needing_attention()`, 000154→000209), has admin-editable reminder wording (the four `nudge_*`
reply templates, 000207), a send path that lands in the customer's existing
Help Scout thread (`send-helpscout-reply`), and an inbound signal when anyone
replies (`helpscout-webhook`, 000208). The last step is human: a designer must
see the flag and click "Send a reminder". This feature closes that gap so
response rate improves without adding staff load.

## Decisions (locked, Rob 2026-06-09)

- **Oversight: Hybrid.** Only `sent_never_viewed` auto-sends. The other three
  chase rules (`viewed_not_actioned`, `approaching_dormant`,
  `stuck_in_progress`) produce **review-queue** items a designer sends with one
  click. Rules graduate to auto only by explicit config change.
- **Persistence: Standard.** Max 2 automated nudges per proof per version, then
  stop and surface "needs a human" (call / personal email).
- **`request_changes_no_version` never emails the customer.** The discharge is
  shipping a new version; any nudge for this rule is designer-facing (deferred —
  out of scope for this build).
- **Dry-run first.** The full pipeline runs for ~a week sending nothing,
  visible in a dashboard Outbox, before any live send.

## Architecture rule #1: the sender is the authority

The single most important commitment from the review. Candidate lists (nightly
compute output, the review queue) are **never authorisation to send**. The
sender re-validates everything in the moment before each Help Scout POST:

- the rule predicate still holds (status, view-existence, current version);
- no active snooze, grace window clear, kill switches on;
- no customer reply newer than our last outbound touch (hard rule, below);
- caps, cooldown, and daily-touch dedupe all pass.

To shrink the stale window structurally, compute and send run as **one pass in
a single morning job** — 09:00 Europe/London, Monday–Friday (the
working-hours/working-days check lives *inside* the function, computed in
Europe/London, so the cron trigger time only has to be approximately right and
BST drift is irrelevant). There is no overnight snapshot that a morning
dispatcher acts on.

The review queue renders **live** from the rules engine on every dashboard
load (no persisted nightly snapshot), and a one-click send from it goes through
the same re-validating sender — a stale click is dropped with a visible "no
longer needed", not sent. (The existing `ResolvePopover` manual nudge has the
same staleness property today and gets the same single-proof re-check.)

## Architecture rule #2: claim first, send second

A crash between the Help Scout POST and any durable record double-sends on the
next run. So the nudge log row is an **idempotency claim, not a receipt**:

1. INSERT the `proof_nudges` row in state `sending`, protected by a unique
   constraint. If the insert loses the conflict, do not send.
2. POST to Help Scout.
3. UPDATE the row to `sent` (with the HS thread id) or `failed`.

Stale `sending` rows on a later run **never auto-retry the POST** — they are
quarantined to the review queue for a human (optionally auto-verified by
fetching the conversation's threads and matching the rendered body).
`thread_id === 0` from HS is "sent but unverifiable", not failure. Rows in
`sending` and `sent` both count toward every cap so a crashed claim cannot be
spent twice.

## Architecture rule #3: never nudge past a customer reply

If `proofs.helpscout_last_customer_reply_at` is newer than our last outbound
touch for that proof (version send or last nudge), automation hard-skips and
queues for human review — **regardless of the grace window**. An unanswered
customer reply means a human owes the next message, never a bot. Both
timestamps already exist; this is one predicate in the eligibility query.

Plus a durable opt-out: `proofs.auto_nudge_disabled_at timestamptz` (nullable),
settable with one click from the review queue, checked by the sender. The
queue's "cancel this chase" action wires to the existing abandon flow where
appropriate (status `abandoned` already removes a proof from all chase rules).

## What gets built

### 1. `proof_nudges` — the single nudge ledger (new table)

One row per nudge, **manual and automatic alike** — there is exactly one
ledger, so cap and spacing maths can count human touches.

Columns (indicative): `id`, `proof_id` FK, `proof_version_id` FK (version
current at send), `rule_code`, `template_id`, `source` (`auto` | `manual`),
`state` (`sending` | `sent` | `failed` | `skipped` | `dry_run`), `outcome` text
(e.g. `superseded: approved`, `skipped_closed_conversation`,
`recipient_mismatch`, `suppressed_sibling`, `skipped: automation disabled`),
`helpscout_conversation_id`, `helpscout_thread_id`, `sent_by` FK profiles
(null for auto), `rendered_body` snapshot, `created_at`.

Constraints / indexes:

- Unique claim key for auto sends: `(proof_id, rule_code, proof_version_id,
  sent_date)` where `source = 'auto'` — the ON CONFLICT gate from rule #2.
- One automated send per conversation per day, **database-enforced**: partial
  unique index on `(helpscout_conversation_id, sent_date)` where
  `source = 'auto'` and state in (`sending`,`sent`).
- `dry_run` is a first-class state, and the cap/cooldown read path is a single
  SQL function that excludes it **by definition** — structural, not a query
  convention each caller must remember.

Grants (the 000176 / 000178 footgun): enable RLS, `GRANT SELECT` to
`authenticated` (Outbox + review queue reads), then immediately
`REVOKE INSERT, UPDATE, DELETE ... FROM authenticated`. Every write — including
the manual-nudge record — happens server-side (service-role sender, or inside
`send-helpscout-reply`), so the ledger is append-only from the clients' view
and auto-vs-manual counting stays trustworthy.

Manual path change: `MessageSendPanel` passes `template_id` to
`send-helpscout-reply`; when it is a `nudge_*` template the function inserts
the `proof_nudges` row (source `manual`) in the same request as the successful
HS POST. While in that file, close the unvalidated-write gap: the
`last_reply_sent_at` update must verify the `version_id` belongs to the
`proof_id`.

### 2. `nudge_runs` — heartbeat (new table)

A dead nightly batch must be distinguishable from "nobody needed chasing". The
run row is the pipeline's **first write**: insert `started_at` before
computing, stamp `finished_at` last, so a crash mid-run is visible as an open
row. Columns: `started_at`, `finished_at`, `mode` (`dry_run` | `live`),
`candidates_computed`, `sent`, `skipped_by_guardrail`, `errors jsonb`. Written
on **every** run including zero-candidate runs.

- Outbox panel shows "Last run: N hours ago"; age > ~25 h renders a
  needs-attention-style warning banner.
- An **open run row gates auto-send** (pause until a human clears it).
- Same panel carries a webhook-freshness indicator: newest
  `greatest(helpscout_last_reply_at, helpscout_last_customer_reply_at)` across
  all proofs — multi-day staleness at Plasma's HS volume signals a dead
  webhook.
- If pg_cron + pg_net is the trigger, the run row IS the success signal —
  `cron.job_run_details` cannot be relied on (pg_net discards the response).

### 3. Automation config + kill switches

- Per-rule automation settings (`auto_send`, `repeat_days`, `max_nudges`) live
  under a **top-level sibling key** in `site_settings.needs_attention_rules`
  (e.g. `"automation": { "sent_never_viewed": { … } }`) — the admin
  Reset-to-defaults merge preserves top-level keys but clobbers keys inside
  rule objects (PV-2026W22-239).
- `auto_send` reads **fail-closed**: `coalesce((…)::boolean, false)` in SQL /
  `=== true` in TS. A rules object missing the automation keys sends nothing
  (tested).
- New `settings.auto_nudges_enabled boolean default false` with its own audit
  action and its own control on Admin → Needs-attention. `replies_enabled`
  turns out to gate **only** the designers' manual send path — it stays as a
  master AND-gate (off ⇒ nothing sends anywhere), but automation gets its own
  switch. A paused run logs outcome `skipped: automation disabled` so it is
  distinguishable from an empty one.

### 4. The service-role sender — `send-nudges` (new edge function)

Auth: `verify_jwt = false` plus its own constant-time `X-Cron-Secret`-style
check, mirroring the `helpscout-webhook` HMAC pattern. `requireDesigner`
cannot be reused.

**Eligibility (computed in-function, per proof).** The job does **not** consume
`proofs_needing_attention()`'s output: that function collapses to one
highest-priority rule per proof (`distinct on … order by priority`), which
breaks automation in both directions — a higher-priority rule masks the
auto-send rule (acute once Phase 2b ships: the `helpscout_follow_up_tag` rule
sits at priority 2 and would permanently hide `sent_never_viewed` for exactly
the proofs a human tagged for chasing), and an exhausted proof keeps winning
the collapse so its escalation never surfaces. Instead the job evaluates the
`sent_never_viewed` predicate directly (or via a new return-all-rules variant),
with these corrections and guards:

- **Send-evidence anchor.** The dashboard rule counts from
  `proof_versions.created_at` — version *creation*, not customer *send*. The
  auto path requires positive send evidence and measures the threshold from
  it: `coalesce(proof_versions.last_reply_sent_at,
  proofs.helpscout_last_reply_at) is not null`. No evidence → no auto-nudge
  (fail toward silence); "version uploaded but never announced" is a
  designer-facing problem, not a customer email.
- **Views.** No non-bot `proof_version_views` row for the current version (the
  rule's own predicate). Note the bot filter is a UA regex + a 2.5 s JS timer —
  see the Phase 2 entry audit below.
- **Snoozes.** Query `proof_attention_snoozes` directly with
  `snoozed_until > now()`; **any** active snooze on the proof (regardless of
  rule_code) pauses all automated sends for it. Never read snooze state from
  `public_dashboard_projects` — its `snoozed_until` stays non-null for 24 h
  *after* expiry (000186) and would wrongly pause/unpause.
- **Grace window** (000208/000209) honoured as-is. Note the bot's own send
  self-stamps `helpscout_last_reply_at` via the webhook, so flagged proofs
  vanish from the dashboard flag for `grace_days` after each send — expected,
  and the Outbox copy should say so. The grace window is **belt-and-braces
  only**: authoritative spacing comes from the ledger (next item).
- **Cap and cooldown — from `proof_nudges`, nothing else.**
  - Cap: `max_nudges` (default 2) automated sends per
    `(proof_id, rule_code, proof_version_id)` — shipping a new version
    re-arms the rule with a fresh allowance, matching how the rule itself
    re-arms.
  - Lifetime ceiling: 6 automated sends per proof across all versions/rules,
    so a long revision cycle cannot accumulate unbounded email.
  - Cooldown: `repeat_days` (default 3) in **working days**, evaluated from
    the newest ledger row of *any* source — manual touches always delay
    automation. Working-day maths must skip UK bank holidays: the sender
    consults the gov.uk bank-holidays JSON cached in `settings` (yearly
    refresh); `business_days_between` and the dashboard rules stay untouched.
  - Manual nudges also consume per-version cap slots (default; see Open
    decisions).
  - Customer engagement (a view, an HS reply) resets nothing by itself; only
    a new version re-arms. Engagement that leads nowhere should hit the
    human-escalation flag, not re-arm the bot.
- **Customer-reply hard-skip and opt-out** per architecture rule #3.
- **Conversation gates.** One `fetchConversation` GET serves three checks (it
  is already needed for `primaryCustomer.id`):
  - status: skip `closed`/spam conversations → outcome
    `skipped_closed_conversation` (or review queue). Never reply into a closed
    thread.
  - the unattended path does **not** pass `status: 'pending'` to
    `postStaffReply` — reopening/re-queueing conversations is a
    designer-initiated semantic only.
  - recipient match: compare `conv.primaryCustomer.email` against the proof
    contact's email (trimmed, case-insensitive). Mismatch or either missing →
    do not send, outcome `recipient_mismatch` (both emails in the log row),
    route to review queue. Render `{first_name}` from the HS primaryCustomer
    for automated sends so greeting and recipient cannot diverge.
  - belt-and-braces for rule #3: inspect the same response's threads embed for
    a customer thread newer than the proof's last outbound touch and hard-skip
    on a hit — webhook delivery is at-most-once, and a single missed
    customer-reply event would otherwise be the one path past the hard-skip.
    Near-zero extra cost since the GET already happens.
- **Sibling / multi-link grouping.**
  - Multiple proofs can legitimately share one `helpscout_conversation_id`
    (two designs proofed in one thread — intended, do not constrain it away).
    The sender groups eligible nudges by conversation: at most one automated
    nudge per conversation per run (highest-priority proof wins), enforced by
    the partial unique index.
  - Daily-touch identity: the resolved HS primaryCustomer email (lowercased),
    falling back to the proof contact's `lower(email)`. When more than one
    eligible proof resolves to the same identity in a cycle: auto-send
    **none**, emit a single combined review-queue item listing the siblings so
    a human sends one email covering all. Log `suppressed_sibling` — a
    suppression must not advance the suppressed proofs' cap/cooldown clocks.

**Send identity & visibility.** Sender resolution: current version's
`created_by` → `profiles.helpscout_user_id` → the HS conversation assignee →
`HELPSCOUT_DEFAULT_USER_ID`. Auto-nudge replies are **not hidden** — the
`proof-action` `hideThread` pattern is for confirmation copies of actions the
customer already took; the nudge IS the substantive message a later reply
answers. `automated = true` goes on the ledger row and in the audit metadata so
designers can tell bot sends apart in the history.

**Template rendering, server-side.** Extract the renderer to
`supabase/functions/_shared/replyTemplates.ts` and delete `proof-action`'s
inline copy (this build creates the *third* renderer otherwise — the extraction
condition that file's own comment sets). Build `{url}` from the existing
`PROOF_VIEWER_BASE_URL` secret. Post-render gate: refuse to send (→ review
queue) if any `{token}` survives unresolved or `url` / `first_name` rendered
empty — the renderer substitutes silently, so this gate is the real guardrail.
The dry-run Outbox displays the fully-rendered body, not the template id, so a
blank link is visible during the review week.

**Batch resilience.** One HS token per run (re-fetch once on 401). Each proof's
send wrapped in its own try/catch that always writes an outcome row — one
failure never aborts the loop. `HsError` handling: 429 → stop the remainder of
the run (eligible proofs simply go tomorrow); 5xx → log per-item failure,
continue; other 4xx → permanent failure, surface in Outbox/review queue.

### 5. Exhaustion — a first-class state, not a silent grave

"2 automated nudges sent, still no response" must land somewhere a human
already looks:

- Derived from the ledger (`count >= max_nudges` AND the rule still firing):
  its own dashboard chip/tile alongside the needs-attention surfaces, with
  copy variants added to `attentionReason` / `attentionResolution` in
  `src/lib/needsAttention.ts` ("2 automated reminders sent — needs a call").
- Tag or assign the HS conversation so the escalation also appears inside
  Help Scout.
- Escalation is **human-gated** — never automated off
  `helpscout_last_customer_reply_at` (the webhook stamps delivery-time `now()`
  with a best-effort direction defaulting to staff; fine for suppression,
  unsafe as a "customer never responded" source of truth). The queue row links
  to the HS conversation so the designer can see whether a reply was actually
  missed.

### 6. Second nudge = new conversation (deliverability lever)

The original proof email and nudge #1 ride one thread; if that thread is in the
customer's spam folder, nudge #2 in the same thread measures the spam folder,
not the customer. The second `sent_never_viewed` nudge therefore opens a **new
Help Scout conversation with a fresh subject line** — the cheapest
deliverability variation available, and it makes the Phase 3 nudge→view metric
meaningful. The `POST /v2/conversations` pattern exists in
`contact-form-submit`; extract a shared helper into `_shared/helpscout.ts`.

### 7. Webhook hardening (small, while we're in there)

- Stamp from the payload's embedded thread `createdAt` where present (the
  parse already exists), falling back to `now()`, written with
  `GREATEST(existing, incoming)` so a late HS retry can never regress a stamp.

### 8. Trigger mechanism — decision needed (see Open decisions)

No pg_cron→edge-function pattern exists in this repo (000080 is DB-only). The
two candidates:

- **pg_cron + pg_net** on the project that actually hosts the proofs schema:
  cron job `http_post`s the function URL, shared secret read from Vault
  (`vault.decrypted_secrets`) inside a small SECURITY DEFINER wrapper — never
  inlined in `cron.job.command`; the job command schema-qualified. Fire-and-
  forget; the `nudge_runs` row is the outcome record.
- **External scheduler** (Supabase dashboard cron UI / GitHub Actions cron):
  delivery logs and retries for free.

Either way the working-hours check stays inside the function.

## Guardrail → mechanism map

| Guardrail | Enforced by |
| --- | --- |
| Max 2 auto-nudges, re-armed per version | `proof_nudges` count per (proof, rule, version); claim-first unique key |
| Lifetime ceiling | `proof_nudges` count per proof (≤ 6) |
| ~3-working-day spacing | `repeat_days` vs newest ledger row (any source), UK bank holidays included |
| Never past a customer reply | hard-skip predicate on `helpscout_last_customer_reply_at` vs last outbound touch |
| Reply grace window | 000208/000209 guard — belt-and-braces, not the spacing authority |
| Snoozes | direct `proof_attention_snoozes` query, `snoozed_until > now()`, any rule pauses the proof |
| Kill switches | `auto_nudges_enabled` (automation-scoped, default off) AND `replies_enabled` (master) |
| HS-linked proofs only | conversation id present + conversation GET succeeds + status not closed |
| Right recipient | primaryCustomer email == contact email, else review queue |
| UK working hours / days | Europe/London check inside the function |
| One touch per customer per day | conversation-level partial unique index + per-identity dedupe |
| No duplicate sends | claim-first ledger insert (rule #2) |
| Audit | audit_log row + ledger row per send, `automated` flagged |

## Rollout

**Preconditions (hard blockers, in order):**

1. **Topology — ✅ verified 2026-06-09** (Rob, dashboard SQL editor): live
   proofs are in the **stock-control** project, `proofs.proofs` (25 proofs);
   the CLI-linked `xpcjanqrcgzjmwketxtt` still carries the full migrated
   schema in `public` but has **zero rows and null activity** — an empty
   schema copy that would make a misdirected dry-run pass vacuously.
   **Remaining work:** the CLI link, local `.env`, and CLAUDE.md's migration
   workflow all still point at the old project. Re-point the toolchain (or
   explicitly retire `pnpm db:diff` / `db:push:confirm` for this work), adopt
   the live project's schema-qualification convention for the new migrations,
   and apply everything from Rob's Terminal per the prod-gating rule.
2. **Webhook — ✅ verified 2026-06-09**: `helpscout-webhook` is firing in
   prod. 25/25 proofs HS-linked, 25/25 carry `helpscout_last_reply_at`
   stamps, 10/25 carry customer-reply stamps, newest stamps same-day. The
   grace window, customer-reply hard-skip, and send-evidence fallback all
   have live data behind them.
3. **Sender identity.** Confirm `HELPSCOUT_DEFAULT_USER_ID` is set in prod
   (stock-control → Edge Functions → Secrets).

**Phase 1 — dry run (~1 week).** Full pipeline nightly in `dry_run` mode:
ledger rows written (structurally excluded from caps), Outbox panel shows the
fully-rendered would-send list + skip reasons + run heartbeat. The cadence
simulation counts dry rows so spacing and cap exhaustion are visible
night-over-night; dry rows are **retained** at the Phase 2 flip (structurally
excluded from cap maths) — they form the counterfactual baseline cohort for
the Analytics section below.

*Acceptance — a quiet week proves nothing without these:*

- **Positive control:** each run's candidate count reconciles against the
  dashboard's needs-attention chase-rule count for the same day; zero
  candidates while the dashboard shows eligible proofs **alarms**, not passes.
- The Outbox never lists a proof whose `helpscout_last_customer_reply_at`
  postdates its last outbound touch.
- A manually-chased proof visibly drops out of the would-send list (cheap
  end-to-end check of the webhook + grace path).
- A multi-link fixture (two `in_progress` proofs, one conversation, both
  flagged) exercises the grouped path.
- A multi-version fixture (or a live proof that ships a v2 during the dry
  week) demonstrates the cap re-arming per version while the lifetime ceiling
  keeps counting across versions.
- `recipient_mismatch` count is visible — non-zero also signals existing
  proof↔conversation links worth fixing in `/admin/customers`.
- Cadence/cap/grace decision logic is **unit-tested against synthetic ledger
  histories** — the send→webhook-stamp→grace-suppression loop cannot occur in
  dry-run, so tests are the only pre-launch coverage it gets.
- One-off bot-view audit on live `proof_version_views`: non-bot rows within
  ~10 minutes of a send, identical UAs across unrelated customers,
  datacentre-range IPs. Offenders → extend the UA regex and/or add a stricter
  automation-only view predicate; the dashboard keeps its looser definition.

**Phase 2 — auto-send `sent_never_viewed` only.** First week against an
allowlist (Rob's test contact + a handful of live proofs), then open up.
Review queue live for the other three rules.

**Phase 3 — measure and tune.** Primary metric: nudge→action
(`proof_events` approve / request_changes after a ledger row). Nudge→view is
indicative only (bot-filter noise). Tune thresholds/wording; consider the
Aircall escalation for exhausted proofs.

**Phase 2b interaction (future).** When the HS tag sync ships, decide
explicitly whether a "follow up" tag suppresses or boosts automation for a
proof that also satisfies `sent_never_viewed` — encoded in the job's input
query with a logged outcome, never decided silently by the 000154 priority
ordering. Reconcile the `enabled` drift (000154 seeds the tag rule enabled on
live; `DEFAULT_RULES` has it false).

## Analytics — measuring effectiveness

Derived, not collected: every metric computes from data the design already
records (`proof_nudges`, `proof_version_views`, `proof_events`,
`helpscout_last_customer_reply_at`, `nudge_runs`). No new tracking. One new
derived object: a `nudge_outcomes` SQL view — per sent nudge, the first
subsequent non-bot view, first customer action (approve / request_changes /
HS customer reply), and their time deltas, with an `attributed` flag (action
within a 72 h window and before any later outbound touch).

Headline metrics (rolling 30/90 days, split by rule and nudge number):

- **Response rate** (primary): % of nudges followed by a customer action
  within 7 days. Actions, not views — the bot-filter noise makes views
  untrustworthy as a primary signal.
- **Open rate** (indicative): % followed by a first non-bot view within
  3 days.
- **Funnel**: eligible → nudge 1 → nudge 2 → exhausted → human outcome, with
  drop-off at each step. The nudge-1 (same thread) vs nudge-2 (new
  conversation) response comparison doubles as the deliverability signal: if
  fresh conversations outperform, original sends are landing in spam.
- **Operational health**: skip-reason mix (`recipient_mismatch`,
  `skipped_closed_conversation`, `suppressed_sibling`, …), opt-out rate, cap
  exhaustion rate — guardrails firing too often is its own finding.

**Counterfactual baseline**: the Phase 1 dry-run rows record exactly which
proofs *would* have been nudged while nudging nobody — their natural response
rate over the same windows is the baseline Phase 2 sends are judged against
(like-for-like: stalled proofs vs stalled proofs, not stalled vs healthy).
This is why dry rows are retained, not purged.

Surface: a "Reminder performance" card on Admin → Needs-attention beside the
automation dials it informs. Honesty note in the UI copy: percentages are
noisy below ~30 nudges; judge trends, not single weeks. Wording A/B tests
stay out of scope until volume supports them.

## Open decisions (Rob)

1. **Trigger mechanism** — pg_cron + pg_net on the live project, or an external
   scheduler. (Recommendation: dashboard cron UI / external — free delivery
   logs and retries, no Vault plumbing.)
2. **Do manual nudges consume the per-version auto cap?** Default in this spec:
   yes (they always reset the cooldown regardless).
3. **Second-nudge-as-new-conversation** — confirm you're happy with a fresh
   thread/subject for nudge #2 (it splits the HS history across two
   conversations for that proof).
4. **The lifetime ceiling number** (spec says 6).

## Out of scope (this build)

- Designer-facing nudges for `request_changes_no_version`.
- Phase 2b tag sync itself (only its interaction rule is pre-decided here).
- SMS/phone channel automation — exhausted proofs surface for a *human* call.
- Any change to dashboard rule display semantics (`proofs_needing_attention()`
  keeps its collapsed single-rule emission for the UI).

## Provenance

Design decisions: session of 2026-06-09 (memory:
`project_followup_automation.md`). Hardening commitments: adversarial review of
2026-06-09 — five lenses (plan logic, send path, rules SQL, webhook/infra,
customer ops), 30 findings raised, 26 confirmed after independent refutation
attempts, 4 refuted, 2 gap findings (nudge-log grants; kill-switch scope) —
all encoded above.
