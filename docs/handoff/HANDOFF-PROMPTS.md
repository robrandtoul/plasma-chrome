# What to hand Claude Code

Nothing gets moved and no repo gets copied. Every session runs inside one app repo, starting with `proof-viewer`.

## The change to the plan

`MIGRATION.md` assumes the package exists first. Working from inside a single repo, that is the wrong order, so invert it:

1. **Build the chrome inside `proof-viewer`**, in one self-contained folder, and replace that app's header with it.
2. **Extract that folder to `robrandtoul/plasma-chrome`** when the second app needs it, and point proof-viewer at the tag.
3. **The other three apps adopt the tag**, one session each, each inside its own repo.

This costs less than it sounds. Proof-viewer has the richest chrome, so it was always going to shape the API — a package built in isolation would have been designed around it anyway. What you get instead is a real consumer from day one and a browser to check against.

**The risk, stated plainly:** step 2 is the step that gets skipped. If the chrome stays inside proof-viewer, you have spent this effort fixing one app and you still have four bespoke headers and four copies of `appSwitcher.ts`. The whole point was to stop the drift. So step 1 has one non-negotiable requirement: **the folder must be extractable by moving it, with no edits.** The prompt enforces that, and it is the thing to check before you sign off phase 1.

---

## Setup

One thing to do:

Unzip this bundle into the proof-viewer repo at `docs/chrome-handoff/`. That is the only file movement in the whole plan — documentation into the repo that needs it, no repos touched.

```
proof-viewer/
  docs/chrome-handoff/
    README.md
    MIGRATION.md
    HANDOFF-PROMPTS.md
    reference/chrome.css
    reference/chrome-reference.html
    screenshots/
    prototype/
    before/
```

Then start Claude Code inside `proof-viewer` as normal.

Commit it. Later sessions in the other three repos get the same unzip, and having it in git means you are always handing the same spec to each one.

---

## Phase 1 — build the chrome in proof-viewer

Run inside `proof-viewer`.

```
Build the shared navigation chrome specified in docs/chrome-handoff/,
inside this repo, and replace this app's header with it.

Read before writing any code:
  - docs/chrome-handoff/README.md — the full design specification
  - docs/chrome-handoff/reference/chrome.css — the finished stylesheet
  - docs/chrome-handoff/MIGRATION.md — the proof-viewer section lists
    what to delete, keep and rewire, and the traps specific to this app
Open docs/chrome-handoff/reference/chrome-reference.html in a browser.
It renders every state with the real class names and is your acceptance
target for the whole phase.

Build it at src/chrome/ as a self-contained folder that could be lifted
out and published as a package later, without edits. That constraint is
the point of the exercise, so treat these as hard rules inside
src/chrome/:

  - Copy reference/chrome.css to src/chrome/chrome.css UNCHANGED,
    comments included. Do not rewrite, reformat, reorder or modernise
    it. Its comments record why values were chosen. If you think a
    declaration is wrong, say so in your summary rather than editing it.
  - NO Tailwind classes anywhere inside src/chrome/. This repo is
    Tailwind v4 and it will be tempting. Three of the four apps that
    will eventually use this folder are on different Tailwind versions
    or none, which is the entire reason the styling lives in that CSS
    file.
  - NO import of react-router inside src/chrome/. The chrome renders
    whatever `linkComponent` prop it is handed; this app passes NavLink.
  - NO import of Supabase, this app's lib/, or anything else outside
    src/chrome/. Data arrives as props. `apps` comes from the host's own
    fetchMyApps call — keep that file where it is.
  - React 18-compatible only. No React 19-only APIs, even though this
    app is on 19. Two of the four apps are on 18.

Implement the ChromeProps API exactly as declared in README.md,
including variant="switcher-only" and the appsVisible preference (cookie
on .plasmadesign.co.uk, default true at three or more apps).

Match chrome-reference.html's markup exactly — same elements, same class
names, same nesting.

Then wire it into this app, following MIGRATION.md's proof-viewer
section: delete src/lib/appSwitcher/appSwitcher.ts,
src/design/AppSwitcherBar.tsx and all of src/design/DesignerHeader.tsx,
and render <Chrome> from DesignerChrome.tsx instead. Keep
fetchMyApps.ts, adding fullLabel and description to the mapped row. Pass
ChatMenu through as a slot rather than reimplementing it — it owns a
realtime subscription.

Its "Watch for" list is not optional. In particular: the condense-on-
scroll behaviour goes, and the sticky admin header in AdminLayout must
use top: var(--pd-chrome-height) rather than a hardcoded offset, because
the chrome is 94px or 56px depending on a per-user preference.

Do not build the prototype's accent / density / badge-visibility
controls. Those are review affordances, not features.

Run the app and check it against chrome-reference.html side by side.
Then verify extractability explicitly: list every import inside
src/chrome/ that points outside src/chrome/, and every Tailwind class
inside it. Both lists should be empty. If they are not, say so plainly
rather than quietly leaving them.
```

