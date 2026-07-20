-- 000330_unique_designer_colours.sql
--
-- Give every member of staff their own colour, and keep it that way.
--
-- profiles.designer_colour is the identity colour behind someone's avatar,
-- their dashboard chip, their feedback cards and (as of this migration) their
-- chat bubbles. It only does its job — "that's a message from Chris" at a
-- glance — if no two people share one.
--
-- Two things were working against that:
--
--   1. The palette had four colours, and 000153 hand-assigned them so no two
--      designers clashed. That was a one-off tidy-up, not a rule, so the
--      guarantee lapsed the moment someone new arrived: Alan Garland and Chris
--      Jackson are both 'teal' today and render as the same green.
--
--   2. The auto-assign in set_designer_presentation() picks from a three-colour
--      array by hashing the user id. A hash over three buckets collides
--      constantly — it is what put Alan on Chris's colour in the first place.
--
-- So: widen the palette to seven, assign the first FREE colour rather than a
-- hashed one, and move Alan onto a colour of his own. Seven leaves two spare
-- against today's five active staff; if the team ever outgrows the palette the
-- trigger falls back to the least-used colour rather than failing an insert,
-- and adding an eighth colour is one entry here plus one in
-- src/lib/designerColours.ts.
--
-- Deliberately NOT a unique index on designer_colour: hiring the eighth person
-- would then fail their profile insert outright — a hard signup failure to
-- prevent two avatars looking alike. Uniqueness is worth arranging, not worth
-- an outage.

-- ── 1. Widen the palette ─────────────────────────────────────────────────────
--
-- Keep the four existing names exactly as they are: they are already stored on
-- live profile rows and denormalised onto thousands of message/feedback rows.
-- 'teal' renders green and 'coral' renders orange after the reskin; the names
-- are historical and the UI labels them by what you actually see.

alter table proofs.profiles
  drop constraint if exists profiles_designer_colour_check;

alter table proofs.profiles
  add constraint profiles_designer_colour_check
  check (designer_colour in ('blue', 'teal', 'coral', 'purple', 'gold', 'pink', 'cyan'));

comment on column proofs.profiles.designer_colour is
  'Identity colour for this person''s avatar, chips and chat bubbles. One of '
  'seven; kept unique per active member of staff by set_designer_presentation(). '
  'Palette mirrored in src/lib/designerColours.ts.';

-- ── 2. Auto-assign the first free colour, not a hashed one ───────────────────
--
-- SECURITY DEFINER because the function has to look at everyone else's colours
-- to know which are free, and the profiles SELECT policies only let a non-admin
-- see their own row (see 000329, which added team_roster() for the same
-- reason). Nothing about other people leaves the function — it returns a colour
-- name for the row being written. EXECUTE is revoked from callers per the
-- 000182 house pattern; a trigger fires regardless of EXECUTE.
--
-- The initials half of the function is unchanged from the live definition.

create or replace function proofs.set_designer_presentation()
  returns trigger
  language plpgsql
  security definer
  set search_path = proofs, public, extensions, pg_temp
as $$
begin
  if new.designer_initials is null and new.full_name is not null then
    new.designer_initials := nullif(
      upper(
        coalesce(left(split_part(new.full_name, ' ', 1), 1), '')
        ||
        case
          when new.full_name ~ ' '
            then left(split_part(new.full_name, ' ', array_length(string_to_array(new.full_name, ' '), 1)), 1)
          else ''
        end
      ),
      ''
    );
  end if;

  if new.designer_colour is null then
    -- First colour down the palette that no other active member of staff is
    -- using. Deactivated people are ignored so a leaver's colour is reusable.
    select p.c
      into new.designer_colour
    from unnest(array['blue', 'teal', 'coral', 'purple', 'gold', 'pink', 'cyan'])
      with ordinality as p(c, ord)
    where not exists (
      select 1
      from proofs.profiles ex
      where ex.designer_colour = p.c
        and ex.id <> new.id
        and ex.deactivated_at is null
    )
    order by p.ord
    limit 1;

    -- More active staff than colours: share the least-crowded one rather than
    -- leaving the column null (which would render them grey everywhere).
    if new.designer_colour is null then
      select p.c
        into new.designer_colour
      from unnest(array['blue', 'teal', 'coral', 'purple', 'gold', 'pink', 'cyan'])
        with ordinality as p(c, ord)
      left join proofs.profiles ex
        on ex.designer_colour = p.c
       and ex.id <> new.id
       and ex.deactivated_at is null
      group by p.c, p.ord
      order by count(ex.id), p.ord
      limit 1;
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function proofs.set_designer_presentation() from public, anon, authenticated;
grant execute on function proofs.set_designer_presentation() to service_role;

-- ── 3. Break the one live collision ──────────────────────────────────────────
--
-- Alan Garland and Chris Jackson are both 'teal'. Chris has held teal since
-- 000153 and has the longer history of messages and cards carrying it, so Alan
-- moves. Gold is the furthest free hue from the green they were sharing.
--
-- Guarded on the collision still existing so a replay (or Alan having picked
-- his own colour in the meantime) is a no-op rather than an override.

update proofs.profiles me
   set designer_colour = 'gold'
 where me.full_name = 'Alan Garland'
   and me.designer_colour = 'teal'
   and exists (
     select 1
     from proofs.profiles other
     where other.designer_colour = 'teal'
       and other.id <> me.id
       and other.deactivated_at is null
   );

-- ── 4. Realign the denormalised copies ───────────────────────────────────────
--
-- Six tables stamp the author's colour onto each row at insert time (the
-- feedback_items idiom from 000271, repeated for chat, announcements, order
-- link notes and the flagged board). That denormalisation is deliberate — it is
-- what lets everyone see an author's colour despite profiles being self-read
-- only — but it means a colour change leaves old rows on the old colour.
--
-- Colour is presentation, not attribution: the whole point is that one person
-- reads as one colour, so past rows should follow a change rather than fossilise
-- it. Names and initials are left frozen, since those genuinely record who
-- wrote something at the time.
--
-- Safe to re-run: each statement only touches rows that disagree with the
-- profile. Rows whose author has since been deleted (nullable FK) are skipped.

update proofs.team_messages m
   set author_colour = p.designer_colour
  from proofs.profiles p
 where p.id = m.author_id
   and m.author_colour is distinct from p.designer_colour;

update proofs.feedback_items f
   set created_by_colour = p.designer_colour
  from proofs.profiles p
 where p.id = f.created_by
   and f.created_by_colour is distinct from p.designer_colour;

update proofs.announcements a
   set created_by_colour = p.designer_colour
  from proofs.profiles p
 where p.id = a.created_by
   and a.created_by_colour is distinct from p.designer_colour;

update proofs.order_link_notes n
   set created_by_colour = p.designer_colour
  from proofs.profiles p
 where p.id = n.created_by
   and n.created_by_colour is distinct from p.designer_colour;

update proofs.watch_items w
   set created_by_colour = p.designer_colour
  from proofs.profiles p
 where p.id = w.created_by
   and w.created_by_colour is distinct from p.designer_colour;

update proofs.watch_updates u
   set created_by_colour = p.designer_colour
  from proofs.profiles p
 where p.id = u.created_by
   and u.created_by_colour is distinct from p.designer_colour;
