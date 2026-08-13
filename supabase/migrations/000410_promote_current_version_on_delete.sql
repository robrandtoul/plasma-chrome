-- 000410 — deleting the current version promotes its predecessor
--
-- Deleting the current version left the proof with NO version flagged
-- current, because the insert side and the delete side were asymmetric:
--
--   superseded_at : stamped   by stamp_supersession_on_insert
--                   RESTORED  by clear_supersession_on_delete   ← symmetric
--   is_current    : unset-siblings + set-new
--                             by set_is_current_on_insert
--                   nothing   on delete                         ← asymmetric
--
-- set_is_current_on_insert is a BEFORE INSERT trigger that clears
-- is_current on every existing sibling before the new row lands. If that
-- new row is then deleted, the clear stands on its own and the proof is
-- left with zero current versions. Nothing puts it back.
--
-- The everyday route in is NewVersionPage's save, which rolls a
-- half-built version back from NINE separate failure paths with a bare
-- `delete().eq('id', versionData.id)` (variants failed, images failed, QR
-- rows failed, …). Every one of them silently costs the proof its current
-- version. VersionDetailModal.handleDelete is the only caller that
-- hand-promotes a successor first, and it decides whether to bother from
-- a client-side copy of is_current that can be stale.
--
-- A proof in that state is quietly broken rather than obviously broken:
--   * the dashboard pill reads "Not viewed" for ever — proofBucket falls
--     through to that bucket whenever current_version_id is null, so it
--     says it no matter how many times the customer opens the proof
--   * the customer still sees the newest version (the page falls back to
--     the last one), but with the amber "you're looking at an earlier
--     version" warning over the top of it, and the tab reads History
--     instead of Current
--   * every current-version-only panel — team sharing, decline feedback —
--     silently disappears
--
-- It also self-heals the moment anyone adds another version, since the
-- next insert flags itself current. That is why this surfaced as a single
-- stranded proof rather than a pile of them: the damage is normally
-- absorbed before anyone gets round to reporting it, which makes the
-- true rate much higher than the one row this repairs.
--
-- Fixed in the database rather than at the nine call sites: the invariant
-- belongs beside the trigger that breaks it, and it then covers every
-- future caller for free.

create or replace function proofs.promote_current_on_delete()
returns trigger
language plpgsql
security definer
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $function$
begin
  -- Only losing the CURRENT version leaves a hole; deleting a superseded
  -- one changes nothing about which version is live. This early return is
  -- also what stops VersionDetailModal.handleDelete double-promoting —
  -- it promotes the successor first, so by the time its delete lands
  -- old.is_current is already false.
  if not old.is_current then
    return old;
  end if;

  -- Never promote inside a proof that is itself being deleted. A proof
  -- delete cascades to its versions (delete_proof_cascade deletes the
  -- proofs row and lets the FK do the rest, so the parent is already
  -- gone by the time we get here), and every sibling is about to follow.
  -- Promoting would be pointless, and it would fire
  -- finalize_on_version_promotion -> _finalize_proof_if_complete against
  -- a proof that no longer exists — which does NOT simply no-op, because
  -- that function reads the status into a variable and a NULL there
  -- fails to trip its `not in ('in_progress','dormant')` guard.
  if not exists (select 1 from proofs where id = old.proof_id) then
    return old;
  end if;

  -- Promote the chronologically-latest survivor. Deliberately the same
  -- successor clear_supersession_on_delete picks, so is_current and
  -- superseded_at can never disagree about which version is live. With no
  -- survivors the UPDATE matches nothing, which is the right answer.
  update proof_versions
  set is_current = true
  where id = (
    select id from proof_versions
    where proof_id = old.proof_id
      and id <> old.id
    order by created_at desc
    limit 1
  );

  return old;
end;
$function$;

-- Internal trigger plumbing — nothing calls this directly, and trigger
-- invocation ignores EXECUTE, so the revoke costs nothing (000182).
revoke execute on function proofs.promote_current_on_delete() from public, anon, authenticated;

drop trigger if exists proof_versions_promote_current_on_delete on proofs.proof_versions;
create trigger proof_versions_promote_current_on_delete
  after delete on proofs.proof_versions
  for each row execute function proofs.promote_current_on_delete();

-- Repair whatever is already stranded. Written generically rather than
-- pinned to the one proof this was found on, and idempotent — on a
-- healthy database it matches nothing.
--
-- Safe against a spurious approval: promoting fires
-- finalize_on_version_promotion, but that only flips a proof to approved
-- when every required slot on the promoted version is already signed off.
-- The single row this repairs today is doubly excluded — it carries zero
-- approval rows, and it is a Selection (variant round), which bails out
-- of the finaliser at its top guard (000141).
update proofs.proof_versions v
set is_current = true
where v.id in (
  select distinct on (pv.proof_id) pv.id
  from proofs.proof_versions pv
  where not exists (
    select 1 from proofs.proof_versions c
    where c.proof_id = pv.proof_id and c.is_current
  )
  order by pv.proof_id, pv.created_at desc
);

comment on function proofs.promote_current_on_delete() is
  'Promotes the latest surviving sibling when a proof''s current version is deleted. Counterpart to set_is_current_on_insert, which clears is_current on every sibling before the new row lands: without this, deleting that row (notably NewVersionPage''s save rollbacks) leaves the proof with no current version at all, which reads as a permanent "Not viewed" on the dashboard.';
