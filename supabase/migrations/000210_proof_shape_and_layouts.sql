-- Migration 000210: proof shape + per-layout storage (Set collection, Phase 2).
--
-- Phase 1 shipped the proof-type wizard UI with no schema: the resolved
-- shape only drove the existing flags (is_variant_round / card_type /
-- has_personalisation) and Set (collection) was preview-only — its
-- layout titles had nowhere to live. This migration adds the storage so
-- a Set (collection) can be a real, saveable proof:
--
--   1. proof_versions.shape          — first-class shape, nullable.
--   2. proof_layouts                 — one row per titled layout in a
--                                      Set (collection). Mirrors
--                                      proof_round_variants deliberately.
--   3. proof_version_images.layout_id — per-layout image association,
--                                      the receive-all equivalent of
--                                      round_variant_id (pick-one) and
--                                      associated_name (recipients).
--   4. public_proof_version_images   — rebuilt to expose layout_id.
--   5. public_get_customer_proof     — rebuilt to expose each version's
--                                      shape + layouts list.
--
-- ADDITIVE AND BACKWARD-COMPATIBLE. Inert on production: no existing row
-- has shape = 'set_collection', no proof_layouts rows exist, and every
-- existing image has layout_id null. The shape backfill for legacy rows
-- is a SEPARATE idempotent migration (000211). The finalisation change
-- that makes layouts required approval slots is also separate (later
-- step), so this migration changes no behaviour on its own.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE TABLE IF NOT EXISTS,
-- CREATE INDEX IF NOT EXISTS, pg_policies existence checks, and
-- drop+recreate for the view / create-or-replace for the RPC.

begin;

-- ── 1. proof_versions.shape ───────────────────────────────────────────
--
-- Makes the resolved proof shape first-class so the customer page and
-- dashboard can branch without re-deriving from flags, and so Set
-- (single) and Recipients — which both map to card_type today — are
-- finally distinguishable. Nullable: legacy rows stay null until the
-- 000211 backfill, and the frontend falls back to flag-based behaviour
-- for null. The wizard writes it going forward.

alter table proof_versions
  add column if not exists shape text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'proof_versions_shape_chk'
  ) then
    alter table proof_versions
      add constraint proof_versions_shape_chk
      check (shape is null or shape in (
        'recipients', 'set_single', 'set_collection', 'selection'
      ));
  end if;
end$$;

comment on column proof_versions.shape is
  'Resolved proof-type-wizard shape: recipients | set_single | '
  'set_collection | selection. Nullable — legacy rows are backfilled '
  'from flags in 000211 and the frontend falls back to flag-based '
  'behaviour when null. set_collection is the only shape that carries '
  'proof_layouts rows; set_single gets the shape value but no layout '
  'rows (one shared slot, as today).';

-- ── 2. proof_layouts table ────────────────────────────────────────────
--
-- One row per titled layout in a Set (collection) — e.g. "ECG card",
-- "Infarction card". Mirrors proof_round_variants (000138) so it reuses
-- the same per-slot patterns, but kept as a SEPARATE table on purpose:
-- "pick one" (round variants) and "receive all" (layouts) have
-- different finalisation rules, and overloading one table would repeat
-- the names-array overloading we deliberately refused. `title` is the
-- customer-facing layout heading; `id` is the stable identity that
-- per-layout approvals and images key on (never title or sort_order,
-- which change when a designer renames or reorders).

create table if not exists proof_layouts (
  id                uuid        primary key default gen_random_uuid(),
  proof_version_id  uuid        not null references proof_versions(id) on delete cascade,
  title             text        not null,
  sort_order        int         not null default 0,
  created_at        timestamptz not null default now()
);

comment on table proof_layouts is
  'One row per titled layout in a Set (collection) proof_version. '
  'Designer-managed via the version form; the customer page reads '
  'these through public_get_customer_proof.layouts to render one '
  'section per layout. Empty (zero rows) on every other shape, '
  'including Set (single).';

comment on column proof_layouts.title is
  'Customer-facing layout heading (e.g. "ECG card"). These are layout '
  'titles, NOT recipient names — they live here rather than in '
  'proof_versions.names so "names" keeps meaning named recipients '
  'only. Empty strings rejected at the application layer.';

