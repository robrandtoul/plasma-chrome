-- 000258_outsourcing_config.sql
-- Make the supplier (outsourced) routing + email admin-editable instead of
-- hard-coded in the place-order edge function.
--
-- (1) Per-material routing on proofs.materials:
--       outsourced_product_type  text    The "Material:" line value the supplier
--                                         email carries. MUST match a
--                                         public.outsourced_product_types.name or
--                                         Stock Control can't classify the order.
--       outsourced_supplier_ids  uuid[]  The suppliers this material MAY be sent
--                                         to (public.outsourced_suppliers.id).
--                                         Soft reference (NO cross-schema FK) —
--                                         validated app-side against the live
--                                         supplier list, because suppliers are
--                                         Stock Control's data. One id => that
--                                         supplier is used automatically; several
--                                         => the person placing the order must
--                                         pick one (no default — forced choice).
--     Seeded to match the current hard-coded place-order routing so behaviour is
--     unchanged until an admin edits it on Admin > Outsourcing.
--
-- (2) An editable supplier-order email template (proofs.reply_templates).
--     place-order renders the human wrapper from this and injects the
--     machine-generated, parser-critical spec block as {order_details}. The
--     spec lines stay code-generated (a typo would break Stock Control import);
--     only the surrounding prose is editable.

alter table proofs.materials
  add column if not exists outsourced_product_type text,
  add column if not exists outsourced_supplier_ids uuid[] not null default '{}'::uuid[];

-- Seed routing from the current place-order functions. Supplier ids are resolved
-- by name from Stock Control's live table, so the seed isn't pinned to uuids.
-- Idempotent: only fills rows that don't already carry a product type.
do $$
declare
  qx uuid; swype uuid; solo uuid;
begin
  select id into qx    from public.outsourced_suppliers where name = 'QX Metals' limit 1;
  select id into swype from public.outsourced_suppliers where name = 'Swype'     limit 1;
  select id into solo  from public.outsourced_suppliers where name = 'Solopress' limit 1;

  update proofs.materials
     set outsourced_product_type = 'Metal',
         outsourced_supplier_ids = array_remove(array[qx], null)
   where code ~ '^metal_' and outsourced_product_type is null;

  update proofs.materials
     set outsourced_product_type = 'Carbon fibre',
         outsourced_supplier_ids = array_remove(array[qx], null)
   where code in ('carbon_fibre', 'carbon_fibre_cnc') and outsourced_product_type is null;

  update proofs.materials
     set outsourced_product_type = 'Full colour plastic',
         outsourced_supplier_ids = array_remove(array[qx, swype], null)
   where code = 'plastic_full_colour' and outsourced_product_type is null;

  update proofs.materials
     set outsourced_product_type = 'Standard cards',
         outsourced_supplier_ids = array_remove(array[solo], null)
   where code = 'paper_standard' and outsourced_product_type is null;
end $$;

-- Editable supplier-order email (the human wrapper). The spec block is injected
-- by place-order as {order_details} and stays machine-generated for the parser.
insert into proofs.reply_templates (id, display_name, description, body)
values (
  'supplier_order_email',
  'Supplier order email',
  'Emailed to the supplier when an outsourced order is placed. {customer} is the customer name; {order_details} is the machine-generated spec block (Qty, Material, Type, Thickness, Finish, Must ship by, per-person split, Artwork link) that Stock Control reads — keep that placeholder exactly as-is.',
  E'Hi,\n\nPlease produce the following order for {customer}:\n\n{order_details}\n\nMany thanks.'
)
on conflict (id) do nothing;
