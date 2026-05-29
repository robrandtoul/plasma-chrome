-- 000206_editable_login_copy.sql
--
-- Make the login page's copy editable from Admin > Settings instead of
-- being hard-coded in src/pages/LoginPage.tsx. Five pieces:
--   login_headline      text  — the big left-panel marketing headline
--   login_description   text  — the paragraph under it
--   login_stats         jsonb — the three value/label stat blocks
--   login_form_heading  text  — the right-panel "Welcome back" heading
--   login_form_subcopy  text  — the "Accounts are issued by an admin…" line
--
-- The login page is shown to UNAUTHENTICATED users, so it can't read the
-- settings table directly (RLS is authenticated-only). It reads through
-- the existing public_settings() SECURITY DEFINER RPC (anon-granted) —
-- the same path the customer page uses — so these columns are surfaced
-- there. Same house pattern as the metal-thickness / about-proof / QR
-- copy (000199 / 000200): nullable columns seeded with the exact copy
-- the app shipped with, and publicSettings.ts falls back to the same
-- defaults if a column is null, so the page never blanks.
--
-- login_headline is stored with newlines (rendered with white-space:
-- pre-line) replacing the old hard-coded <br> tags.

begin;

alter table settings add column if not exists login_headline text;
update settings set login_headline = $copy$Every revision,
every recipient,
one private link.$copy$
where id = 1 and login_headline is null;

alter table settings add column if not exists login_description text;
update settings set login_description = $copy$The signed-in side of the proof viewer. Drop in a JPEG, set the spec, snapshot the price. The customer reads, replies, signs off. No JPEGs in inboxes, no spreadsheet trail.$copy$
where id = 1 and login_description is null;

-- Three stat blocks (value + label). Seed mirrors LoginPage's current
-- static placeholders.
alter table settings add column if not exists login_stats jsonb;
update settings set login_stats = $json$
[
  { "value": "142",  "label": "proofs sent this year" },
  { "value": "03",   "label": "designers on the team" },
  { "value": "24 h", "label": "typical turnaround" }
]
$json$::jsonb
where id = 1 and login_stats is null;

alter table settings add column if not exists login_form_heading text;
update settings set login_form_heading = $copy$Welcome back$copy$
where id = 1 and login_form_heading is null;

alter table settings add column if not exists login_form_subcopy text;
update settings set login_form_subcopy = $copy$Accounts are issued by an admin. New here? Ask Rob for a temporary password and change it from the header on first sign-in.$copy$
where id = 1 and login_form_subcopy is null;

-- Surface all five on public_settings(). create or replace keeps the
-- existing anon/authenticated EXECUTE grants; restated for idempotency.
-- Includes every field the prior version (000200) returned plus the five
-- login-copy columns.
create or replace function public_settings()
returns json
language sql
security definer
set search_path = public
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
    'login_form_subcopy',                 login_form_subcopy
  )
  from settings where id = 1;
$$;

grant execute on function public_settings() to anon, authenticated;

commit;
