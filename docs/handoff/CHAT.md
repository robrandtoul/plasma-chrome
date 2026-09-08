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

The panel was styled in Tailwind v4 utilities resolving against proof-viewer's design tokens. The four hosts are Tailwind v4, v4, v3 and none at all, so that could not travel: two apps would have rendered it unstyled.

`chat.css` is the answer, and it follows the same rule `chrome.css` states: depend on no host's CSS. Every class is prefixed and scoped under `.pd-chat`, and colours resolve through a three-step fallback — the package's own `--pd-chat-*` override, then the host's `--c-*` token if it has one, then a literal. Proof-viewer and stock-control keep tracking their design system for free; vCard Studio, which has no tokens, renders correctly anyway.

The conversion was deliberately **mechanical**. Each rule is the declaration Tailwind would have emitted for the class it replaces, so the port was a rename rather than a redesign. Rewriting 1,400 lines of dense panel markup into semantic classes by eye is how a port quietly changes the thing it was supposed to preserve, and nobody would have noticed until the team did.

That means the utility layer is **not a framework** and must not grow into one. It contains the classes this panel uses and nothing else. New work should prefer the semantic `pd-chat__*` classes at the bottom of the file.

To theme it, set the overrides anywhere above the panel:

```css
.pd-chat { --pd-chat-brand: #0055ff; }
```

---

## What the database needs

Two migrations, both in the proof-viewer repo:

- `20260904130639_staff_gate_team_chat.sql` — **apply this first, and independently of everything else.** The room's SELECT policy had no staff gate, so any of the 8 non-staff accounts on the project could read all 60 room messages and post into the room. That was survivable only while no customer-facing bundle contained chat code, which this change ends.
- `20260904130708_team_chat_prefs.sql` — adds the preference column described above.

---

## Releasing a change

`dist/` is committed. So: `npm run build`, commit `dist/`, tag, then move each app's pin. Forgetting the build ships a stale bundle to all four apps at once.

Because the chat and the chrome share a repo, a chat change moves the chrome's tag too. That is the accepted cost of not having a second package to create, pin and remember. It makes the package's existing rule stricter, not looser: **add props, never rename them**, or a release has to land in four repos at once.
