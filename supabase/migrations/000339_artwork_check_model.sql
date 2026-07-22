-- Artwork check: admin-selectable Claude model (docs/artwork-check-spec.md).
--
-- The check runs on claude-opus-4-8 by default (the model it was tuned and
-- validated on). This column lets an admin pick a different model from the
-- Admin → Artwork check tab without a redeploy — the edge function reads it at
-- run time. NULL = use the default (env ARTWORK_CHECK_MODEL, then the
-- compiled default). Free text rather than a CHECK: the valid model set
-- changes over time and is curated in the admin dropdown; a bad value simply
-- makes a run error (verdict 'error', non-stranding), never a hard failure.
--
-- Rides the existing proofs.settings row, so no grant work. Apply via MCP /
-- dashboard SQL editor per the house workflow — never CLI push.

alter table proofs.settings
  add column if not exists artwork_check_model text;

comment on column proofs.settings.artwork_check_model is
  'Claude model id the artwork sanity check runs on (Admin → Artwork check). NULL = the function default (claude-opus-4-8). Takes effect on the next run, no redeploy.';
