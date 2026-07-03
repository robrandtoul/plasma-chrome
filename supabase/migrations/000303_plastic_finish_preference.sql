-- 000303: gloss / matte finish choice on Full Colour Plastic — the first
-- "preference-only" finish dimension.
--
-- Full colour plastic comes in two finishes, gloss and matte. Unlike the
-- metal finishes (brushed vs mirror artwork tabs), the choice changes
-- nothing about the artwork and nothing about the price — it is strictly
-- the customer's preference, settled at checkout via the open-spec finish
-- chooser (000298/000299). Three pieces:
--
--   1. material_options.description — a short customer-facing line per
--      option, rendered on the pay page's finish cards. Gloss/matte has no
--      studio-photo story the way brushed-vs-mirror does, so words carry
--      the education (the same reasoning as the thickness cards' copy).
--      Nullable; metal/wood rows stay null and render exactly as before.
--   2. Seed: materials.option_label = 'Finish' on plastic_full_colour plus
--      two material_options rows — Gloss (base) and Matte. NO surcharge
--      rows: both price identically, so every card reads "Included" (the
--      wood-species precedent). Idempotent via on conflict on the
--      (material_id, code) unique key.
--   3. public_get_customer_proof: emit the new description field in the
--      options_arr block. CREATE OR REPLACE, body otherwise verbatim from
--      the live definition (000299 lineage) — grants are preserved by
--      replace, so no re-statement needed.
--
-- Deliberately NOT done here: the version form / proof page keep treating
-- plastic as having no option dimension (frontend gates on the material
-- code via finishIsPreferenceOnly) — proofs never grow gloss/matte tabs,
-- because the artwork is identical in both. The chooser is fed from this
-- catalogue directly.

-- 1 ── description column ────────────────────────────────────────────────
alter table proofs.material_options
  add column if not exists description text;

comment on column proofs.material_options.description is
  'Short customer-facing line for the pay-page finish chooser card. Null = no copy (metal finishes rely on photos instead).';

-- 2 ── seed the Full Colour Plastic finish dimension ─────────────────────
update proofs.materials
   set option_label = 'Finish'
 where code = 'plastic_full_colour';

insert into proofs.material_options (material_id, code, display_name, is_base, sort_order, description)
select m.id, v.code, v.display_name, v.is_base, v.sort_order, v.description
from proofs.materials m
join (values
  ('gloss', 'Gloss', true,  10,
   'A bright, reflective surface that makes colours pop.'),
  ('matte', 'Matte', false, 20,
   'A soft, non-reflective surface with a luxurious feel — and better at masking everyday wear and tear.')
) as v(code, display_name, is_base, sort_order, description)
  on true
where m.code = 'plastic_full_colour'
on conflict (material_id, code) do nothing;

-- 3 ── expose description on the customer RPC ────────────────────────────
-- Verbatim live body (000299 lineage) plus the one description line in
-- options_arr. CREATE OR REPLACE keeps the existing grants (EXECUTE to
-- anon) intact.
create or replace function proofs.public_get_customer_proof(p_proof_id uuid)
returns jsonb
language sql
stable security definer
set search_path = proofs, public, extensions, pg_temp
as $function$
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
          'material_code',            m.code,
          -- -- Shape + layouts (000210) ------------------------------
          -- shape makes the wizard's resolution first-class; layouts
          -- carries one row per titled layout on a Set (collection),
          -- in sort order. Empty array on every other shape.
          'shape',                    pv.shape,
          'layouts', (
            select coalesce(
              jsonb_agg(
                jsonb_build_object(
                  'id',         pl.id,
                  'title',      pl.title,
                  'sort_order', pl.sort_order
                )
                order by pl.sort_order, pl.id
              ),
              '[]'::jsonb
            )
            from proof_layouts pl
            where pl.proof_version_id = pv.id
          )
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
          'sort_order',   mo.sort_order,
          'photo_url',    mo.photo_url,
          'description',  mo.description
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
$function$;
