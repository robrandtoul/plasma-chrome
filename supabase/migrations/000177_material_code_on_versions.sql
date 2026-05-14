-- Migration 000177: expose m.code as material_code on proof version surfaces.
--
-- The customer page needs to know the raw material code (e.g. 'metal_steel')
-- to gate the metal thickness guide section (analogous to the letterpress
-- Construction section which gates on the presence of core/front/back colour
-- data). The code is already on the materials row joined by both
-- public_proof_versions and public_get_customer_proof — this migration simply
-- surfaces it.
--
-- Changes:
--   1. Rebuild public_proof_versions to add m.code as material_code.
--   2. Rebuild public_get_customer_proof to add 'material_code' to each
--      version object.
--
-- Both are drop+recreate because Postgres view column binding is fixed at
-- definition time, and the RPC uses create or replace (idempotent on
-- return-type changes since it returns jsonb). Grants re-stated per the
-- CLAUDE.md pattern: any drop+recreate wipes grants silently.

begin;

-- ── 1. Rebuild public_proof_versions ──────────────────────────────────────
--
-- Body matches 000172 exactly, with m.code as material_code appended after
-- m.option_label (keeping all pre-existing columns in their declared order
-- so existing typed consumers don't shift column offsets).

drop view if exists public_proof_versions;

create view public_proof_versions as
  select
    pv.id,
    pv.proof_id,
    pv.version_number,
    pv.material_id,
    pv.material_display,
    pv.ink_names,
    pv.currency,
    pv.pricing_snapshot,
    pv.shipping_note,
    pv.change_notes,
    pv.is_current,
    pv.created_at,
    pv.material_options,
    m.disclaimer        as material_disclaimer,
    m.description       as material_description,
    m.icon_url          as material_icon_url,
    m.option_label,
    pv.custom_quote,
    pv.superseded_at,
    pv.names,
    pv.split_name_surcharge_snapshot,
    (
      select coalesce(
        jsonb_agg(jsonb_build_object(
          'name', pna.name,
          'state', pna.state,
          'carried_from_version_id', pna.carried_from_version_id,
          'material_option_code', pna.material_option_code
        )),
        '[]'::jsonb
      )
      from proof_name_approvals pna
      where pna.proof_version_id = pv.id
    ) as approvals,
    pv.card_type,
    m.display_quantities,
    m.quote_min_quantity,
    m.quote_max_quantity,
    m.key_features,
    pv.displayed_variant_ids,
    (
      select coalesce(
        jsonb_agg(jsonb_build_object(
          'name', e.name,
          'event_type', e.event_type,
          'actor_name', e.actor_name,
          'comment', e.comment,
          'created_at', e.created_at,
          'helpscout_thread_id', e.helpscout_thread_id,
          'material_option_code', e.material_option_code,
          'round_variant_id', e.round_variant_id
        )),
        '[]'::jsonb
      )
      from (
        select distinct on (proof_version_id, name) *
        from proof_events
        where proof_version_id = pv.id
        order by proof_version_id, name, created_at desc
      ) e
    ) as latest_events_by_name,
    s.approvals_enabled as approvals_enabled,
    cc.name             as core_colour_name,
    cc.hex_value        as core_colour_hex,
    fc.name             as front_colour_name,
    fc.hex_value        as front_colour_hex,
    bc.name             as back_colour_name,
    bc.hex_value        as back_colour_hex,
    pv.is_variant_round,
    (
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'id',           rv.id,
            'code',         rv.code,
            'display_name', rv.display_name,
            'sort_order',   rv.sort_order
          )
          order by rv.sort_order, rv.code
        ),
        '[]'::jsonb
      )
      from proof_round_variants rv
      where rv.proof_version_id = pv.id
    ) as round_variants,
    pv.is_per_direction_pricing,
    pv.has_personalisation,
    -- ── Material code (000177) ────────────────────────────────────────
    -- Raw material code from the materials table (e.g. 'metal_steel',
    -- 'paper_letterpress'). Null when material_id is null (i.e. on
    -- per-direction-pricing variant rounds — the same condition that
    -- makes material_id nullable). Customer page uses this to gate
    -- material-specific contextual panels such as the metal thickness
    -- guide and the letterpress construction section.
    m.code              as material_code
  from proof_versions pv
  left join materials m on m.id = pv.material_id
  left join letterpress_core_colours cc on cc.id = pv.core_colour_id
  left join letterpress_core_colours fc on fc.id = pv.front_colour_id
  left join letterpress_core_colours bc on bc.id = pv.back_colour_id
  cross join (select approvals_enabled from settings where id = 1) s;

