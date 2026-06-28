# Push Notifications for the Proof Viewer iOS Home-Screen App — Scoping Plan

This plan describes how to add configurable push notifications so you and your designers get a tap on your iPhone when something important happens in the Proof Viewer — a customer approves a proof, requests changes, pays for an order, opens a pay link, and so on. Each person controls which events notify them, and any designer can additionally "watch" a specific project to get its updates.

It is written so a non-coder can follow the reasoning, but with enough precision that an engineer can build it without re-deriving decisions. Status: **scoping only — no code, migrations, or edge functions have been written or applied.**

> **Two corrections, verified against source (latest migration is `000275`):**
> 1. **The "pay-link-opened gap" does not exist — it's already built and live.** Migration `000262` added `orders.pay_link_opened_at` and a token-validated setter `proofs.record_order_pay_link_opened(order_id, token)`; `000266` added a staff guard (`auth.uid() is null`) so a signed-in designer opening the link is a no-op. `OrderPayPage` already calls it, and `OrdersPage` + the dashboard already display it. **We do not build a parallel column or function — we hang the push onto the existing setter.**
> 2. **There is no "to-order / fulfilment" role.** The role CHECK is exactly `('admin', 'designer')` (migration `000035`). Chris is a `designer`. "Who gets fulfilment pings" is **not derivable from role** and must be made data-driven (Section 5). There is a `materials.production_route` column (in_house/supplier) but that's a property of the product, not the person.

---

## 1. Feasibility & constraints — what iOS actually allows

**The honest bottom line: feasible, with real limits.** A web app added to the iPhone Home Screen can receive push notifications since iOS 16.4 (March 2023). No Apple Developer account, no App Store, no APNs certificates — Apple's push servers speak the standard Web Push protocol any server can talk to. But iOS imposes hard rules:

1. **The app MUST be installed to the Home Screen.** Push does not work in a normal Safari tab on iPhone — only the installed app can subscribe. You and your designers already do this, so you clear the single hardest gate. Anyone who hasn't installed it sees an "Add to Home Screen first" instruction, not a broken button.
2. **Permission must come from a real tap**, and it's effectively **one shot**: if someone taps "Don't Allow", your code can never re-prompt — they'd have to fix it in iOS Settings. So the opt-in UX explains the value *before* asking.
3. **Every push must show a visible notification.** iOS forbids silent pushes; after ~3 offences it **revokes push permission entirely**. Push is only ever "show the user something", never quiet background sync.
4. **Delivery is best-effort, not guaranteed.** Pushes can be delayed, coalesced, or dropped if the phone is offline past the message's expiry; subscriptions die silently on uninstall or rotation. **Push is an extra fast nudge layered on top of Help Scout and email — never the only channel for anything the business depends on.** Help Scout stays the reliable record for every customer-facing event.
5. **Notifications are title + body + tap only.** No custom action buttons on iOS; copy truncates (title ~30 chars, body ~120 chars). Design for a short headline and one tap.
6. **Badges work** for installed Home-Screen apps (16.4+) — but see the badge caveat in Section 8.2.

**What already exists vs what is net-new** (verified directly in `index.html`):
- ✅ **Already there:** the Apple Home-Screen setup (`apple-touch-icon`, `apple-mobile-web-app-capable`, title, status-bar style). The app installs and launches chrome-free today. The pay-link-opened detection (000262/000266). A Netlify SPA — **must confirm** the 200-rewrite (Section 8.2).
- ❌ **Net-new — built from scratch:** a real Web App Manifest (`manifest.json`); a Service Worker (`sw.js`) — there is **no service worker in `src/` today**, this is the biggest new frontend piece; and all the push plumbing (VAPID keys, subscription storage, `send-push`, preferences, watches, outbox, kill switch).

> **Uncertainties carried forward honestly (not blockers):**
> - **EU/DMA:** EU iPhone PWAs have at times been forced to open as tabs (no push). Your staff are UK-based, so this doesn't affect them — but don't rely on push for any future EU *customer* device without re-checking.
> - **Deep-linking on a killed app** is less reliable on iOS than Android — a tap sometimes opens the app at its start screen instead of the target. We design a fallback (Section 8.2) and require on-device testing.
> - **`@negrel/webpush` inside Supabase Edge** is the single biggest technical unknown — verify with a standalone smoke test **before** any UI work (Section 9, Phase 0).
> - **`setAppBadge` in the service-worker context on iOS** is not confirmed — treat as best-effort, feature-detect, and drive the badge from the page where it's reliable (Section 8.2).
> - **iOS version floor:** set a tested minimum (recommend **iOS 17+**, test on 16.4 if any staff device is older) and record the actual iOS version of each test device — notificationclick/deep-link bugs are version-dependent.

---

## 2. Architecture overview — the end-to-end flow

