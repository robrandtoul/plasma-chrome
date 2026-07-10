-- 000311_proof_sets.sql
-- Bundle orders Slice 3 — the proof_sets PROOFING layer
-- (docs/bundle-orders-spec.md §4/§5/§14).
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration Rob
-- approves. Do NOT use `supabase db push`.
--
-- WHAT THIS IS, in plain English: when a customer wants two or more DIFFERENT
-- cards (typically different materials — one steel, one letterpress), each
-- card is its own proof, exactly as today. A proof SET is a thin container
-- over those proofs so the customer gets ONE link to review and approve the
-- whole collection, and the designer enters the shared context (customer,
-- Help Scout conversation, currency) ONCE instead of per card.
--
-- This is deliberately SEPARATE from Slice 2's proofs.order_groups:
--
--   * proof_sets link PROOFS at proof time — one review link, one approval
--     journey. They end at approval. No pricing, no payment, no orders.
--   * order_groups link ORDERS at payment time — one pay link, one invoice.
--
-- A set can exist before any order does, and a group can bundle projects
-- that were never a set. Nothing here touches order_groups.
--
-- The customer-facing read path is the token-gated SECURITY DEFINER RPC
-- public_get_proof_set below — the same house pattern as
-- public_get_order_group (000309) and public_get_customer_proof (000162).
-- Anon gets no table grants at all.

-- ── 1. The set table ───────────────────────────────────────────────────────
-- A thin container for the context entered once. Everything about each card
-- (material, artwork, versions, approval state) stays on the member proofs.
create table proofs.proof_sets (
  id uuid primary key default gen_random_uuid(),

  -- The customer this set is for. Mirrors proofs.proofs.contact_id (NOT NULL
  -- — a set is always for a known contact; company comes through the
  -- contact). New member cards inherit this instead of re-picking it.
  contact_id uuid not null references proofs.contacts(id),

  -- The shared Help Scout conversation. Inherited by member cards, and the
  -- "Send set to customer" action posts the one review link on this thread.
  -- Nullable — a proof can carry an override reason instead of a linked
  -- conversation, and a set built from one inherits that state.
  helpscout_conversation_id text,
  helpscout_conversation_url text,

  -- One currency per set (spec §3/§7 — one payer, one currency). Advisory
  -- context for the designer: it seeds each new card's version form. The
  -- authoritative per-card currency stays on proof_versions, as today.
  -- Nullable because a set can be created before any version has picked one.
  currency text
    check (currency is null or currency in ('GBP', 'EUR', 'USD')),

  -- The customer review link: /set/:id?token=…  Same bearer-token posture as
  -- orders.token / order_groups.token; generated app-side at creation. No
  -- expiry — a review link stays live like the /p/:id proof links it wraps.
  token text not null,

  -- Stamped when the designer sends the review link on the Help Scout
  -- thread. Membership LOCKS at this moment (spec §5): the workspace stops
  -- offering "+ Add a card", and a later addition starts a fresh set with a
  -- fresh link. Enforced in the app layer (the designer workspace), same as
  -- order-group eligibility living in the order-group edge function.
  sent_at timestamptz,

  -- Most recent customer open of the set review page (mirror of
  -- order_groups.pay_link_opened_at; stamped via the anon RPC below, only
  -- once the set has been sent — earlier opens are designer previews).
  last_opened_at timestamptz,

  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table proofs.proof_sets is
  'One customer review link over N member proofs (proofs.proof_set_id). The PROOFING layer of bundle orders — shared context (contact, Help Scout thread, currency) entered once, one /set/:id?token link, ends at approval. Completely separate from order_groups (the payment layer). Bundle orders Slice 3 (docs/bundle-orders-spec.md §14).';
comment on column proofs.proof_sets.sent_at is
  'When the review link was posted on the Help Scout thread. Membership locks at this moment — later cards start a fresh set (app-enforced).';
comment on column proofs.proof_sets.currency is
  'Shared currency context entered once; seeds each new card''s version form. The authoritative per-card currency stays on proof_versions.';

-- ── 2. Membership: proofs → their set ──────────────────────────────────────
-- Nullable: a standalone proof has none and behaves exactly as today.
-- ON DELETE SET NULL so removing a set releases members back to standalone
-- proofs rather than deleting design work (mirror of orders.order_group_id).
alter table proofs.proofs
  add column if not exists proof_set_id uuid
    references proofs.proof_sets(id) on delete set null;

comment on column proofs.proofs.proof_set_id is
  'The proof set (review collection) this proof belongs to (proofs.proof_sets); null = standalone. Each member card keeps its own versions, approval flow and (later) its own order — the set only adds the shared review front door.';

create index if not exists proofs_proof_set_id_idx
  on proofs.proofs (proof_set_id)
  where proof_set_id is not null;

-- The customer can set a card aside from the set review page ("decide
-- against this card") with a reason. The reason lands in proof_feedback via
-- the proof-feedback edge function, exactly like the existing decline panel;
-- this stamp is what marks the card as no longer counted in the set's
-- progress. Designer-side the workspace shows it (with the reason) and can
-- clear it. Only meaningful while proof_set_id is set; cleared alongside it.
alter table proofs.proofs
  add column if not exists set_discarded_at timestamptz;

comment on column proofs.proofs.set_discarded_at is
  'Customer set this card aside on the set review page (reason in proof_feedback; stamped by the proof-feedback edge function in set-discard mode). Null = active member. Approval state is untouched — nothing approved is lost.';

-- ── 3. Grants + RLS ─────────────────────────────────────────────────────────
-- The proofs schema has NO default privileges — every new table must state
-- its full grant matrix or the edge functions silently lose access (CLAUDE.md
-- / spec §11). Mirror proofs.order_groups exactly: designers get CRUD (the
-- set workspace manages sets under RLS), service_role gets everything (the
-- proof-feedback edge function stamps discards), anon gets nothing (the
-- review page reads via the token-gated RPC below).
grant select, insert, update, delete on proofs.proof_sets to authenticated;
grant all on proofs.proof_sets to service_role;
revoke all on proofs.proof_sets from anon, public;

alter table proofs.proof_sets enable row level security;

-- Same shape as order_groups_rw: any authenticated designer can manage any set.
create policy proof_sets_rw on proofs.proof_sets
  for all to authenticated using (true) with check (true);

-- ── 4. Anon read path for the set review page ──────────────────────────────
-- Same house pattern as public_get_order_group (000309): SECURITY DEFINER,
-- scoped to the set id AND its secret token, token stripped from the payload.
--
-- Deliberately an EXPLICIT payload build (not to_jsonb minus token) because
-- this is a customer-facing surface: no Help Scout ids, no internal notes,
-- no designer ids leak. Per member proof it returns only what the overview
-- needs — status + the current version's display fields. NO PRICING of any
-- kind (spec §4/§14.2: the front door carries no pricing and no
-- order/payment language; pricing lives on each card's own /p/:id page).
--
-- Member proofs are returned oldest-first with their current version's
-- summary (null fields when a card has no version yet — the workspace's
-- send gate keeps those out of a sent set, but a designer previewing an
-- unfinished set sees them as "still being designed").
create or replace function proofs.public_get_proof_set(p_set_id uuid, p_token text)
returns jsonb
language sql
security definer
set search_path = proofs, public, extensions, pg_temp
as $$
  select jsonb_build_object(
    'set', jsonb_build_object(
      'id', s.id,
      'currency', s.currency,
      'sent_at', s.sent_at,
      'created_at', s.created_at
    ),
    'company_name', co.name,
    'contact_name', c.full_name,
    'proofs', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', p.id,
            'status', p.status,
            'approved_at', p.approved_at,
            'set_discarded_at', p.set_discarded_at,
            'created_at', p.created_at,
            'current_version_id', cv.id,
            'version_number', cv.version_number,
            'names', cv.names,
            'material_display', cv.material_display,
            'shape', cv.shape
          )
          order by p.created_at, p.id
        )
        from proofs.proofs p
        left join lateral (
          select v.id, v.version_number, v.names, v.material_display, v.shape
          from proofs.proof_versions v
          where v.proof_id = p.id
            and v.is_current
          order by v.version_number desc
          limit 1
        ) cv on true
        where p.proof_set_id = s.id
      ),
      '[]'::jsonb
    )
  )
  from proofs.proof_sets s
  join proofs.contacts c on c.id = s.contact_id
  left join proofs.companies co on co.id = c.company_id
  where s.id = p_set_id
    and s.token = p_token;
