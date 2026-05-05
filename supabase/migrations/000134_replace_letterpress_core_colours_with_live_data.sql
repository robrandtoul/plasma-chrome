-- Migration 000134: replace seed core-colour palette with live data.
--
-- Migration 000133 seeded 8 placeholder colours (Natural, Black,
-- Burgundy, Sapphire, Sage, Charcoal, Mustard, Copper) so the
-- feature could be tested end-to-end. This migration replaces them
-- with the real 40-colour palette from the letterpress paper-stock
-- supplier (source: letterpress-paper-swatches.xlsx provided by Rob,
-- 2026-05-05). Two names overlap with the seed (Natural, Sapphire)
-- but with slightly different hex values — both are replaced with
-- the supplier's authoritative values.
--
-- The DELETE relies on proof_versions.core_colour_id's
-- "on delete restrict" FK to fail loudly if any proof references a
-- seeded colour at the moment of this migration. Verified at
-- author time that no rows reference any of the 8 seed colours.
-- If a future re-run hits referenced rows the migration will error
-- with FK violation rather than silently lose the link — that's
-- the desired behaviour.
--
-- Sort order spaced 10 apart (10..400) in the alphabetical order
-- the supplier ships, leaving room to slot future additions
-- between existing entries without renumbering.

begin;

delete from letterpress_core_colours;

insert into letterpress_core_colours (name, hex_value, sort_order) values
  ('Adriatic',         '#4277a0',  10),
  ('Amethyst',         '#3d2e48',  20),
  ('Azure blue',       '#b5c5d7',  30),
  ('Bagdad brown',     '#4d3b33',  40),
  ('Bitter chocolate', '#3f3433',  50),
  ('Bright red',       '#ca323c',  60),
  ('Candy pink',       '#e8b8c2',  70),
  ('Citrine',          '#faa702',  80),
  ('Claret',           '#46262e',  90),
  ('Cobalt',           '#38455b', 100),
  ('Cool blue',        '#d1d0d8', 110),
  ('Dark grey',        '#5b5b59', 120),
  ('Emerald',          '#377a6b', 130),
  ('Factory yellow',   '#face05', 140),
  ('Forest',           '#375842', 150),
  ('Fuchsia pink',     '#cd5c9b', 160),
  ('Harvest',          '#b6977d', 170),
  ('Imperial blue',    '#212d3d', 180),
  ('Lavender',         '#c1aad5', 190),
  ('Lockwood green',   '#377243', 200),
  ('Mandarin',         '#f16301', 210),
  ('Mid green',        '#8b967b', 220),
  ('Natural',          '#f2f0de', 230),
  ('New blue',         '#809cbd', 240),
  ('Nubuck brown',     '#947467', 250),
  ('Pale grey',        '#d2d0cd', 260),
  ('Park Green',       '#a7d7b3', 270),
  ('Pistachio',        '#d0ddc1', 280),
  ('Purple',           '#705299', 290),
  ('Racing green',     '#2e3e3d', 300),
  ('Real grey',        '#afafa6', 310),
  ('Royal blue',       '#434787', 320),
  ('Sapphire',         '#2b466f', 330),
  ('Scarlet',          '#8d303c', 340),
  ('Smoke',            '#676767', 350),
  ('Sorbet yellow',    '#ead9a4', 360),
  ('Stone',            '#d8b9a7', 370),
  ('Tabriz blue',      '#1e9acd', 380),
  ('Turquoise',        '#68ccce', 390),
  ('Vermilion',        '#ac2934', 400);

commit;
