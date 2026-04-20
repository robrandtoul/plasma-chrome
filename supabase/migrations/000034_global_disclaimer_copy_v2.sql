-- Migration 000034: tighten the customer approval disclaimer copy
--
-- Second pass on the Important information block — three shorter paragraphs
-- instead of four. Rendering path is unchanged (whitespace-pre-line with
-- \n\n paragraph separators).

begin;

update site_settings
  set global_disclaimer = $$Please check this proof carefully before approving.

You're responsible for confirming all details, including names, numbers, email and web addresses, spelling and punctuation. Once approved, the artwork goes to production as shown, and any errors found afterwards would require a paid reprint.

If something needs changing, reply with the amendments and we'll send a revised proof.$$
  where id = 1;

commit;
