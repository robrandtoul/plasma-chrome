# Brief: letterpress colours anon RPC (for the Stock Control app)

## Purpose

PlasmaDesign's separate Stock Control app needs to read this project's
letterpress colour palette as a live master list, so its made-to-order
letterpress fields can be picked from the same colours managed here. This
brief adds one small read-only RPC so it can. It is the only change.

Follow this repository's `CLAUDE.md` for all migration conventions.

## What to do

Work on a new branch (for example `letterpress-colours-rpc`). Do not merge it.

Add one new migration in `supabase/migrations/`. Pick the next free number
by listing the directory; do not trust any number quoted in `CLAUDE.md`.
The migration adds a `security definer` function and grants execute to anon:

```sql
create or replace function public_get_letterpress_colours()
returns table (name text, hex_value text, sort_order int)
language sql
security definer
stable
set search_path = public
as $$
  select name, hex_value, sort_order
  from letterpress_core_colours
  where is_active = true
  order by sort_order, name;
$$;

grant execute on function public_get_letterpress_colours() to anon;
```

## Notes

- This matches the existing anon-RPC house pattern (`public_get_lead_times`,
  `public_get_price_list`): `security definer`, execute granted to anon, a
  tight read-only surface. It exposes only the name, hex value and sort
  order of active colours, nothing else.
- It is purely additive. No existing table, view, policy or function is
  changed, so it cannot affect the proof viewer's current behaviour.
- It returns only `is_active = true` rows, so a colour deactivated in the
  admin page automatically disappears for the consumer.
- Deliver and apply the migration through this repository's documented
  flow (`pnpm db:diff`, then `pnpm db:push:confirm`). Leave the branch for
  review.
