-- Migration 000138: variant rounds — schema foundation.
--
-- "Variant rounds" introduce a new flavour of proof_version. Where a
-- standard version offers ONE design (optionally split across N named
-- recipients + a shared section), a variant-round version offers N
-- parallel design alternatives the customer compares side-by-side
-- (e.g. three colour directions of the same metal card). The
-- customer's role on a variant round is to pick a direction, not to
-- approve — that's enforced by the edge function in a later commit.
--
-- This migration is the dark schema foundation. Nothing in the app
-- code reads or writes any of the new objects yet. After this lands:
--
--   * Existing proof_versions all have is_variant_round = false.
--   * No rows exist in proof_round_variants.
--   * Customer page + dashboard render unchanged because no version
--     yet has is_variant_round = true.
--
-- Subsequent steps (per the build plan):
--   2. Public view exposure (is_variant_round, round_variants on the
--      version view; round_variant_id on the images view; extend
--      latest_events_by_name with round_variant_id).
--   3. Edge-function update (proof-action validation + HS copy).
--   4. Customer page (variant-round render path).
--   5. Designer upload UI (mode toggle, variant editor).
--   6. Auto-finalize defensive guard.
--
-- ── New objects ──────────────────────────────────────────────────────
--
--   proof_versions.is_variant_round           boolean not null default false
--   proof_round_variants                       new table — one row per
--                                              parallel variant on a
--                                              variant-round version.
--                                              Unique on (version, code).
--   proof_version_images.round_variant_id      nullable FK; cascade
--                                              delete (deleting a
--                                              variant deletes its
--                                              images, mirroring the
--                                              version-level cascade
--                                              from 000014).
--   proof_events.round_variant_id              nullable FK; ON DELETE
--                                              SET NULL — additive
--                                              telemetry, the audit
--                                              row survives even if
--                                              the variant is later
--                                              cleaned up.
--
-- ── Validation triggers ─────────────────────────────────────────────
--
--   validate_variant_round_proof_version (BEFORE INSERT/UPDATE on
--     proof_versions) — variant-round versions must have an empty
--     names roster. Single-bucket-only rule from the build plan: a
--     version is either "shared + per-recipient" or "variant round",
--     never both.
--
--   validate_variant_round_image (BEFORE INSERT/UPDATE on
--     proof_version_images) — on variant-round versions, every image
--     must have round_variant_id set and associated_name null. On
--     non-variant-round versions, round_variant_id must be null.
--
-- These are defence-in-depth on top of upload-form validation in
-- step 5. Hand-edits via SQL editor still fail loudly.
--
-- ── RLS ──────────────────────────────────────────────────────────────
--
-- proof_round_variants mirrors the proof_events RLS shape (000116):
-- authenticated SELECT, no INSERT/UPDATE/DELETE policies. Service
-- role bypasses RLS by default — designer-side writes during the
-- step-5 upload UI will go via an authenticated RPC or via the
-- existing pattern of authenticated supabase-js calls; if the
-- latter, INSERT/UPDATE/DELETE policies will be added in step 5.
-- Customer-side reads happen via the public view extension in step 2.
--
-- ── Idempotency ──────────────────────────────────────────────────────
--
-- ADD COLUMN IF NOT EXISTS, CREATE TABLE IF NOT EXISTS, CREATE INDEX
-- IF NOT EXISTS, DROP TRIGGER IF EXISTS + CREATE TRIGGER, and the
-- pg_policies existence-check pattern from 000116. Re-applying this
-- migration is a no-op.

begin;

-- ── 1. proof_versions.is_variant_round ───────────────────────────────

alter table proof_versions
  add column if not exists is_variant_round boolean not null default false;

comment on column proof_versions.is_variant_round is
  'True when this version is a variant round (N parallel design '
  'alternatives the customer compares side-by-side). Drives the '
  'customer-page render branch and the edge-function validation '
  'rules from variant-rounds step 3 onward. Mutually exclusive '
  'with a populated names roster — enforced by '
  'validate_variant_round_proof_version().';

-- ── 2. proof_round_variants table ────────────────────────────────────

create table if not exists proof_round_variants (
  id                uuid        primary key default gen_random_uuid(),
  proof_version_id  uuid        not null references proof_versions(id) on delete cascade,
  code              text        not null,
  display_name      text        not null,
  sort_order        int         not null default 0,
  created_at        timestamptz not null default now(),
  unique (proof_version_id, code)
);

comment on table proof_round_variants is
  'One row per parallel variant on a variant-round proof_version. '
  'Designer-managed via the upload UI (step 5). The customer page '
  'reads these via public_proof_versions.round_variants (step 2) '
  'to render the side-by-side comparison grid. Empty (zero rows) '
  'on every standard proof_version.';

comment on column proof_round_variants.code is
  'Machine-readable identifier, unique within the version. '
  'Slug-derived from display_name on first save by the upload UI '
  'in step 5; write-once by application convention so '
  'proof_events.round_variant_id references stay stable across '
  'designer renames.';

comment on column proof_round_variants.display_name is
  'Customer-facing label rendered as the variant card heading and '
  'in the Help Scout thread copy ("Alec chose: Charcoal"). Empty '
  'strings rejected at the application layer (upload-form '
  'validation in step 5) — schema accepts any text.';

