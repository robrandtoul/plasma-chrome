-- 000398: link the register to app contacts durably, instead of by email each
-- time.
--
-- The register (Xero history) and the app (everything since) were joined by
-- comparing email addresses on every read. Measured on live, that key reaches
-- 165 of 186 paying customers — the other 19 are on the register under a
-- DIFFERENT address, typically accounts@ on the invoice versus the individual
-- who approved the proof. For those customers:
--
--   * the nightly reconcile never refreshed their row, so it still claimed
--     they last ordered years ago, and
--   * the recency guard could not see their recent order, so the desk could
--     greet them with "how are you doing for stock?" weeks after they bought —
--     the exact failure the guard exists to prevent.
--
-- matched_contact_id has existed since 000389 but only 19 rows carried one.
-- This backfills it and makes it the primary key of the join, with email as
-- the fallback for rows that have never been linked. A customer who changes
-- address then stays linked, which email matching can never manage.
--
-- ⚠ Two hazards, both found by dry-running this read-only before writing it:
--
--   1. Name matching can tie two different customers together permanently —
--      there is more than one "John Smith". A name is only used when it
--      appears EXACTLY ONCE on both sides; anything ambiguous stays unlinked.
--   2. The first draft let 10 app contacts be claimed by two register rows
--      each, which would let one order be absorbed twice. The link is now
--      one-to-one in both directions: the row with the most history wins.

-- ── Backfill ────────────────────────────────────────────────────────────────

with norm as (
  select id, lower(regexp_replace(customer_name, '[^a-zA-Z0-9]', '', 'g')) as nkey,
         email, orders_count, created_at
  from proofs.reorder_prospects
  where matched_contact_id is null
),
app as (
  select c.id, lower(c.email) as email,
    lower(regexp_replace(coalesce(nullif(co.name, ''), c.full_name), '[^a-zA-Z0-9]', '', 'g')) as nkey
  from proofs.contacts c
  left join proofs.companies co on co.id = c.company_id
  where c.email is not null
),
app_name_unique as (select nkey from app group by nkey having count(*) = 1),
reg_name_unique as (
  select lower(regexp_replace(customer_name, '[^a-zA-Z0-9]', '', 'g')) as nkey
  from proofs.reorder_prospects
  group by 1 having count(*) = 1
),
cand as (
  select n.id as reg_id, a.id as contact_id, 1 as pref, n.orders_count, n.created_at
  from norm n join app a on a.email = lower(n.email)
  union all
  select n.id, a.id, 2, n.orders_count, n.created_at
  from norm n
  join app a on a.nkey = n.nkey
  join app_name_unique anu on anu.nkey = a.nkey
  join reg_name_unique rnu on rnu.nkey = n.nkey
),
per_reg as (
  select distinct on (reg_id) * from cand order by reg_id, pref, contact_id
),
final as (
  select distinct on (contact_id) * from per_reg
  order by contact_id, pref, orders_count desc, created_at asc
)
update proofs.reorder_prospects rp
set matched_contact_id = f.contact_id, updated_at = now()
from final f
where rp.id = f.reg_id
  and not exists (
    -- Never claim a contact another row already owns.
    select 1 from proofs.reorder_prospects other
    where other.matched_contact_id = f.contact_id and other.id <> rp.id
  );

-- ── The guard, now contact-first ────────────────────────────────────────────

create or replace function proofs.reorder_prospects_recently_active(p_days integer default 180)
returns setof uuid
language sql
stable
set search_path = proofs, public, extensions, pg_temp
as $$
  select distinct rp.id
  from proofs.reorder_prospects rp
  join proofs.contacts c
    -- The durable link first; email only for rows never linked. Both, so a
    -- customer is caught whichever way we know them.
    on (rp.matched_contact_id is not null and c.id = rp.matched_contact_id)
    or (rp.matched_contact_id is null and rp.email is not null
        and lower(c.email) = lower(rp.email))
  join proofs.proofs p on p.contact_id = c.id
  left join proofs.orders o
    on o.proof_id = p.id and o.paid_at > now() - make_interval(days => p_days)
  where
    o.id is not null
    or (p.status in ('in_progress', 'dormant')
        and p.created_at > now() - make_interval(days => p_days));
$$;

revoke execute on function proofs.reorder_prospects_recently_active(integer) from public, anon;
grant execute on function proofs.reorder_prospects_recently_active(integer) to authenticated, service_role;
