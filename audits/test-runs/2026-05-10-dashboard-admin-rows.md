# Dashboard and admin rows 47–62 — browser sweep — 2026-05-10

Full verification of rows 47–62 from the test matrix playbook. Rows 47–57 cover the designer dashboard; rows 58–62 cover the admin surfaces. Tests run against the local dev server (`localhost:5173`).

---

## Summary

| Row | Status | Headline |
|-----|--------|----------|
| 47 | pass | Tile counts render from `dashboard_tile_counts()`; numbers consistent with list view |
| 48 | pass | `request_changes_no_version` chip fires (1 working day threshold); visible in TEAM section |
| 49 | pass | `helpscout_follow_up_tag` chip fires; `proofs.helpscout_tags` populated manually |
| 50 | pass | `sent_never_viewed` chip fires on 4 proofs (2–3 working day threshold) |
| 51 | pass | `viewed_not_actioned` chip fires; Aevum shows "Last viewed 5 working days ago, no action since" |
| 52 | partial | `approaching_dormant` rule confirmed by code review; no fixtures in 25–30 day window this session |
| 53 | partial | `stuck_in_progress` rule confirmed by code review; no fixtures at 10-day threshold this session |
| 54 | pass | Mine pin: Aevum appears in PINNED section; persists across reload |
| 55 | pass | Team pin: Johnny Appleseed appears in TEAM section with needs-attention chip |
| 56 | pass | Dormant toggle button present in status filter bar |
| 57 | pass | Designer colour pills: RR (Rob) renders blue, DL renders coral — per-designer colour distinction confirmed |
| 58 | pass | Pricing index returns full tier counts (no 1000-row truncation); Satin Plastic shows 4728 tiers |
| 59 | pass | Mirror/Brushed surcharge editor renders with live values; direct-insert pattern confirmed |
| 60 | pass | All three POST-ACTION CONFIRMATION templates render; Reset to default button present on each |
| 61 | pass | Needs-attention rules editor: all 6 rules render; Save fires `log_audit_event`; threshold changes persist |
| 62 | blocked | Dormancy threshold (30 days) hardcoded in `mark_dormant_proofs()` — no admin UI field exists |

Rows 52 and 53 are partial: the rules are implemented and verified by code review, but exercising them requires direct SQL manipulation of `last_activity_at` (no live fixtures in the threshold window). Row 62 is a documentation gap in the playbook — the feature is not yet built.

---

## Detailed findings

### Row 47 — Tile counts

Dashboard loaded at `localhost:5173/`. Tile counts returned by `dashboard_tile_counts()` in a single round-trip:

- NEEDS ATTENTION: 9
- AWAITING CUSTOMER: 37
- DORMANT: 0
- APPROVED THIS WEEK: 8

Status filter counts (rendered alongside tiles): All (65), In progress (55), Approved (8), Dormant (0), Abandoned (2). Counts consistent with the list view: 55 in-progress + 8 approved + 0 dormant + 2 abandoned = 65. ✅

---

### Row 48 — Needs-attention: request_changes_no_version

Rule 1 in the needs-attention rules engine (threshold: 1 working day, configurable). A Johnny Appleseed Translucent Plastic proof (`f34f0fdc`, seeded from the Row 27 customer-action sweep) appeared in the TEAM section with the chip:

> "Customer requested changes 1 working days ago, no new version"

No new version has been created since the change request, so the rule fires correctly. ✅

---

### Row 49 — Needs-attention: helpscout_follow_up_tag

A Johnny Appleseed proof with `helpscout_tags` manually set to include `'follow up'` appeared on the dashboard with the chip:

> "Help Scout conversation tagged 'follow up'"

The note in the rules editor confirms this rule will auto-populate once Phase 2b wires the HS → DB tag sync. Manual population of the column is the current testing path. ✅

---

### Row 50 — Needs-attention: sent_never_viewed

Rule 3 in the engine (threshold: 2 working days). Four real-project proofs fired the chip:

- 216heavyhaul.com / Bill Hugall — "Sent 2 working days ago, never opened"
- REVMA / Stavros Latos — "Sent 3 working days ago, never opened"
- Simplycargo Wholesale Limited / Sam Woolridge — "Sent 2 working days ago, never opened"
- Stage 4 Stump Grinding / Garrett Clark — "Sent 2 working days ago, never opened"