$$;

revoke all on function proofs.public_get_proof_set(uuid, text) from public;
grant execute on function proofs.public_get_proof_set(uuid, text) to anon, authenticated;

-- ── 5. Stamp "customer opened the set review page" ──────────────────────────
-- Mirror of record_order_group_pay_link_opened (000309): token-validated,
-- only once the set has actually been sent (earlier opens are designer
-- previews), overwrites so the column holds the most recent open.
create or replace function proofs.record_proof_set_opened(p_set_id uuid, p_token text)
returns void
language sql
security definer
set search_path = proofs, public, extensions, pg_temp
as $$
  update proofs.proof_sets
     set last_opened_at = now()
   where id = p_set_id
     and token = p_token
     and sent_at is not null;
$$;

revoke all on function proofs.record_proof_set_opened(uuid, text) from public;
grant execute on function proofs.record_proof_set_opened(uuid, text) to anon, authenticated;

-- ── 6. Seed the "send set review link" reply template ───────────────────────
-- Same house pattern as 000157/000207/000237: ON CONFLICT DO NOTHING so an
-- admin-edited body is never clobbered on replay; the default body mirrors
-- DEFAULT_BODIES in src/lib/replyTemplates.ts so the admin editor's "Reset
-- to default" works. No sign-off (Help Scout appends the signature). No
-- order/payment language — this is a review link, the design phase.
-- Id deliberately NOT proof_-prefixed: the admin Templates page groups
-- proof_* ids as system-triggered post-action confirmations, and this is a
-- designer-composed pre-send message ({first_name}/{company}/{url} scope).
insert into proofs.reply_templates (id, display_name, description, body)
values (
  'set_review_link',
  'Set review link',
  'Sent from the set workspace when a set of cards goes to the customer for review. {url} is the one set review link.',
  'Hi {first_name},

Here are the proofs of your cards{? company} for {company}{/?}. There''s a design for each card in the set — you can look through and approve each one here:

{url}'
)
on conflict (id) do nothing;
