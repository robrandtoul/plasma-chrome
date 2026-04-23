-- Migration 000089: expose helpscout_conversation_id on public_proofs
--
-- The customer proof page renders a small "studio job ref"
-- badge in the masthead and footer (PL · {id}). Pre-migration
-- it synthesised the badge from the first 8 chars of the
-- proof UUID — meaningless to either side of the transaction,
-- just decorative chrome from the editorial restyle.
--
-- We already carry the customer's real Help Scout conversation
-- id on the proof row (added in 000028, required or override-
-- explained per 000067). That's the natural value to surface:
-- it's a short numeric reference the designer can cross-check
-- against their inbox and the customer can quote back when
-- they reply.
--
-- Conservative projection — adding just the id, NOT the URL
-- variants (helpscout_thread_url / helpscout_conversation_url)
-- which point at Plasma's internal Help Scout workspace and
-- have stayed off public_proofs since the original view
-- landed (see 20260419000007 view comment). Opaque numeric
-- reference only; no path leakage.
--
-- null on proofs where the designer set an
-- helpscout_override_reason instead of linking a thread
-- (rare) — customer page hides the badge when the value is
-- null rather than falling back to the synthesised UUID slug.

begin;

drop view if exists public_proofs;

create view public_proofs as
  select
    p.id,
    c.full_name as customer_name,
    co.name     as company,
    p.created_at,
    p.status,
    p.approved_at,
    p.abandoned_at,
    p.helpscout_conversation_id
  from proofs p
  join contacts c on c.id = p.contact_id
  left join companies co on co.id = c.company_id;

grant select on public_proofs to anon, authenticated;

commit;
