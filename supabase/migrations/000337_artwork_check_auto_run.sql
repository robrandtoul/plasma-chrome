-- Artwork check auto-run (docs/artwork-check-spec.md, Phase 3's "auto-run"
-- item). Fire the check the moment an order's Dropbox folder is LINKED — not
-- at payment, which sounds right but isn't: at payment there is no folder yet
-- (it's linked during order prep), so a payment-time run could only record a
-- "no folder linked" error. Folder-link is the first moment the check can
-- genuinely run, it covers every path that sets the folder (the Orders-page
-- link flow, the reprint folder-clone), and by the time a human opens the
-- review page the report is already cached on the order.
--
-- force:true on every fire — a first link has no cached report to force past,
-- and a RE-linked folder means new artwork, so any cached report is stale and
-- must refresh (this also implements the "staleness guard" rollout item for
-- the folder-changed case).
--
-- Idiom: the 000320 push-trigger pattern (pg_net POST from a SECURITY DEFINER
-- trigger), authed with the proofs_send_nudges_key vault secret — a
-- service-role JWT the artwork-check function already accepts (same key the
-- 000278 reconcile cron reuses). One deliberate deviation: the whole body is
-- wrapped in an exception guard, because an ORDER write must never fail on
-- account of an advisory check's plumbing (pushes accepted that risk; money
-- rows don't).
--
-- Cost/noise control: the trigger reads settings.artwork_check_mode itself —
-- 'off' means zero network chatter, not just a no-op at the function.
--
-- Target: the merged stock-control project (proofs schema). Apply via MCP /
-- dashboard SQL editor per the house workflow — never CLI push.

create or replace function proofs.notify_artwork_check_on_folder_link()
  returns trigger
  language plpgsql
  security definer
  set search_path = proofs, public, extensions, pg_temp
as $$
declare
  v_mode text;
  v_key  text;
begin
  -- Only when a folder genuinely arrives or changes. (OLD is only touched on
  -- UPDATE — plpgsql short-circuits, so the INSERT arm never evaluates it.)
  if new.dropbox_folder_url is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.dropbox_folder_url is not distinct from new.dropbox_folder_url then
    return new;
  end if;

  select artwork_check_mode into v_mode from proofs.settings where id = 1;
  if coalesce(v_mode, 'off') = 'off' then
    return new;
  end if;

  select decrypted_secret into v_key
  from vault.decrypted_secrets where name = 'proofs_send_nudges_key';
  if v_key is null then
    return new; -- no key → stay inert; never block the order write
  end if;

  perform net.http_post(
    url := 'https://bjvinrzbdrwebylkmbwy.supabase.co/functions/v1/artwork-check',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    body := jsonb_build_object('order_id', new.id, 'force', true)
  );
  return new;
exception when others then
  -- Fire-and-forget: any failure here (vault, pg_net, queue) must degrade to
  -- "no auto-run" — the review page's on-load run remains the backstop.
  return new;
end;
$$;

comment on function proofs.notify_artwork_check_on_folder_link() is
  'Fires the artwork-check edge function (force:true) when an order''s Dropbox folder is first linked or re-linked. Mode-gated on settings.artwork_check_mode; authed via the proofs_send_nudges_key vault secret; never blocks the order write.';

revoke execute on function proofs.notify_artwork_check_on_folder_link() from public, anon, authenticated;
grant execute on function proofs.notify_artwork_check_on_folder_link() to service_role;

drop trigger if exists notify_artwork_check_on_folder_link on proofs.orders;
create trigger notify_artwork_check_on_folder_link
  after insert or update of dropbox_folder_url on proofs.orders
  for each row execute function proofs.notify_artwork_check_on_folder_link();
