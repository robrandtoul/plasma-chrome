-- 000408: record which past customers order cards for SEVERAL people.
--
-- WHY THIS AND NOT A RUN-OUT PREDICTION. The desk was going to be given a
-- consumption model: cards bought ÷ time until they bought again = a burn rate,
-- and therefore a predicted date they run dry. It was tested against real Xero
-- invoices across all 670 repeat customers and it does not work — not because
-- the data is thin, but because the premise is wrong:
--
--   Cards bought   Typical wait until next order
--   up to 100      155 days
--   101–250        206 days
--   251–500        210 days
--   501–1,000      142 days   ← the SHORTEST wait, on the second-largest orders
--   over 1,000     149 days
--
-- Ten times the cards buys the same wait, and not even monotonically. Order size
-- explains under 1% of when someone returns. Diamond Industrial has ordered
-- exactly 100 cards eleven times since 2020, with gaps from 15 days to 296.
--
-- Customers are not running down a stock cupboard. They buy when they HIRE —
-- someone joins, a role changes, a rebrand lands — and they pick a quantity off
-- our price grid, not from how fast they get through them. Trans American's 29
-- orders went to roughly nine different named people at nine addresses.
--
-- So the useful question is not "are they due?" but "is this an account that
-- adds people?", and the invoice already answers it: an order split between
-- several recipients carries an extra-tooling line. That is what this records.
--
-- ⚠ IT IS DELIBERATELY NOT WIRED INTO THE SCORE. The consumption model would
-- have re-ranked a live worklist on an untested signal; so would this. It is
-- shown to the designer as a fact about the account and they decide. If it
-- earns a place in the ranking later, that should follow a backtest, not a
-- hunch — the last hunch cost a week of investigation to disprove.

alter table proofs.reorder_prospects
  add column split_orders     integer,
  add column max_recipients   integer,
  add column split_signal_at  timestamptz;

comment on column proofs.reorder_prospects.split_orders is
  'How many of this customer''s invoices carried an extra-tooling line, i.e. '
  'were split between several recipients. NULL means not yet measured — which '
  'is NOT the same as zero, and the desk must not render it as "never splits".';

comment on column proofs.reorder_prospects.max_recipients is
  'The largest number of recipients seen on any one of their orders, taken as '
  '(tooling line quantity + 1). 1 means every order we have seen went to one '
  'person. '
  '⚠ Read from the tooling line''s QUANTITY, never from its amount: the '
  'per-name rate has varied (£15, £9, £25, £39 and $49 all appear within a '
  'single month), so an amount-derived count is wrong. Verified against real '
  'invoices where the description happens to name the people — Claratus '
  'INV-26483 has tooling quantity 3 and names four; Prism Power INV-26491 has '
  'quantity 2 and reads "(Darren, Wayne and Steve)". '
  '⚠ It counts BATCHES, which are usually people but occasionally designs — '
  'The Medical Lounge INV-26468 reads "500 per design". Treat it as "this '
  'account orders for more than one recipient", not as a headcount.';

comment on column proofs.reorder_prospects.split_signal_at is
  'When the tooling-line scrape last ran. The register is otherwise a snapshot '
  'with no per-column freshness, and this one is read straight from Xero rather '
  'than derived from the seeded aggregates, so it can go stale on its own.';

-- No index. The desk reads the whole pending set already and filters client-
-- side; 2,758 rows do not need one, and an unused index is a thing to explain
-- to whoever reads this next.
