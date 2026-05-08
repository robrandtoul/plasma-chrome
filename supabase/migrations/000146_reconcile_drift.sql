-- Migration 000146: reconcile direct-edit drift surfaced by the
-- 2026-05-08 pricing audit.
--
-- Two unrelated drifts captured in source so that a fresh replay of
-- migrations + seed produces the live state, and so that future
-- audits don't keep flagging them.
--
-- Item 1 — revert a single tier value back to the seed canonical.
--
-- price_tiers.metal_gun_metal | 800um | GBP | 750 was edited live
-- to 1798.63 / 2.39817 (37p below the seed's 1799.00 / 2.39867).
-- The seed value is canonical; the live value looks like an
-- accidental overwrite. We force the row back to the seed value
-- here so live + source agree again.
--
-- Item 2 — capture four deliberate split-name surcharge enablements
-- that were applied directly to live and never made it into source.
--
--   acrylic            £25 / €39 / $39
--   carbon_fibre       £39 / €39 / $49
--   carbon_fibre_cnc   £39 / €39 / $49
--   paper_standard     £39 / €39 / $49
--
-- These were intentional rate changes — wood / acrylic / paper
-- standard / carbon fibre originally didn't bill split-name
-- tooling, but Rob has decided the cost should now apply on
-- acrylic, carbon fibre (both variants), and standard paper.
-- Wood remains null. The CLAUDE.md global rules are updated to
-- match alongside this migration.
--
-- Both items are idempotent — re-running on already-reconciled
-- rows is a no-op.

begin;

-- ── Item 1: gun_metal 800um GBP 750 ───────────────────────────
update price_tiers pt
set total_price = 1799.00,
    unit_price  = round(1799.00::numeric / 750, 4)
from material_variants mv
join materials m on m.id = mv.material_id
where pt.material_variant_id = mv.id
  and m.code = 'metal_gun_metal'
  and mv.code = '800um'
  and pt.currency = 'GBP'
  and pt.quantity = 750;

-- ── Item 2: split-name surcharge enablements ─────────────────
update materials
set split_name_surcharge_gbp = 25.00,
    split_name_surcharge_eur = 39.00,
    split_name_surcharge_usd = 39.00
where code = 'acrylic';

update materials
set split_name_surcharge_gbp = 39.00,
    split_name_surcharge_eur = 39.00,
    split_name_surcharge_usd = 49.00
where code in ('carbon_fibre', 'carbon_fibre_cnc', 'paper_standard');

commit;
