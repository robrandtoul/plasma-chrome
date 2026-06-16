-- 000241 — Stripe payment mode (test / live) for the ordering checkout.
--
-- Going live repoints two independent integrations:
--   * Xero  — an OAuth reconnect to the real organisation (no env change; the
--     connected org lives in xero_connection.tenant_id). Handled by the
--     existing "Connect Xero" button.
--   * Stripe — which secret key + webhook signing secret the functions use.
--     A database value can't hold a secret, so we keep BOTH key sets in the
--     environment and this column selects which the functions use:
--       test → STRIPE_SECRET_KEY_TEST   (falls back to STRIPE_SECRET_KEY)
--       live → STRIPE_SECRET_KEY_LIVE   (falls back to STRIPE_SECRET_KEY)
--     The webhook verifies against both signing secrets regardless, since
--     Stripe signs with the secret for whichever mode the event came from.
--
-- Default 'test' so behaviour is unchanged on apply — nothing goes live until
-- an admin deliberately flips this on Admin → Settings (with a confirm). The
-- CHECK keeps it to the two known modes.
--
-- Additive, inherits the settings table grants (frontend reads/writes it, the
-- edge functions read it service-role). No new grant needed.

alter table proofs.settings
  add column if not exists payment_mode text not null default 'test';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'settings_payment_mode_check'
  ) then
    alter table proofs.settings
      add constraint settings_payment_mode_check check (payment_mode in ('test', 'live'));
  end if;
end $$;

comment on column proofs.settings.payment_mode is
  'Which Stripe key set the checkout functions use: test (sandbox) or live. Default test. Xero''s live/demo switch is separate — it''s an OAuth reconnect to the real org.';
