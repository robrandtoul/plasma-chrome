# `@plasma/chrome/chat`

The staff team chat, as one implementation shared by all four apps.

British English, no em dashes, same as the rest of this repo.

---

## Why it moved here

The chat existed twice: proof-viewer had it, and stock-control had a fork of it. Both read the **same** tables (`proofs.team_messages` and friends), so they were never showing different conversations. They drifted in every other way, and one of the ways was destructive.

What the two copies actually did to each other, measured on live before this change:

- **Stock-control was writing its staleness into shared state.** It had no resync of any kind: no foreground refetch on `visibilitychange` / `focus` / `online`, and a `.subscribe()` callback that only handled `SUBSCRIBED`, so a dropped socket was never noticed. It fetched messages once, on mount. But it *did* stamp `profiles.team_chat_seen_at` to wall-clock `now()` whenever its panel opened. Proof-viewer recomputes unread from that stamp rather than incrementing a counter, deliberately, so opening a stale stock panel marked as read a batch of messages **neither app had ever displayed**. A pinned stock dropdown fired this on every page load.
- **Stock's message search had been silently returning nothing.** One query used the root client instead of the schema-scoped accessor every other query in that file used. Stock's client is pinned to `public`, `public.team_messages` does not exist, `data` came back null, and the UI degraded to filtering the loaded window with no error. Nobody noticed.
- **Stock rendered one colleague grey.** It predated the seven-colour palette, so a person whose colour was added later had no entry.
- **Stock could empty its own history and hide the way back.** Its initial load did `msgs ?? []` with no error guard and then set `initialFullRef` from that result, so one failed read both emptied the list and marked the history exhausted, removing the "Show earlier messages" button that was the only route back.

None of that is a criticism of the fork. It is what happens to any hand-maintained copy, and stock's own header said so: *"proof-viewer owns the canonical copy — keep behavioural changes in sync"*. That process is the thing that failed, and adding a third and fourth copy for Card Programme and vCard Studio would have failed harder.

So the chat lives in the package, next to the navigation chrome, for the same reason the chrome does: four apps, one thing, one place to change it.

---

## What "in sync" actually required

Sharing the code fixes drift. It does **not**, on its own, fix sync, because the four apps sit on four subdomains. Three separate problems, three separate answers:

**Messages** were never the problem. All four apps are on one Supabase project and one set of tables, and both old copies already opened the same realtime topic (`team-chat`) with the same presence key. A third and fourth app joining that topic join the same presence set for free.

**Read state** is durable in the database but was only *observed* by each app's own resync. Now every read also broadcasts on the shared realtime topic, so a badge cleared in Stock clears in Proofs as it happens rather than whenever Proofs next resyncs. The database stamp is still the truth; the broadcast is purely latency. If the socket is down nothing is lost, only delayed.

**Preferences could not cross at all.** `localStorage` is scoped to an origin, so muting the sound in Proofs could never reach Stock, and the open conversation was lost on every app switch. That last one matters most: 93% of messages on live are DMs, so switching apps almost always dumped you out of the conversation you were reading. Anything that must follow a person now lives on `proofs.profiles.team_chat_prefs`:

| Setting | Where it lives | Why |
| --- | --- | --- |
| Sound on/off | database | Mute once, quiet everywhere. |
| Dropdown pinned | database | It is a working style, not a window. |
| Placement (floating/docked) | database | Honoured only where the host has a dock. |
| Open conversation | database | The one that was costing people their place. |
| Manual status (Away/Busy) | database | Presence keeps a person's *most present* status across tabs, so without this an idle tab in another app silently overrode a deliberate "Busy". |
| Dropdown size, popout size, dock height | database | Added in 1.9.3. Rob asked for the window to arrive the same size it was left, and works on one screen. The stored value is never capped on write — the dropdown caps to the viewport at render — so a size chosen on a large screen shrinks to fit a laptop and comes back intact on the large screen. If someone does work across two very different displays, this is the setting to move back to the browser. |
| "Am I the popout?" | browser (session) | A question about one tab. |

The three sizes keep the browser-storage key names they always had (`<prefix>-size`, `<prefix>-popout-size`, `<prefix>-dock-height`), so a size someone had already set carries over rather than resetting to the default on the first load after the upgrade. Storage is still written on every change and is what the panel reads at mount; the profile is the copy that crosses apps and it is applied over the top when the preferences arrive.

Every read of the preference column is guarded on the key being **present**, not truthy, and the column is fetched in its own request rather than folded into the profile select. PostgREST rejects an entire select if one named column is missing, so folding it in would mean an app running against a database that predates the migration lost the whole profile row. As written, either deploy order is safe.

