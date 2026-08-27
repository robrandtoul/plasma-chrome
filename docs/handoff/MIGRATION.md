# Migration — four repos, in this order

Read `README.md` first; it holds the full spec. This file is the sequencing and the per-repo detail.

## Order, and why

1. **`plasma-chrome`** — build the package, verified against a scratch React 18 app with no Tailwind.
2. **`proof-viewer`** — adopt first. It has the richest chrome, so it exercises nearly the whole API and its needs shape the last gaps.
3. **`plasmadesign-stock-control`** — adopt second, not last. It is the most different (plain JS, no router, no in-app nav today), so it proves the `linkComponent` seam and the `switcher-only` path early rather than after three apps are already shipped.
4. **`card-programme`** then **`vcard-creator`** — the easy ones once the seams hold.

Do not delete any copy of `appSwitcher.ts` until that app is on the package. The four copies are identical and harmless until then.

---

## 0. `plasma-chrome` (new)

> **Sequencing note.** If you are working from inside a single repo, this package does not exist yet — see `HANDOFF-PROMPTS.md`. The chrome is built as `src/chrome/` inside `proof-viewer` first and extracted here when the second app needs it. The file layout and constraints below are the same either way; only the timing changes.

```
src/
  Chrome.tsx            shell, sticky, exports --pd-chrome-height
  SwitcherStrip.tsx     ink row, rendered only when appsVisible
  HeaderBar.tsx         app identity, nav, right cluster
  AppMenu.tsx           popover, app list, preference row
  AccountMenu.tsx       identity, preference row, rows, sign out
  MobileChrome.tsx      top bar, bottom tab bar, account sheet
  Toggle.tsx
  chrome.css            all pd-chrome-* rules, built to dist
  useDismissable.ts     outside click + Escape + focus return
  useAppsVisible.ts     cookie read/write, default rule
  types.ts
```

- `peerDependencies: { "react": "^18 || ^19" }`. No React 19-only APIs.
- **No Tailwind, no react-router, no Supabase.** If any of those appear in `package.json`, the package has failed its one job.
- **`chrome.css` is supplied** — `reference/chrome.css` in this bundle is the finished stylesheet, prefixed, commented and contrast-corrected. Copy it in as `src/chrome.css`; do not rewrite it from the README tables.
- Ship `dist/chrome.css` as a single import. Consumers add one line; no build-step CSS.
- Publish as a git tag: `github:robrandtoul/plasma-chrome#v1.0.0`.

**Build the markup against `reference/chrome-reference.html`.** It renders every state with the real class names, so each component has an exact target: open it beside your implementation and compare. Class list, in the order you will need them: `pd-chrome`, `pd-chrome--with-strip`, `pd-chrome__strip`, `__strip-brand`, `__strip-mark`, `__strip-wordmark`, `__strip-nav`, `__strip-link`, `__strip-link--current`, `__strip-rule`, `__strip-role`, `__bar`, `__spacer`, `__divider`, `__divider--account`, `__app-wrap`, `__app`, `__app--static`, `__app-mark`, `__app-name`, `__chevron`, `__nav`, `__nav-item`, `__nav-item--active`, `__count`, `__search`, `__search-icon`, `__search-input`, `__kbd`, `__icon-btn`, `__dot`, `__account-wrap`, `__account`, `__account-name`, `__avatar`, `__avatar--lg`, `__panel`, `__panel--apps`, `__panel--account`, `__panel-label`, `__panel-divider`, `__app-row`, `__app-row--current`, `__app-row-mark`, `__app-row-text`, `__app-row-title`, `__app-row-desc`, `__here`, `__identity`, `__identity-text`, `__identity-name`, `__identity-meta`, `__menu-row`, `__signout`, `__pref`, `__pref-text`, `__pref-title`, `__pref-hint`, `__switch`, `__switch--on`, `__switch-knob`, `__mobile-bar`, `__mobile-title`, `__tabs`, `__tab`, `__tab--active`, `__tab-label`.

**Test it against the hardest host first.** A React 18 + plain JS + no-Tailwind + no-router scratch app is the real target — if the package works there, all four repos work. Building it against `proof-viewer` first will silently let Tailwind utilities leak into it.

