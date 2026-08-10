# Xero re-scrape — build spec

Deepening the Reorder register, and wiring what it knows into the order builder.

Status: **proposed, not built.** Nothing here has been applied to live. Written
10 Aug 2026 against live (`bjvinrzbdrwebylkmbwy`), the register as it stood that
day (2,758 rows), and the surviving seed artefacts from 9 Aug 2026.

---

## 1. What this is for

When a returning customer comes back, the designer building their order has to
work out what they bought last time — and for anyone whose history predates the
app, that means digging through old Help Scout threads and Xero invoices by
hand. The Reorder register already holds three and a bit years of that history,
scraped from Xero, but it is not plugged into the order builder and it does not
know which *finish* anyone chose. This spec covers three pieces of work: reading
the finish off the Xero invoices, wiring the register into the order builder's
"Their last order" suggestion, and (optionally) scraping further back than
1 April 2023.

Rob's own framing of the problem: *entering a returning customer's previous
thickness and finish into the order builder is manual, and means searching
across legacy systems.*

---

## 2. What we have today

### 2.1 The register

`proofs.reorder_prospects` — **2,758 rows**, measured live 10 Aug 2026.

| | |
| --- | --- |
| Rows | 2,758 (2,739 scraped from Xero + 19 enrolled from app orders) |
| Date range | first order 1 Apr 2023 → last order 7 Aug 2026 |
| With an email | 2,708 |
| With a spec phrase (`last_spec`) | 2,575 |
| With a quantity (`last_qty`) | 2,575 |
| With a variant **label** (`last_variant_label`) | 2,263 |
| With a variant **id** (`last_variant_id`) | **1,039** |
| With a material id (`last_material_id`) | 2,158 |
| Linked to an app contact (`matched_contact_id`) | 195 |
| States | 2,405 pending · 348 suppressed · 5 queued |
| Contacted so far | **0** — no outreach has actually gone out yet |

A nightly job (`proofs.reconcile_reorder_register()`, pg_cron job 14, 02:00)
folds new app payments into it and re-scores every row.

### 2.2 What it can answer

- *When did this customer last buy, and how many did they order?* — 2,575 rows.
- *Roughly what were they?* — a sentence like `"500 letterpress cards (900gsm)"`.
- *Exactly which catalogue thickness?* — only 1,039 rows. The other 1,224 have a
  label we cannot resolve to anything we still sell (`"760 micron"`, `"900gsm"`,
  `"400gsm"`, `"3mm thick"`).

### 2.3 What it cannot answer, and why

**It has never known a finish.** Not "rarely" — never. Measured on live: rows
whose `last_spec` mentions mirror = **0**, brushed = **0**, natural = **0**,
gloss = **0**. (The 243 rows that match a naive finish-word search are all
material *names* — "matte black metal", "matt laminated".)

The reason is structural, and it took some digging to establish. The seed
composed `last_spec` from the Xero **item name**, not the line **description**.
Two invoices prove it beyond doubt:

- INV-25885 — description says `"Matt black metal card"` (one t), item name says
  `"Matte black metal card"` (two t's). The register stored **matte**.
- INV-25883 — description says
  `"Gold metal business cards (500 micron with brushed finish)"`, item name says
  `"Gold metal cards (500 micron)"`. The register stored the item name, and the
  word *brushed* was thrown away.

The item name is a controlled list — only **63 distinct labels** across 4,389
invoice lines — so it is clean, consistent and finish-free. The finish only ever
existed in the free-text description.

### 2.4 What the order builder does today

`proofs.last_paid_order_for_proof(proof_id, material_id)` (migration 000364)
answers "Their last order" from **orders we hold in the app**. Measured across
all 226 approved proofs on live:

| | n |
| --- | --- |
| Answered by the app today | **172** |
| Would be answered by the register under this spec | **20** |
| Answered by neither | **34** |

Of those 20, eleven are material-confirmed and only **five** carry a usable
thickness id. So this is a small, honest gain today — not a coverage
transformation. Its value grows with how far back the register reaches, not with
time.

### 2.5 Three known defects in the seeded data

Found while researching this, all still live, none requiring a scrape to fix:

1. **40 rows read `"carbon Fibre Cards"`** — a lower-casing helper only touched
   the first character of a Title Case item name.
2. **41 rows pair a spec with the wrong date.** The seed picked the most recent
   *single-product* invoice for the phrase but the most recent invoice of any
   kind for the date. Worst case: Gestion AHD inc., whose phrase comes from
   March 2025 while the row says they last ordered July 2026.
3. **23 rows have a mixed-currency lifetime value** — dollars added to pounds,
   then labelled with whichever currency they used most.

### 2.6 There is no seeding code

Worth stating plainly, because it shapes the whole plan: **the original scrape
was never written down.** No script in `scripts/`, no doc, nothing in git
history. It was done conversationally through the Xero MCP and chunked SQL
inserts. The only surviving artefacts are in a session scratchpad under
`/private/tmp` — 14 quarterly invoice-header pulls, 14 line-item pulls, and the
three `.mjs` files that turned them into rows. They are disposable, machine-
local and not backed up.

In particular, **the rule that decided which invoice lines counted as "product"
was never recorded.** That rule is what makes an invoice count as
"unambiguously one product" and therefore eligible for a spec phrase at all.
Reconstructed from live invoices (not read from source): a product line is one
with an inventory item whose code is **not** `020` (extra tooling), `050`
(international shipping), `052` (domestic shipping) or `910` (US customs); a
line with no inventory item is not a product line.

---

## 3. What changes

Three separable parts. They can be built and shipped independently, and I
recommend a specific order — see §7.

### Part A — Read the finish off the Xero line descriptions

**What it buys.** A finish for roughly 430–460 of the 510 register rows on
metals that actually have a finish choice (steel, gold, rose gold), plus
whatever lands for the 174 full-colour-plastic rows.

**Why it works now.** The finish naming rate rose sharply over time and the
register's own window sits entirely in the good era:

| Era | Option-bearing lines sampled | Finish named |
| --- | --- | --- |
| 2019 + 2021 | 20 | 6 (30%) — metals specifically **0 of 11** |
| 2023 onward | 30 | 27 (**90%**) |

All 510 of the register's option-bearing metal rows fall after April 2023.

**What it costs, honestly.** The evidence base is small: 33 finish strings
observed across 153 invoices. Every one of them mapped cleanly to a real
catalogue option, but that is a zero-error observation over 33 lines, not a
proof. Full-colour plastic is effectively **unmeasured** — three in-window lines
in the sample. The recommendation is therefore to build it, run it in shadow,
and **count what actually landed before trusting it**.

**Scope limits that are not fixable.** Only five catalogue materials have an
option dimension at all (steel, gold, rose gold: Natural/Brushed/Mirror;
full-colour plastic: Gloss/Matte; wood: six species). For the other 1,253
register rows — translucent, letterpress, satin, gun metal, matte black, tinted,
matte white — there is no finish because there was never a choice to make. Their
descriptions do carry colour and attribute text ("lava orange", "with black
infill", "full colour logo"), and **none of it is a catalogue option**. Storing
any of it would invent a dimension that does not exist.

Ink counts (letterpress, satin, translucent, tinted — 879 rows) are simply not
recoverable. No pre-2026 invoice line names one.

### Part B — Wire the register into the order builder

**What it buys.** Twenty of 226 approved proofs gain a "Their last order"
suggestion they do not have today. Five of those twenty carry a thickness; the
rest give the designer a quantity, a date and a sentence to work from.

**What it costs.** One migration (a DROP + CREATE of an existing function, which
wipes and must restate its grants) and a modest change to one modal. No edge
function change, no change to the customer-facing `previous_spec` payload shape.

**The conversion already exists.** `previousSpecFromReengagement()` in
`src/lib/reengagement.ts` already turns a register snapshot into the builder's
`PreviousSpec` shape, and already encodes every hard rule: refuse on material
mismatch, never invent a finish, never send a label without its id. This work
adds a **new source**, not new rules. Anything that re-derives those rules in the
builder is a bug.

**The hazard nobody had named.** The nightly reconcile folds app payments into
the register, so for a proof that already has a paid order, the register's "last
order" **is that same order**. Measured: 123 of the 158 approved proofs with a
register answer are in exactly that state. Most are shielded because the app
path answers first — but on 6 of the 26 raw register answers, the register hands
back the customer's *current* purchase as their *previous* one. One `NOT EXISTS`
kills it.

### Part C — Scrape further back than 1 April 2023

**What it buys.** Extending to 1 April 2022 adds **1,492 paid invoices**. About
a third of those customers are already on the register, so expect roughly
**690–730 new rows** (register 2,758 → ~3,470) and **~400 existing rows
gaining older history**. Of the touched rows, ~180 go from "one order ever" to
"two or more", which is a real scoring improvement — a repeat buyer is worth
more than a one-off and currently scores like a one-off.

**What it costs, and why I am lukewarm.** The desk serves five names a day.
There are already 2,386 servable rows — about **22 months of supply**. Only 32
of them score 80 or more. So the constraint is not names, it is ordering. Part C
buys score *accuracy* on ~400 rows and 715 low-scoring names nobody will reach
this year. Going back to 2019 is worse: those customers last bought four to
seven years ago, earn the minimum recency score, and would sit permanently below
2,386 rows that already outrank them.

It is also the riskiest of the three (see §5), and ~110 of the rows it touches
are customers deliberately rested because they bought recently.

---

## 4. The exact work

House rules that apply throughout, stated once:

- **Migrations are applied via MCP `apply_migration` against the merged
  stock-control project** (`bjvinrzbdrwebylkmbwy`), or pasted into its dashboard
  SQL editor. Never `supabase db push` — the CLI link points at the retired
  standalone project, which answers with the right schema and zero rows.
- **Re-emit any existing function from the LIVE `pg_get_functiondef`, never from
  a migration file.** Live has drifted from source before and rebuilding from an
  old file silently drops whatever landed since.
- **The `proofs` schema has no default privileges.** Every new table and every
  re-created function must state its own grants, or the edge functions and the
  nightly job silently lose access. A new function additionally defaults to
  `EXECUTE TO PUBLIC`, and `anon` holds schema USAGE with PostgREST serving it —
  so the `revoke` is load-bearing, not tidiness.
- **Anything that reaches `orders.previous_spec` is customer-visible**, verbatim,
  through both pay-page RPCs. It is not on `_customer_order_json()`'s strip list
  and it has no CHECK constraint. The only gate is the seven-key allow-list in
  `create-order`'s sanitiser.
- **Migration numbers below are the next free at time of writing.** Re-check with
  `ls supabase/migrations/0004*` before committing. Never take a number from
  CLAUDE.md's summary — that has cost two PRs already.
- **Verify by querying the table afterwards, never by trusting a job's own
  report.** The original seed had one agent report success while its inserts were
  still in flight.

### Step 0 — Rescue the seed artefacts (do this first, today)

The 28 JSON pulls and three `.mjs` files are still present, ~1.2 MB total, at:

```
/private/tmp/claude-501/-Users-robrandtoul-Documents-Claude-Projects-proof-viewer/
  77829b34-838e-40d9-a5c2-314fd22362fa/scratchpad/
```

Copy `xero-window-*.json`, `spec/`, `spec-seed/`, `emails.json`, `register.json`,
`aggregate.mjs` and `aggregate-spec.mjs` into
`docs/audits/reorder-register-seed-2026-08-09/` and commit them. If that
directory is cleared first, the exact inputs are gone and every figure in §2
becomes unreproducible — and the mixed-currency fix in Step 7 becomes expensive
rather than cheap.

This is blocking for Step 7 and desirable for everything else.

### Step 1 — Write the scraper as a committed script

`scripts/xero-register-scrape.ts`, run by hand, output written to a staging
table (Step 2), never directly to `reorder_prospects`.

Requirements, each earned from the original run:

- Page through `get_invoices` in quarterly windows with
  `include_line_items: true`. **The MCP caps at 100 items per page and its
  `page_count` is unreliable** — it reported 1 for a month that held ≥100. Page
  until a short page comes back, do not trust the count.
- `status = PAID` only. **Exclude `amount_total = 0`** (ATG Ltd's INV-20240 is a
  real £0.00 paid invoice and would inflate the order count).
- **Grain is one row per invoice**, not per line and not per day. The seed
  counted invoices (Premier Eco Cards = 116 orders, cadence 11 days), and the
  nightly reconcile counts payments. Mixing the two makes `cadence_days`
  meaningless.
- **Money is recorded per currency and never converted.** Conversion happens once,
  at scoring time, inside the SQL scorer.
- **Write down the product-line filter in the script, as a named constant with a
  comment**, because it decides which invoices are eligible for a spec at all:

```ts
// A "product line" is a card we made. Everything else on the invoice is a
// service line. Getting this wrong changes which invoices count as
// "unambiguously one product", which silently changes which customers have a
// last_spec at all.
//   020 = Extra tooling · 050 = International shipping
//   052 = Domestic shipping · 910 = US Customs Handling Service
// A line with no inventory item is the summary-line fallback ("Order ORD-…")
// and is not a product line either.
const NON_PRODUCT_ITEM_CODES = new Set(['020', '050', '052', '910'])
```

### Step 2 — Migration: staging table + the new columns

Next free number at time of writing: **000406**. Additive and inert — nothing
reads these columns until Steps 4 and 5.

```sql
-- 000406 — staging table + finish/provenance columns for the Xero re-scrape.
--
-- Nothing in the scraper writes proofs.reorder_prospects directly. It lands in
-- a staging table, the writes are previewed read-only, and only then applied.
-- That is the 000395 lesson (see docs/reorder-register-rescrape-spec.md §5.1):
-- that reconcile wrote 175 rows to live, 100 of which duplicated customers who
-- were already there, and the register had to be restored.

create table proofs.reorder_backfill_stage (
  xero_contact_id text primary key,
  customer_name   text not null,
  email           text,
  currency        text not null,          -- modal currency across the window
  first_order_on  date not null,
  last_order_on   date not null,          -- <= window_end BY CONSTRUCTION
  invoices        integer not null check (invoices > 0),
  value_gbp       numeric(12,2),          -- per currency. NEVER pre-converted:
  value_usd       numeric(12,2),          -- adding a USD sum into a GBP column
  value_eur       numeric(12,2),          -- is 000395 defect 2 in a new shape.
  window_start    date not null,
  window_end      date not null,
  loaded_at       timestamptz not null default now()
);

alter table proofs.reorder_backfill_stage enable row level security;
-- ⚠ Load-bearing. ALTER DEFAULT PRIVILEGES (000176) would otherwise hand
-- `authenticated` full CRUD on this table the moment it is created.
revoke all on proofs.reorder_backfill_stage from anon, authenticated;
grant all on proofs.reorder_backfill_stage to service_role;

-- Finish, parsed from the Xero line description (Part A). Mirrors the id +
-- frozen-label pairing 000399 established for the variant: a retired or renamed
-- option must still be nameable to whoever reads the row later.
alter table proofs.reorder_prospects
  add column last_option_id     uuid references proofs.material_options(id) on delete set null,
  add column last_option_label  text,
  add column last_option_source text
    check (last_option_source in ('order_column', 'xero_description')),
  -- Provenance + re-run guard for a deeper scrape (Part C).
  add column history_backfilled_to date;

comment on column proofs.reorder_prospects.last_option_id is
  'Finish/species the customer last chose, where the catalogue offers a choice '
  'AND we could establish it beyond doubt. NULL is the EXPECTED state for the '
  '1,253 rows on materials with no option dimension at all — there was no '
  'choice to make, so this is not missing data. It is also the expected state '
  'wherever the invoice simply did not say. ⚠ Do NOT "fix" a NULL by defaulting '
  'to Natural: on steel and gold, Mirror and Brushed carry a surcharge Natural '
  'does not, so a wrong finish also badges the wrong price column.';

comment on column proofs.reorder_prospects.history_backfilled_to is
  'Earliest date this row''s history has been extended back to by a Xero '
  'backfill. NULL = never backfilled (history starts at first_order_on). '
  'Doubles as the re-run guard: a backfill only writes rows where this is NULL.';
```

### Step 3 — The finish parse, in shadow

Run the parse into `last_option_id` / `last_option_label` / `last_option_source`
and **stop there**. Nothing reads those columns yet.

The parse, in order. Every step can only produce NULL — none of them may guess:

1. **Single product line only.** An invoice with two or more product lines
   yields nothing. (Same rule the existing spec phrase uses.)
2. **Resolve the material first**, from the item code. If it does not resolve,
   stop.
3. **If that material has no `material_options` rows, store NULL and stop.**
   This one guard disposes of every false positive found in the research:
   "lava orange", "black infill", "full colour logo", "CMYK print", and — the
   sharp one — "Matte black metal", where *matte* is part of the material's own
   name and an unscoped search for /matt/ would read it as a finish.
4. **Match only against that material's own options**, case-insensitively, in
   exactly two shapes:
   - `<option> finish` — covers every hand-keyed form observed: "with natural
     finish", "- Natural finish", newline + "Natural Finish", "with mirror
     finish", "with brushed finish", "with gloss finish", "with glossy finish",
     "- matt finish", "(760 micron - matt finish)". Allow exactly two synonyms:
     `glossy`→Gloss, `matt`→Matte.
   - `— <exact display name>` at end of string — the app-era format. ⚠ **Reject
     the literal `— prototype sample` first**: `invoiceBuild.ts` uses the same
     separator for prototypes and one such invoice already exists on live.
5. **Refuse on contradiction.** If the description names a thickness or material
   that disagrees with the item record, store NULL for the whole spec, not just
   the finish. Real cases: INV-25013 says copper on a gun-metal item; INV-23471
   says 1500 micron on an 800 micron item.
6. **Refuse on two materials in one line.** INV-23456 reads "Gold metal cards
   (800 micron with mirror finish) / 50 in traditional gold / 50 in rose gold" —
   one product line, genuinely two materials.
7. **Refuse if two options of the same material both appear.** Never rank, never
   take the first.
8. **Never infer from silence.** No finish word means NULL, never Natural — even
   though Natural is the commonest steel finish. The unnamed lines are precisely
   the ones a default gets wrong.

For the 141 app-era orders (paid on or after 25 Jun 2026) **do not parse at
all** — read `proofs.orders.material_option_id`, which is populated on 38 of 38
option-bearing orders. Mark those rows `last_option_source = 'order_column'`.

The mapping is complete; every finish string observed maps to a real option id:

| Material | Description says | Option |
| --- | --- | --- |
| Stainless Steel / Gold Metal / Rose Gold Metal | natural finish | Natural |
| " | brushed finish | Brushed |
| " | mirror finish | Mirror |
| Full Colour Plastic | gloss finish, glossy finish | Gloss |
| " | matt finish, matte finish | Matte |
| Wood | (already in the item name — no description parse needed) | the six species |

**Then stop and check.** Pull 20 metal rows at random and compare each against
the actual Xero invoice by hand before anything is wired up. Also count what
landed on full-colour plastic — that material is unmeasured, and if it comes in
thin or wrong, ship the metals only.

### Step 4 — Migration: the register fallback in the order builder

Next free number after Step 2: **000407** (re-check).

`last_paid_order_for_proof` gains five designer-side columns and a second
source. Return-shape change, so **DROP + CREATE** — `CREATE OR REPLACE` cannot
change a return type, and the drop wipes the ACL, hence the restated grants.
The order path's body is carried over **byte-for-byte from the live
`pg_get_functiondef`** so today's 172 answers cannot shift.

```sql
-- 000407 — let the Reorder register answer "Their last order" when the app can't.
--
-- last_paid_order_for_proof (000364) can only speak about orders WE hold, so a
-- customer whose history predates the app gets nothing and the designer is sent
-- to old Help Scout threads and Xero invoices by hand — which 000364's own
-- comment anticipated. The Reorder register already holds that history, so this
-- wires it in as a SECOND source BEHIND the first.
--
-- Measured on live 2026-08-10 across 226 approved proofs: the app answers 172,
-- the register adds 20, and 34 stay unanswered.
--
-- Three rules, each of which cost something to learn:
--
-- 1. ⚠ NEVER ECHO THIS PROOF'S OWN ORDER. reconcile_reorder_register() absorbs
--    app payments into the register, so for a proof that already has a paid
--    order the register's last_order_on IS that order — true of 123 of the 158
--    approved proofs with a register answer. Most are shielded because the order
--    path answers first, but where it doesn't (material changed after ordering,
--    order carrying no variant/option/quantity) the register would parrot the
--    customer's CURRENT purchase back as their PREVIOUS one: 6 of 26 raw
--    answers. The NOT EXISTS below is that guard, on date grain because that is
--    the grain the register stores.
--
-- 2. CONTACT-FIRST, EMAIL FALLBACK — deliberately NOT the order path's
--    company-else-contact stance. Measured: adding a company-wide sweep changes
--    coverage by ZERO (26 -> 26). The register has no company column and its
--    customer_name is already coalesce(company.name, contact.full_name), so it
--    is company-grained already; a company sweep would only reintroduce the
--    many-rows-per-customer ambiguity 000398 removed.
--
-- 3. THE VARIANT IS REFUSED ON A MATERIAL MISMATCH, THE QUANTITY IS NOT. A
--    quantity and a date make no claim about material; a badge asserts "this
--    option is what you had". Same refusal previousSpecFromReengagement makes,
--    so the pay page and the builder can never disagree.
--    ⚠ Strict equality of two non-null ids, never IS NOT DISTINCT FROM: a
--    per-direction Selection stores material_id NULL, and NULL "matching" NULL
--    would badge a variant on a proof that has no material at all.

drop function if exists proofs.last_paid_order_for_proof(uuid, uuid);

create function proofs.last_paid_order_for_proof(p_proof_id uuid, p_material_id uuid)
returns table (
  order_id uuid,
  variant_id uuid,
  variant_label text,
  option_id uuid,
  option_label text,
  quantity integer,
  paid_at timestamptz,
  -- 000407 additions. All five are DESIGNER-SIDE ONLY: none has a slot in
  -- orders.previous_spec, and create-order's sanitiser is a seven-key
  -- allow-list, so none can reach the pay page.
  source_kind text,      -- 'order' | 'register'
  last_order_on date,    -- register path only; timezone-proof month source
  spec_text text,        -- register prose, e.g. "500 letterpress cards (900gsm)"
  material_match boolean,
  material_known boolean
)
language sql
stable
security invoker
set search_path = proofs, public, extensions, pg_temp
as $$
  with target as (
    select c.id as contact_id, c.company_id, lower(c.email) as email
    from proofs.proofs p
    join proofs.contacts c on c.id = p.contact_id
    where p.id = p_proof_id
  ),
  -- Byte-for-byte the live 000364 body. The order path must not shift.
  from_orders as (
    select
      o.id as order_id,
      o.material_variant_id as variant_id,
      mv.display_name as variant_label,
      o.material_option_id as option_id,
      mo.display_name as option_label,
      o.quantity,
      coalesce(o.paid_at, o.created_at) as paid_at
    from proofs.orders o
    join proofs.proofs p2 on p2.id = o.proof_id
    join proofs.contacts c2 on c2.id = p2.contact_id
    left join proofs.material_variants mv on mv.id = o.material_variant_id
    left join proofs.material_options mo on mo.id = o.material_option_id
    cross join target t
    where p_material_id is not null
      and o.status in ('paid', 'fulfilled')
      and o.order_kind = 'production'
      and (o.material_variant_id is not null or o.material_option_id is not null or o.quantity is not null)
      and coalesce(o.material_id, mv.material_id) = p_material_id
      and case
        when t.company_id is not null then c2.company_id = t.company_id
        else c2.id = t.contact_id
      end
    order by coalesce(o.paid_at, o.created_at) desc
    limit 1
  ),
  from_register as (
    select
      rp.last_qty as quantity,
      rp.last_order_on,
      rp.last_spec as spec_text,
      rp.last_variant_id,
      rp.last_variant_label,
      (rp.last_material_id is not null
        and p_material_id is not null
        and rp.last_material_id = p_material_id) as material_match,
      (rp.last_material_id is not null) as material_known
    from proofs.reorder_prospects rp
    cross join target t
    where
      -- Strictly a FALLBACK: an order we hold always wins.
      not exists (select 1 from from_orders)
      and rp.last_spec is not null
      -- Nothing displayable is worse than nothing: a bare "when" guides nobody.
      and (rp.last_qty is not null or rp.last_variant_id is not null)
      and (
        rp.matched_contact_id = t.contact_id
        or (rp.matched_contact_id is null
            and rp.email is not null and t.email is not null
            and lower(rp.email) = t.email)
      )
      -- Rule 1: never hand back a purchase made on THIS proof.
      and not exists (
        select 1 from proofs.orders o
        where o.proof_id = p_proof_id
          and o.status in ('paid', 'fulfilled')
          and o.paid_at::date = rp.last_order_on
      )
    order by (rp.matched_contact_id = t.contact_id) desc nulls last,
             rp.orders_count desc, rp.created_at
    limit 1
  )
  select
    order_id, variant_id, variant_label, option_id, option_label, quantity, paid_at,
    'order'::text, null::date, null::text, true, true
  from from_orders
  union all
  select
    null::uuid,
    -- Rule 3: the variant only survives a material match...
    case when material_match then last_variant_id end,
    -- ...and the label only rides WITH the id. A bare label makes the pay page
    -- print "isn't available on this order" over a grid of ink counts — 822
    -- live rows carry a label with no id.
    case when material_match and last_variant_id is not null then last_variant_label end,
    -- The finish stays NULL on this path for now. See §7 decision 4: the
    -- register only learns a finish in Step 3, and it is not let through until
    -- the shadow spot-check passes.
    null::uuid, null::text,
    quantity,
    -- Deliberately NOT last_order_on::timestamptz: that cast uses the server
    -- timezone and the client formats in the browser's, which slides a
    -- 1st-of-month into the previous month west of Greenwich. The date is
    -- returned raw and formatted by formatOrderMonth().
    null::timestamptz,
    'register'::text,
    last_order_on,
    spec_text,
    material_match,
    material_known
  from from_register;
$$;

comment on function proofs.last_paid_order_for_proof(uuid, uuid) is
  'Order builder auto-suggest for "Their last order". Prefers a paid order we '
  'hold (same material, company-else-contact); falls back to the Reorder '
  'register''s Xero-derived history (contact-first, email fallback) when we hold '
  'none. source_kind says which answered. ⚠ The register path NEVER returns a '
  'finish, never returns a variant on a material mismatch, and never returns a '
  'purchase made on this same proof. spec_text/source_kind/material_* are '
  'designer-side only — they have no slot in orders.previous_spec, which is '
  'customer-visible.';

-- The drop wiped the ACL. A new function grants EXECUTE to PUBLIC by default,
-- the proofs schema has no default function ACL, anon holds schema USAGE and
-- PostgREST serves it — so this revoke is load-bearing (the 000356 lesson,
-- restated verbatim from 000364). This function joins contacts and orders.
revoke execute on function proofs.last_paid_order_for_proof(uuid, uuid) from public, anon;
grant execute on function proofs.last_paid_order_for_proof(uuid, uuid) to authenticated;

-- matched_contact_id is now the primary join key for the desk AND this path,
-- and the table has no index on it (verified: only pkey, xero_contact_id,
-- (state, score), and the partial proof_id index).
create index if not exists reorder_prospects_matched_contact_idx
  on proofs.reorder_prospects (matched_contact_id)
  where matched_contact_id is not null;
```

**Before applying**, run the body read-only across all 226 approved proofs and
confirm four numbers: 226 rows for 226 distinct proofs (never two), 172 `order`
/ 20 `register` / 34 null, and zero of each illegal shape — variant-on-mismatch
0, label-without-id 0, option-from-register 0. This was done at authoring time
and all four held.

### Step 5 — Frontend: the order builder's third card state

`src/components/OrderBuilderModal.tsx`.

**Deploy order: migration first, frontend second.** The old frontend reads the
seven fields it knows and ignores the five new columns, so the gap is safe. The
reverse also survives thanks to the default below, but is pointless.

RPC row type:

```ts
interface LastOrderRow {
  order_id: string | null
  variant_id: string | null
  variant_label: string | null
  option_id: string | null
  option_label: string | null
  quantity: number | null
  paid_at: string | null
  // 000407. Absent when running against a pre-000407 database, so every one of
  // these must have a safe default.
  source_kind?: 'order' | 'register' | null
  last_order_on?: string | null
  spec_text?: string | null
  material_match?: boolean | null
  material_known?: boolean | null
}
```

Fetch:

```ts
const row = data[0] as LastOrderRow
// ⚠ Default to 'order' when the key is absent, so a frontend deployed ahead of
// the migration behaves exactly as it did before — never renders the register
// card off undefined fields. (Same defaulting stance as 000244's toFacts.)
const sourceKind = row.source_kind === 'register' ? 'register' : 'order'

if (!row.variant_label && !row.option_label && row.quantity == null && !row.spec_text) return

setPrevSuggestion({
  variantId: row.variant_id,
  variantLabel: row.variant_label,
  optionId: sourceKind === 'register' ? null : row.option_id,
  optionLabel: sourceKind === 'register' ? null : row.option_label,
  quantity: row.quantity,
  paidAt: row.paid_at,
  sourceKind,
  // ⚠ formatOrderMonth, not formatMonthYear: the register hands back a bare
  // date, and formatMonthYear's new Date(iso) parses it as UTC midnight then
  // renders in local time, sliding a 1st-of-month back a month west of
  // Greenwich. formatOrderMonth slices the ISO string instead.
  whenLabel:
    sourceKind === 'register'
      ? (row.last_order_on ? formatOrderMonth(row.last_order_on) ?? '' : '')
      : formatMonthYear(row.paid_at),
  specText: sourceKind === 'register' ? (row.spec_text ?? null) : null,
  materialMatch: row.material_match !== false,
  materialKnown: row.material_known !== false,
})
```

Apply handler — the honesty gate:

```ts
const s = prevSuggestion!
// A register answer may only fill the thickness when the material agrees.
// Everything else it knows (quantity, when) is material-independent.
const mayFillVariant = s.sourceKind === 'order' || s.materialMatch

setPrevEngaged(true)
setPrevSource('auto')                       // ⚠ NOT 'register' — see §7 decision 3
setPrevVariantId(thicknessEligible && mayFillVariant ? s.variantId ?? '' : '')
setPrevVariantLabel(thicknessEligible && mayFillVariant ? s.variantLabel ?? '' : '')
setPrevOptionId(finishEligible ? s.optionId ?? '' : '')     // no-op on the register path
setPrevOptionLabel(finishEligible ? s.optionLabel ?? '' : '')
setPrevQuantity(s.quantity != null ? String(s.quantity) : '')
setPrevWhen(s.whenLabel)
setDirty(true)
```

`previousSpecPayload` needs **no edit**: it reads only the gated state above.
⚠ **Never map `spec_text` into `variant_label`.** `"500 letterpress cards
(900gsm)"` in that slot renders as a thickness name on the customer's pay page —
the sanitiser is an allow-list of key *names*, so it cannot stop a leak by
*slot*.

Card copy for the register state:

```
Last time they ordered 500 letterpress cards (900gsm) — August 2026
From their Xero invoice history — we don't hold this order in the app.
[+ when material unknown]  We couldn't tell which material that was, so only
                           the quantity is filled in.
[+ when material differs]  That was a different material from this proof, so
                           the thickness hasn't been filled in.
[ Use these details ]  [ Not now ]
```

The prose stays visible above the form after applying, so a designer who
recognises "900gsm" can set the thickness by hand. This is a pre-filled manual
form, not a read-only line — 15 of the 20 register answers have no thickness id,
and the designer is the only person who can finish the job.

No change to `create-order`, `_shared/previousSpec.ts`, `src/lib/previousSpec.ts`
or `pnpm test:previous-spec`.

### Step 6 — (Optional, Part C) the deeper backfill

Only if Rob says yes to §7 decision 1. Load the staging table from Step 1 with
the 1 Apr 2022 → 31 Mar 2023 window, then:

**6a. Preview, read-only, and get the numbers signed off** (this is the house
pattern — 000356, 000376 and 000400 were all previewed read-only before apply):

```sql
-- 1. Match classes.
select
  count(*) filter (where exists (select 1 from proofs.reorder_prospects rp
                                 where rp.xero_contact_id = s.xero_contact_id))  as by_contact_id,
  count(*) filter (where not exists (select 1 from proofs.reorder_prospects rp
                                     where rp.xero_contact_id = s.xero_contact_id)
                     and exists (select 1 from proofs.reorder_prospects rp
                                 where lower(rp.email) = lower(s.email)))        as by_email_only,
  count(*)                                                                       as staged_total
from proofs.reorder_backfill_stage s;

-- 2. Rows that FAIL the overlap or currency guard. These must be zero writes.
select s.xero_contact_id, s.customer_name, s.last_order_on, rp.first_order_on, rp.state
from proofs.reorder_backfill_stage s
join proofs.reorder_prospects rp on rp.xero_contact_id = s.xero_contact_id
where s.last_order_on >= rp.first_order_on or s.currency <> rp.currency;

-- 3. Live-state census of what the UPDATE would touch. Expect ~28% suppressed.
select rp.state, rp.outcome_note, count(*)
from proofs.reorder_backfill_stage s
join proofs.reorder_prospects rp on rp.xero_contact_id = s.xero_contact_id
where s.last_order_on < rp.first_order_on
group by 1, 2 order by 3 desc;

-- 4. Score movement, computed WITHOUT writing anything.
select rp.customer_name, rp.score as before,
  (proofs._reorder_score(
     rp.orders_count + s.invoices, rp.last_order_on,
     (rp.lifetime_value + case rp.currency when 'USD' then s.value_usd
                                           when 'EUR' then s.value_eur
                                           else s.value_gbp end)
       * case rp.currency when 'USD' then 0.78 when 'EUR' then 0.86 else 1 end,
     nullif(((rp.last_order_on - least(rp.first_order_on, s.first_order_on))
             / (rp.orders_count + s.invoices - 1))::int, 0)
   ) ->> 'score')::int as after
from proofs.reorder_prospects rp
join proofs.reorder_backfill_stage s on s.xero_contact_id = rp.xero_contact_id
where s.last_order_on < rp.first_order_on and rp.state = 'pending'
order by after - before desc limit 50;

-- 5. What happens to the head of the queue (only 32 rows score >= 80 today).
select count(*) from proofs.reorder_prospects
where state = 'pending' and (suppressed_until is null or suppressed_until <= current_date)
  and score >= 80;
```

**6b. The UPDATE — add-only, older history only:**

```sql
update proofs.reorder_prospects rp
set
  first_order_on = least(rp.first_order_on, s.first_order_on),
  orders_count   = rp.orders_count + s.invoices,

  -- Money: the row's OWN currency only.
  lifetime_value = case
    when rp.lifetime_value is null then null          -- unknown stays unknown
    else rp.lifetime_value + case rp.currency
           when 'USD' then coalesce(s.value_usd, 0)
           when 'EUR' then coalesce(s.value_eur, 0)
           else            coalesce(s.value_gbp, 0) end
  end,
  avg_order_value = case
    when rp.lifetime_value is null then null
    else round((rp.lifetime_value + case rp.currency
                  when 'USD' then coalesce(s.value_usd, 0)
                  when 'EUR' then coalesce(s.value_eur, 0)
                  else            coalesce(s.value_gbp, 0) end)
               / nullif(rp.orders_count + s.invoices, 0), 2)
  end,

  -- The rhythm, recomputed over the WIDER span and the NEW count. nullif(…,0)
  -- because several orders on one day is a buying event, not a rhythm of zero.
  cadence_days = case
    when rp.orders_count + s.invoices >= 2
      then nullif(((rp.last_order_on - least(rp.first_order_on, s.first_order_on))
                   / (rp.orders_count + s.invoices - 1))::int, 0)
    else rp.cadence_days end,

  history_backfilled_to = s.window_start,
  updated_at            = now()
from proofs.reorder_backfill_stage s
where rp.xero_contact_id = s.xero_contact_id
  -- ⚠ THE GUARD. Every staged invoice is dated strictly before the row's
  -- earliest known order, so none of them can already be counted. This is the
  -- single condition that makes ADD safe; drop it and you re-run 000395's
  -- duplicate defect as arithmetic, which is invisible on the admin page.
  and s.last_order_on < rp.first_order_on
  -- ⚠ Never twice.
  and rp.history_backfilled_to is null
  -- Currency mismatch is a review item, not a write.
  and s.currency = rp.currency;
```

**6c. The INSERT — three guards, in the order 000395 taught:**

```sql
insert into proofs.reorder_prospects (
  xero_contact_id, customer_name, email, currency,
  first_order_on, last_order_on, orders_count,
  lifetime_value, avg_order_value, cadence_days,
  state, suppressed_until, outcome_note,
  history_backfilled_to, last_reconciled_at
)
select
  s.xero_contact_id, s.customer_name, s.email, s.currency,
  s.first_order_on, s.last_order_on, s.invoices,
  case s.currency when 'USD' then s.value_usd
                  when 'EUR' then s.value_eur else s.value_gbp end,
  round(case s.currency when 'USD' then s.value_usd
                        when 'EUR' then s.value_eur else s.value_gbp end
        / s.invoices, 2),
  case when s.invoices >= 2
    then nullif(((s.last_order_on - s.first_order_on) / (s.invoices - 1))::int, 0) end,
  'pending',
  null,                                  -- nothing to rest: 3+ years dormant
  'Enrolled from the 2022-23 Xero backfill',
  s.window_start,
  s.window_end::timestamptz              -- ⚠ NOT now(). See §5.3.
from proofs.reorder_backfill_stage s
-- Contact id is exact for the 2,739 scraped rows; email and normalised name
-- cover the 19 app-enrolled rows, which carry NO xero_contact_id and would
-- otherwise be duplicated — exactly 000395 defect 1.
where not exists (
  select 1 from proofs.reorder_prospects rp where rp.xero_contact_id = s.xero_contact_id)
and not exists (
  select 1 from proofs.reorder_prospects rp
  where s.email is not null and rp.email is not null
    and lower(rp.email) = lower(s.email))
and not exists (
  select 1 from proofs.reorder_prospects rp
  where lower(regexp_replace(rp.customer_name, '[^a-zA-Z0-9]', '', 'g'))
      = lower(regexp_replace(s.customer_name, '[^a-zA-Z0-9]', '', 'g')));
```

**6d. Re-score by calling the existing function, never by writing `score`:**

```sql
select proofs.reconcile_reorder_register();
```

That recomputes `score` and `score_reasons` for every row through the one living
scorer. Branch A is provably a no-op because no watermark moved.

**6e. Verify afterwards by querying the table** — row count, distinct
`xero_contact_id`, duplicates on email and on normalised name, and per-column
null counts. Not by reading the job's report.

### Step 7 — The three data fixes (independent of everything above)

1. **The 40 `"carbon Fibre Cards"` rows** — a single `UPDATE … set last_spec =
   replace(last_spec, 'carbon Fibre Cards', 'carbon fibre cards')`. Correct the
   stored prose rather than title-casing at render time; the data is wrong.
2. **The 41 stale-phrase rows** — null their `last_spec` (and the structured
   columns 000399 derived from it). One statement, always true. Storing the
   phrase's own invoice date is more honest but adds a column and a branch to
   `reengagement.ts` for 41 rows.
3. **The 23 mixed-currency lifetime values** — re-sum per currency from the
   rescued header JSON and write the modal currency's own total. **Only cheap
   while the Step 0 artefacts exist.**

---

## 5. What could go wrong

### 5.1 ⚠ The 000395 reconcile failure — the precedent that matters most

On 9 August 2026 the first version of the nightly reconcile (migrations
000395/000396) was applied to live and ran. It wrote 175 rows. It was then
reviewed adversarially, **seven separate defects were found, the 175 rows were
deleted, the cron was unscheduled, and the register was restored to its 2,739
seeded rows** before 000397 rewrote it.

The seven, because every one of them is a trap this re-scrape could fall into:

| # | Defect | How it happened |
| --- | --- | --- |
| 1 | **Duplicate enrolment (critical)** | The "is this customer already here?" test compared emails — but 2,244 of 2,739 rows had no email, so for 82% of the register it was a NULL comparison that never matched. **100 of the 174 enrolled rows duplicated somebody already on the register.** |
| 2 | **Money converted twice (critical)** | Enrolment stored a GBP-converted figure while labelling the row USD, then the scorer converted again. A $2,600 customer scored as if they had spent £1,582. |
| 3 | **State clobbering** | Any payment reset the row to `pending` — including `converted`, which that same payment had just earned. |
| 4 | **Half a refresh** | `cadence_days`, `lifetime_value`, `avg_order_value` and `first_order_on` were never updated, so the stale-rhythm problem the job existed to solve survived it. |
| 5 | **Combined payments counted N times** | One combined payment across three orders read as three purchases a day apart, giving a cadence of zero. |
| 6 | **Offline orders worth zero** | Coalescing an unknown value to 0 turned "we don't know" into "worth nothing" — 33 customers recorded at £0. |
| 7 | **Shared emails double-absorbed** | Where two register rows shared an address, one order updated both. **86 register rows share 42 email addresses today**, so this is live at scale. |

The lessons this spec takes from it, and where each is applied:

- **Never write the live table from a scraper.** Stage it, preview it read-only,
  apply it deliberately (Step 2, Step 6a).
- **Guard identity on three keys, not one** — contact id, then email, then
  normalised name — because the register is full of rows with no email and 19
  rows with no Xero contact id at all (Step 6c).
- **Never convert money in a write.** Store per currency, convert once at scoring
  time (staging table, Step 6b).
- **Never write `score`.** It is recomputed nightly from recency and would be
  overwritten within a day anyway, disagreeing in the meantime (Step 6d).
- **Verify by querying the table, not by reading the job's report.** The original
  seed also had one agent report success while its inserts were still in flight.

### 5.2 A confident wrong claim about the customer's own history

The governing rule for the whole build. "You last ordered 250 Stainless Steel
500 micron cards" with no finish named is incomplete but true, and the customer
fills the gap themselves. "You last ordered them in Mirror" when they had
Natural is a confident falsehood about the customer's own purchase, from a
company claiming to be their supplier. And on steel and gold, Mirror and Brushed
carry a per-quantity surcharge Natural does not — so a wrong finish also badges
the wrong price column.

**Guard:** every parse step in Step 3 can only produce NULL. Prefer leaving ~60
of the 510 metal rows blank over storing a plausible guess on any of them. The
column comment says so, so nobody later "fixes" the blanks by defaulting to
Natural.

### 5.3 `last_reconciled_at` — the most destructive line a backfill could contain

It is a **per-row watermark**, not a job-ran stamp. Its meaning: *orders paid
after this are new to the register; everything before it is already counted.*
Branch A of the nightly job reads it as `paid_at > last_reconciled_at`.

The two failure directions are not symmetric:

- **Stamped too late** → every payment in the gap is never added. Permanent and
  silent. A full re-scrape that rebuilt `orders_count` from Xero and stamped
  `now()` would lose the **65 of 211 paid production orders that carry no Xero
  invoice at all** (31%), forever.
- **Stamped too early** → payments already counted get added again, instantly.

**Guard:** existing rows — **do not touch it**. The backfill adds only invoices
strictly older than the row's first known order, which changes nothing about
what the row already claims. New rows — stamp `window_end`, not `now()`; their
figures cover only the scraped window, and the nightly job then adds anything
later exactly once. Rule to state in the migration header: *stamp the end of the
contiguous coverage the row's figures actually rest on.*

### 5.4 Suppression resurrection

About 28% of the rows a 2022 backfill would touch (~110) are `suppressed`
recent buyers, rested for 180 days with the note "Recent buyer — covered by the
in-app reorder flow". Any write to `state` or `suppressed_until` would put
someone who bought a fortnight ago in front of a designer to be asked how they
are doing for stock.

**Guard:** the UPDATE writes neither. Nothing in the plan writes any lifecycle
column — `state`, `queued_on`, `contacted_at`, `follow_up_due_on`,
`followed_up_at`, `proof_id`, `outcome_note`, `suppressed_until`,
`matched_contact_id`. Because of that, **the desk does not need to be paused**
(those two fields are the only ones the day's queue is filtered on), though
running after the day's five have gone out is still the courteous option.

### 5.5 Never delete a register row

`proofs.proofs.reengagement_prospect_id` is `ON DELETE SET NULL`, so deleting a
row silently refiles that outreach project as an organic enquiry and corrupts
both `analytics_reengagement` and the exclusion guards. **Guard:** the plan
contains no DELETE. Upsert on `xero_contact_id`, and remember the 19 rows that
have none.

### 5.6 Overwriting `last_spec` with a description

The description is the *least* display-safe field in Xero — it carries other
recipients' names ("Marlven Oribiana x 100, Chace Cowlin x 100, …") and
personalisation notes. `last_spec` reaches an anonymous customer verbatim on the
re-engagement band via `public_get_proof_order_state`, and the
`reengagement_context` CHECK constraint is a key allow-list, not a content
filter — it would not stop this.

**Guard:** the description is never stored. Only a matched catalogue option id
and its frozen display name are (Step 2). Any new key that does reach the
re-engagement band must be added to the `proofs_reengagement_context_keys_chk`
allow-list in the same migration that creates it.

### 5.7 Leaking by slot rather than by name

`create-order`'s sanitiser is an allow-list of seven key *names*, so a register
field cannot leak into `previous_spec` by name. It can leak by **slot** — put
the prose in `variant_label` and the pay page renders "500 letterpress cards
(900gsm)" as a thickness. **Guard:** `spec_text` has no path into
`previousSpecPayload`, and the comment in Step 5 says why.

Related asymmetry worth noting but out of scope: `orders.previous_spec` has **no
CHECK constraint**, unlike its sibling `proofs.reengagement_context`, and is
RLS-writable by any authenticated session.

### 5.8 The product-line filter is reconstructed, not read

The rule in Step 1 was inferred from live invoices, not read from the original
source, because no source exists. A re-scrape built on a slightly different
filter produces a different product-line count for some invoices, which flips
them between "one unambiguous product" and "ambiguous" — silently changing which
customers have a spec at all. **Guard:** before trusting a new pull, re-run the
filter over the rescued 2023–2026 JSON and confirm it reproduces the same
eligible set the seed produced (2,611 phrases before 000394's plausibility
pass).

### 5.9 Grain mixing

The seed counted **invoices** (Premier Eco Cards: 116 orders, cadence 11 days);
the nightly reconcile adds **payments**. A backfill on payment grain would make
`orders_count` a mixture of two definitions and `cadence_days` computed from it
meaningless. **Guard:** invoice grain, stated in Step 1 and enforced by the
staging table's primary key being one row per contact per window.

### 5.10 Queue reshuffle

Only 32 of 2,386 servable rows score 80 or more, and the desk serves five a day
off the top. A 2022 backfill moves ~180 rows from one order to two-or-more,
which is +10 to +25 points each. That is the desired effect, but it must be
**shown before it happens** (Step 6a query 4), not discovered by a designer
wondering where yesterday's names went.

### 5.11 Xero contact merges

A customer whose Xero contact was merged since 9 Aug 2026 presents a different
contact id and slips past the contact-id guard. Email and normalised name catch
most; someone whose name *and* email both changed would enrol twice.
**Guard:** the post-apply duplicate check in Step 6e, on email and on normalised
name.

---

## 6. Deliberately not in scope

- **Extending to 2019.** The 2019–2021 era names a finish on 0 of 11
  option-bearing metal lines, uses materials we no longer sell (phosphor bronze)
  and thicknesses we no longer offer (200 and 400 micron steel). Those customers
  would score the minimum on recency and sit permanently below 2,386 rows that
  already outrank them. Adding names the desk will never reach is cost without
  benefit.
- **Ink counts for letterpress, satin, translucent and tinted (879 rows).** The
  data does not exist pre-app — no invoice line names one. Only 4 rows carry an
  ink-count label today, all from app orders.
- **Colour and attribute text on option-less materials** ("lava orange", "with
  black infill", "full colour logo"). Storing it would invent a catalogue
  dimension that does not exist, and it is the same free text that names other
  recipients.
- **Resolving wood species from prose to an option id.** The register's prose
  does carry the species ("- Maple", "- Black walnut") — wood is the one
  material where the information genuinely exists — but it is prose, and the
  41 rows on "Wood cards (3mm thick) - Mixed" have no species at all. Left for
  the designer to read. See §7 decision 5.
- **Company-wide matching in the builder.** Measured: adds exactly zero
  coverage (26 → 26). The register has no company column and is already
  company-grained through `customer_name`, so a company sweep would only
  reintroduce the many-rows-per-customer ambiguity 000398 removed.
- **Retired thicknesses (200 and 400 micron steel, 33 rows).** Left as frozen
  labels with no variant id, consistent with 000399. We cannot sell them again.
- **Recording register provenance durably.** "How often did the register supply
  the suggestion?" is a fair question, but its honest home is an audit row or a
  designer-only column, not the customer-visible payload. Small separate piece
  of work.
- **A CHECK constraint on `orders.previous_spec`.** Real gap (§5.7), separate
  decision.
- **Making any of this automatic.** Hand-raised Xero invoices still happen (2 of
  23 lines in the July 2026 sample), so the register keeps acquiring rows whose
  finish only the description carries. This is a one-off enrichment plus a
  committed script; re-running it is a deliberate act.

---

## 7. Open decisions

**1. Do we scrape further back than 1 April 2023?**
*Recommendation: **no, or not yet.*** The desk already holds 22 months of supply
and the constraint is ordering, not names. The genuine prize is the ~180 rows
that would go from "one-off" to "repeat buyer" and score accordingly — but that
is a ~15% accuracy improvement bought with the riskiest work in this spec,
touching ~110 deliberately-rested customers. Do Parts A and B first, watch what
the desk actually converts, and revisit. If the answer becomes yes, 1 Apr 2022
is the right stop, not 2019.

**2. Do we parse the finish at all, given the evidence base is 33 strings?**
*Recommendation: **yes, for metals only at first.*** Steel, gold and rose gold
are 510 rows in the good era with a measured 90% naming rate, and every observed
string mapped cleanly. Run it in shadow, spot-check 20 by hand against the
actual invoices, then decide on full-colour plastic separately — that material
is genuinely unmeasured (three sample lines) and can be shipped later or not at
all.

**3. Do we widen `previous_spec.source` to include `'register'`?**
*Recommendation: **no.*** `source` is parsed and never displayed anywhere on
either pay page, so widening it buys no customer-visible behaviour. It would
cost an edit to both copies of the type, both ternaries, the parity test, and a
permanent third value every future reader must handle — plus a silent trap,
since today's parser coerces an unknown source to `'manual'`, so writing
`'register'` before the reader ships stores a wrong provenance with no error.
`'auto'` stays literally true. The provenance that matters to the *designer*
rides in the RPC's `source_kind` column and is rendered in the card.

**4. Once the finish is parsed, do we let it through to the builder?**
*Recommendation: **not in the first release; then yes, gated.*** Step 4 ships
with the register's finish always NULL. After the shadow spot-check passes
clean, letting it through is a small change: return `last_option_id` /
`last_option_label` only when the material matches **and** the label rides with
the id, exactly as the variant does. Keep `last_option_source` visible to the
designer so a Xero-parsed finish and a finish read off a real order row are
never confused.

**5. Wood species — prose or an option id?**
*Recommendation: **prose only**, for now.* Wood is the one material where the
register genuinely holds the answer, and species is most of what a customer
remembers about a wood card. But 41 of the 221 wood rows are "Mixed" with no
species, and resolving free text to an option id is the same guessing this spec
refuses everywhere else. Revisit alongside decision 4.

**6. Do we fix the three seeded-data defects, and how?**
*Recommendation: **yes to all three**, in the order 2 → 1 → 3.* The 41
stale-phrase rows are the only one that can currently tell a customer something
untrue, so null them first. The 40 title-case rows are cosmetic but embarrassing
in front of a customer — correct the stored prose, not the renderer. The 23
mixed-currency lifetime values only affect internal scoring, but they are cheap
to fix **only while the rescued JSON exists**, so do them before that window
closes.

**7. Should the register's provenance be written down at all — a script and this
doc — given it is now a live production dataset with a nightly job attached?**
*Recommendation: **yes, and it is Step 0.*** Every other feature this size in
the repo has a spec. Right now the only account of where 2,739 customer records
came from is a temp directory.