---

## Being noticed (1.10.0)

The chat had one way of telling you something had arrived: a badge on its own
header pill, and a short quiet chime. Both only work on a tab you are already
looking at, which is the one case where you did not need telling. With the tab
in the background there was no lasting trace of any kind, so a message missed
in the moment was missed for good, and people were missing them.

Four signals now, each independently guarded so a browser that cannot do one
still does the others.

**The tab title** carries the count, `(3) Proof Viewer`, with a bullet after it
when something is personal. The hosts set their own titles per page and
proof-viewer restores the previous one when a page unmounts, so `badge.ts`
watches the `<title>` element: any title it did not write becomes the new base
and the count goes back on top. Without that the count would be wiped by the
next navigation, or, worse, a prefixed title would be captured as the
"previous" one and restored later with a stale number frozen into it.

**The favicon** takes a coloured disc in the corner, coral for personal and
blue otherwise. It is drawn by loading the host's own icon into a canvas, so a
host whose icon will not load (no intrinsic size, cross-origin, a 404) simply
does not get this one, once, rather than retrying on every message. No digits:
at sixteen physical pixels a number is a smudge.

**The installed app's icon** gets `navigator.setAppBadge`, which is a no-op in
a browser tab and the dock or Home Screen count everywhere else.

**A desktop notification** is raised for a DM or an @mention that arrives while
the app is not the window in front of you. Three things about it are
load-bearing:

- It is hung off the branch where the message *counted as unread*, not tested
  separately. That is the question worth asking, and it settles the awkward
  case for free: with chat popped out into its own window the app document has
  lost focus while the conversation may be in plain sight, and anything visible
  there has already been marked read.
- Its tag is `chat:<message id>`, which is exactly the tag `send-push` sets.
  Where both a push and a local notification arrive, the operating system
  treats them as the same notification and replaces rather than stacks, so
  nobody is told twice about one message.
- It is silent. The panel chimes for the same message, and letting the
  notification sound as well means two noises for one event, from two
  different places, a fraction of a second apart.

How much it may say is a preference, `alerts`, alongside the others in
`team_chat_prefs`: sender and message, sender only, or off. It travels for the
same reason muting does, and "sender only" exists because a preview is on
screen for anyone standing behind you. It defaults to the fullest form:
someone who has granted notification permission has already said they want to
be told, and asking them to opt in a second time, in a menu they would have to
find, is how a feature ships and then goes unused.

The chime is louder, and the personal one is three rising notes rather than
two, which is what makes it read as a deliberate phrase rather than a blip and
is what the ear picks out of background noise. The room cue was lifted much
less: it fires for every message the whole team sends, and a room cue as
insistent as the personal one would train people to mute the lot, taking their
private messages with it.

The header pill pulses when the personal count goes up. Finite, three beats:
a control that animates for as long as it has unread stops reading as a signal
within about a minute and becomes wallpaper. It is keyed off the rise rather
than off "is there unread", so a second message pulses again instead of being
swallowed by the first one's animation, and returning to a page with old
unread does not replay an alert about nothing new. `prefers-reduced-motion`
drops the movement and keeps everything else.

⚠ None of this replaces push, and push is what reaches a phone in a pocket.
Proof-viewer's `reconcileSubscription()` was separately found to be repairing
nothing when a subscription had been pruned server-side, which had left one
person with 140 undelivered messages over a month and no indication anything
was wrong. If notifications are "not working" for someone, check
`proofs.push_subscriptions` has a row for them before looking at any of the
above.

---

## The message peek (1.11.0)

The four signals in 1.10.0 all assume you are somewhere else. The desktop
notification is explicitly gated on the app NOT being the window in front of
you, so a message arriving while you were working here got a badge, a chime and
a three-beat pulse, and nothing that said who it was from or what they wanted.

So a card now grows out from under the header pill: sender, the message, and a
click that opens that conversation. It and the desktop notification are exact
complements, one wanting the document focused and the other wanting it not, so
nobody is ever told the same thing twice at once.

`transform-origin: top right` is what makes it read as the button opening out
rather than a panel arriving from off-screen. That is the whole difference
between a notification and an interruption.

**Every message peeks, and a personal one lingers.** A DM or an @mention holds
for 8 seconds against a room message's 3.5. A difference in dwell alone would
read as a glitch, so the two cards also differ in colour: coral with a left
rule for personal, plain for the room. The colour is what turns the timing into
a rule somebody can learn.