---

## 1. `proof-viewer` — React 19, Tailwind v4, react-router

**Delete**

- `src/lib/appSwitcher/appSwitcher.ts`
- `src/design/AppSwitcherBar.tsx`
- The whole of `src/design/DesignerHeader.tsx`: the pill strip, `SearchField`, `MobileSearchField`, `UserPill`, `BottomTabBar`, `TabInner`, `AccountSheet`

**Keep**

- `src/lib/appSwitcher/fetchMyApps.ts` — data access stays per-app. Add `fullLabel` and `description` to the mapped row.
- `src/design/PlasmaWordmark.tsx` — still used on the sign-in screen; it just leaves the header.
- `src/design/Sheet.tsx` — the chrome's mobile account sheet can use it, or the package can ship its own.
- `ChatMenu` — pass it through the chrome's chat slot rather than reimplementing it in the package. It owns a realtime subscription.

**Rewire**

- `DesignerChrome.tsx` renders `<Chrome>` in place of `<AppSwitcherBar/>` + `<DesignerHeader/>`.
- Every page currently passes `active`, `role`, `user`, `search`, `actions`, `chatUnread`, `ordersUnread`, `flaggedCount` to `DesignerHeader`. Map those onto `ChromeProps` — a thin `useDesignerChrome()` hook that builds the `nav` array is the cheapest way to avoid touching a dozen page files.
- The `orderingEnabled` gate on Orders and Logbook, and the `role === 'admin'` gate on Admin, move into that hook. **The chrome takes an already-filtered nav array** — it holds no feature-flag logic.

**Behaviour changes to make deliberately**

- `useScrolled` and the condense-on-scroll behaviour go. Rule 6. `useScrolled` may have other callers — check before deleting the file.
- The `⌘K` badge keeps calling `openCommandPalette()`; wire it through `search.onPalette`.
- Nav labels are unchanged: Dashboard, Orders, Logbook, Flagged, Quote, Admin. The internal id `proofs` for Dashboard stays — renaming it churns a dozen files for nothing.

**Watch for**

- The sticky admin header in `AdminLayout` sits below the chrome and hardcodes its offset. Move it to `top: var(--pd-chrome-height)`.
- Mobile tabs stay Dashboard · Orders · Chat · Activity · More. The Activity tab is a real route (`/activity`), not a sheet — keep it that way.

---

## 2. `plasmadesign-stock-control` — React 18, Tailwind v3, plain JS, no router

**Delete**

- `src/lib/appSwitcher/appSwitcher.ts`
- `src/components/AppSwitcherBar.jsx`
- The header block in `src/components/Dashboard.jsx` (around lines 1329–1434)

**Keep**

- `src/lib/appSwitcher/fetchMyApps.ts` — including its user-keyed cache. Add the two new fields.
- `ChatMenu.tsx`, `NotificationsToggle.jsx` — pass through as slots.

**The decision this repo forces**

Stock Control has **no in-app nav** because the dashboard is one page of panels; Insights and Admin are view swaps held in `useState`, not destinations. You have two options and must pick one:

- **A.** Make Insights and Admin real destinations (hash routes or a minimal router) so the nav has three items and behaves like the other three apps.
- **B.** Accept that it is a one-page app: the nav array is `[Dashboard, Insights, Admin]` driven by the existing `showInsights` / admin state, with `href="#"` and an `onClick`. The chrome does not care — it renders `linkComponent`, and here that is a `<button>`-like `<a>`.

**B is the smaller change and the honest one.** Take A only if you were already planning to add routing.

**This app also loses the most.** Today its header carries name, `ADMIN`, and five unlabelled icons — Insights, Admin, Chat, bell, key, door. Under the new system: Insights and Admin become nav items, Chat and the bell become the standard icon buttons, and the key (change password) and door (sign out) move into the account menu. That is the fix for finding 04; expect it to feel like a bigger change here than anywhere else.

**Watch for**

- No router means `linkComponent` defaults to `'a'`. This is the case that proves the seam — do it here, early.
- The stock-filter bar under the header (`Dashboard.jsx` ~line 579) is sticky and hardcodes its offset. `top: var(--pd-chrome-height)`.
- Plain JS: the package must be consumable without TypeScript. Ship `.d.ts` files but never require them.

