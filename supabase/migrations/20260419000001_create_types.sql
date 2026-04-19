-- Shared enum types and utility functions used across all tables.

create type material_type as enum (
  'metal', 'wood', 'plastic', 'acrylic', 'letterpress', 'paper'
);

create type currency_type as enum (
  'GBP', 'EUR', 'USD'
);

-- Reusable trigger function: keeps updated_at current on any table.
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
