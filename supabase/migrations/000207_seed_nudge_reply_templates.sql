-- 000207_seed_nudge_reply_templates.sql
--
-- Per-rule "send a reminder" templates for the Needs-attention resolve flow.
-- The dashboard / detail-page resolve popover offers a one-click nudge to the
-- customer for the four chase rules; each opens the existing MessageSendPanel
-- pre-filled with its matching template here.
--
-- Same house pattern as 000102 / 000157: seed (id, display_name, description,
-- body) once, ON CONFLICT (id) DO NOTHING so re-running is a no-op and later
-- edits are admin-driven through Settings → Templates. The bodies mirror
-- DEFAULT_BODIES in src/lib/replyTemplates.ts so the editor's "Reset to
-- default" works. They use the designer_picked variable set (first_name,
-- company, version_number, url) and carry no sign-off — Help Scout appends the
-- configured signature (see the 000157 / PV-2026W19-001 note).
--
-- The ids are unprefixed (not proof_*), so the admin editor renders them in the
-- "Pre-send messages" (designer_picked) sub-section alongside first_proof /
-- revision, which is the correct variable scope for the insert toolbar.

insert into reply_templates (id, display_name, description, body) values
  (
    'nudge_sent_never_viewed',
    'Reminder — sent but never opened',
    'One-click nudge offered on the Needs-attention "sent but never opened" rule. Prompts the customer to open a proof they have not viewed.',
    E'Hi {first_name},\n\nJust checking the proof of your cards{? company} for {company}{/?} reached you — it doesn''t look like it''s been opened yet. Here''s the link again whenever you have a moment:\n\n{url}'
  ),
  (
    'nudge_viewed_not_actioned',
    'Reminder — viewed, awaiting a decision',
    'One-click nudge offered on the Needs-attention "viewed but not actioned" rule. Asks the customer for approval or feedback after they have looked at the proof.',
    E'Hi {first_name},\n\nHope you''ve had a chance to look over the proof{? company} for {company}{/?}. Any thoughts, or are you happy for us to go ahead? Here''s the link if you''d like another look:\n\n{url}'
  ),
  (
    'nudge_approaching_dormant',
    'Reminder — approaching dormant',
    'One-click nudge offered on the Needs-attention "approaching dormant" rule. A gentle prod before the proof auto-marks dormant.',
    E'Hi {first_name},\n\nJust a quick nudge on your card proof{? company} for {company}{/?} before it slips off our active list. Let us know if you''d like any changes — here''s the link:\n\n{url}'
  ),
  (
    'nudge_stuck_in_progress',
    'Reminder — stuck in progress',
    'One-click nudge offered on the Needs-attention "stuck in progress" catch-all rule. A check-in after a long stretch with no activity.',
    E'Hi {first_name},\n\nChecking in on your card proof{? company} for {company}{/?} — we haven''t heard back in a little while. Happy to help with any tweaks; here''s the link again:\n\n{url}'
  )
on conflict (id) do nothing;
