-- Migration 000059: support renaming a material (display_name only)
--
-- Schema-wise this adds:
--   * a case-insensitive unique index on materials.display_name, so
--     two materials can't share a label from the admin's perspective
--   * a trigger that propagates display_name changes into the
--     proof_versions.material_display snapshot column, so every read
--     path that already queries proof_versions sees the new name
--     without having to be rewritten to join materials
--
-- The bump_proof_activity trigger on proof_versions would otherwise
-- mark every existing proof as "just touched" (wake dormants, update
-- last_activity_at) whenever we renamed a material — that's not
-- activity by a person. Guard it with pg_trigger_depth() so cascaded
-- updates from other triggers don't bump proof activity.
--
-- The `code` column is the internal slug (URLs, CSV filenames, FKs)
-- and stays immutable — no UI path edits it.

begin;

-- 1. Case-insensitive uniqueness on display_name.
create unique index if not exists materials_display_name_lower_idx
  on materials (lower(display_name));

-- 2. Propagate renames into proof_versions.material_display.
create or replace function sync_material_display_name()
returns trigger
language plpgsql
as $$
begin
  if NEW.display_name is distinct from OLD.display_name then
    update proof_versions
      set material_display = NEW.display_name
      where material_id = NEW.id;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_sync_material_display_name on materials;
create trigger trg_sync_material_display_name
  after update on materials
  for each row execute function sync_material_display_name();

-- 3. Stop cascaded updates from looking like person-driven activity.
create or replace function bump_proof_activity()
returns trigger
language plpgsql
as $$
begin
  -- pg_trigger_depth() > 1 means we were fired from inside another
  -- trigger — e.g. sync_material_display_name pushing a name change
  -- down into every proof_version. Those aren't real activity.
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  update proofs
    set last_activity_at = now(),
        status = case when status = 'dormant' then 'in_progress' else status end
    where id = new.proof_id;
  return new;
end;
$$;

commit;
