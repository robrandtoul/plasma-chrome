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
| Dropdown size, popout size | browser | Genuinely about the window in front of you. A size chosen on a 27-inch monitor has no business travelling to a laptop. |
| "Am I the popout?" | browser (session) | A question about one tab. |

Every read of the preference column is guarded on the key being **present**, not truthy, and the column is fetched in its own request rather than folded into the profile select. PostgREST rejects an entire select if one named column is missing, so folding it in would mean an app running against a database that predates the migration lost the whole profile row. As written, either deploy order is safe.

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

- `20260904100000_staff_gate_team_chat.sql` — **apply this first, and independently of everything else.** The room's SELECT policy had no staff gate, so any of the 8 non-staff accounts on the project could read all 60 room messages and post into the room. That was survivable only while no customer-facing bundle contained chat code, which this change ends.
- `20260904110000_team_chat_prefs.sql` — adds the preference column described above.

---

## Releasing a change

`dist/` is committed. So: `npm run build`, commit `dist/`, tag, then move each app's pin. Forgetting the build ships a stale bundle to all four apps at once.

Because the chat and the chrome share a repo, a chat change moves the chrome's tag too. That is the accepted cost of not having a second package to create, pin and remember. It makes the package's existing rule stricter, not looser: **add props, never rename them**, or a release has to land in four repos at once.