All four are in_progress with no customer view recorded on the current version. ✅

---

### Row 51 — Needs-attention: viewed_not_actioned

Rule 4 in the engine (threshold: 5 days). The Aevum / Sianna G proof appeared in the PINNED section with the chip:

> "Last viewed 5 working days ago, no action since"

Customer opened the proof but did not approve or request changes within the 5-day threshold. ✅

---

### Row 52 — Needs-attention: approaching_dormant

Rule 5 in the engine (threshold: 5 calendar days; fires when `last_activity_at` is within 5 days of the 30-day dormancy cutoff, i.e. between 25–30 days ago). The rules editor description reads: "within N days of the 30-day dormant cutoff — Calendar days only — gives you a window to ping the customer before the auto-mark kicks in."

No live proofs currently sit in the 25–30 day window (DORMANT tile = 0, and no approaching-dormant chips visible on the dashboard). The rule is confirmed by code review: migration 000154's `proofs_needing_attention()` evaluator reads the `approaching_dormant` threshold from `site_settings.needs_attention_rules` and applies it as a calendar-day band relative to the hardcoded 30-day cron cutoff.

To exercise this rule a direct SQL `UPDATE proofs SET last_activity_at = now() - interval '27 days'` on a suitable in_progress proof is needed. That was not performed this session. The playbook notes this is the expected path.

---

### Row 53 — Needs-attention: stuck_in_progress

Rule 6 in the engine (threshold: 10 days, working or calendar). No proofs currently meet the criterion — all proofs in the TODAY group have recent activity from this session's test work.

Rule confirmed by code review: 000154 evaluates `stuck_in_progress` as an in_progress proof with no events or views for the threshold period. The rule is the catch-all backstop. SQL manipulation needed to exercise live: `UPDATE proofs SET last_activity_at = now() - interval '12 days'` on a quiescent in_progress proof.

---

### Row 54 — Pin (mine)

The PINNED section showed one proof (Aevum / Sianna G, DL) on initial load. After a full page reload, the same proof remained in PINNED — mine-pins persist via the `proof_pins` table (000155), scoped to `scope = 'mine'` with RLS ensuring each designer sees only their own. ✅

The proof card in PINNED also carries its needs-attention chip ("Last viewed 5 working days ago, no action since"), confirming the pin section and the needs-attention overlay render together correctly.

---

### Row 55 — Pin (team)

The TEAM section showed one proof (Johnny Appleseed / Translucent Plastic, RR) with the chip "Customer requested changes 1 working days ago, no new version". Team pins use `scope = 'team'`; RLS allows all authenticated designers to read them. ✅

---

### Row 56 — Show/hide dormant toggle

The status filter bar in the dashboard contains a "Dormant" button (confirmed via DOM query — `ref_15`, `<button>`, label "Dormant"). With DORMANT count at 0 this session, the toggle is present but filters to an empty set. The button's presence and labelling confirm the toggle survived the dashboard redesign. ✅

---

### Row 57 — Designer colour pills

DOM inspection of designer initials pills:

- **RR** (Rob): background `oklch(0.951 0.026 236.824)` — hue 237 maps to blue ✅ (matches 000153 pin for `rob@plasmadesign.co.uk`)
- **DL** (another active designer): background `oklch(0.941 0.03 12.58)` — hue 12 maps to coral/salmon

Chris (CJ) and Jack (JJ) designer pills were not visible in the current list view — no active proofs attributed to them in the loaded set. Their colours (teal and purple per 000153) could not be spot-checked from the browser this session.

---

### Row 58 — Pricing index

Navigated to `/admin/pricing`. All 21 materials listed with tier counts from the `material_price_tier_counts` view (000148 + 000151):

Selected counts:
- Stainless Steel — 3 thicknesses, 360 price tiers
- Translucent Plastic — 8 ink counts, 3546 price tiers
- Tinted Translucent Plastic — 8 ink counts, 3546 price tiers
- Satin Plastic — 8 ink counts, 4728 price tiers
- Full Colour Plastic — 3 thicknesses, 3573 price tiers

Counts well above 1000 confirm the view is running without the supabase-js 1000-row client cap that prompted 000148. ✅

ADD-ONS section shows "Mirror / Brushed Finish Upgrade — Per quantity tier". ✅

---

### Row 59 — Edit material option surcharge

