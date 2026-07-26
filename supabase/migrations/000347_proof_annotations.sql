-- Proof annotations — coordinate-anchored notes on a proof image
-- (docs/proof-annotation-proposal.md).
--
-- Two authors, one shape:
--   • designer callouts  — a note the designer leaves for the CUSTOMER to read
--     ("your logo sits smaller than your file — that's the finest the engraving
--     holds"). Authenticated write.
--   • customer pins      — an optional "point at it" alongside a change request,
--     so the customer can indicate WHERE instead of describing a location in
--     prose. Written by the proof-action edge function (service_role).
--
-- ── Why a coordinate is only a fraction ──────────────────────────────────────
-- x/y are normalised 0–1 fractions of the image's own box, never pixels. The
-- customer page renders proof images with width/height auto under
-- `max-h-full max-w-full object-contain` (ProofDetailView) or `w-full
-- object-contain` (ImageGrid), so in both cases the <img> element box already
-- hugs the painted image and object-contain letterboxes nothing. That means a
-- click maps to a fraction with getBoundingClientRect() alone — and because
-- that rect is post-transform, the same maths holds at any pinch-zoom or pan.
-- Consequence: NO width/height metadata is needed on proof_version_images, and
-- this migration deliberately does not add any.
--
-- ── The presentation rule this table exists to serve ─────────────────────────
-- Rows are DATA, never flattened pixels, because the artwork the customer is
-- presented with must never be drawn on: the overview shows an unmarked card
-- plus a quiet "A note from <designer>" strip, each callout carries its own
-- CSS-cropped detail, and a numbered marker appears only once the customer has
-- deliberately zoomed in. A flattened PNG would put squiggles on the sales
-- artefact by construction and would kill the checklist and carry-forward uses
-- as well. Storing the coordinate of the SUBJECT (not of the dot) is also what
-- lets the renderer offset a marker clear of the detail it points at.
--
-- ── Gates ────────────────────────────────────────────────────────────────────
-- Two independent booleans rather than one, so the lower-risk designer half can
-- go live without exposing the anon write path (matching the phasing in the
-- proposal). Plain booleans, not an off/shadow/live enum — per the 000343
-- reasoning, a surface is either offered or it isn't; there is nothing to tune
-- invisibly here.
--
-- ⚠ Grants note (the proofs schema has NO default privileges — a new table is
-- born with no grants at all, service_role included): every grant below is
-- stated explicitly. anon gets nothing; customer reads flow through the
-- SECURITY DEFINER RPC at the end, and customer writes through proof-action.
--
-- Apply via MCP apply_migration / the dashboard SQL editor per the house
-- workflow — never CLI push.

-- ── 1. The table ─────────────────────────────────────────────────────────────

create table if not exists proofs.proof_annotations (
  id                     uuid primary key default gen_random_uuid(),
  proof_version_id       uuid not null references proofs.proof_versions(id) on delete cascade,

  -- Which image the note is anchored to. Available client-side already: the
  -- customer page's image objects carry the real proof_version_images.id, which
  -- is strictly better provenance than side alone and makes side derivable.
  proof_version_image_id uuid references proofs.proof_version_images(id) on delete cascade,

  -- Denormalised locators, kept so a note still reads sensibly if its image row
  -- is replaced in a later version (and so the Help Scout text can say "front").
  side                   text check (side is null or side in ('front', 'back')),
  associated_name        text,

  -- Normalised fraction of the image box. See the header.
  x                      numeric not null check (x >= 0 and x <= 1),
  y                      numeric not null check (y >= 0 and y <= 1),

  body                   text not null check (btrim(body) <> '' and length(body) <= 600),

  author_kind            text not null check (author_kind in ('designer', 'customer')),
  created_by             uuid references proofs.profiles(id) on delete set null,
  author_name            text,

  -- Ties a customer pin to the change request it was submitted with, so the
  -- designer surface can group "these 3 pins came with this note".
  proof_event_id         uuid references proofs.proof_events(id) on delete set null,

  -- Tick-off. Designer marks a customer pin addressed; survives for audit.
  resolved_at            timestamptz,
  resolved_by            uuid references proofs.profiles(id) on delete set null,

  created_at             timestamptz not null default now()
);

comment on table proofs.proof_annotations is
  'Coordinate-anchored notes on a proof image: designer callouts shown to the customer, and optional customer pins accompanying a change request. x/y are normalised 0-1 fractions of the image box, never pixels — see docs/proof-annotation-proposal.md.';
comment on column proofs.proof_annotations.x is
  'Horizontal position as a 0-1 fraction of the image box. Anchors the SUBJECT, not the rendered dot — the renderer may offset the marker so it does not cover what it points at.';
comment on column proofs.proof_annotations.y is
  'Vertical position as a 0-1 fraction of the image box.';
comment on column proofs.proof_annotations.author_kind is
  'designer = a callout written for the customer to read; customer = a pin placed alongside a change request.';
comment on column proofs.proof_annotations.author_name is
  'Display name shown against the note. Designer rows: their FIRST name, stamped server-side by proof_annotations_set_author (this is what makes the customer-facing "A note from Rob" label work with no profiles join and no designer field on any anon RPC). Customer rows: the name they typed on the change request.';
comment on column proofs.proof_annotations.resolved_at is
  'When a designer marked this addressed. Tick-off only — the row is never deleted on resolve.';

create index if not exists proof_annotations_version_idx
  on proofs.proof_annotations (proof_version_id);
create index if not exists proof_annotations_image_idx
  on proofs.proof_annotations (proof_version_image_id);
create index if not exists proof_annotations_event_idx
  on proofs.proof_annotations (proof_event_id)
  where proof_event_id is not null;

-- ── 2. Grants + RLS ──────────────────────────────────────────────────────────

revoke all on proofs.proof_annotations from anon, public;
grant select, insert, update, delete on proofs.proof_annotations to authenticated;
grant all on proofs.proof_annotations to service_role;

alter table proofs.proof_annotations enable row level security;

drop policy if exists proof_annotations_select        on proofs.proof_annotations;
drop policy if exists proof_annotations_insert        on proofs.proof_annotations;
drop policy if exists proof_annotations_update        on proofs.proof_annotations;
drop policy if exists proof_annotations_delete        on proofs.proof_annotations;

-- Every designer can read every annotation (same stance as proof_pins /
-- proof_attention_snoozes).
create policy proof_annotations_select on proofs.proof_annotations
  for select to authenticated using (true);

-- A designer may only insert DESIGNER rows, attributed to themselves. Customer
-- pins arrive via the edge function under service_role, which bypasses RLS —
-- so the authenticated path can never manufacture a fake customer pin. Same
-- audit-attribution hardening as 000159 (proof_pins) and 000167 (snoozes).
create policy proof_annotations_insert on proofs.proof_annotations
  for insert to authenticated
  with check (author_kind = 'designer' and created_by = auth.uid());

-- Editing the note text stays with its author; ticking off (resolved_at) is
-- open to any designer, so a colleague can clear work they did.
--
-- Note on what a policy can and cannot do here: RLS USING sees the OLD row and
-- WITH CHECK sees the NEW one, and neither can reference the other — so
-- "created_by must not change" is NOT expressible as a policy predicate (a
-- `created_by is not distinct from created_by` check reads plausibly and is
-- tautologically true). Attribution immutability is enforced by the trigger in
-- section 3a instead.
create policy proof_annotations_update on proofs.proof_annotations
  for update to authenticated
  using (created_by = auth.uid() or author_kind = 'customer' or proofs.is_admin());

create policy proof_annotations_delete on proofs.proof_annotations
  for delete to authenticated
  using (created_by = auth.uid() or proofs.is_admin());

-- ── 3. Author stamping ───────────────────────────────────────────────────────
-- Designer rows get their displayed name from their own profile, so the client
-- never supplies (and cannot falsify) it. First name only: the customer-facing
-- strip reads "A note from Rob", and a surname adds nothing but exposure.
-- SECURITY DEFINER so it can read profiles despite that table's self-read-only
-- RLS; EXECUTE revoked from callers (a trigger fires regardless — same
-- hardening as 000182 and the 000271 sibling).
create or replace function proofs.proof_annotations_set_author()
  returns trigger
  language plpgsql
  security definer
  set search_path = proofs, public, extensions, pg_temp
as $$
begin
  if new.author_kind = 'designer' then
    select nullif(btrim(split_part(coalesce(p.full_name, ''), ' ', 1)), '')
      into new.author_name
      from proofs.profiles p
     where p.id = new.created_by;
  end if;
  return new;
end $$;

revoke execute on function proofs.proof_annotations_set_author() from public, anon, authenticated;
grant execute on function proofs.proof_annotations_set_author() to service_role;

drop trigger if exists proof_annotations_set_author on proofs.proof_annotations;
create trigger proof_annotations_set_author
  before insert on proofs.proof_annotations
  for each row execute function proofs.proof_annotations_set_author();

-- ── 3a. Attribution immutability on update ───────────────────────────────────
-- The update policy above lets a designer tick off a colleague's row and edit
-- their own — but nothing in a policy can stop an UPDATE from also rewriting
-- who authored the note (see the note on the policy). This pins the identity
-- columns to their stored values, so a REST update can change the note text,
-- the coordinates and the resolve state, and nothing else.
create or replace function proofs.proof_annotations_lock_attribution()
  returns trigger
  language plpgsql
  set search_path = proofs, public, extensions, pg_temp
as $$
begin
  new.author_kind      := old.author_kind;
  new.created_by       := old.created_by;
  new.author_name      := old.author_name;
  new.proof_event_id   := old.proof_event_id;
  new.proof_version_id := old.proof_version_id;
  new.created_at       := old.created_at;
  return new;
end $$;

revoke execute on function proofs.proof_annotations_lock_attribution() from public, anon, authenticated;
grant execute on function proofs.proof_annotations_lock_attribution() to service_role;

drop trigger if exists proof_annotations_lock_attribution on proofs.proof_annotations;
create trigger proof_annotations_lock_attribution
  before update on proofs.proof_annotations
  for each row execute function proofs.proof_annotations_lock_attribution();

-- ── 4. Gates ─────────────────────────────────────────────────────────────────

alter table proofs.settings
  add column if not exists proof_callouts_enabled boolean not null default false,
  add column if not exists proof_pins_enabled     boolean not null default false;

comment on column proofs.settings.proof_callouts_enabled is
  'Designer callouts on proofs (Admin → Settings). Off = designers cannot add them and the customer-facing note strip stays hidden even where rows exist. Independent of proof_pins_enabled so the designer half can go live first.';
comment on column proofs.settings.proof_pins_enabled is
  'Lets a customer optionally place pins alongside a change request. Off = the "Point at it" affordance is hidden and proof-action rejects any pins in the payload. The free-text note is unaffected either way.';

-- ── 5. Anon read path ────────────────────────────────────────────────────────
-- A dedicated small RPC rather than re-emitting public_get_customer_proof: that
-- function is large, and every drop/recreate of a customer-facing read path in
-- this repo has at some point lost its grants (000148→000151, 000168→000174,
-- 000186→000197). Same house pattern as public_get_lead_times (000180) and
-- public_get_price_list (000184) — tight surface, no fresh table grant to anon.
--
-- Returns DESIGNER callouts only. A customer's own pins are deliberately not
-- read back: they are shown from client state at submit time, and returning
-- them would let anyone holding the proof id read another visitor's notes.
-- Honours proof_callouts_enabled, so flipping the gate off hides the strip
-- everywhere without touching any row.
create or replace function proofs.public_get_proof_annotations(p_version_id uuid)
  returns jsonb
  language plpgsql
  security definer
  stable
  set search_path = proofs, public, extensions, pg_temp
as $$
declare
  v_enabled boolean;
  v_result  jsonb;
begin
  if p_version_id is null then
    return '[]'::jsonb;
  end if;

  select coalesce(s.proof_callouts_enabled, false) into v_enabled
    from proofs.settings s
   limit 1;

  if not coalesce(v_enabled, false) then
    return '[]'::jsonb;
  end if;

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'id',                     a.id,
               'proof_version_image_id', a.proof_version_image_id,
               'side',                   a.side,
               'associated_name',        a.associated_name,
               'x',                      a.x,
               'y',                      a.y,
               'body',                   a.body,
               'author_name',            a.author_name,
               'created_at',             a.created_at
             )
             order by a.created_at
           ),
           '[]'::jsonb
         )
    into v_result
    from proofs.proof_annotations a
   where a.proof_version_id = p_version_id
     and a.author_kind = 'designer';

  return coalesce(v_result, '[]'::jsonb);
