-- Migration 000033: replace lorem ipsum with production disclaimer copy
--
-- The customer proof page already renders site_settings.global_disclaimer
-- with whitespace-pre-line, so using \n\n between paragraphs gives the
-- blank-line spacing the copy needs.

begin;

update site_settings
  set global_disclaimer = $$Before you approve, please check carefully.

You're responsible for making sure every detail on this proof is correct, including names, phone numbers, email addresses, web addresses, spelling and punctuation. Once you approve, we'll send the artwork straight to production exactly as shown.

Any errors discovered after approval are not the responsibility of PlasmaDesign Ltd, and a reprint would need to be quoted and paid for separately.

Please take your time, and if anything looks off, just reply with the changes and we'll send a revised proof.$$
  where id = 1;

commit;