create index if not exists proof_layouts_proof_version_id_sort_order_idx
  on proof_layouts (proof_version_id, sort_order);

alter table proof_layouts enable row level security;

-- Authenticated full CRUD (the version form writes these directly via
-- the authenticated supabase-js client), anon revoked. Mirrors the
-- proof_round_variants policy set (000138 read + 000140 write). The
-- 000176 ALTER DEFAULT PRIVILEGES already grants authenticated table
-- CRUD; these RLS policies make the row access explicit. No anon grant —
-- customers read layouts only through public_get_customer_proof.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'proof_layouts'
      and policyname = 'proof_layouts: authenticated read'
  ) then
    create policy "proof_layouts: authenticated read"
      on proof_layouts for select to authenticated using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'proof_layouts'
      and policyname = 'proof_layouts: authenticated insert'
  ) then
    create policy "proof_layouts: authenticated insert"
      on proof_layouts for insert to authenticated with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'proof_layouts'
      and policyname = 'proof_layouts: authenticated update'
  ) then
    create policy "proof_layouts: authenticated update"
      on proof_layouts for update to authenticated using (true) with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'proof_layouts'
      and policyname = 'proof_layouts: authenticated delete'
  ) then
    create policy "proof_layouts: authenticated delete"
      on proof_layouts for delete to authenticated using (true);
  end if;
end$$;

-- ── 3. proof_version_images.layout_id ─────────────────────────────────
--
-- Per-layout image association for Set (collection). The receive-all
-- equivalent of round_variant_id (pick-one) and associated_name
-- (recipients). Non-null on a collection's images; null for shared /
-- named / round-variant images. Cascade delete: removing a layout
-- removes its images, mirroring round_variant_id (000138).
--
-- The existing validate_variant_round_image() trigger (000138) is
-- unaffected: a collection image lives on a non-variant-round version
-- (round_variant_id null, associated_name null), which the trigger
-- already permits.

alter table proof_version_images
  add column if not exists layout_id uuid
  references proof_layouts(id) on delete cascade;

comment on column proof_version_images.layout_id is
  'Layout this image belongs to on a Set (collection) version. Non-null '
  'on collection images; null on shared, per-recipient, and '
  'round-variant images. Cascade delete: removing a layout removes its '
  'images.';

create index if not exists proof_version_images_layout_id_idx
  on proof_version_images (layout_id);

-- ── 4. Rebuild public_proof_version_images (expose layout_id) ─────────
--
-- Append-only column addition; PostgreSQL can't change a view's column
-- list with create-or-replace, so this is a drop + recreate. Body
-- matches the current 000192 definition with layout_id appended after
-- round_variant_id (keeping pre-existing columns in their declared
-- order so typed consumers don't shift offsets). Grants + security_invoker
-- re-stated — drop+recreate silently wipes both (the 000168/000174
-- footgun).

drop view if exists public_proof_version_images;

create view public_proof_version_images as
  select
    id,
    proof_version_id,
    image_path,
    sort_order,
    material_option,
    original_filename,
    associated_name,
    side,
    round_variant_id,
    layout_id,
    is_qr_code,
    qr_decoded_data,
    qr_kind,
    qr_vcard_slug
  from proof_version_images;

revoke select on public_proof_version_images from anon, public;
grant  select on public_proof_version_images to authenticated;
alter view public_proof_version_images set (security_invoker = on);

-- ── 5. Rebuild public_get_customer_proof (expose shape + layouts) ─────
--
-- create or replace (returns jsonb, so the return-type is unchanged).
-- Body matches the current 000177 definition with two additions to each
-- per-version object: 'shape' and a 'layouts' array (id, title,
-- sort_order). Everything else is byte-for-byte the 000177 body.

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
          'material_code',            m.code,
          -- ── Shape + layouts (000210) ────────────────────────────
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

revoke execute on function public_get_customer_proof(uuid) from public;
grant  execute on function public_get_customer_proof(uuid) to anon, authenticated;

commit;