**A burst replaces rather than stacks**, and the card says who the latest is
from plus "and 2 more". Four cards sliding down under the header is how a
helpful thing becomes the thing everybody switches off, and the badge already
carries the true count.

⚠ `personal` is **sticky across a burst**, and that is the rule to keep. The
card describes the newest message, so room chatter arriving behind a DM takes
over the name and the text while the DM is still unread underneath it. Letting
that drag the card back to the short dwell and the quiet colour would cut short
the very message that earned the long one. Once a burst contains something for
you, the card is for you.

Three gates, in `store.tsx`:

- It hangs off the branch where the message **counted as unread**, same as the
  desktop notification, so a thread you are reading never raises one.
- `!viewingRef.current` is the "chat is shut" test, and it has to be separate
  from that branch: reaching there only means you are not reading THIS thread,
  so without it a DM would slide a card over the top of an open panel that is
  already showing its unread pill.
- The popped-out guard, because that window is listening too.

**The dwell timer lives in the store, not in ChatMenu**, and that is
deliberate: ChatMenu renders at desktop widths only, so a card raised on a
phone would otherwise sit in state with nothing to time it out and appear stale
the moment the window was widened.

It has its own on/off (`peek` in `team_chat_prefs`) rather than riding the
`alerts` level, because the two cover different moments and someone can
reasonably want one without the other. They share the preview-or-sender-only
choice, though: a card in your own window is if anything MORE likely to be read
over your shoulder than a corner toast. `alerts: 'off'` means "no desktop
notification", not "no privacy", so the peek resolves it to sender-only rather
than to the full preview.

The pure rules are exported (`mergePeek`, `peekDwell`, `peekBody`, `peekTitle`)
for the same reason the popout's are: this package has no test runner, and the
merge rule is the part that goes quietly wrong.

---

## Claude in the chat (1.12.0)

Staff can message **Claude**, or @mention it in the Team room, to ask about
projects, orders, customers and prices. The answer is posted back into the same
thread. Everything about how it answers lives in proof-viewer (migration
`20261013120000_team_chat_assistant.sql`, the `team-chat-assistant` edge
function); this package only has to recognise it.

Claude is a real row on `proofs.profiles`, because every chat table references
profiles, flagged `is_bot`. `team_roster()` returns that flag, and lists the bot
**only while the assistant is switched on** (Admin → AI drafts), so nobody is
offered a DM pill that would never be answered. The panel reads it as
`TeamMember.isBot`:

- **No presence dot.** Claude never tracks presence, so the usual grey dot would
  say "offline" about something that is always available. Its thread pill
  carries a spark instead.
- **An "AI" tag** beside its name, and a spark avatar instead of initials, so a
  reply in the room reads as the assistant's, not a colleague's.
- **Its own empty state and placeholder** in a DM, saying what it is for and that
  it cannot change anything.

Its typing indicator needs nothing new: the edge function broadcasts `typing` on
the shared `team-chat` topic with `userId` = the bot's id and `to` = the asker on
a DM, exactly the payload a person's composer sends.

⚠ `isBot` is read as a literal `true` only. A roster from a database that
predates the migration has no such column, and its rows must read as people.

---

## Ink & Paper, and the sync fixes (1.13.0)

Proof-viewer moved every staff page to one design language in October 2026
("Ink & Paper": cream paper, ink controls, one coral for counts and nothing
else, mono labels) and the chat was the one surface left behind. With Claude
in it the chat was about to get far more use, so it was redrawn to that
language in every app at once, and the sync faults that had been reported as
"sometimes chats don't update" were found and fixed in the same change. The
design canvas is linked from proof-viewer's PR.

**What changed on screen.**

- **One header per conversation** (who, their state, search, the ⋯ menu, and
  one placement-specific control the host passes in: close, undock, back)
  replaces the presence strip and the row of five placement icons. Every
  "where does chat live" choice (the full page, dock, pop out, keep open)
  and every setting (sounds, desktop alerts, the peek, your status) sits in
  the ⋯ menu, which is the same in the dropdown, the dock, the popout and
  the page. The host supplies the placement items as `placementItems`
  (`ChatPlacementItem[]`) and the trailing control as `headerAction`.
- **Conversations as chips** under the header (ink when open), or, on the
  full page at 760px and up, a **list beside the thread** with the last
  message, its time and an unread count per row. Below 640px the page is a
  phone: the list and the thread take turns, with a back button.
- **Every message on the left**, your own included, with the avatar and the
  name carrying the identity: no bubbles, no per-person tint. A second
  message from the same person within five minutes drops the name and shows
  its time in the gutter on hover. One hover toolbar top right (react,
  mention, copy, delete). Day dividers in the mono label style, and a single
  coral **New** rule above the first message you have not read, placed when
  the thread opens and removed when you next send.