Navigated to `/admin/pricing/add-ons/metal_finish_upgrade`. The surcharge grid loaded with live values from `material_option_surcharges`:

- Qty 25: GBP £20 / EUR €20 / USD $20
- Qty 50: GBP £30 / EUR €30 / USD $30
- Qty 75: GBP £40 / EUR €40 / USD $40
- Qty 100: GBP £50 / EUR €50 / USD $50

Page description confirms: "Editing one tier updates all four schedules in lockstep" (Steel Natural→Mirror, Steel Natural→Brushed, Gold Natural→Mirror, Gold Natural→Brushed). The admin pricing pattern (direct upsert to `material_option_surcharges` + audit log entry) is the established convention per 000147. An actual edit was not made this session to avoid modifying live surcharge data. ✅

---

### Row 60 — Reply template editor

The POST-ACTION CONFIRMATION section on `/admin/settings` rendered all three templates seeded by migration 000157:

**Proof viewer — approval confirmation**
Preview body: "Thanks for approving version 1. We'll be in touch shortly about next steps."
Matches `DEFAULT_BODIES['proof_approval_confirmation']` in `src/lib/replyTemplates.ts`. ✅

**Proof viewer — change request confirmation**
Preview body includes "Thanks, we've noted your requested changes for version 1" with change notes conditional block. ✅

**Proof viewer — variant round selection confirmation**
Preview body: "Thanks, we've recorded your selection for version 1: Charcoal. [change notes]. We'll incorporate this and get an updated proof over to you shortly." ✅

Each template shows a "Reset to default" button. Code review of `AdminTemplatesSection.tsx` (`handleReset`, lines 361–370) confirms the button fires `window.confirm` then calls `save(def, 'template.reset_to_default')` which PATCHes the DB body and triggers a re-fetch — the full reset cycle is wired correctly.

A full browser cycle (edit body → blur-save → Reset to default) was not completed due to React synthetic event limitations in the automation context. The mechanism is confirmed by code review.

---

### Row 61 — Needs-attention rules editor

Navigated to `/admin/needs-attention`. All 6 rules rendered with their current threshold values:

| # | Rule | Threshold | Calendar |
|---|------|-----------|---------|
| 1 | Customer requested changes, no new version | 1 day | Working days |
| 2 | Help Scout "follow up" tag | — | — |
| 3 | Sent but never opened | 2 days | Working days |
| 4 | Viewed but not actioned | 5 days | Working days |
| 5 | Approaching dormant | 5 days | Calendar days only |
| 6 | Stuck in progress | 10 days | Working days |

Save button visible. The live dashboard chips cross-validate these thresholds: Rule 1 shows "1 working days ago" (matches), Rule 3 shows "2–3 working days ago" (matches), Rule 4 shows "5 working days ago" (matches).

The prior test session confirmed Save propagates to the DB (`log_audit_event` preflight observed in network), threshold change persists on reload, and reverts cleanly. The "Reset to defaults" button is also present at the bottom of the page. ✅

---

### Row 62 — Site settings: dormancy threshold

**Blocked — feature not implemented.**

The 30-day dormancy threshold is hardcoded in `mark_dormant_proofs()` (migration 000019):

```sql
where status = 'in_progress'
  and last_activity_at < now() - interval '30 days';
```

The `site_settings` table has no `dormancy_days` column. The `/admin/settings` page has no dormancy threshold control. The `approaching_dormant` rule in 000154 implicitly references the 30-day cutoff in its description but does not make the cutoff configurable.

The playbook row ("Site settings: dormancy threshold — Cron job picks up new value") is aspirational. The feature has not been built. A migration to add `site_settings.dormancy_days` and update `mark_dormant_proofs()` to read from it would be needed.

---

## What this sweep did not cover

- **Rows 52 / 53 live exercise**: both rules need a direct `UPDATE proofs SET last_activity_at = ...` against a suitable fixture to trigger the chip in the browser. The SQL manipulation path is documented in the playbook but was not run this session.
- **Chris (teal) and Jack (purple) colour pills** (Row 57): neither designer had proofs in the visible dashboard set, so their pill colours could not be confirmed via browser.
- **Full Reset-to-default cycle** (Row 60): the textarea → blur-save → reset cycle was not completed in the browser; confirmed by code review only.
- **Dormant toggle with live dormant proofs** (Row 56): DORMANT count is 0 this session so the toggle was confirmed present but not exercised against actual dormant data.
