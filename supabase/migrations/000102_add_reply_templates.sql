-- Migration 000102: editable reply templates for the customer-reply
-- pipeline (Ship 1 of intervention 3).
--
-- Stores the message body that designers send to customers when a
-- new proof goes live. Today the table is admin-edit-only; designer-
-- and customer-facing surfaces (the message editor on proof creation,
-- the Help Scout API send, the re-send capability) ship in Ships 2-4
-- of the intervention.
--
-- Two seed rows: 'first_proof' (sent on v1 creation) and 'revision'
-- (sent on v2+ creation). Stable string ids let the application code
-- reference templates by name without coupling to an integer surrogate.
-- New template types ship via future migrations; the UI doesn't
-- expose insert/delete to keep the application's enum of expected ids
-- honest.
--
-- Body strings use the {variable} substitution syntax and the
-- {? variable}…{/?} conditional rendering syntax. The substitution
-- helper lives in src/lib/replyTemplates.ts; DEFAULT_BODIES there
-- must stay in sync with the seed values below.

begin;

create table reply_templates (
  id            text        primary key,
  display_name  text        not null,
  description   text        not null default '',
  body          text        not null default '',
  updated_at    timestamptz not null default now(),
  updated_by    uuid        references auth.users(id)
);

create trigger reply_templates_updated_at
  before update on reply_templates
  for each row execute function update_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────────
--
-- Authenticated designers need SELECT so the new-version flow (Ship 2)
-- can fetch a template body before sending. Admin-only UPDATE keeps
-- template content under the same gate as the rest of the settings
-- surface. No insert/delete from RLS; new templates ship via
-- migrations.

alter table reply_templates enable row level security;

create policy "reply_templates: authenticated read"
  on reply_templates for select to authenticated using (true);

create policy "reply_templates: admin update"
  on reply_templates for update to authenticated using (is_admin());

-- ── Seed defaults ────────────────────────────────────────────────────────────
--
-- E'…' string syntax for literal newlines. Variables in the body
-- ({first_name}, {company}, {url}, {version_number}) are documented
-- in src/lib/replyTemplates.ts TEMPLATE_VARIABLES.
--
-- {designer_first_name} is intentionally left out of the seed copy
-- pending the designer-accounts feature; the variable is documented
-- in the admin UI and resolves to empty today, so dropping it into
-- the body would render an awkward signature gap. Admins can edit
-- the seeded body to wire the variable in once accounts arrive.

insert into reply_templates (id, display_name, description, body) values
  (
    'first_proof',
    'First proof',
    'Sent when a designer creates v1 of a new project.',
    E'Hi {first_name},\n\nHere''s the first proof of your cards{? company} for {company}{/?}. Have a look and let us know what you think.\n\n{url}\n\nMany thanks,\nPlasma Design'
  ),
  (
    'revision',
    'Revision',
    'Sent when a designer creates v2 or later of an existing project.',
    E'Hi {first_name},\n\nHere''s v{version_number} of your cards{? company} for {company}{/?} with the changes you asked for. Take another look when you have a moment.\n\n{url}\n\nMany thanks,\nPlasma Design'
  );

commit;