---

## Phase 2 — extract the package

Do this when you are ready to start the second app, not before. If phase 1 kept its discipline this is mechanical, an hour at most.

Create `robrandtoul/plasma-chrome`, then run this inside `proof-viewer`:

```
src/chrome/ in this repo is about to become the shared package
@plasma/chrome, consumed by three other apps.

Prepare it for extraction:
  - Confirm again that nothing inside src/chrome/ imports from outside
    it, and that it contains no Tailwind classes. Fix anything that
    slipped in.
  - Write the package.json it will need: name @plasma/chrome,
    peerDependencies react ^18 || ^19, a build that emits
    dist/chrome.css as a single import, and no dependency on Tailwind,
    react-router or Supabase.
  - Write a README covering the ChromeProps API and the linkComponent
    seam, aimed at someone adopting it in an app with a different CSS
    setup.
  - Copy docs/chrome-handoff/ into the package as docs/handoff/ so the
    spec travels with the code.
  - Add a demo page reproducing every section of
    reference/chrome-reference.html using the React components, so
    future changes can be checked for parity without an app.

Then tell me the exact git commands to move src/chrome/ into the
plasma-chrome repo preserving history, and the change to this app's
package.json and imports to consume it as
"@plasma/chrome": "github:robrandtoul/plasma-chrome#v1.0.0".

Do not delete src/chrome/ from this repo yet — I will do that once the
package builds and this app still runs against it.
```

---

## Phases 3, 4, 5 — the other three apps

One session each, inside that app's repo. Unzip the bundle into `docs/chrome-handoff/` there first, same as before.

**Order: `plasmadesign-stock-control`, then `card-programme`, then `vcard-creator`.** Stock Control goes first of the three because it is plain JS with no router, which is what proves the `linkComponent` seam. vCard Studio goes last because it styles bare `a` with a `border-bottom` and will expose any rule in `chrome.css` that a host `a:hover` can beat.

Template — replace the bracketed name:

```
Adopt @plasma/chrome in this repo, replacing this app's bespoke header
and its copy of the cross-app switcher.

Read first:
  - docs/chrome-handoff/README.md — the design specification
  - docs/chrome-handoff/MIGRATION.md — go to the [REPO NAME] section and
    follow it; it lists what to delete, keep and rewire, and the traps
    specific to this app
Open docs/chrome-handoff/reference/chrome-reference.html in a browser
and match it.

Add the dependency:
  "@plasma/chrome": "github:robrandtoul/plasma-chrome#v1.0.0"
and import its stylesheet once at the app entry point.

Do not restyle anything below the chrome. Do not touch fetchMyApps.ts
beyond adding the fullLabel and description fields — data access stays
per-app on purpose; only appSwitcher.ts is deleted.

MIGRATION.md's "Watch for" list for this app is not optional; those are
the things that break silently.

Check against MIGRATION.md's "Definition of done" before finishing, in
particular:
  - no appSwitcher.ts anywhere in the repo
  - sign out reachable in exactly one place: the account menu
  - no sticky element below the chrome hardcoding a pixel offset — they
    use top: var(--pd-chrome-height)
  - a bottom tab bar exists under md:
  - no white text on #ff5b3a anywhere

If the package needs a change to serve this app, say so and stop rather
than working around it in the app. A workaround here is the drift this
whole exercise exists to remove.
```

For `plasmadesign-stock-control`, add this line to the prompt:

```
Insights and Admin stay useState view swaps behind nav-shaped controls
(MIGRATION.md option B). Do not add a router to this app.
```

---

## Two decisions worth making before you start

**Stock Control's Insights and Admin.** Real routes, or `useState` view swaps behind nav-shaped controls? Option B, the view swaps, is the smaller change and the chrome cannot tell the difference. The line above assumes B; delete it if you want A.

**Card Programme's header is deliberately not sticky today**, with a stated reason in the code. The spec makes it sticky for consistency across four apps. It is the one place the new system overrides an existing considered decision — if you would rather keep it as it is, say so in that session's prompt.

---

## If you would rather use cloud sessions

The plan above works unchanged: every phase runs inside a single repo, which is what a cloud session sees. The only thing you lose is being able to run the apps in a browser, so phase 1's comparison against `chrome-reference.html` becomes a reading exercise rather than a looking one. Given that phase 1 is where the whole design either lands or does not, do that one locally if you can and the rest wherever is convenient.