```
  [Something happens]            [Server decides]              [Phone shows it]
  ───────────────────            ───────────────               ────────────────
  Customer requests changes  ┌─► send-push edge fn:            Service worker on the
   (proof-action inserts a   │   0. check master kill-switch   installed app receives
    proof_events row) ──────►│   1. resolve recipients         the 'push' event ──► always
                             │   2. apply prefs + watches       shows a banner; updates badge
  Customer pays an order     │   3. drop the actor              from the page on focus
   (stripe-webhook flips ───►│   4. truncate copy, build payload
    orders.status='paid')    │   5. write outbox row (dedup)   Designer taps the banner
                             │   6. fetch subscriptions        ──► opens app deep-linked to
  Customer opens pay link    │   7. encrypt + POST to Apple    /proofs/:id (or /orders),
   (EXISTING setter      ────┤   8. prune dead subs (404/410)  with a cold-open fallback
    record_order_pay_link_   │
    opened) wraps send-push  │   notify-sweep (cron):
                             │   trigger/condition events
  Proof finalises approved ──┘   (approved, to_order) with a
   (000126 trigger) ──────────►  deploy-time cutoff watermark
```

An event we already detect calls a new **`send-push`** edge function. It checks the master kill switch, figures out *who* should hear (project ownership + each person's preferences + per-project watches), truncates the copy, writes a dedup'd outbox row, looks up each recipient's phone subscription(s), encrypts a tiny payload, and hands it to Apple's push service. The phone's service worker wakes and **always** shows the banner. Tapping opens the right screen.

We hang `send-push` off events we already detect. We invent **no** new detection — the one place the original plan thought was a gap (pay-link-opened) already exists, so we reuse it.

---

## 3. Data model — new tables

Four new tables plus two existing-table additions, all in the `proofs` schema of the live merged project (`bjvinrzbdrwebylkmbwy`). They follow the established precedents: `proof_pins` (000155) and `proof_attention_snoozes` (000163) for per-user/per-proof shape + RLS; `needs_attention_rules` (000154) for JSON config; the 000176 grant matrix; and the 000178 `fedex_rate_cache` SELECT-only pattern.

> **Migration numbering:** the next free number is **`000276`** (verified: latest in source is `000275_order_xero_contact`). Re-run `ls supabase/migrations/0002*` immediately before writing — never infer from this doc. Write every migration **schema-qualified** (`proofs.`) and state the **full grant matrix explicitly** (the `proofs` schema has no default privileges; a new table is born with zero grants, service_role included). Each is applied to live via MCP `apply_migration` (Rob approves) — never CLI push.

### 3.1 `push_subscriptions` — one row per device a person enabled

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK default `gen_random_uuid()` | |
| `user_id` | uuid NOT NULL, FK `auth.users(id)` ON DELETE CASCADE | whose phone |
| `endpoint` | text NOT NULL UNIQUE | Apple push URL; UNIQUE so re-subscribe upserts cleanly |
| `p256dh` | text NOT NULL | subscription public key (encryption) |
| `auth` | text NOT NULL | 16-byte auth secret |
| `user_agent` | text | so a person recognises "iPhone" vs "Mac" in settings |
| `created_at` | timestamptz default now() | |
| `last_seen_at` | timestamptz default now() | bumped on re-subscribe; prune stale rows |
| `last_failure_code` | int | last HTTP status from a send (404/410 = dead) |

- **Index:** `(user_id)`.
- **RLS:** read/insert/update/delete **own rows only** (`using (user_id = auth.uid())`, `with check (user_id = auth.uid())`). `send-push` reads across all users via the service-role client (bypasses RLS).
- **Upsert behaviour:** the subscribe path must be `INSERT … ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, last_seen_at = now()`. A shared device or a reinstall that re-issues the same endpoint **re-homes** it to the current user rather than silently orphaning the old user's row.
- **Grants:** `GRANT SELECT, INSERT, UPDATE, DELETE … TO authenticated; GRANT ALL … TO service_role; REVOKE ALL … FROM anon, public`.
- **Deactivation hook:** the existing `deactivate-user` edge function must **delete this user's `push_subscriptions` rows** (and their `proof_watches`), so a locked-out account stops receiving customer data via push immediately, independent of token expiry.

### 3.2 `notification_preferences` — account-level per-event toggles

One row per user, a JSON map of event → setting (mirrors `needs_attention_rules`). JSON so adding events later needs no migration.

| Column | Type | Notes |
|---|---|---|
| `user_id` | uuid PK, FK `auth.users(id)` ON DELETE CASCADE | |
| `prefs` | jsonb NOT NULL default `'{}'` | `{ "<event_code>": "on" \| "off" \| "own_projects" }` |
| `quiet_hours` | jsonb | `{ "enabled": false, "start": "20:00", "end": "08:00", "tz": "Europe/London" }` |
| `badge_cleared_at` | timestamptz | drives the unread/badge model (Section 7) |
| `updated_at` | timestamptz default now() | |

- **The per-event value grammar is a fixed three-value enum:** `"on"` | `"off"` | `"own_projects"`. The resolver must handle all three identically at **both** the role-default layer and the personal-override layer.
- **Missing-row tolerance:** a fresh designer has **no row**. Every read path must `LEFT JOIN` and fall back to role defaults, never error.
- **RLS / grants:** own-row read+write; service-role full; anon revoked.

### 3.3 `proof_watches` — per-project "watch this" overrides, tri-state

Modelled on `proof_pins`, but a purely-additive watch can't express "only notify me about *this one* project" (the Donna example). So watches are **tri-state per event**.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `proof_id` | uuid NOT NULL, FK `proofs.proofs(id)` ON DELETE CASCADE | |
| `user_id` | uuid NOT NULL, FK `auth.users(id)` ON DELETE CASCADE | the watcher |
| `events` | jsonb NOT NULL default `'{}'` | `{ "<event_code>": "on" \| "off" }`; **empty `{}` = watch all notifiable events on for this project** |
| `created_at` | timestamptz default now() | |
| `created_by` | uuid FK `auth.users(id)` ON DELETE SET NULL | audit attribution |

- **Unique index:** `(proof_id, user_id)` — one watch per person per project, upsert pattern (like `proof_attention_snoozes`' `(proof_id, rule_code)`).
- **Semantics:** a watch entry of `"on"` for an event **forces it on** for that project even if the account default is off; `"off"` **forces it off** for that project even if the default is on. So a watch can both add ("hear more about X") and scope down ("only X"). Confirm with Rob which reading the three examples intend (Section 10, Q-Watch).
- **RLS:** all authenticated **read** (so the proof page can show "also watched by" — same open-read precedent as `proof_pins`). INSERT/UPDATE/DELETE with `with check (user_id = auth.uid() and created_by = auth.uid())` — pins `created_by` to `auth.uid()` (mirroring the 000159 `pinned_by` guard).
- **Grants:** authenticated CRUD; service-role full; anon revoked.

### 3.4 `notification_outbox` — the ledger of what we sent (and why)

A send log modelled on the `proof_nudges` convention: deduplication, "did Rob already get pinged?", and a debugging/observability trail. **Service-role writes only.**

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `event_code` | text NOT NULL | e.g. `customer_requests_changes` |
| `source_kind` | text NOT NULL CHECK in (`proof_event`,`order`,`proof_finalize`,`condition`) | discriminator so the three id namespaces can't collide |
| `source_event_id` | text NOT NULL | the originating id **plus a cycle discriminator** for condition events (see below) |
| `proof_id` | uuid FK `proofs.proofs(id)` **ON DELETE SET NULL** | nullable; SET NULL so deleting a proof doesn't erase the audit ledger |
| `order_id` | uuid FK `proofs.orders(id)` **ON DELETE SET NULL** | same |
| `recipient_user_id` | uuid NOT NULL, FK `auth.users(id)` ON DELETE CASCADE | who we notified |
| `title` / `body` / `url` | text | exactly what we sent (already truncated) |
| `status` | text NOT NULL CHECK in (`queued`,`sent`,`failed`,`skipped_pref`,`skipped_quiet`,`skipped_actor`,`skipped_killswitch`,`skipped_testmode`,`skipped_backfill`,`no_subscription`) | outcome, mirroring the nudge outcome-string pattern |
| `created_at` | timestamptz default now() | |

- **Dedup key:** unique index on `(event_code, source_kind, source_event_id, recipient_user_id)`. **Cycle-safe:** for condition/finalize events the `source_event_id` must carry a transition discriminator so a legitimate re-firing isn't suppressed forever. A proof legitimately re-enters `approved`/`to_order` after a reopen (`reopen_proof`, 000158) or a revision (000260). Use `source_event_id = '<proof_id>:<approved_at epoch>'` (or the revision generation) rather than a bare `proof_id`.
- **RLS:** authenticated **SELECT only**, predicate `recipient_user_id = auth.uid() OR proofs.is_admin()`. Follow the 000178 pattern exactly: enable RLS, `GRANT SELECT … TO authenticated`, **explicit** `REVOKE INSERT, UPDATE, DELETE … FROM authenticated`, `GRANT ALL … TO service_role`, `REVOKE ALL … FROM anon, public`.

### 3.5 Settings additions (on the existing singleton `settings` table, admin-only write)

```
settings.push_enabled                  boolean default false   -- MASTER KILL SWITCH
settings.notification_feature_since    timestamptz             -- deploy cutoff for the sweep (Section 9)
settings.fulfilment_user_ids           uuid[] default '{}'     -- who gets order/fulfilment pings (NOT a role)
settings.notification_role_defaults    jsonb                   -- baseline per role, value grammar on/off/own_projects
settings.notification_copy             jsonb                   -- admin-editable per-event title/body templates
```

- **`push_enabled` is the master gate.** `send-push` returns immediately with outbox status `skipped_killswitch` when false. Mirrors `auto_nudges_enabled` / `auto_order_reminders_enabled`. Ship it **false**; turn on after Phase 1's smoke test.
- **`fulfilment_user_ids` resolves the role problem.** Because Chris is a `designer` like everyone else, a role default would flip order pings on for *all* designers. Instead, order/fulfilment events resolve their natural recipients from this admin-managed array — data-driven, seeded in a migration (not a hand edit). Add/remove a fulfiller from Admin → Settings; no schema change.
- **`notification_role_defaults`** keys on the two real roles (`admin`, `designer`). Designers default to their **own projects'** change-requests/approvals/replies (`"own_projects"`); admins default to a chosen set.
- **`notification_copy`** makes the per-event title/body wording admin-editable (like reply templates / site copy).

---

## 4. Event taxonomy — notifiable events mapped to exact, real hooks

| Event code | Detection hook | Mechanism | Natural default recipient |
|---|---|---|---|
| `customer_requests_changes` | `proof-action` insert of `proof_events` (`event_type='request_changes'`); already posts to Help Scout | edge fn | The project's designer(s) — see Section 6. **High value.** |
| `proof_approve_per_recipient` | `proof-action` insert of `proof_events` (`event_type='approve'`) | edge fn | The project's designer(s). **Suppressed when it also finalizes the whole proof.** |
| `project_reaches_approved_status` | `maybe_finalize_proof_status` trigger (000126) + the 000218 promote path + the designer "Mark as approved" button | trigger / cron sweep | The project's designer(s). The "whole proof signed off" moment. |
| `customer_replies_by_email` | `helpscout-webhook` stamps `helpscout_last_customer_reply_at` | edge fn | The project's designer(s); a natural watch target for Donna. |
| `order_paid` | `stripe-webhook` flips `orders.status='sent'→'paid'` (idempotent) | edge fn | `orders.created_by` + everyone in `settings.fulfilment_user_ids` + admins. |
| `pay_link_opened` | **EXISTING** `proofs.record_order_pay_link_opened(order_id, token)` (000262) with the 000266 staff guard; `OrderPayPage` already calls it | RPC wrapper | `orders.created_by` + fulfilment users. The 000266 guard already makes a staff open a no-op — actor-suppression is free. |
| `project_reaches_to_order_status` | continuously-tested condition (`approved_no_order` rule, 000250/000261) | cron sweep + outbox dedup | Fulfilment users + admins. |
| `helpscout_agent_reply` | `helpscout-webhook` stamps `helpscout_last_reply_at` | — | **Not a push event** (no customer action). |

**The two events with no single firing point** (`project_reaches_approved_status`, `project_reaches_to_order_status`) are handled by a cron **`notify-sweep`**, not by wiring `pg_net` into a trigger. The outbox cycle-safe dedup key makes them safe against re-evaluation, and the **deploy-time cutoff** (`settings.notification_feature_since`) stops the first sweep from notifying every already-approved proof in history.

**Cross-event de-dup.** One customer action can fire two codes seconds apart — a per-recipient approval that *finalizes* the proof emits both `proof_approve_per_recipient` and `project_reaches_approved_status`. Rule: **`proof_approve_per_recipient` notifies only when it does NOT finalize the proof.** The change-request and reply paths additionally coalesce within a short window per `(recipient, proof)`.

**Pay-link-opened — corrected.** Do **not** build a new column/function. It exists as `orders.pay_link_opened_at` + `record_order_pay_link_opened` (000262/000266). Wire the push by extending that **existing** setter (or its `OrderPayPage` caller) to fire `send-push` after the stamp.

The other previously-mooted gaps (`order-sent-link-issued`, `customer_proof_view`) stay out of v1 — views are noisy, link-issued is the designer's own action.

---

## 5. Preference granularity — how toggles + watches combine

Three layers. Mental model: **role default → personal override → project watch (force-on or force-off).**

1. **Role default** (`settings.notification_role_defaults[role][event]`): baseline per the two real roles. Order/fulfilment events are **not** role-driven — they resolve recipients from `settings.fulfilment_user_ids`.
2. **Personal override** (`notification_preferences.prefs[event]` = `on`/`off`/`own_projects`): an explicit value wins over the role default. Absent = fall back to the role default.
3. **Per-project watch** (`proof_watches.events[event]` = `on`/`off`): scoped to one project; **wins over both**. `on` forces the ping even if the account default is off; `off` forces silence. Empty `events {}` = all notifiable events on for that project.

**The "send or not?" decision for one (person, event, project):**

```
shouldNotify(person, event, proof):
  watch = proof_watches[(proof, person)]
  if watch:
      if watch.events is empty:            return YES        # watch-all
      if event in watch.events:            return watch.events[event] == "on"
      # event not named in a non-empty watch → fall through to account-level
  pref = person.prefs[event]               # "on" | "off" | "own_projects" | absent
  if pref is set:
      if pref == "own_projects":           return isProjectDesigner(person, proof)
      return pref == "on"
  roleDefault = settings.notification_role_defaults[person.role][event]
  if roleDefault == "own_projects":        return isProjectDesigner(person, proof)
  return roleDefault == "on"
```

**Your three examples, satisfied:**
- *Approvals + pay-links to you (Rob):* admin role default `on` for those events (or your own-project scope) → you're a natural recipient on every order/approval.
- *To-order to Chris:* Chris's id in `settings.fulfilment_user_ids` → he gets `to_order`/`order_paid`/`pay_link_opened` without it firing for all designers.
- *One project's changes/replies to Donna:* Donna sets a **watch** on that proof with `change_request` + `email_reply` forced on (and, if she wants *only* that project, her account defaults set to `own_projects`/`off` so the watch is additive-and-scoped).

---

## 6. Recipient resolution — the precise algorithm

### Canonical "the project's designer"

"Current-version creator" and "project designer" **routinely diverge** here — a second designer can create v2 (carry-forward), "Set as current" (000218), or override-approve another's proof. **Decision, used everywhere identically:** the natural recipients for a proof-level event are the **deduplicated set** of:
- `proofs.created_by` (the true project originator), **and**
- the **current** `proof_versions.created_by` (whoever made the version in play).

Anyone else is covered by the watch table. Stated once, reused in `send-push` and `notify-sweep`.

### Actor identity must reach every send path

- **Customer events** (`customer_requests_changes`, `proof_approve_per_recipient`, `customer_replies_by_email`): the actor is the **customer**, who has no staff `user_id`. Suppression is a no-op — staff are notified.
- **`pay_link_opened`:** the 000266 staff guard already makes a staff open a no-op at the DB layer.
- **Designer-triggered finalize / promote / override:** the cron sweep has **no acting-user context**, so a designer who marks their own proof approved would self-ping. **Fix:** add `proofs.last_finalized_by uuid` (FK `auth.users`, SET NULL), stamped by the finalize/promote path, read by `notify-sweep` for self-suppression.

### The algorithm

```
resolveRecipients(event_code, context):   # context: proof_id and/or order_id, actor_user_id (may be null)
  candidates = {}
  # 1. Natural owners
  if event is proof-level:
      candidates.add(proofs.created_by); candidates.add(current proof_versions.created_by)   # deduped
  if event in {order_paid, pay_link_opened}:
      candidates.add(orders.created_by); candidates.add(settings.fulfilment_user_ids)
      if event == order_paid: candidates.add(all admins)
  if event == project_reaches_to_order_status:
      candidates.add(settings.fulfilment_user_ids); candidates.add(all admins)
  # 2. Everyone watching this project (force-on adds them even if their default is off)
  for w in proof_watches where proof_id = context.proof_id:
      if w.events empty OR w.events[event] == "on": candidates.add(w.user_id)
  # 3. Filter through preferences (force-off in a watch removes here)
  recipients = [ p for p in candidates if shouldNotify(p, event_code, proof) ]
  # 4. Drop the actor (persisted actor for designer events; customer actor null → no-op)
  recipients = [ p for p in recipients if p.user_id != context.actor_user_id ]
  # 5. Drop deactivated users defensively
  recipients = [ p for p in recipients if p.deactivated_at is null ]
  # 6. Quiet hours — drop per person, except the always-send set
  return recipients
```

For each surviving recipient, fetch all their `push_subscriptions` rows and send to each device.

---

## 7. Delivery pipeline — the `send-push` edge function

**Recommended single approach: a dedicated `send-push` edge function, invoked directly from where events are already detected.**

### How it's invoked
1. **✅ Direct call from the existing edge functions** (`proof-action`, `stripe-webhook`, `helpscout-webhook`, and the `record_order_pay_link_opened` caller) via `EdgeRuntime.waitUntil(fetch(send-push, …))` — fire-and-forget, the pattern `helpscout-webhook` already uses for the AI-draft pipeline and `proof-action` for the deferred Help Scout hide. **Failure-isolation:** wrap the dispatch so a thrown push error is caught/logged and **cannot** affect the existing chains or add customer-request latency.
2. ❌ DB trigger → `pg_net` → edge fn (more moving parts, silent failures).
3. ❌ Inline send in each edge function (duplicates VAPID/encryption).

For trigger-only / condition-only events, one **`notify-sweep`** cron edge function (reuse the weekday cron infra behind `send-nudges`/`send-order-reminders`) queries for proofs that newly reached `approved`/`to_order` **since `settings.notification_feature_since`**, reads `proofs.last_finalized_by`, and calls the shared send logic.

### Master + mode gates
- `settings.push_enabled = false` → outbox `skipped_killswitch`.
- **Test-mode order events:** while `settings.payment_mode = 'test'` or `settings.ordering_enabled = false`, gate `order_paid`/`pay_link_opened` → outbox `skipped_testmode`, so test orders never look like real sales.

### VAPID setup
- One P-256 ECDSA VAPID key pair. Store both as Supabase secrets (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`) plus `VAPID_SUBJECT` (`mailto:rob@plasmadesign.co.uk`). The **public** key also goes to the frontend via `VITE_VAPID_PUBLIC_KEY` (safe). The **private** key never leaves the edge runtime.
- **Library:** Deno-native **`jsr:@negrel/webpush`** (Web Crypto). The npm `web-push` package is Node-oriented and unreliable on Deno — do not use it.
- **Hand-rolled fallback precision:** if we hand-roll VAPID, the JWT `aud` claim must be `new URL(endpoint).origin` (e.g. `https://web.push.apple.com`), **not** the full endpoint, `exp ≤ 24h` — else Apple returns 401.

### Copy templates
Per-event copy lives in `settings.notification_copy` (admin-editable). **Free-text customer comments are customer-authored and shown on the lock screen** — sanitise and **clip server-side to the iOS limits (title ≤30, body ≤120)** before building *and* encrypting (also payload-size safety). Decide lock-screen privacy with Rob (Section 10 Q8). Example:

```json
{ "title": "Changes requested", "body": "Acme Ltd — “Logo too small on v2”", "url": "/proofs/8f3c…" }
```

### Sending loop, retries, cleanup
Per (recipient → subscription): encrypt + POST via the library.
- **`201`** → outbox `sent`.
- **`404` / `410 Gone`** → subscription dead: **DELETE that `push_subscriptions` row**, no retry. This is the **source of truth** for dead subscriptions (the `pushsubscriptionchange` event is unreliable on iOS).
- **`429`** → short back-off. **`413`** → payload too large (shouldn't happen with clipped copy — log).
- **TTL by urgency:** short TTL for ephemeral events (`pay_link_opened`); **longer (24h+)** for `order_paid` / `customer_requests_changes` so an overnight-offline phone still gets it.

### Dedup / coalescing
Insert the outbox row **first** (status `queued`); a unique-violation on `(event_code, source_kind, source_event_id, recipient_user_id)` means already handled — skip. Makes webhook retries (Stripe, Help Scout) safe; the cycle-discriminator keeps honest re-firings alive.

### Quiet hours
Per `notification_preferences.quiet_hours`. Handle the **overnight wrap** (e.g. 20:00–08:00) and compare in the stored `tz` with BST/GMT. **Don't silently swallow money events:** the always-send set — `order_paid`, `customer_requests_changes` — **pierces quiet hours** (Rob's call, Q-Quiet). Everything else inside the window → `skipped_quiet`, not sent in v1 (no deferred queue).

### Read / unread / badge model
- The **outbox is the unread source**: a recipient's unread = count of their `sent` outbox rows since `notification_preferences.badge_cleared_at`.
- **Drive the badge from the page, not the push handler:** on app focus/launch and on `notificationclick`, the app computes the unread count and calls `navigator.setAppBadge(count)` / `clearAppBadge()`. The service worker attempts a best-effort badge only if `'setAppBadge' in self.navigator`.

### Batching
Out of scope for v1 (each event = one push). Add a per-recipient daily cap / digest only if volume becomes annoying (Q-Volume).

---

## 8. Frontend + iOS-correct opt-in UX

### 8.1 The Web App Manifest (net-new)
Add `public/manifest.json`: `name`, `short_name: "Proofs"`, `start_url: "/"`, `id: "/"`, `display: "standalone"`, `theme_color`, `background_color`, the existing 180×180 icon + a 512×512. Link from `index.html` **alongside** the existing Apple meta tags (keep both).

### 8.2 The Service Worker (net-new — the core new client piece)
Add `public/sw.js` at the site root. **Push-only — three handlers, and a hard rule:**

> **The service worker MUST contain NO `fetch`/caching handler.** Adding one later to a Vite SPA risks serving **stale hashed bundles**. Keep `sw.js` cache-free: `push` + `notificationclick` + `pushsubscriptionchange` only.

- **`push`** — `event.data.json()`, then **always** `self.registration.showNotification(...)` (no-silent-push rule). Then a **best-effort, feature-detected** badge: `if ('setAppBadge' in self.navigator) …` (unverified in SW context on iOS — the reliable badge happens from the page).
- **`notificationclick`** — `close()`; `clients.matchAll(...)` → if a window is open, `client.navigate(url)` + `focus()`; else `clients.openWindow(url)`. Build the absolute URL from `self.registration.scope`.
- **`pushsubscriptionchange`** — re-subscribe with the stored VAPID public key and POST the fresh subscription. **Opportunistic backup only** (unreliable on iOS); the reliable freshness mechanisms are 410/404 send-time pruning + re-subscribe-on-launch.

> **SPA deep-link routing:** `clients.openWindow('/proofs/:id')` on a **cold** open hits the server for that path. **Confirm/require the Netlify SPA 200-rewrite** (`/* → /index.html 200`) so deep paths resolve to the SPA shell instead of 404.

**Registration & readiness:** register at app boot (`src/lib/auth.tsx` bootstrap). **Await `navigator.serviceWorker.ready`** before enabling the subscribe button / calling `subscribe()`.

**iOS deep-link cold-open fallback:** a killed app sometimes opens at `start_url`. Have the `push` handler `postMessage` the target to any open client and/or stash a "pending deep link" key the app reads once on launch. **Test foreground / background / fully-killed.**

### 8.3 The gesture-gated opt-in (iOS-correct)
A **"Enable notifications on this device"** card (`PanelShell` + `Button`):
- **Feature-detect, never UA-sniff:** show the button only when `'serviceWorker' in navigator`, `'PushManager' in window`, AND standalone (`matchMedia('(display-mode: standalone)')` || `navigator.standalone`).
- **Not installed?** Friendly instruction card: "Add Proof Viewer to your Home Screen first (Share → Add to Home Screen), then come back."
- **Explain value before asking**, then on tap `Notification.requestPermission()` → on `granted`, **convert the VAPID key first:**

```js
// urlBase64ToUint8Array — iOS WebKit requires a Uint8Array, NOT the raw base64url string
const appServerKey = urlBase64ToUint8Array(import.meta.env.VITE_VAPID_PUBLIC_KEY)
await navigator.serviceWorker.ready
const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appServerKey })
// POST sub.toJSON() to save-push-subscription (authenticated upsert ON CONFLICT (endpoint))
```

Passing the base64 string straight to `subscribe()` **throws on iOS** — conversion is mandatory.
- **Don't burn the prompt:** if `Notification.permission === 'denied'`, show "turn them back on in iOS Settings → Notifications → Proof Viewer", not a dead button.
- **Re-subscribe-on-launch reconciliation:** on launch, compare the live `PushSubscription` to the stored one and re-POST on mismatch.

### 8.4 Per-account settings screen
New page `/settings/notifications` (template `AdminSettingsPage.tsx`):
- The per-device enable card + a list of this account's `push_subscriptions` (showing `user_agent` to remove an old device).
- **Per-event toggles** writing `notification_preferences.prefs` (`on`/`off`/`own_projects`), pre-filled from the role default.
- **Quiet hours** control.
- **"Disable all notifications for my account"** single switch (distinct from the admin master switch).
- **"Send a test push to my devices"** button.

### 8.5 Per-project watch toggle
On `ProofDetailPage.tsx`, near the existing pin/snooze affordances, a **"Watch this project"** control that upserts/deletes a `proof_watches` row for `(proof_id, auth.uid())`, with a compact per-event picker (force-on / force-off / inherit). Show "Also watched by: [avatars]" (mirrors `proof_pins`).

### 8.6 Admin observability page
A small **Admin → Notifications** page reading `notification_outbox`: recent sends + status counts ("did my push send, and if not why?"), plus a **health/heartbeat row** mirroring `send-nudges` so a wholesale failure is visible.

---

## 9. Phased rollout — small, shippable, buildable steps

Each phase is one or a few PRs, each independently `pnpm build`-clean.

**Phase 0 — De-risk the unknown, then scaffold.**
1. **Standalone VAPID spike (first):** a throwaway edge function that sends one real push to a `*.push.apple.com` endpoint via `@negrel/webpush`, confirming it works in Supabase Edge. Time-box the hand-rolled fallback if it fails. **No UI until this passes.**
2. Add `manifest.json`, register an empty-but-valid **cache-free** `sw.js`, **confirm the Netlify SPA 200-rewrite**, confirm the installed app still launches chrome-free and the SW registers on a real iPhone.

**Phase 1 — Vertical slice: `customer_requests_changes` only, designer-only, no preferences UI.**
- Migration `000276`: `push_subscriptions` only (with the `ON CONFLICT (endpoint)` upsert + the `deactivate-user` cleanup).
- Frontend: gesture-gated enable card + `urlBase64ToUint8Array` + `serviceWorker.ready` await + subscribe + save. Hard-code "notify the canonical project designer pair".
- Edge: `send-push` (kill-switch check, VAPID, clip copy, encrypt, send, 410-cleanup) wired into `proof-action`'s change-request path via `EdgeRuntime.waitUntil` with failure isolation.
- **Goal:** Rob requests a change as a test customer on his own proof, a real banner lands on his iPhone, tapping it deep-links to the proof. Flip `settings.push_enabled` on only after this passes.

**Phase 2 — Preferences + outbox + dedup + kill-switch surfaces.**
Add `notification_preferences` + `notification_outbox` + the `settings` additions. Wire the recipient-resolution algorithm, the canonical-designer pair, actor suppression (incl. `proofs.last_finalized_by`), the cross-event de-dup rule, the per-account settings screen, the account-level disable-all, and the "send test push to me" button.

**Phase 3 — More events + read/badge model + observability.**
Wire `proof_approve_per_recipient` (with finalize-suppression), `project_reaches_approved_status` (+ `notify-sweep` with the deploy-cutoff), `customer_replies_by_email`, `order_paid` (test-mode-gated). Add the read/unread/badge model + page-driven badge. Add Admin → Notifications + heartbeat.

**Phase 4 — Per-project watches.**
Add `proof_watches` (tri-state) + the watch toggle on the proof detail page. Delivers the Donna requirement.

**Phase 5 — Pay-link + to-order + polish.**
Wire `pay_link_opened` onto the **existing** setter (no new column). Wire `project_reaches_to_order_status` via the sweep. Quiet-hours enforcement (overnight wrap + always-send), `pushsubscriptionchange` + re-subscribe-on-launch self-healing. Real-device acceptance checklist (Section 11).

---

## 10. Decisions for Rob

1. **Which events ship (Phase 3)?** Recommendation: `customer_requests_changes`, `proof_approve_per_recipient`, `project_reaches_approved_status`, `customer_replies_by_email`, `order_paid`. In or out — `pay_link_opened`?
2. **Default recipients per role.** Confirm: designers default to *their own projects'* change-requests + approvals + replies; admins (you) get your own projects + orders only, or **everything** (firehose)?
3. **Fulfilment recipients.** Confirm we put **Chris (and you?)** in `settings.fulfilment_user_ids` for `order_paid` / `to_order` / `pay_link_opened`, seeded **in a migration**. (Replaces the impossible "to-order role".)
4. **Paid-order pings — you AND Chris, or just Chris?**
5. **Q-Watch — what does "just this one project to Donna" mean?** Opt-IN-*more* (watch adds), or scope-DOWN (only this project, mute the rest)? The tri-state watch supports both; your answer sets the default.
6. **Q-Quiet — should `order_paid` / `customer_requests_changes` pierce quiet hours?** (Recommended yes.) Do quiet hours mute everything else?
7. **Q-Volume — a per-recipient daily cap / digest threshold?** Or accept an uncapped stream in v1?
8. **Lock-screen privacy** — include the customer/company name in the body? Show a truncated change-request comment, or generic "requested changes"?
9. **EU customers** — confirm all staff devices are UK (so we ignore the EU/DMA PWA-push uncertainty for staff).
10. **Go-live gating** — confirm push for `order_paid`/`pay_link_opened` stays `skipped_testmode` until `settings.payment_mode = 'live'`.

---

## 11. Risks & gotchas

**iOS-specific:** one-shot permission (denial sticky, recover only via iOS Settings); no-silent-push revocation (always `showNotification`); VAPID key must be a `Uint8Array` (mandatory conversion); `serviceWorker.ready` before first `subscribe()`; `setAppBadge` in SW unverified (drive badge from page); deep-link on killed apps (pending-deep-link stash + Netlify 200-rewrite + on-device testing); install gate (`PushManager` absent in a tab — feature-detect + standalone check); truncation (clip server-side, no action buttons).

**Operational:** subscription churn (410/404 send-time delete is the source of truth; re-subscribe-on-launch; `pushsubscriptionchange` only as backup); no-fetch-handler rule (never cache in `sw.js`); VAPID key storage (private key as Supabase secret; one pair — rotating invalidates every subscription); double-sends (outbox row first + unique index; `order_paid` idempotent; cross-event finalize-suppression); re-firing across reopen/revision (cycle discriminator); outbox audit survives deletes (SET NULL FKs); self-notification (`proofs.last_finalized_by` + 000266 guard + null customer actor); quiet hours can't swallow money events (always-send set); push never the only channel (Help Scout + email remain the record); failure isolation on hot paths; deactivated-user data leak (`deactivate-user` deletes subs/watches); test-mode order pings gated by `payment_mode`; master kill switch (`settings.push_enabled`); observability (Admin → Notifications + heartbeat); grant/RLS footguns (explicit grant matrix; SELECT-only outbox needs explicit `REVOKE`; pick the migration number by `ls`, next is `000276`).

**Real-device acceptance checklist:** on a real iPhone at the tested iOS floor — (1) install-gate card shows in a Safari tab, enable card shows when standalone; (2) value-first prompt → granted → subscription saved; (3) banner arrives for a real change-request; (4) tap deep-links in foreground / background / **fully-killed**; (5) denied-permission recovery copy shows; (6) badge increments on send, clears on focus; (7) a second device test; (8) re-subscribe-on-launch re-homes a rotated subscription; (9) the master kill switch silences sends. Record each device's iOS version.

---

## Phase 1 in one page — for green-lighting the first slice

**What it proves:** that a push notification can travel from a real customer action all the way to a banner on your iPhone, and tapping it opens the right proof. Nothing more — one event, one recipient (you), no settings screens yet.

**What gets built:**
- A throwaway **VAPID spike first** — one real test push to Apple's servers from the edge runtime — to confirm the push library works on Supabase before any UI. If it fails, we fall back to a documented hand-rolled method (time-boxed).
- A **`manifest.json`** and a small **`sw.js`** background script (push-only, no caching), confirming the installed app still works and Netlify serves deep links.
- One new table, **`push_subscriptions`**, storing which phones to notify.
- An **"Enable notifications on this device"** card that — only when it's the installed Home-Screen app — explains the value, then on your tap asks iOS for permission and saves your phone.
- A **`send-push`** function wired to the existing "customer requested changes" detection point, behind a **master on/off switch** so nothing fires until you flip it.

**The single success test:** with the switch on, you act as a test customer and request a change on one of your own proofs. A banner appears on your iPhone; you tap it; the app opens to that proof.

**Cost/risk:** small and self-contained. No customer-facing change, no money flow touched, no effect on Help Scout, email, or the existing pay-link tracking. The biggest unknown (does the push library run on Supabase) is settled in the spike before anything else is built.

---

## Key files/anchors an engineer will touch

- **Existing detection hooks:** `supabase/functions/proof-action/index.ts`; `supabase/functions/stripe-webhook/index.ts`; `supabase/functions/helpscout-webhook/index.ts`.
- **Existing pay-link infra to reuse (do not rebuild):** `supabase/migrations/000262_order_pay_link_opened.sql`, `supabase/migrations/000266_pay_link_open_staff_guard.sql` (`orders.pay_link_opened_at` + `record_order_pay_link_opened`); caller `src/pages/OrderPayPage.tsx`; surfaced in `src/pages/OrdersPage.tsx` + `src/lib/dashboardGrouping.ts`.
- **New edge functions:** `supabase/functions/send-push/`, `supabase/functions/save-push-subscription/`, `supabase/functions/notify-sweep/` (no `order-link-opened` — it exists).
- **New frontend:** `public/manifest.json`, `public/sw.js`; settings page templated on `src/pages/admin/AdminSettingsPage.tsx`; watch toggle in `src/pages/ProofDetailPage.tsx`; SW registration in `src/lib/auth.tsx`; UI from `src/design/`. **Netlify:** confirm/add the SPA 200-rewrite.
- **New migrations:** next free number **`000276`** — verify with `ls supabase/migrations/0002*` before writing.
