-- 000299: finish photos — real photos of each finish (Natural / Brushed /
-- Mirror per metal) on the pay page's open-spec finish chooser
-- (docs/metal-spec-at-checkout-spec.md §5.3.5, Rob's photo upgrade).
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration. Do NOT
-- use `supabase db push`.
--
-- Two pieces:
--
--   1. material_options.photo_url — a public URL to a studio photo of that
--      finish on that material (steel-Brushed and gold-Brushed are separate
--      material_options rows, so each carries the right photo). Photos live in
--      the EXISTING public `material-icons` bucket under a `finish-photos/`
--      prefix — its storage policies are already admin-gated (admin
--      upload/update/delete, authenticated read, public bucket) and the
--      admin material editor already uses the same upload pattern for icons,
--      so no new bucket or storage policies are needed. Writes to the column
--      itself ride the existing "material_options: staff write" RLS policy +
--      authenticated CRUD grant verified on live 2026-07-03.
--
--   2. public_get_customer_proof — the options_arr CTE gains 'photo_url' so
--      the pay page (and anything else reading the proof graph) receives it.
--      CREATE OR REPLACE of a FUNCTION preserves its grants (unlike the view
--      drop+recreate footgun), so no grant re-statement is needed. Body below
--      is the live definition fetched 2026-07-03 with exactly one added line.

alter table proofs.material_options
  add column if not exists photo_url text;

-- Finish photos are real photography, not icons — give the shared bucket
-- enough headroom for a web-sized JPEG (was 2 MB, set when it only held
-- icons). Mime allow-list (png/jpeg/svg) unchanged.
update storage.buckets
  set file_size_limit = 5242880
  where id = 'material-icons' and file_size_limit < 5242880;

comment on column proofs.material_options.photo_url is
  'Public URL of a studio photo of this finish on this material (material-icons bucket, finish-photos/ prefix). Shown on the pay page''s open-spec finish chooser; null = fall back to the proof''s per-finish artwork, then a text-only card.';

CREATE OR REPLACE FUNCTION proofs.public_get_customer_proof(p_proof_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'proofs', 'public', 'extensions', 'pg_temp'
AS $function$
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
          'photo_url',    mo.photo_url
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
