-- 000293: let system (created_by NULL) inserts keep their supplied author name.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via MCP apply_migration. Do NOT use `supabase db push`.
--
-- The helpscout-webhook auto-flags a project when a 'complaint' tag is added,
-- inserting a watch_items card with created_by NULL and a supplied
-- created_by_name ('Help Scout (complaint tag)'). The 000290 trigger always ran
-- the profile lookup, which on a NULL created_by would null the supplied name.
-- Guard ONLY the author block so system inserts keep their label; the proof
-- context (company / contact / designer / order) still stamps unconditionally.

create or replace function proofs.watch_items_set_context()
  returns trigger
  language plpgsql
  security definer
  set search_path = proofs, public, extensions, pg_temp
as $$
begin
  -- Author identity from the caller's own profile — only for a real author.
  if new.created_by is not null then
    select p.full_name, p.designer_initials, p.designer_colour
      into new.created_by_name, new.created_by_initials, new.created_by_colour
    from proofs.profiles p
    where p.id = new.created_by;
  end if;

  -- Proof context (company / contact / designer / HS thread) — always.
  select co.name, c.full_name, pr.full_name, pf.helpscout_conversation_url
    into new.company_name, new.contact_name, new.designer_name,
         new.helpscout_conversation_url
  from proofs.proofs pf
  left join proofs.contacts  c  on c.id  = pf.contact_id
  left join proofs.companies co on co.id = c.company_id
  left join proofs.profiles  pr on pr.id = pf.created_by
  where pf.id = new.proof_id;

  -- Ordered date + stock number from the proof's most recent order, if any.
  select (coalesce(o.paid_at, o.sent_at, o.created_at))::date, o.stock_order_number
    into new.ordered_on, new.stock_order_number
  from proofs.orders o
  where o.proof_id = new.proof_id
  order by o.created_at desc
  limit 1;

  return new;
end;
$$;
