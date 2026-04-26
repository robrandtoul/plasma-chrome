-- Migration 000104: global on/off switch for the customer-reply send.
--
-- When false (the default), send-helpscout-reply rejects every
-- request with a 503 and an admin-friendly error. Designers can
-- still compose messages but the Send button is disabled in the UI
-- and the edge function is the actual safety surface (defence in
-- depth). When true, sends route through Help Scout as today.
--
-- Used as:
--   * Trial-week safety: ship with the column off so initial
--     designer use exercises the editor and previews without
--     sending live messages. Admin flips on when ready.
--   * Kill switch: if a problem ever surfaces post-launch, an
--     admin flips off and all sends pause within one settings-
--     cache TTL (60s) without a code deploy.
--
-- No RLS changes needed: the existing settings policies
-- ('settings: authenticated read', 'settings: admin update' from
-- migration 000045) cover the new column. Designers can read the
-- flag (needed to render the disabled UI states); admins can
-- write it via the existing AdminSettingsPage save plumbing.
--
-- Edits are audited under setting.replies_enabled_updated, same
-- shape as the other setting.X_updated entries the AUDIT_ACTION
-- map already handles.

begin;

alter table settings
  add column replies_enabled boolean not null default false;

comment on column settings.replies_enabled is
  'Global on/off switch for the send-helpscout-reply edge function. '
  'False (default) blocks all customer-reply sends with a 503; '
  'designers can compose messages but Send is disabled. True allows '
  'sends. Used as a trial-week safety surface and an emergency kill '
  'switch. Edits audited under setting.replies_enabled_updated.';

commit;