create index if not exists proof_round_variants_proof_version_id_sort_order_idx
  on proof_round_variants (proof_version_id, sort_order);

alter table proof_round_variants enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'proof_round_variants'
      and policyname = 'proof_round_variants: authenticated read'
  ) then
    create policy "proof_round_variants: authenticated read"
      on proof_round_variants for select
      to authenticated
      using (true);
  end if;
end$$;

-- No INSERT / UPDATE / DELETE policies — service-role bypass model,
-- mirroring proof_events (000116). If the step-5 upload UI uses
-- authenticated supabase-js writes (likely), the matching policies
-- will be added in that commit.

-- ── 3. proof_version_images.round_variant_id ─────────────────────────

alter table proof_version_images
  add column if not exists round_variant_id uuid
  references proof_round_variants(id) on delete cascade;

comment on column proof_version_images.round_variant_id is
  'Variant this image belongs to. Non-null on every image of a '
  'variant-round version; null on every image of a standard '
  'version. Cascade delete: removing a variant removes its images. '
  'Mutual exclusion with associated_name (a variant-round image '
  'can never also be associated to a recipient) is enforced by '
  'validate_variant_round_image().';

create index if not exists proof_version_images_round_variant_id_idx
  on proof_version_images (round_variant_id);

-- ── 4. proof_events.round_variant_id ─────────────────────────────────

alter table proof_events
  add column if not exists round_variant_id uuid
  references proof_round_variants(id) on delete set null;

comment on column proof_events.round_variant_id is
  'Variant the customer chose at action time on a variant-round '
  'version. Null on standard-version events. ON DELETE SET NULL: '
  'append-only audit row survives if the variant is later cleaned '
  'up (e.g. designer edits the variant set after the event was '
  'recorded). Populated by the proof-action edge function in '
  'variant-rounds step 3.';

-- ── 5. validate_variant_round_proof_version trigger ──────────────────
--
-- Fires BEFORE INSERT or UPDATE on proof_versions. Rejects any row
-- where is_variant_round = true AND names is non-empty. Catches both
-- "designer creates a variant round with a recipient roster" and
-- "designer flips an existing per-recipient version to variant-round
-- mode without clearing names first".

create or replace function validate_variant_round_proof_version()
returns trigger
language plpgsql
as $$
begin
  if new.is_variant_round
     and coalesce(array_length(new.names, 1), 0) > 0 then
    raise exception 'variant-round versions cannot have a recipient roster (proof_versions.names must be empty when is_variant_round = true)'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

comment on function validate_variant_round_proof_version() is
  'BEFORE INSERT/UPDATE trigger on proof_versions. Enforces the '
  'single-bucket-only rule from the variant-rounds build plan: a '
  'version is either standard (shared + per-recipient, names may '
  'be populated) or a variant round (names must be empty). Defence '
  'in depth on top of upload-form validation in step 5.';

drop trigger if exists trg_validate_variant_round_proof_version on proof_versions;

create trigger trg_validate_variant_round_proof_version
  before insert or update on proof_versions
  for each row
  execute function validate_variant_round_proof_version();

-- ── 6. validate_variant_round_image trigger ──────────────────────────
--
-- Fires BEFORE INSERT or UPDATE on proof_version_images. Looks up the
-- parent version's is_variant_round flag and enforces:
--
--   * variant-round version → image must have round_variant_id set
--                              and associated_name null
--   * standard version       → image must have round_variant_id null
--                              (associated_name is unconstrained on
--                              standard versions — it carries the
--                              recipient name or null for shared)
--
-- The lookup is one row by primary key and runs once per image
-- insert/update. No measurable hot-path impact.

create or replace function validate_variant_round_image()
returns trigger
language plpgsql
as $$
declare
  v_is_variant_round boolean;
begin
  select pv.is_variant_round
    into v_is_variant_round
    from proof_versions pv
    where pv.id = new.proof_version_id;

  if v_is_variant_round is null then
    -- Parent version not found. Let the FK constraint produce the
    -- canonical error rather than masking it here.
    return new;
  end if;

  if v_is_variant_round then
    if new.associated_name is not null then
      raise exception 'variant-round versions cannot use per-recipient images (proof_version_images.associated_name must be null when the parent version is_variant_round = true)'
        using errcode = '23514';
    end if;
    if new.round_variant_id is null then
      raise exception 'images on a variant-round version must have round_variant_id set'
        using errcode = '23514';
    end if;
  else
    if new.round_variant_id is not null then
      raise exception 'round_variant_id is only valid on variant-round versions (proof_version_images.round_variant_id must be null when the parent version is_variant_round = false)'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

comment on function validate_variant_round_image() is
  'BEFORE INSERT/UPDATE trigger on proof_version_images. Enforces '
  'the variant-rounds image-attribution rules: variant-round '
  'version images must have round_variant_id set and '
  'associated_name null; standard-version images must have '
  'round_variant_id null. Defence in depth on top of upload-form '
  'validation in step 5.';

drop trigger if exists trg_validate_variant_round_image on proof_version_images;

create trigger trg_validate_variant_round_image
  before insert or update on proof_version_images
  for each row
  execute function validate_variant_round_image();

commit;
