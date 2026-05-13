-- Migration 000175: production lead times on materials.
--
-- Adds an admin-managed lead-time window per material so the
-- Quote compiler can surface "we are currently quoting X-Y
-- business days for <material>" inline beside the material and
-- quantity selectors, and (optionally) drop a matching line into
-- the copy-paste quote body.
--
-- Three nullable columns on materials:
--   * lead_time_min_days   int  — lower bound in business days
--   * lead_time_max_days   int  — upper bound in business days
--   * lead_time_updated_at timestamptz — last admin save
--
-- The pair is kept in lockstep by a CHECK constraint: either both
-- are NULL (no lead time recorded) or both are populated with
-- positive integers and max >= min. The admin tab clears both
-- atomically; the Quote compiler renders the panel only when the
-- pair is non-null.
--
-- Materials RLS already gates designer reads + admin writes, so
-- no new policies are required. No public_* views are touched —
-- lead times are designer-only and the customer-facing /p/:id
-- page must not surface them.
--
-- lead_time_updated_at is set explicitly by the admin tab on every
-- save so the "Last updated" column can render a relative age.
-- Nullable rather than `default now()` so the seed catalogue
-- doesn't claim a freshness that no human has ever signed off on.

begin;

alter table materials
  add column lead_time_min_days   int,
  add column lead_time_max_days   int,
  add column lead_time_updated_at timestamptz;

comment on column materials.lead_time_min_days is
  'Lower bound of the current production lead time, in business '
  'days. Admin-managed via the Lead times tab. Nullable; paired '
  'with lead_time_max_days under a CHECK constraint so the two '
  'are always set or cleared together. Surfaced on the Quote '
  'compiler only — never on customer-facing surfaces.';

comment on column materials.lead_time_max_days is
  'Upper bound of the current production lead time, in business '
  'days. See lead_time_min_days for the full contract.';

comment on column materials.lead_time_updated_at is
  'Timestamp of the most recent admin save to either lead-time '
  'column. Null when no lead time has ever been recorded; cleared '
  'back to null when the admin nulls both columns at once.';

alter table materials
  add constraint materials_lead_time_pair_chk
  check (
    (lead_time_min_days is null and lead_time_max_days is null)
    or (
      lead_time_min_days is not null
      and lead_time_max_days is not null
      and lead_time_min_days > 0
      and lead_time_max_days >= lead_time_min_days
    )
  );

commit;