---

## 3. `card-programme` — React 19, Tailwind v4, react-router

**Delete**

- `apps/console/src/lib/appSwitcher/appSwitcher.ts`
- `apps/console/src/components/AppSwitcherBar.tsx`
- The `<header>` block and the `pill` class helper in `apps/console/src/App.tsx`

**Fix, specifically**

The sign-out avatar. Today:

```tsx
<button onClick={() => void signOut()} title={`${email} · sign out`}>
  {initialsOf(email)}
</button>
```

An identity affordance whose only behaviour is ending the session, while the same glyph opens a menu in every other app. It becomes the standard account button; sign out moves into the menu.

**The no-role screen**

`App.tsx` renders `<AppSwitcherBar/>` above `<SignIn notStaff/>` on purpose — whoever lands there is usually staff of another app who followed a link, and a dead end with no way back is the confusion the strip exists to end. Preserve this exactly: `<Chrome variant="switcher-only" apps={apps} currentApp="programme" .../>`.

**Watch for**

- Nav labels are unchanged: Overview, This run, Customers, History, Admin. They lose the uppercase mono treatment and become standard 13.5px sentence-case items.
- The header is deliberately **not** sticky today, with a stated reason. It becomes sticky — rule 6, and consistency across four apps is worth more than that reasoning. Flag it to Rob if the run sheets feel worse for it.
- The Customers-only search field becomes `search` passed conditionally on `pathname === '/customers'`, as now.
- This app has no mobile nav today. It gains the bottom tab bar: Overview · This run · Customers · Chat · More.

---

## 4. `vcard-creator` — React 18, hand-written CSS, no Tailwind, react-router

**Delete**

- `apps/studio/src/lib/appSwitcher/appSwitcher.ts`
- `apps/studio/src/components/AppSwitcherBar.tsx`
- The `<header className="app-bar">`, scrim and drawer blocks in `apps/studio/src/components/AppShell.tsx`
- The entire `.app-bar__*` rule block in `apps/studio/src/index.css` (roughly lines 300–490)

**Keep**

- `StudioMark` — the contact-card glyph. It is used on the sign-in panel. The chrome's app mark is the shared square, so the studio-specific glyph does not appear in the header any more.

**Two content changes**

1. **`Account` stops being a nav destination.** It is currently the last item in `buildNavItems`. Its contents belong in the account menu; the nav becomes Cards, QR codes, Users, Analytics, Settings (plus Deleted for admins).
2. **The full email address leaves the bar.** `rob@plasmadesign.co.uk` in the header is the widest single element in any of the four apps. It moves into the account menu's identity block, where the spec already places it.

**Watch for**

- This repo styles bare `a` with a `border-bottom`, which is why `appSwitcher.ts` writes its hover rules two classes deep. The package's stylesheet needs the same defence: every `pd-chrome-*` rule that could be beaten by a host `a:hover` (specificity 0-1-1) must be written two classes deep. **This is the app that will find those bugs.**
- No Tailwind here at all — the reason the package ships plain CSS.
- Customers also use this app (`isStaff` is false for them, `my_apps()` returns fewer than two entries and the strip renders nothing). The chrome must degrade to the header alone for a customer with one app, exactly as `mountAppSwitcher` returns a no-op below two entries today. Customer nav is My card + Insights; keep it working.

---

## Definition of done

- No file named `appSwitcher.ts` remains in any repo.
- All four apps import the same `@plasma/chrome` version.
- `grep -r "PlasmaWordmark" src/` in each repo returns hits only on sign-in / auth screens.
- Sign out is reachable in exactly one place per app: the account menu.
- Every app has a bottom tab bar under `md:`.
- No sticky element below the chrome hardcodes a pixel offset.
- The preference set in one app is in effect in the other three on next load.
- Keyboard: `Tab` through the whole chrome, `Escape` closes both popovers, focus returns to the trigger, and the focus ring is visible on every control.
- Contrast: no white text on `#ff5b3a` anywhere.
