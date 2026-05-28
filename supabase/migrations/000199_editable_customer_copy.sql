-- 000199_metal_thickness_notes.sql
--
-- Make two pieces of hard-coded customer copy editable from
-- Admin > Settings instead of being baked into the React bundle:
--   1. the metal "Thickness" card (settings.metal_thickness_notes, JSONB)
--   2. the "About this proof" footer note (settings.about_proof_copy, text)
--
-- The copy was previously baked into src/components/MetalThicknessPanel.tsx
-- (two static option sets) and src/pages/CustomerProofPage.tsx (the intro
-- line). This migration moves it into the existing singleton `settings`
-- row as a single JSONB blob and exposes it on the public_settings() RPC,
-- which is already the customer page's read path for the global
-- disclaimer + confirmation copy (see 000120). Same house pattern: no new
-- anon grant on `settings` itself, the SECURITY DEFINER RPC is the surface.
--
-- Shape (mirrors src/lib/metalThicknessNotes.ts DEFAULT_METAL_THICKNESS_NOTES):
--   {
--     "intro":      "<paragraph>",
--     "standard":   [ { "label", "name", "description" }, x3 ],   -- 300/500/800µm
--     "mini_steel": [ { "label", "name", "description" }, x3 ]    -- 200/300/500µm
--   }
--
-- The seed below is the exact copy the app shipped with, so the customer
-- page looks identical until someone edits it. The column is nullable;
-- publicSettings.ts falls back to the same defaults if it is ever null,
-- so a fresh DB without the seed still renders readable copy.

begin;

alter table settings
  add column if not exists metal_thickness_notes jsonb;

-- Seed the singleton row only when it has not been set yet, so re-running
-- on a DB where an admin has already edited the copy is a no-op.
update settings
set metal_thickness_notes = $json$
{
  "intro": "Metal cards are available in three thicknesses. The pricing table to the left shows the cost for each — choose the weight that suits you best.",
  "standard": [
    {
      "label": "300µm",
      "name": "Slim",
      "description": "The same thickness as a standard paper business card, but with the rigidity of a credit card — because it's solid steel throughout."
    },
    {
      "label": "500µm",
      "name": "Mid-weight",
      "description": "Noticeably more substantial than card stock, with a satisfying presence in the hand."
    },
    {
      "label": "800µm",
      "name": "Substantial",
      "description": "The thickness of a bank card — the option that commands attention the moment it is handed over. Rigid and reassuringly weighty."
    }
  ],
  "mini_steel": [
    {
      "label": "200µm",
      "name": "Slim",
      "description": "Slightly thinner than a standard paper business card, but with the rigidity of a credit card — because it's solid steel throughout."
    },
    {
      "label": "300µm",
      "name": "Mid-weight",
      "description": "Noticeably more rigid than card stock, with a satisfying presence in the hand."
    },
    {
      "label": "500µm",
      "name": "Substantial",
      "description": "The thickest option — it commands attention the moment it is handed over. Rigid and reassuringly weighty."
    }
  ]
}
$json$::jsonb
where id = 1
  and metal_thickness_notes is null;

-- "About this proof" footer note — the quiet card at the bottom of the
-- customer page's right column explaining the proof's screen-rendering
-- limits. Previously hard-coded in CustomerProofPage.tsx. Seed matches
-- src/lib/publicSettings.ts ABOUT_PROOF_COPY_DEFAULT.
alter table settings
  add column if not exists about_proof_copy text;

update settings
set about_proof_copy = $copy$The proof shows etching colour, ink finish, layout and copy at the closest faithful representation we can make on screen. The real card will differ slightly in the way the material catches light, the depth of any embossing or etch, and the weight in hand. Plasma Design hand-finishes every set in Stoke-on-Trent.$copy$
where id = 1
  and about_proof_copy is null;

-- Extend the public_settings() RPC to return the new fields. create or
-- replace keeps the existing anon/authenticated EXECUTE grants; restated
-- below for belt-and-braces idempotency.
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
    'about_proof_copy',                   about_proof_copy
  )
  from settings where id = 1;
$$;

grant execute on function public_settings() to anon, authenticated;

commit;
