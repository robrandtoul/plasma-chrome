-- Migration 000184: public_get_price_list RPC for the marketing site
-- price-list pages.
--
-- The plasmadesign.co.uk GBP/EUR/USD price-list pages currently render
-- via the CommonNinja embed. The cell-by-cell parity audit on
-- 2026-05-15 confirmed every one of the 16 tables on each page is
-- backed by data Supabase already holds (materials, material_variants,
-- price_tiers, material_options, material_option_surcharges). We are
-- replacing CommonNinja with a small Squarespace-side script that
-- renders the same tables from Supabase — this migration ships the
-- anon-readable read path that script will call. GBP first, EUR + USD
-- to follow once GBP is verified live.
--
-- ── House pattern ───────────────────────────────────────────────────
--
-- Migration 000162 revoked anon SELECT on price_tiers, materials,
-- material_variants, material_options, material_option_surcharges and
-- the public_* views over them. The 000180 lead-times RPC established
-- the follow-on pattern for new anon read paths: a SECURITY DEFINER
-- function with EXECUTE granted to anon, returning a tightly-scoped
-- jsonb payload — no new view, no fresh anon GRANT, no re-opening the
-- table-shaped surface 000162 deliberately closed.
--
-- ── Scope ──────────────────────────────────────────────────────────
--
-- The function takes one currency ('GBP' | 'EUR' | 'USD') and returns
-- everything the 16 tables need in a single round-trip. Pricing data
-- only — no customer, proof, contact, profile, audit, or settings
-- columns. Materials are filtered to is_active = true,
-- is_published = true, archived_at IS NULL, so unpublished rows
-- (Titanium, today) stay hidden exactly as they are on the live page.
-- Variants are filtered to is_active = true. Price tiers and option
-- surcharges are filtered to the requested currency.
--
-- carbon_fibre_cnc and paper_letterpress_gilded come through like any
-- other published material; the rendering script computes the CNC and
-- gilding surcharge columns as differences between those materials
-- and their base (carbon_fibre / paper_letterpress) totals. The
-- material_option_surcharges path covers the metal mirror/brushed
-- column on metal_steel and metal_gold.
--
-- ── Shape ──────────────────────────────────────────────────────────
--
-- Returns a jsonb object:
--   {
--     "currency": "GBP",
--     "materials": [
--       {
--         "code": "metal_steel",
--         "display_name": "Stainless Steel",
--         "variants": [
--           {
--             "id": <uuid>,
--             "code": "300um",
--             "display_name": "300 micron",
--             "variant_type": "thickness",
--             "ink_count": null,
--             "sort_order": 1,
--             "tiers": [{ "quantity": 50, "total_price": 279.00 }, ...]
--           }, ...
--         ],
--         "option_surcharges": [
--           { "option_code": "brushed", "quantity": 50, "surcharge": 30.00 },
--           { "option_code": "mirror",  "quantity": 50, "surcharge": 30.00 }, ...
--         ]
--       }, ...
--     ]
--   }
--
-- The script reads everything by material_code, so nesting per
-- material keeps the per-table lookup O(1) without a client-side
-- join. Surcharges are grouped under their owning material rather
-- than emitted globally so the response stays self-contained per
-- material card.
--
-- Returns an empty materials array for unknown currencies rather than
-- raising — keeps the script's error path tied to "RPC returned
-- nothing useful" rather than two separate failure modes.

begin;

create or replace function public_get_price_list(p_currency text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with currency_input as (
    select upper(coalesce(p_currency, '')) as c
  ),
  -- Published, active, non-archived materials only. Titanium
  -- (is_published = false today) is excluded by this filter and
  -- stays hidden on the rendered pages without any extra logic.
  visible_materials as (
    select m.id, m.code, m.display_name, m.sort_order
    from materials m
    where m.is_active     = true
      and m.is_published  = true
      and m.archived_at   is null
  ),
  variant_tiers as (
    select
      mv.material_id,
      mv.id            as variant_id,
      mv.code          as variant_code,
      mv.display_name  as variant_display_name,
      mv.variant_type,
      mv.ink_count,
      mv.sort_order    as variant_sort_order,
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'quantity',    pt.quantity,
            'total_price', pt.total_price
          )
          order by pt.quantity
        ) filter (where pt.id is not null),
        '[]'::jsonb
      ) as tiers
    from material_variants mv
    join visible_materials vm on vm.id = mv.material_id
    left join price_tiers pt
      on pt.material_variant_id = mv.id
     and pt.currency = (select c from currency_input)
    where mv.is_active = true
    group by mv.material_id, mv.id, mv.code, mv.display_name,
             mv.variant_type, mv.ink_count, mv.sort_order
  ),
  -- Per-currency option surcharges, scoped to options owned by
  -- visible materials. Today this only fires for metal_steel and
  -- metal_gold (mirror + brushed). Other materials' options either
  -- have no surcharge rows (wood species, carbon fibre Without
  -- cutting) or no option_surcharges path at all.
  material_surcharges as (
    select
      mo.material_id,
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'option_code', mo.code,
            'quantity',    mos.quantity,
            'surcharge',   mos.surcharge
          )
          order by mo.code, mos.quantity
        ) filter (where mos.id is not null),
        '[]'::jsonb
      ) as option_surcharges
    from material_options mo
    join visible_materials vm on vm.id = mo.material_id
    left join material_option_surcharges mos
      on mos.material_option_id = mo.id
     and mos.currency = (select c from currency_input)
    group by mo.material_id
  )
  select jsonb_build_object(
    'currency', (select c from currency_input),
    'materials', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'code',         vm.code,
            'display_name', vm.display_name,
            'variants', coalesce(
              (
                select jsonb_agg(
                  jsonb_build_object(
                    'id',           vt.variant_id,
                    'code',         vt.variant_code,
                    'display_name', vt.variant_display_name,
                    'variant_type', vt.variant_type,
                    'ink_count',    vt.ink_count,
                    'sort_order',   vt.variant_sort_order,
                    'tiers',        vt.tiers
                  )
                  order by vt.variant_sort_order, vt.variant_code
                )
                from variant_tiers vt
                where vt.material_id = vm.id
              ),
              '[]'::jsonb
            ),
            'option_surcharges', coalesce(
              (
                select ms.option_surcharges
                from material_surcharges ms
                where ms.material_id = vm.id
              ),
              '[]'::jsonb
            )
          )
          order by vm.sort_order, vm.code
        )
        from visible_materials vm
      ),
      '[]'::jsonb
    )
  );
$$;

revoke execute on function public_get_price_list(text) from public;
grant  execute on function public_get_price_list(text) to anon, authenticated;

commit;
