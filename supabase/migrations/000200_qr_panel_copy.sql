-- 000200_qr_panel_copy.sql
--
-- Make the two paragraphs of explanatory copy on the customer-facing
-- "QR code contents" panel editable from Admin > Settings, instead of
-- being baked into src/components/QrCodePanel.tsx.
--
--   1. qr_panel_intro_copy  — the standing "Please double-check the
--      contents of each QR code…" instruction.
--   2. qr_panel_vcard_copy  — the "For Plasma vCards, scanning the QR
--      saves the contact details…" note.
--
-- Same house pattern as the metal-thickness / about-proof copy in
-- 000199: two nullable text columns on the singleton `settings` row,
-- surfaced to the customer page through the existing SECURITY DEFINER
-- public_settings() RPC (no new anon grant on `settings` itself). The
-- seeds below are the exact copy the app shipped with, so the customer
-- page looks identical until someone edits it; publicSettings.ts falls
-- back to the same defaults if a column is ever null, so a fresh DB
-- without the seed still renders readable copy.

begin;

alter table settings
  add column if not exists qr_panel_intro_copy text;

-- Seed the singleton row only when unset, so re-running on a DB where an
-- admin has already edited the copy is a no-op.
update settings
set qr_panel_intro_copy = $copy$Please double-check the contents of each QR code. Scan with your phone or read the decoded text alongside each one. The on-screen QR is the exact image we'll print.$copy$
where id = 1
  and qr_panel_intro_copy is null;

alter table settings
  add column if not exists qr_panel_vcard_copy text;

update settings
set qr_panel_vcard_copy = $copy$For Plasma vCards, scanning the QR saves the contact details to a phone. The look of the page it opens — the photo, colours, and layout — is yours to personalise after your cards arrive.$copy$
where id = 1
  and qr_panel_vcard_copy is null;

-- Extend the public_settings() RPC to return the two new fields. create
-- or replace keeps the existing anon/authenticated EXECUTE grants;
-- restated below for belt-and-braces idempotency. Includes every field
-- 000199 returned plus the two QR-panel columns.
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
    'qr_panel_vcard_copy',                qr_panel_vcard_copy
  )
  from settings where id = 1;
$$;

grant execute on function public_settings() to anon, authenticated;

commit;
