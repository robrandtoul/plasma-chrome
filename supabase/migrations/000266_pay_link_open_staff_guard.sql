-- 000266_pay_link_open_staff_guard.sql
-- Don't record a "pay link opened" when the opener is a signed-in STAFF member.
--
-- record_order_pay_link_opened (000262) stamps pay_link_opened_at for anyone who
-- loads the anon /order/:id?token=… page on a still-'sent' order. A designer who
-- opens the link to check it (and lingers past the page's 1.5s delay) would
-- otherwise log a false "customer opened the link", muddying the Orders row +
-- the dashboard activity feed.
--
-- A real customer is never signed in, so they're anonymous (auth.uid() is null).
-- Staff are signed in across the shared *.plasmadesign.co.uk SSO domain, so their
-- request carries a JWT and auth.uid() is non-null even on the anon pay page.
-- Gating on `auth.uid() is null` therefore stamps for genuine customers and makes
-- a signed-in staff open a no-op. auth.uid() reflects the actual caller inside a
-- SECURITY DEFINER function (it reads the request JWT GUC, not the owner). The
-- only gap is staff opening the link logged-out / incognito — a rare, deliberate
-- act. Token + status='sent' gates and the grant matrix are unchanged.

create or replace function proofs.record_order_pay_link_opened(p_order_id uuid, p_token text)
returns void
language sql
security definer
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $$
  update proofs.orders
     set pay_link_opened_at = now()
   where id = p_order_id
     and token = p_token
     and status = 'sent'
     and auth.uid() is null;
$$;

revoke execute on function proofs.record_order_pay_link_opened(uuid, text) from public;
grant  execute on function proofs.record_order_pay_link_opened(uuid, text) to anon, authenticated;
