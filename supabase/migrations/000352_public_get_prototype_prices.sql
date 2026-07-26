-- 000352: public_get_prototype_prices — an anon read path for the
-- prototyping-service fees, so the AI drafter can quote them from the table
-- instead of from a sentence.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), where
-- proof-viewer lives in the `proofs` schema. Apply by pasting into that
-- project's dashboard SQL editor (or an MCP apply_migration). Do NOT use
-- `supabase db push` — the CLI link points at the retired standalone project.
--
-- ── Why ─────────────────────────────────────────────────────────────
--
-- House rule 12 in the AI-draft briefing says a one-off card costs "£180 inc
-- VAT, covering up to two cards". That figure is not in any table — it was
-- typed into the rule. The real fees live in proofs.prototype_prices
-- (migration 000287) and they are PER MATERIAL FAMILY: metal and carbon fibre
-- £179 / €189 / $189, acrylic £89 / €99 / $99, wood £59 / €79 / $79. Paper and
-- plastic prototypes are not offered at all.
--
-- The July 2026 edit review (docs/ai-draft-edit-review-2026-07.md §2.6) found
-- the drafter quoting £180 for a WOOD card — three times the real £59 — and
-- £180 for metal where the table says £179. That is not one wrong number; it
-- is what always happens when a price lives in prose. This migration gives the
-- drafter the same live read path it already has for the price list (000184)
-- and lead times (000180), so the figures can no longer drift from the admin
-- table.
--
-- ── House pattern ───────────────────────────────────────────────────
--
-- Same shape as public_get_lead_times (000180) and public_get_price_list
-- (000184): a SECURITY DEFINER function with EXECUTE granted to anon,
-- returning a tightly-scoped jsonb payload. No view, no fresh anon GRANT —
-- proofs.prototype_prices itself stays unreadable by anon (000287 revoked it),
-- and the restatement below makes that explicit rather than assumed. Pricing
-- data only: no customer, proof, contact, order, audit or settings columns.
--
-- ── Shape ───────────────────────────────────────────────────────────
--
--   {
--     "prices": [
--       { "family": "metal", "currency": "GBP", "amount": 179.00 }, ...
--     ],
--     "not_offered": ["paper", "plastic"]
--   }
--
-- Only families that are switched on AND priced appear in "prices" — that is
-- the same eligibility test the order builder uses, so the drafter can never
-- offer a prototype the ordering machinery would refuse to take.
--
-- "not_offered" carries the families we deliberately do not prototype. It is
-- there so the drafter can say "we don't offer a paper prototype" as a FACT
-- read from the table, rather than us writing that sentence into a rule and
-- creating the next £180. If an admin ever switches paper on, the family moves
-- from one list to the other and every future draft follows, with no code or
-- briefing change.
--
-- GBP amounts are VAT-inclusive; EUR and USD are VAT-free (the house
-- convention, and what 000287 seeded).

begin;

create or replace function proofs.public_get_prototype_prices()
returns jsonb
language sql
stable
security definer
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $$
  select jsonb_build_object(
    -- Offered = active AND priced. A row can exist with no amount yet
    -- (paper/plastic ship that way), which is not an offer.
    'prices', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'family',   pp.family,
            'currency', pp.currency,
            'amount',   pp.amount
          )
          order by pp.family, pp.currency
        )
        from prototype_prices pp
        where pp.is_active = true
          and pp.amount is not null
      ),
      '[]'::jsonb
    ),
    -- A family counts as not offered when it has no active, priced row in ANY
    -- currency. Families are all-or-nothing in practice, and this phrasing
    -- keeps a half-configured family out of the "we don't do it" list.
    'not_offered', coalesce(
      (
        select jsonb_agg(f.family order by f.family)
        from (
          select pp.family
          from prototype_prices pp
          group by pp.family
          having count(*) filter (where pp.is_active and pp.amount is not null) = 0
        ) f
      ),
      '[]'::jsonb
    )
  );
$$;

comment on function proofs.public_get_prototype_prices() is
  'Anon read path for the prototyping-service fees (proofs.prototype_prices, '
  '000287): the active per-family/currency prices plus the families we do not '
  'prototype. Read by the AI drafter as grounding so prototype figures are '
  'never hardcoded into a house rule. Same SECURITY DEFINER pattern as '
  'public_get_lead_times (000180) and public_get_price_list (000184).';

revoke all on function proofs.public_get_prototype_prices() from public;
grant execute on function proofs.public_get_prototype_prices() to anon, authenticated;

-- Belt and braces: the raw table must stay closed to anon. 000287 already
-- revoked it, and no default privilege grants anon anything, but the RPC is
-- only a narrow surface if the wide one stays shut — so say it out loud.
revoke all on proofs.prototype_prices from anon;

commit;