end $$;

comment on function proofs.public_get_proof_annotations(uuid) is
  'Anon read path for designer callouts on one proof version. Returns [] when settings.proof_callouts_enabled is false. Designer rows only — customer pins are never read back through this. No customer, pricing, contact or internal fields.';

revoke all on function proofs.public_get_proof_annotations(uuid) from public;
grant execute on function proofs.public_get_proof_annotations(uuid) to anon, authenticated, service_role;

-- ── 6. Expose the pin gate to the customer page ──────────────────────────────
-- The callout gate needs no client flag (the RPC above already returns [] when
-- it is off), but the "Point at it" affordance has to know whether to render at
-- all, so proof_pins_enabled joins public_settings().
--
-- ⚠ The field list below was read from the LIVE function definition
-- (pg_get_functiondef) on 2026-07-26, not from the migration files: this RPC has
-- been extended several times since 000200 (login copy, US tariff) and a
-- re-emit built from the last migration that touched it would silently DROP
-- those fields and break the customer page. If you extend it again, read live
-- first. Nineteen existing fields, verbatim, plus one.
create or replace function proofs.public_settings()
returns json
language sql
security definer
set search_path = proofs, public, extensions, pg_temp
as $$
  select json_build_object(
    'disclaimer_text',                    disclaimer_text,
    'company_name',                       company_name,
    'reply_email',                        reply_email,
    'approve_confirmation_copy',          approve_confirmation_copy,
    'request_changes_confirmation_copy',  request_changes_confirmation_copy,
    'metal_thickness_notes',              metal_thickness_notes,
    'about_proof_copy',                   about_proof_copy,
    'qr_panel_intro_copy',                qr_panel_intro_copy,
    'qr_panel_vcard_copy',                qr_panel_vcard_copy,
    'login_headline',                     login_headline,
    'login_description',                  login_description,
    'login_stats',                        login_stats,
    'login_form_heading',                 login_form_heading,
    'login_form_subcopy',                 login_form_subcopy,
    'us_tariff_fee_gbp',                  us_tariff_fee_gbp,
    'us_tariff_fee_eur',                  us_tariff_fee_eur,
    'us_tariff_fee_usd',                  us_tariff_fee_usd,
    'us_tariff_intro_copy',               us_tariff_intro_copy,
    'us_tariff_optout_warning',           us_tariff_optout_warning,
    'proof_pins_enabled',                 coalesce(proof_pins_enabled, false)
  )
  from settings where id = 1;
$$;

grant execute on function proofs.public_settings() to anon, authenticated;
