-- Migration 000157: seed the three reply_templates rows that the
-- proof-action edge function looks up when sending a customer
-- confirmation reply.
--
-- Rationale:
--   Help Scout never emails customer-thread messages back to the
--   customer who sent them, so when a customer approves or requests
--   changes via the proof viewer they have no record of their own
--   action in their inbox. The proof-action edge function (per the
--   commit "Send a designer confirmation reply on customer proof
--   actions") layers a staff reply on top of the existing customer-
--   thread post: same conversation, attributed to the proof's
--   designer, which Help Scout DOES email out — so the customer
--   sees a confirmation in the same email thread as the original
--   proof email.
--
--   These three rows are the body templates the edge function
--   resolves by code. The display_name + description values are the
--   admin labels surfaced in the editor (matches commit 6's
--   AdminTemplatesSection sub-section split).
--
--   Routing in proof-action:
--     * variant-round selection           → proof_variant_selection_confirmation
--     * standard approve                  → proof_approval_confirmation
--     * standard request_changes          → proof_change_request_confirmation
--
-- Default bodies are mirrored in src/lib/replyTemplates.ts
-- DEFAULT_BODIES so the admin editor's "Reset to default" button
-- works. The two must stay in sync — same pattern as the
-- first_proof / revision pair from migration 000102.
--
-- Idempotent: ON CONFLICT (id) DO NOTHING means re-running on a DB
-- that already has these rows is a no-op. Mirrors migration 000102's
-- safe-replay shape.

begin;

insert into reply_templates (id, display_name, description, body) values
  (
    'proof_approval_confirmation',
    'Proof viewer — approval confirmation',
    'Sent automatically to every customer who approves a proof. Edits affect all future confirmation emails.',
    E'Thanks for approving {version_label}. We''ll be in touch shortly about next steps.'
  ),
  (
    'proof_change_request_confirmation',
    'Proof viewer — change request confirmation',
    'Sent automatically to every customer who requests changes via the proof viewer. Edits affect all future confirmation emails.',
    E'Thanks, we''ve recorded your changes for {version_label}:<br><br>{? change_notes}{change_notes}<br><br>{/?}We''ll get an updated proof over to you shortly.'
  ),
  (
    'proof_variant_selection_confirmation',
    'Proof viewer — variant round selection confirmation',
    'Sent automatically to every customer who picks a direction on a variant round. Edits affect all future confirmation emails.',
    E'Thanks, we''ve recorded your selection for {version_label}: {chosen_variant}.<br><br>{? change_notes}{change_notes}<br><br>{/?}We''ll incorporate this and get an updated proof over to you shortly.'
  )
on conflict (id) do nothing;

commit;
