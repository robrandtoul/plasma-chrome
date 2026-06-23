-- 000259_reply_templates_admin_insert.sql
-- Allow admins to CREATE reply_templates rows, not just edit existing ones.
--
-- reply_templates shipped as a fixed, seeded set that admins EDIT: it has an
-- admin-only UPDATE policy and a signed-in SELECT policy, but no INSERT policy,
-- so INSERT was blocked for everyone. Per-supplier supplier-order emails
-- (id 'supplier_order_email:<supplier_id>') are created on first save from
-- Admin > Outsourcing via an upsert, whose INSERT path then violated RLS
-- ("new row violates row-level security policy for table reply_templates").
--
-- Mirror the existing admin-only UPDATE policy: admins may insert. Idempotent.
do $$
begin
  if not exists (
    select 1 from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'proofs' and c.relname = 'reply_templates'
      and p.polname = 'reply_templates: admin insert'
  ) then
    create policy "reply_templates: admin insert" on proofs.reply_templates
      for insert to authenticated
      with check ((select proofs.is_admin()));
  end if;
end $$;
