-- Single-row table holding global configurable copy shown on the customer page.
-- The check constraint on id = 1 enforces the single-row invariant.

create table app_settings (
  id               int primary key check (id = 1),
  disclaimer_html  text not null default '',
  updated_at       timestamptz default now()
);

create trigger app_settings_updated_at
  before update on app_settings
  for each row execute function update_updated_at();

-- Seed the single row with a placeholder disclaimer.
-- Edit this via the Supabase dashboard or update the migration before first run.
insert into app_settings (id, disclaimer_html)
values (
  1,
  '<p>All prices are indicative and exclude shipping. Final pricing is confirmed on your invoice.</p>'
);

-- RLS: public can read, only authenticated designers can update.
alter table app_settings enable row level security;

create policy "app_settings: public select"
  on app_settings for select
  using (true);

create policy "app_settings: authenticated update"
  on app_settings for update
  to authenticated
  using (true);
