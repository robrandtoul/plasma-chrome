-- 000393: say what they last bought, not just when.
--
-- The re-engagement band (000392) could tell a past customer "you last ordered
-- it in March 2024" but not what "it" was, because the register was seeded from
-- Xero invoice HEADERS only. The line items turn out to carry the product in a
-- controlled vocabulary the business already maintains (Xero item codes), so a
-- customer can now be told "you last ordered 500 translucent plastic cards
-- (760 micron) in January 2026" — which is far better evidence that we are
-- their actual supplier than a bare date, and saves them remembering what they
-- bought. It also tells the DESIGNER what to build before they go hunting.
--
-- Two changes, and the second one exists because the first would otherwise be
-- rejected by the guard added in 000392 — which is the guard working.

-- 1. The register keeps the phrase it derived from the invoice.
--
-- Stored composed and sentence-ready ("500 translucent plastic cards (760
-- micron)") rather than as parts, so no consumer has to re-derive grammar from
-- a quantity and a catalogue label.
--
-- ⚠ Only set where the source invoice had EXACTLY ONE product line. A customer
-- whose last invoice split 600 cards across three colourways would otherwise be
-- told they ordered "600 translucent plastic cards", which is true in total and
-- wrong in substance. Ambiguity degrades to NULL and the band falls back to the
-- date-only sentence.
alter table proofs.reorder_prospects
  add column last_spec text;

comment on column proofs.reorder_prospects.last_spec is
  'Sentence-ready phrase for what this customer last bought, e.g. "500 translucent '
  'plastic cards (760 micron)" (000393). Derived from the Xero invoice line items, '
  'and only when the invoice had exactly one product line — an ambiguous invoice '
  'leaves this NULL rather than flattening several products into one figure. '
  'Reaches the customer via proofs.reengagement_context, so display-safe only.';

-- 2. Let the display-safe snapshot carry it.
--
-- 000392's CHECK enforces a two-key allow-list by asserting that subtracting the
-- permitted keys leaves an empty object. A third key has to be named here or
-- every outreach project carrying a spec would fail to insert.
alter table proofs.proofs
  drop constraint proofs_reengagement_context_keys_chk;

alter table proofs.proofs
  add constraint proofs_reengagement_context_keys_chk
  check (
    reengagement_context is null
    or (
      jsonb_typeof(reengagement_context) = 'object'
      and (reengagement_context - 'last_order_on' - 'orders_count' - 'last_spec') = '{}'::jsonb
    )
  )
  not valid;

alter table proofs.proofs
  validate constraint proofs_reengagement_context_keys_chk;

comment on column proofs.proofs.reengagement_context is
  'Display-safe snapshot for the re-engagement band on /p/:id (000392, widened '
  '000393). Returned VERBATIM to anon via public_get_proof_order_state — never '
  'write anything here that a customer must not read (no scores, no lifetime '
  'value, no internal notes). Presence of the object is itself the "outreach '
  'proof" flag; the CHECK enforces the three-key allow-list.';