- **Claude is drawn as Claude**: a spark avatar and a cyan AI tag, a header
  line saying it only reads, an empty state with four example questions, and
  a "Claude is looking…" row driven by the typing broadcast the function
  already sends. `.pd-chat__bot-tag` and `.pd-chat__bot-avatar` keep their
  names (proof-viewer's e2e reads them).
- **The header control is a nav item**: 32px, 8px corners, the same hover
  and pressed paper as the chrome's own items, with the room count in the
  nav's coral and a count that is for you in the deeper red. ⌘⇧C opens it.
- **The composer is one pill field** (44px, growing to a few lines) with the
  clip and an ink send inside it. The helper line is gone; the typing line
  holds its height whether or not anyone is typing, so nothing moves.

**What changed underneath.** Four faults in `store.tsx`, each hiding until
two things happened together, which is why they read as random:

1. A resync's merge kept only rows **older** than the fetched window's
   start, so a message that arrived live while the fetch was in flight was
   thrown away and stayed missing until the next resync. The merge now keeps
   rows newer than the window's newest too, de-duplicated by id, and the
   INSERT handler updates `messagesRef` synchronously so a row not yet
   rendered cannot be merged away.
2. A resync asked for during a resync (a focus resync and a socket rejoin at
   the same moment) was dropped. `syncAgainRef` runs it once more, after.
3. A mounted panel counted as "looking": a pinned dropdown or a docked card
   in a background tab stamped every arriving message seen, so it was never
   unread, never chimed, never raised a desktop alert, and never showed as
   new on return. `isLooking()` is `viewingRef && !document.hidden`; the
   resync on return stamps the open thread if it picked up unread meanwhile.
4. Nothing noticed a socket that died without a status callback while the
   tab stayed visible. `probeNewest()` asks for the newest row every 90s
   while visible and resyncs if it is not one we hold.

Version drift was checked and ruled out: all four apps pinned v1.12.0. The
database (publication, replica identity, the select policy) was verified on
live and is not a cause.

---

## Send later (1.14.0)

Rob, 13 October 2026: "Can we add the ability to send a timed message. Send
later?" A message written now and delivered at a chosen time, in the room or
a DM, from any of the four apps.

**On screen.** A clock in the composer's field, beside the clip, opens a
small card above it: the quick choices (in an hour; this afternoon while it
is still an hour away; tomorrow morning; Monday morning when that is neither
tomorrow nor a week off) and a time of your own. The earliest is the next
whole minute at least a minute away, the latest a year. A waiting message
sits in a strip between the thread and the composer (only once there is
one, so a thread with nothing scheduled looks exactly as it did), with its
time ("Tomorrow at 09:00", then "Sending now" once due), its words, and
**Send now / Edit / Cancel**. Edit puts the words back in the composer with
the files carried, ringed on the strip and named in a banner over the field;
the row stays where it is until Save (Enter, or the tick where send was),
Send or a new time replaces it, so abandoning an edit loses nothing. The
labels re-read themselves on a 30-second clock, so "Tomorrow" becomes
"Today" overnight without a reload.

**Underneath.** The waiting room is `proofs.team_scheduled_messages`
(migration `20261013170000`, proof-viewer): a row is readable, cancellable
and nothing else by its author, behind the staff gate, and an every-minute
pg_cron job (`proofs-send-scheduled-messages`, plain SQL, no HTTP) moves
every due row into `team_messages`. The reasons it is a table of its own
rather than a future-dated message, in the migration's header: everything
that happens when a message lands hangs off the INSERT into `team_messages`
(the author stamp, the DM and mention pushes, Claude's answer, the realtime
arrival every open panel listens for), so a row written early with a "not
yet" flag would fire all of them early. Delivery and cancellation are both
`DELETE … RETURNING`, so whoever deletes the row first owns it and "Send
now" cannot race the cron into two copies. A delivered row leaves the strip
the moment it goes: the author's own message arriving by realtime, while
something of theirs is due, triggers a re-read, and a timer at the soonest
`send_at` (then every 15 s while anything is overdue) covers a dead socket.

The store gained `scheduled`, `scheduledSupported`, `scheduleSend`,
`cancelScheduled` (its `removed: false` means the cron got there first,
which the panel reads as "sent", never as a failure) and `sendScheduledNow`,
and its one insert is now `postMessage`, shared by `send` and the send-now
path, which posts on the row's own recipient rather than the thread on
screen. `scheduledSupported` goes false when the database answers that the
table does not exist (42P01 / PGRST205), so a host on a database without the
migration shows no clock and no strip rather than offering a time it cannot
keep. The pure rules (presets, the earliest minute, the labels, the
`datetime-local` conversions) are `src/chat/later.ts`, exported for a host
to test.

---

## The contract

Everything host-specific arrives through `ChatConfig`. `src/chat/types.ts` is authoritative.

```tsx
import { TeamChatProvider, ChatMenu, ChatPopoutHost } from '@plasma/chrome/chat';

<TeamChatProvider
  config={{
    client: supabase,          // the ROOT client, not a schema-scoped one
    userId: session?.user.id ?? null,
    isAdmin: role === 'admin',
    storagePrefix: 'pv:chat',  // per app; namespaces storage and the popout window
    fullPagePath: '/chat',     // where THIS app mounts the chat page
    popoutEnabled: true,
    dockEnabled: true,         // only proof-viewer has a rail to dock into
  }}
>
  {routes}
  <ChatPopoutHost />
</TeamChatProvider>
```

Three things about that config are load-bearing:

**Pass the root client.** The package derives its own `client.schema('proofs')` for every table and RPC, and uses the root only for `channel()`, `removeChannel()` and `storage`, none of which are schema-scoped. Each app pins its own client to its own schema (`public`, `proofs`, `qr`, `programme`), so a host that passed its pinned client and let the package call `.from()` would resolve against the wrong schema. That is exactly the bug that killed stock's search; deriving the accessor in one place makes it unavailable.

**`storagePrefix` must differ per app.** It namespaces browser storage, but more importantly it names the popout window. Window names are keyed per **browser**, not per origin, and the four apps share one SSO session, so a shared name means pressing "Pop out" in Stock re-uses and navigates the window Proofs already had open.

**`dockEnabled` is a statement about the host, not a preference.** Only proof-viewer has a dashboard rail. A stored `docked` preference is honoured where a dock exists and ignored where it does not, and it is deliberately not cleared, so it still works when the person goes back to the app that can render it. If you set it, put `id={CHAT_DOCK_ID}` on the dock container.

---

## Styling

The panel is drawn in proof-viewer's Ink & Paper language, and `chat.css` is how that travels: the four hosts are Tailwind v4, v4, v3 and none at all, so the panel depends on no host's CSS. Every class is prefixed and scoped under `.pd-chat`, written in both forms (`.pd-chat.pdc-x, .pd-chat .pdc-x`) because the root carries the scope class and a utility on the same element, which a descendant combinator never matches. Colours resolve through a three-step fallback: the package's own `--pd-chat-*` override, then the host's `--c-*` token if it has one, then proof-viewer's literal. Proof-viewer and stock-control keep tracking their design system for free; vCard Studio, which has no tokens, renders correctly anyway.

Since 1.13.0 the stylesheet is **named parts** (`pd-chat__head`, `pd-chat__chip`, `pd-chat__msg`, `pd-chat__field`, and so on) plus a short list of layout utilities. The old mechanically ported utility layer is gone with the design it carried. The rule stays: this is not a framework and must not grow into one. New work adds a named part, not a utility.

Presence colours map to the kit's tones (online = done, idle = theirs, away = paused, busy = need); the assistant's cyan is its own, so it reads as neither a person's colour nor a state. The font is IBM Plex Sans with Geist Mono for numbers and labels; a host that has not loaded them gets the system stacks.

To theme it, set the overrides anywhere above the panel:

```css
.pd-chat { --pd-chat-brand: #0055ff; }
```

---

## What the database needs

Three migrations, all in the proof-viewer repo:

- `20260904130639_staff_gate_team_chat.sql` — **apply this first, and independently of everything else.** The room's SELECT policy had no staff gate, so any of the 8 non-staff accounts on the project could read all 60 room messages and post into the room. That was survivable only while no customer-facing bundle contained chat code, which this change ends.
- `20260904130708_team_chat_prefs.sql` — adds the preference column described above.
- `20261013170000_team_chat_send_later.sql` — the waiting room, its delivery function and the every-minute cron (1.14.0). Without it the chat still works; the clock and the strip simply do not appear.

---

## Releasing a change

`dist/` is committed. So: `npm run build`, commit `dist/`, tag, then move each app's pin. Forgetting the build ships a stale bundle to all four apps at once.

Because the chat and the chrome share a repo, a chat change moves the chrome's tag too. That is the accepted cost of not having a second package to create, pin and remember. It makes the package's existing rule stricter, not looser: **add props, never rename them**, or a release has to land in four repos at once.