-- Re-apply grants. Drop + recreate silently removes grants; re-stating
-- them here matches the established anon-RPC pattern (000162 / 000172).
revoke select on public_proof_versions from anon, public;
grant  select on public_proof_versions to authenticated;

-- ── 2. Rebuild public_get_customer_proof ──────────────────────────────────
--
-- Body matches 000172 exactly. The only change is the addition of
-- 'material_code', m.code after 'has_personalisation' in the per-version
-- jsonb object.

create or replace function public_get_customer_proof(p_proof_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with
  target as (
    select
      p.id                           as proof_id,
      p.status,
      p.approved_at,
      p.abandoned_at,
      p.disclaimer_acknowledged_at,
      c.full_name                    as customer_name,
      co.name                        as company
    from proofs p
    join contacts c on c.id = p.contact_id
    left join companies co on co.id = c.company_id
    where p.id = p_proof_id
  ),
  proof_materials as (
    select distinct material_id
    from proof_versions
    where proof_id = p_proof_id
      and material_id is not null
  ),
  proof_currencies as (
    select distinct currency
    from proof_versions
    where proof_id = p_proof_id
      and currency is not null
  ),
  versions_arr as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id',                            pv.id,
          'proof_id',                      pv.proof_id,
          'version_number',                pv.version_number,
          'material_id',                   pv.material_id,
          'material_display',              pv.material_display,
          'ink_names',                     pv.ink_names,
          'currency',                      pv.currency,
          'pricing_snapshot',              pv.pricing_snapshot,
          'shipping_note',                 pv.shipping_note,
          'change_notes',                  pv.change_notes,
          'is_current',                    pv.is_current,
          'created_at',                    pv.created_at,
          'material_options',              pv.material_options,
          'material_disclaimer',           m.disclaimer,
          'material_description',          m.description,
          'material_icon_url',             m.icon_url,
          'option_label',                  m.option_label,
          'custom_quote',                  pv.custom_quote,
          'superseded_at',                 pv.superseded_at,
          'names',                         pv.names,
          'split_name_surcharge_snapshot', pv.split_name_surcharge_snapshot,
          'approvals', (
            select coalesce(
              jsonb_agg(jsonb_build_object(
                'name',                    pna.name,
                'state',                   pna.state,
                'carried_from_version_id', pna.carried_from_version_id,
                'material_option_code',    pna.material_option_code
              )),
              '[]'::jsonb
            )
            from proof_name_approvals pna
            where pna.proof_version_id = pv.id
          ),
          'card_type',                     pv.card_type,
          'display_quantities',            m.display_quantities,
          'quote_min_quantity',            m.quote_min_quantity,
          'quote_max_quantity',            m.quote_max_quantity,
          'key_features',                  m.key_features,
          'displayed_variant_ids',         pv.displayed_variant_ids,
          'latest_events_by_name', (
            select coalesce(
              jsonb_agg(jsonb_build_object(
                'name',                  e.name,
                'event_type',            e.event_type,
                'actor_name',            e.actor_name,
                'comment',               e.comment,
                'created_at',            e.created_at,
                'helpscout_thread_id',   e.helpscout_thread_id,
                'material_option_code',  e.material_option_code,
                'round_variant_id',      e.round_variant_id
              )),
              '[]'::jsonb
            )
            from (
              select distinct on (proof_version_id, name) *
              from proof_events
              where proof_version_id = pv.id
              order by proof_version_id, name, created_at desc
            ) e
          ),
          'approvals_enabled',  s.approvals_enabled,
          'core_colour_name',   cc.name,
          'core_colour_hex',    cc.hex_value,
          'front_colour_name',  fc.name,
          'front_colour_hex',   fc.hex_value,
          'back_colour_name',   bc.name,
          'back_colour_hex',    bc.hex_value,
          'is_variant_round',   pv.is_variant_round,
          'round_variants', (
            select coalesce(
              jsonb_agg(
                jsonb_build_object(
                  'id',           rv.id,
                  'code',         rv.code,
                  'display_name', rv.display_name,
                  'sort_order',   rv.sort_order
                )
                order by rv.sort_order, rv.code
              ),
              '[]'::jsonb
            )
            from proof_round_variants rv
            where rv.proof_version_id = pv.id
          ),
          'is_per_direction_pricing', pv.is_per_direction_pricing,
          'has_personalisation',      pv.has_personalisation,
          -- ── Material code (000177) ──────────────────────────────
          'material_code',            m.code
        )
        order by pv.version_number asc
      ),
      '[]'::jsonb
    ) as arr
    from proof_versions pv
    left join materials m on m.id = pv.material_id
    left join letterpress_core_colours cc on cc.id = pv.core_colour_id
    left join letterpress_core_colours fc on fc.id = pv.front_colour_id
    left join letterpress_core_colours bc on bc.id = pv.back_colour_id
    cross join (select approvals_enabled from settings where id = 1) s
    where pv.proof_id = p_proof_id
  ),
  options_arr as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id',           mo.id,
          'material_id',  mo.material_id,
          'code',         mo.code,
          'display_name', mo.display_name,
          'is_base',      mo.is_base,
          'sort_order',   mo.sort_order
        )
        order by mo.sort_order
      ),
      '[]'::jsonb
    ) as arr
    from material_options mo
    where mo.material_id in (select material_id from proof_materials)
  ),
  surcharges_arr as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id',                 mos.id,
          'material_option_id', mos.material_option_id,
          'currency',           mos.currency,
          'quantity',           mos.quantity,
          'surcharge',          mos.surcharge
        )
      ),
      '[]'::jsonb
    ) as arr
    from material_option_surcharges mos
    where mos.material_option_id in (
      select id from material_options
      where material_id in (select material_id from proof_materials)
    )
  ),
  variants_arr as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id',           mv.id,
          'material_id',  mv.material_id,
          'display_name', mv.display_name,
          'variant_type', mv.variant_type,
          'sort_order',   mv.sort_order
        )
        order by mv.sort_order
      ),
      '[]'::jsonb
    ) as arr
    from material_variants mv
    join materials m on m.id = mv.material_id
    where mv.material_id in (select material_id from proof_materials)
      and m.is_active     = true
      and m.is_published  = true
      and m.archived_at   is null
      and mv.is_active    = true
  ),
  tiers_arr as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id',                  pt.id,
          'material_variant_id', pt.material_variant_id,
          'currency',            pt.currency,
          'quantity',            pt.quantity,
          'total_price',         pt.total_price,
          'unit_price',          pt.unit_price
        )
      ),
      '[]'::jsonb
    ) as arr
    from price_tiers pt
    join material_variants mv on mv.id = pt.material_variant_id
    join materials m on m.id = mv.material_id
    where mv.material_id in (select material_id from proof_materials)
      and pt.currency    in (select currency from proof_currencies)
      and m.is_active    = true
      and m.is_published = true
      and mv.is_active   = true
      and m.archived_at  is null
  ),
  personalisation_pricing_obj as (
    select coalesce(
      jsonb_object_agg(
        pp.currency,
        jsonb_build_object(
          'per_card_rate', pp.per_card_rate,
          'min_charge',    pp.min_charge
        )
      ),
      '{}'::jsonb
    ) as obj
    from personalisation_pricing pp
    where pp.currency in (select currency from proof_currencies)
  )
  select case
    when not exists (select 1 from target) then null
    else jsonb_build_object(
      'proof', (
        select jsonb_build_object(
          'customer_name',              t.customer_name,
          'company',                    t.company,
          'status',                     t.status,
          'approved_at',                t.approved_at,
          'abandoned_at',               t.abandoned_at,
          'disclaimer_acknowledged_at', t.disclaimer_acknowledged_at
        )
        from target t
      ),
      'versions',                   (select arr from versions_arr),
      'material_options',           (select arr from options_arr),
      'material_option_surcharges', (select arr from surcharges_arr),
      'material_variants',          (select arr from variants_arr),
      'price_tiers',                (select arr from tiers_arr),
      'personalisation_pricing',    (select obj from personalisation_pricing_obj)
    )
  end;
$$;

-- Grants re-stated. create or replace preserves existing EXECUTE grants
-- on functions (unlike views), but re-stating is belt-and-braces and
-- consistent with the established pattern.
revoke execute on function public_get_customer_proof(uuid) from public;
grant  execute on function public_get_customer_proof(uuid) to anon, authenticated;

commit;
