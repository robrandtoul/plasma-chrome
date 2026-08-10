-- 000407: record which FINISH a past customer last chose.
--
-- Part A of docs/reorder-register-rescrape-spec.md. The register can already say
-- what material and thickness someone last bought; it cannot say the finish,
-- because the seeding job read the Xero ITEM NAME rather than the line
-- DESCRIPTION — the description says "Gold metal business cards (500 micron
-- with brushed finish)" and the item name says "Gold metal cards (500 micron)".
-- See scripts/reorder-register/README.md for the four proofs of that.
--
-- Finish is half of what a designer currently hunts through legacy systems for
-- when building a repeat order, so this is the column that makes the register
-- worth reading at order time.
--
-- ADDITIVE AND INERT. Nothing reads these columns yet — the parse runs in
-- shadow and is checked by hand before anything is wired up (spec Step 3).
--
-- ⚠ The spec numbered this 000406; that number went to the stale-spec data fix
-- instead. Same content, next free number.
--
-- DELIBERATELY NOT HERE, though the spec drafts them: the
-- `reorder_backfill_stage` staging table and `history_backfilled_to`. Both exist
-- only to serve Part C (scraping further back than April 2023), which the spec
-- itself recommends against for now — the desk holds ~22 months of supply, so
-- the constraint is ordering, not names. Schema for work we have decided not to
-- do is just schema nobody understands later. They arrive with Part C or not
-- at all.

alter table proofs.reorder_prospects
  add column last_option_id     uuid references proofs.material_options(id) on delete set null,
  add column last_option_label  text,
  add column last_option_source text
    check (last_option_source in ('order_column', 'item_name', 'xero_description'));

-- ⚠ The id and the frozen label travel together, exactly as 000399 established
-- for the variant: a retired or renamed option must still be nameable to
-- whoever reads the row in two years. And a source is mandatory whenever there
-- is an id, because the three sources are NOT equally trustworthy — one is our
-- own order column, one is a catalogue name, one is parsed from free text a
-- human typed onto an invoice. Anything downstream that decides how much to
-- trust the finish reads this.
alter table proofs.reorder_prospects
  add constraint reorder_prospects_last_option_chk
  check (
    (last_option_id is null and last_option_label is null and last_option_source is null)
    or (last_option_id is not null and last_option_label is not null and last_option_source is not null)
  );

comment on column proofs.reorder_prospects.last_option_id is
  'Finish/species the customer last chose, where the catalogue offers a choice '
  'AND we could establish it beyond doubt. NULL is the EXPECTED state for the '
  '1,863 register rows on materials with no option dimension at all — there was '
  'no choice to make, so it is not missing data. It is equally expected wherever '
  'the invoice simply did not say. '
  '⚠ Do NOT "fix" a NULL by defaulting to the base option: on steel, gold and '
  'rose gold, Mirror and Brushed carry a surcharge Natural does not, so a '
  'guessed finish also badges the wrong price column on the customer''s own '
  'page. Silence means silence.';

comment on column proofs.reorder_prospects.last_option_source is
  'How we know. order_column = read from proofs.orders.material_option_id on an '
  'order placed through this app (highest confidence, no parsing). item_name = '
  'the catalogue item name carried it, which is only true for wood species. '
  'xero_description = parsed from the free text a human typed on the Xero '
  'invoice line (lowest confidence — see the refusal rules in '
  'scripts/reorder-register/finishParse.mjs).';
