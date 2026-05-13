-- Migration 000172: personalisation add-on for membership cards.
--
-- Adds an optional, paid "personalisation" feature: unique data
-- per card (member numbers, individual names, etc.). Distinct from
-- the existing split-name tooling surcharge, which prices multi-
-- name batches that share a single design — personalisation
-- prices unique-per-card data across the whole run.
--
-- Pricing model: a flat per-card rate with a minimum-charge floor,
-- per currency. surcharge = max(min_charge, qty x per_card_rate).
-- The rate and floor are admin-editable from the settings page;
-- they are NEVER snapshotted onto proof_versions. Customer pages
-- always render today's live numbers, so a rate change applies
-- immediately to every personalised proof in the system. The
-- alternative (snapshotting at version creation) was rejected
-- explicitly in the brief.
--
-- Eligibility: gated on materials.supports_personalisation = true
-- AND proof_versions.card_type = 'membership'. The supports flag is
-- admin-editable so the list of eligible materials can shift later
-- without a code change. Initial eligible set seeded below:
--   * all metal_* materials (eight codes)
--   * plastic_full_colour
--   * wood
--   * acrylic
-- Verified against the live materials table at migration time.
--
-- This migration:
--   1. Adds materials.supports_personalisation, seeds eligible rows.
--   2. Creates personalisation_pricing (one row per currency).
--   3. Adds proof_versions.has_personalisation.
--   4. Rebuilds public_proof_versions (drop + create) to expose the
--      new flag.
--   5. Replaces public_get_customer_proof to include has_personalisation
--      on each version plus the live per_card_rate + min_charge
--      resolved for each version's currency.
--   6. RLS + grants on personalisation_pricing per the anon-RPC
--      pattern (memory:proof_viewer_anon_rpc_pattern.md). Designers
--      get read; admins get update. Anon gets nothing direct; the
--      RPC is the only anon-reachable surface.

begin;

-- ── 1. materials.supports_personalisation ──────────────────────────

alter table materials
  add column supports_personalisation boolean not null default false;

comment on column materials.supports_personalisation is
  'When true, the designer-side new/edit version form shows the '
  '"Add personalisation" checkbox (gated also on card_type = '
  '''membership''). Admin-editable from the material content modal. '
  'Initial seed set in migration 000172 covers all metal_* materials, '
  'plastic_full_colour, wood, and acrylic.';

update materials
   set supports_personalisation = true
 where code in (
   'metal_copper',
   'metal_gold',
   'metal_gun_metal',
   'metal_matte_black',
   'metal_matte_white',
   'metal_mini_steel',
   'metal_steel',
   'metal_titanium',
   'plastic_full_colour',
   'wood',
   'acrylic'
 );

-- ── 2. personalisation_pricing ─────────────────────────────────────
--
-- One row per currency. per_card_rate + min_charge are both > 0
-- (CHECK enforced). Seed values match the brief:
--   GBP 0.20 / 50
--   USD 0.25 / 50
--   EUR 0.25 / 50

create table personalisation_pricing (
  currency       text not null primary key
                 check (currency in ('GBP','USD','EUR')),
  per_card_rate  numeric(10,2) not null check (per_card_rate > 0),
  min_charge     numeric(10,2) not null check (min_charge > 0),
  updated_at     timestamptz not null default now()
);

comment on table personalisation_pricing is
  'Per-currency personalisation pricing for the membership-card '
  'add-on. Rate and floor only; the customer page renders '
  'max(min_charge, qty x per_card_rate) live for every personalised '
  'proof. NEVER snapshotted onto proof_versions — admin edits '
  'propagate immediately to every existing personalised proof.';

insert into personalisation_pricing (currency, per_card_rate, min_charge) values
  ('GBP', 0.20, 50),
  ('USD', 0.25, 50),
  ('EUR', 0.25, 50);

-- RLS: authenticated designers can read so the admin editor and any
-- future designer-facing surfaces work. Only admins can insert /
-- update / delete; mirrors the site_settings pattern. Anon gets
-- nothing direct — the customer page reads via the RPC below.

alter table personalisation_pricing enable row level security;

create policy "personalisation_pricing read for authenticated"
  on personalisation_pricing
  for select
  to authenticated
  using (true);

create policy "personalisation_pricing update for admin"
  on personalisation_pricing
  for update
  to authenticated
  using (is_admin())
  with check (is_admin());

-- Grants: explicit revoke from anon, grant select to authenticated.
-- The RPC below is the only anon-reachable surface.
grant select on personalisation_pricing to authenticated;
grant update on personalisation_pricing to authenticated;
revoke select on personalisation_pricing from anon, public;

-- ── 3. proof_versions.has_personalisation ──────────────────────────

alter table proof_versions
  add column has_personalisation boolean not null default false;

comment on column proof_versions.has_personalisation is
  'When true, the customer page renders a personalisation line item '
  '(per-card rate with min-charge floor) beneath the base pricing '
  'grid, plus a Total row. Eligibility gate on the form side: '
  'materials.supports_personalisation = true AND card_type = '
  '''membership''. Suppressed when custom_quote = true or '
  'is_per_direction_pricing = true (both bypass the standard grid).';

-- ── 4. Rebuild public_proof_versions ──────────────────────────────
--
-- Drop and recreate (not create-or-replace) since we are appending
-- columns to a view and Postgres binds view columns at definition
-- time. Body matches 000144 with the has_personalisation column
-- appended at the end of the select list.

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
    -- ── Personalisation (000172) ──────────────────────────────
    -- Per-version flag. Customer page renders the personalisation
    -- line item live from personalisation_pricing when this is
    -- true (and the version is not custom_quote / per-direction).
    pv.has_personalisation
  from proof_versions pv
  left join materials m on m.id = pv.material_id
  left join letterpress_core_colours cc on cc.id = pv.core_colour_id
  left join letterpress_core_colours fc on fc.id = pv.front_colour_id
  left join letterpress_core_colours bc on bc.id = pv.back_colour_id
  cross join (select approvals_enabled from settings where id = 1) s;

-- The anon enumeration fix (000162) revokes SELECT from anon, public
-- on this view and grants it to authenticated. Re-apply the same
-- grants since this is a fresh view object.
revoke select on public_proof_versions from anon, public;
grant  select on public_proof_versions to authenticated;

-- ── 5. Rebuild public_get_customer_proof ──────────────────────────
--
-- Same body as 000162, with three changes:
--   * has_personalisation added to the per-version jsonb object.
--   * A new top-level personalisation_pricing block resolved for
--     every currency referenced by the proof's versions. Returned
--     as a {currency: {per_card_rate, min_charge}} map so the
--     customer page can look up the rate by activeVersion.currency.
--     Resolves live from personalisation_pricing — no snapshot.
--   * Filter on personalisation_pricing scoped to proof_currencies
--     so we never leak the full per-currency table.

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
          'has_personalisation',      pv.has_personalisation
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
    -- One key per currency referenced by the proof's versions. The
    -- customer page indexes this by activeVersion.currency to render
    -- live numbers; updating personalisation_pricing in the admin
    -- propagates the new rate to every personalised proof on the
    -- next page load (no version bump needed).
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
