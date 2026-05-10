-- Migration 000162: anon enumeration fix.
--
-- The recon at audits/test-runs/2026-05-09-rls-recon.md mapped what the anon
-- role can SELECT from PostgREST today. The customer-facing views
-- (public_proofs, public_proof_versions, public_proof_version_images,
-- public_material_options, public_material_option_surcharges,
-- public_material_variants, public_price_tiers, public_site_settings) all
-- return data unfiltered to anon, leaking customer_name + company +
-- helpscout_conversation_id and the proof_versions PII (recipient names,
-- ink_names, change_notes) across every proof in the system.
--
-- ── Why this isn't a row-level RLS problem ──────────────────────────
--
-- Anon has no identity. RLS filters rows per user; with no user it can
-- only allow-all or deny-all. The protection on customer URLs is the
-- unguessability of the proof UUID. The desired guarantee is "anon can
-- fetch one proof's graph given its UUID, but cannot enumerate any
-- table" — which is the shape of a SECURITY DEFINER RPC, not a row-level
-- policy.
--
-- ── What this migration does ────────────────────────────────────────
--
-- 1. Defines public_get_customer_proof(p_proof_id uuid) returns jsonb,
--    SECURITY DEFINER, with EXECUTE granted to anon + authenticated.
--    One round-trip from the customer page; returns null when the proof
--    isn't found (so the existing `data === null` 404 branch fires).
--
-- 2. Revokes anon SELECT on the customer-facing views and the
--    underlying tables they read from. Keeps authenticated SELECT
--    intact via explicit re-grants so the designer dashboard, the
--    Proof detail page, the version detail modal, and the
--    customer-proof-images edge function (service-role) keep working.
--
-- The function reads underlying tables, not the views, so it doesn't
-- depend on the views' grants. It runs as the function owner via
-- SECURITY DEFINER, which bypasses both the revoked grants and any RLS
-- policies on the underlying tables — exactly the surface the customer
-- page needs without exposing the tables themselves.

begin;

-- ── 1. SECURITY DEFINER RPC ──────────────────────────────────────────
--
-- Returns SQL NULL when the proof doesn't exist, so the customer page's
-- existing `if (data === null) setNotFound(true)` branch fires
-- unchanged. Returns a jsonb object otherwise, mirroring the row shape
-- the page already consumes via the public_* views — every per-version
-- aggregate (approvals, latest_events_by_name, round_variants) and the
-- letterpress colour denormalisations are kept identical so the
-- client-side readers don't change.
--
-- Aggregates are wrapped in coalesce(jsonb_agg(...), '[]'::jsonb) so an
-- empty result set comes back as [] rather than null — the array
-- consumers on the client want to call .filter / .find without a
-- defensive null check.
--
-- The "proof" object intentionally omits the columns CustomerProofPage
-- doesn't read: id (already known from the URL), created_at,
-- abandoned_at, disclaimer_acknowledged_at, helpscout_conversation_id.
-- Field hygiene: don't ship what the page doesn't consume. The "PL ·
-- {hs_id}" reference badge (CustomerProofPage:2182) goes away as a
-- consequence — the customer page's commit drops that derivation in
-- the same change.

create or replace function public_get_customer_proof(p_proof_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with
  -- Resolve proof + its derived contact/company display names. Single
  -- row or zero rows; drives the SQL-NULL return when the proof is
  -- missing.
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
  -- Material ids and currencies actually referenced by this proof's
  -- versions. Used to scope the catalogue lookups so we never return
  -- pricing for materials/currencies the customer can't see on this
  -- proof.
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
          'is_per_direction_pricing', pv.is_per_direction_pricing
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
  -- Variant + tier scoping mirrors the public_material_variants and
  -- public_price_tiers view filters from migration 000117: only active,
  -- published, non-archived materials, and active variants. A customer
  -- holding a proof for a since-archived material sees an empty
  -- pricing grid rather than stale prices, matching the live-pricing
  -- philosophy.
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
      and m.archived_at  is null
      and mv.is_active   = true
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
      'versions',                  (select arr from versions_arr),
      'material_options',          (select arr from options_arr),
      'material_option_surcharges',(select arr from surcharges_arr),
      'material_variants',         (select arr from variants_arr),
      'price_tiers',               (select arr from tiers_arr)
    )
  end;
$$;

revoke execute on function public_get_customer_proof(uuid) from public;
grant  execute on function public_get_customer_proof(uuid) to anon, authenticated;

-- ── 2. Revoke anon SELECT on customer-facing views ───────────────────
--
-- The page no longer reads any of these directly. The designer
-- dashboard's authenticated session re-grants below.

revoke select on public_proofs                       from anon, public;
revoke select on public_proof_versions               from anon, public;
revoke select on public_proof_version_images         from anon, public;
revoke select on public_site_settings                from anon, public;
revoke select on public_material_options             from anon, public;
revoke select on public_material_option_surcharges   from anon, public;
revoke select on public_material_variants            from anon, public;
revoke select on public_price_tiers                  from anon, public;

-- ── 3. Revoke anon SELECT on underlying tables ───────────────────────
--
-- Belt-and-braces: even if a future PostgREST configuration exposes a
-- table at /rest/v1/<name>, anon shouldn't be able to read it. RLS
-- already filters most of these to zero rows for anon (the recon
-- showed `[]` from contacts, companies, proofs, etc.) but
-- `proof_versions` returned actual data — so explicit revokes here
-- close that gap regardless of whatever permissive policy was leaving
-- the door open.

revoke select on proofs                       from anon, public;
revoke select on proof_versions               from anon, public;
revoke select on proof_version_images         from anon, public;
revoke select on materials                    from anon, public;
revoke select on material_variants            from anon, public;
revoke select on material_options             from anon, public;
revoke select on material_option_surcharges   from anon, public;
revoke select on price_tiers                  from anon, public;
revoke select on site_settings                from anon, public;

-- ── 4. Re-grant authenticated SELECT explicitly ──────────────────────
--
-- The designer-side surfaces still need read access:
--   * Dashboard reads public_proofs / public_proof_versions via
--     RLS-aware authenticated paths and via public_dashboard_projects
--     (already locked, untouched here).
--   * VersionDetailModal reads public_material_variants and
--     public_price_tiers under an authenticated session.
--   * The customer-proof-images edge function reads
--     public_proof_version_images under SERVICE ROLE which bypasses
--     grants entirely — but explicitly granting authenticated keeps
--     the surface available if we ever flip it client-side.
--   * NewProofPage / NewVersionPage / EditVersionPage / ProofDetailPage
--     and the admin pricing pages all SELECT directly from the
--     underlying tables (proofs, proof_versions, proof_version_images,
--     materials, material_variants, material_options,
--     material_option_surcharges, price_tiers, site_settings) under an
--     authenticated session.
--
-- Section 3 above stripped SELECT FROM anon, public. Postgres
-- semantics: a role inherits the public role's privileges, so a REVOKE
-- ... FROM public can effectively remove the privilege from
-- authenticated as well *if* the original grant was to public. To
-- avoid that ambiguity — for both the views and the underlying tables
-- — re-grant SELECT TO authenticated explicitly. Belt-and-braces;
-- defence against the case where original grants went via PUBLIC and
-- the REVOKE strips authenticated as well as anon. RLS on each
-- underlying table still enforces row-level access.

grant select on public_proofs                       to authenticated;
grant select on public_proof_versions               to authenticated;
grant select on public_proof_version_images         to authenticated;
grant select on public_site_settings                to authenticated;
grant select on public_material_options             to authenticated;
grant select on public_material_option_surcharges   to authenticated;
grant select on public_material_variants            to authenticated;
grant select on public_price_tiers                  to authenticated;

grant select on proofs                       to authenticated;
grant select on proof_versions               to authenticated;
grant select on proof_version_images         to authenticated;
grant select on materials                    to authenticated;
grant select on material_variants            to authenticated;
grant select on material_options             to authenticated;
grant select on material_option_surcharges   to authenticated;
grant select on price_tiers                  to authenticated;
grant select on site_settings                to authenticated;

commit;
