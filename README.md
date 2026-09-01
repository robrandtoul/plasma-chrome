# `@plasma/chrome`

One navigation chrome, shared by the four PlasmaDesign staff apps: Proofs (`proofs.`), vCard Studio (`qr.`), Card Programme (`programme.`) and Stock Control (`stock.`). It replaces four bespoke headers and four verbatim copies of `appSwitcher.ts`.

The package ships React components and one stylesheet. It has no runtime dependencies at all. It does not know about Tailwind, react-router, Supabase or lucide, and it never fetches anything: every piece of data arrives as a prop and routing arrives as a component.

The design specification travels with the code in [`docs/handoff/`](docs/handoff/). `docs/handoff/README.md` is the source of truth for measurements and copy, and `docs/handoff/reference/chrome-reference.html` is the static reference page to compare against.

---

## Install

```jsonc
// package.json
"dependencies": {
  "@plasma/chrome": "github:robrandtoul/plasma-chrome#v1.0.0"
}
```

There is no registry. The tag is the version, and upgrading is a deliberate per-app act: move the tag, run the app, look at it.

`dist/` is not committed, so npm builds the package on install through its `prepare` script. That needs the package's devDependencies, which npm installs for a git dependency automatically. Nothing is required of the host beyond having React.

Then import the stylesheet exactly once, at the app entry point, before your own styles:

```ts
// src/main.tsx
import '@plasma/chrome/chrome.css';
import './index.css';
```

One line, no build-step CSS, no PostCSS plugin, no Tailwind config change. The order matters only in that your own sheet should come second, so that a rule of yours can win if you ever need it to.

Peer dependency: `react` at `^18 || ^19`. Both are exercised: the package typechecks against `@types/react` 18 and 19, and uses no React 19 only API.

---

## Use

```tsx
import { Chrome } from '@plasma/chrome';

<Chrome
  apps={apps}                      // your own my_apps() result, mapped
  currentApp="proofs"
  nav={nav}                        // already filtered for role and flags
  activeNavId="orders"
  mobileTabIds={['dashboard', 'orders', 'chat', 'activity']}
  user={user}
  linkComponent={NavLink}
  search={{ value, onChange: setValue, placeholder: 'Search orders' }}
  chatUnread={3}
  notificationsUnread={1}
  accountLinks={{ notifications: '/settings/notifications', feedback: '/feedback' }}
  onEditProfile={() => navigate('/settings/profile')}
  onSignOut={signOut}
/>
```

The chrome is sticky and full bleed. Render it above your page content, not inside your `max-w` container.

Also exported, for the rare host that needs a piece rather than the whole: `SwitcherStrip`, `HeaderBar`, `AppMenu`, `AccountMenu`, `MobileChrome`, `Toggle`, the `useDismissable` and `useAppsVisible` hooks, and the cookie helpers `APPS_COOKIE`, `readAppsCookie`, `writeAppsCookie`, `defaultAppsVisible`. Prefer `Chrome`. The parts are exported so the demo can pose them, not because assembling your own bar is supported.

---

## `ChromeProps`

`src/types.ts` is authoritative. This table is it, in prose.

| Prop | Type | Required | What it does |
| --- | --- | --- | --- |
| `apps` | `ChromeApp[]` | yes | Every app this person holds a role on, in `my_apps().sort_order`. Drives the strip, the app menu and the mobile account sheet. Below two entries the strip does not render at all, whatever the preference says. |
| `currentApp` | `string` | yes | Matched against `ChromeApp.app` to find the current entry. Its `role` becomes the strip's role label. |
| `appName` | `string` | no | The name shown in the header and the mobile title. **Pass it.** Omitted, it is derived from the matching `ChromeApp.fullLabel` — which arrives over the network, so the bar shows the raw registry key (`programme`, `proofs`) until the app list lands, and for good if `my_apps()` fails. |
| `nav` | `ChromeNavItem[]` | yes | The header's destinations, **already filtered** for role and feature flags. The chrome holds no gating logic and never will. |
| `activeNavId` | `string \| null` | yes | The `id` of the item to mark active. The chrome does not read the URL, so highlighting is the host's decision. |
| `mobileTabIds` | `string[]` | yes | Up to four ids resolved against `nav` for the bottom tab bar. More is appended by the chrome. Ignored when `mobileTabs` is supplied; pass `[]` then. |
| `mobileTabs` | `ChromeNavItem[]` | no | The tab set given outright, for the common case where the mobile bar is not a subset of the desktop nav. See below. |
| `user` | `ChromeUser` | yes | Avatar, name, email and role label for the account control and its menu. |
| `linkComponent` | `React.ComponentType<any>` | no | The router seam. Defaults to `'a'`. See below. |
| `search` | `ChromeSearch` | no | A controlled search field. Omit it entirely on screens with nothing to search: the field is not decorative. |
| `actions` | `ReactNode` | no | Page level CTAs, rendered at the far left of the right cluster, before search. |
| `chat` | `ReactNode` | no | A whole chat control, rendered in the chat position, instead of the chrome's own button. See below. |
| `chatUnread` | `number` | no | Unread count on the chat button. Supplying this (or `chatMentionUnread`, or `chat`) is what makes the button appear; `0` shows the button with no badge. |
| `chatMentionUnread` | `number` | no | Mentions, used for the button's accessible label. |
| `notifications` | `ReactNode` | no | A whole notifications control, rendered in the bell position, instead of the chrome's own button. Same contract as `chat`. |
| `notificationsUnread` | `number` | no | Same contract as `chatUnread` for the bell. Omit both this and `notifications` and there is no bell. |
| `appsVisible` | `boolean` | no | Controlled preference. Omit it and the chrome owns the cookie itself, which is what you want in an app. |
| `onAppsVisibleChange` | `(next: boolean) => void` | no | Called on every change, controlled or not. Useful for mirroring the preference into a profile column. |
| `onSignOut` | `() => void` | yes | The one sign out in the product. It is only ever in the account menu, never on the bar. |
| `onEditProfile` | `() => void` | no | Renders the Edit profile row. Omit it and the row is not rendered. |
| `accountLinks` | `ChromeAccountLinks` | no | Hrefs for the Notifications and Feedback rows. A row with no href is not rendered, so an app with no feedback page does not get a dead menu item. |
| `accountActions` | `ChromeAccountAction[]` | no | Extra account menu rows that run a handler rather than navigate, placed after the specified rows and before sign out. Keep the list short. |
| `variant` | `'full' \| 'switcher-only'` | no | Defaults to `'full'`. See below. |
| `tabBarPosition` | `'absolute' \| 'fixed'` | no | Defaults to `'absolute'`. Pass `'fixed'` when your app scrolls the **document** rather than an inner frame. See below. |

Supporting types:

```ts
interface ChromeApp {
  app: string;          // 'proofs' | 'qr' | 'programme' | 'stock'
  label: string;        // short, for the strip: Proofs, vCards, Programme, Stock
  fullLabel: string;    // for the header and the app menu: vCard Studio
  description: string;  // one line, for the app menu row
  url: string;          // absolute, another origin
  role: string;         // this person's role in that app
}

interface ChromeNavItem {
  id: string;
  label: string;
  href: string;
  badge?: number;       // shown as 9+ above nine; falsy or zero hides it
  end?: boolean;        // exact match highlighting, forwarded to linkComponent
  onClick?: (e: MouseEvent<HTMLElement>) => void;  // for a host with no router
}

interface ChromeUser {
  name: string;         // full name; the bar shows the first word only
  email: string;
  initials: string;
  colour: string;       // any CSS colour, used as the avatar background
  avatarUrl?: string | null;
  roleLabel: string;
}

interface ChromeSearch {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  onPalette?: () => void;   // renders the Cmd-K badge and the collapsed icon button
}

interface ChromeAccountLinks {
  notifications?: string;
  feedback?: string;
}

interface ChromeAccountAction {
  id: string;
  label: string;
  onClick: () => void;
}
```

### Props beyond the original specification

`ChromeProps` in `docs/handoff/README.md` does not have `mobileTabs`, `chat`, `accountLinks`, `accountActions`, `notifications`, `tabBarPosition` or `appName`. Each was added because the specification asks for something its own prop list cannot express, and each is commented at its declaration in `src/types.ts` with the reason. In short:

- **`mobileTabs`** exists because `mobileTabIds` can only be resolved against `nav`, and the specified mobile bars are not subsets of the desktop navs. Every app is asked for a Chat tab, but rule 4 makes chat a right cluster icon button rather than a destination; Proofs is asked for an Activity tab, which is a route with no nav item. Supply `mobileTabs` to give the bar outright. Omit it and ids are resolved against `nav` as originally described.
- **`chat`** is the slot the migration promises proof-viewer, whose `ChatMenu` owns a realtime subscription and must not be reimplemented here. Pass the whole control and the chrome puts it in the chat position. Omit it and the chrome draws its own button from the counts.
- **`accountLinks`** carries the hrefs for the Notifications and Feedback rows. The specification names three account menu rows but declares a handler for one of them, which would leave the other two unreachable in an app that has those pages.
- **`accountActions`** carries account menu rows that run a handler instead of navigating. Stock Control forced it: the migration moves its change password control into the account menu, and change password there is a modal, not a route. Routing it through `onEditProfile` would have put a row labelled Edit profile in front of a password dialog.
- **`notifications`** is the bell's equivalent of `chat`, and for the same reason. The migration passes Stock Control's `NotificationsToggle` through "as slots" alongside `ChatMenu`, but the declared prop was a number. That bell owns a per device push subscription and its own popover; a number would have drawn a dead duplicate next to the real control.
- **`tabBarPosition`** exists because the package had silently assumed every host locks its frame to the viewport. See below.
- **`appName`** exists because the header derived the app's own name from `apps`, which every host fetches asynchronously. The bar read the lowercase database key on every first paint, and permanently whenever the fetch failed. An app knows its own name; it should not learn it over the network.

`ChromeNavItem.onClick` is a fourth addition of the same kind. The migration's option B for a host with no router is a nav array "with `href="#"` and an `onClick`", and says "the chrome does not care" — but `NavLinkish` forwarded `href`, `aria-current` and `end` and nothing else, so the click did nothing. It is forwarded now, to the default plain `<a>` as well as to a supplied `linkComponent`. The host owns the `preventDefault`.

---

## The `linkComponent` seam

The chrome renders navigation with whatever component you hand it, and it never imports a router:

```tsx
const Comp = linkComponent ?? 'a';
<Comp className={...} href={item.href} aria-current={active ? 'page' : undefined} />
```

Three of the four apps pass react-router's `NavLink`, which accepts `to` **and** `href`, so they pass it directly. Stock Control has no router, passes nothing, and gets a plain `<a>` doing full page navigation, which is correct for it.

**The chrome writes `href`.** A link component that insists on `to` needs a four line adapter at the seam. proof-viewer's `ChromeLink` is the worked example, and `demo/App.tsx` has a runnable copy of the same shape:

```tsx
import { Link } from 'react-router';

/** The chrome writes href; Link wants to. */
export function ChromeLink({ href, end, ...rest }: { href?: string; end?: boolean }) {
  void end;                                  // meaningless to a plain Link
  return <Link to={href ?? ''} {...rest} />;
}

<Chrome linkComponent={ChromeLink} ... />
```

Two details worth knowing:

- `end` is forwarded **only** when you supplied a `linkComponent` and the item declares it, because a bare `<a>` has no use for it and React would warn about an unknown DOM attribute.
- The switcher strip and the app menu rows are always plain `<a>` elements regardless of `linkComponent`. They point at other origins, and there is no client route to another app's domain.

---

## `variant="switcher-only"`

```tsx
<Chrome variant="switcher-only" apps={apps} currentApp="programme" nav={[]} activeNavId={null} mobileTabIds={[]} ... />
```

Renders the strip and nothing else: no header bar, no nav, no mobile chrome. It exists for the signed in but no role screen. Whoever lands there is usually staff of another app who followed a link, and a dead end with no way back is exactly the confusion the strip exists to end. Card Programme has this screen today and it must keep it.

The strip renders at every width in this mode, including on a phone, because it is the only way out.

---

## The `appsVisible` preference

One boolean decides between the two chrome heights: the ink switcher strip above the header bar, or no strip and an app menu behind the header's app name.

**It is stored in a cookie, never in `localStorage`.** The four apps are four origins, so `localStorage` would give each of them an independent setting, which is worse than having none: a person would turn the strip on in Proofs and find it off in Stock.

```
pd_chrome_apps=1; Domain=.plasmadesign.co.uk; Path=/; Max-Age=31536000; SameSite=Lax; Secure
```

The name is exported as `APPS_COOKIE`. The cookie sits beside the SSO session on the parent domain, so it follows a person across all four apps.

**Default:** on at three or more apps, off at two. People who cross apps are shown the door before they go looking for it; people who do not are not charged 38px for a switcher they use monthly. Below two apps the strip does not render at all, whatever the cookie says, and there is nothing to switch to.

**Two controls, one value.** The app menu row reads as "keep this open", which is where someone discovers the strip. The account menu row reads as a setting, which is where they go to undo it. Both write the same cookie.

The value is read synchronously in `useState`'s initialiser, not in an effect, so the chrome never flickers between its two heights on load.

### Caveat: it will not persist in local development

A cookie with `Domain=.plasmadesign.co.uk` cannot be set from `localhost`, and `Secure` rules out plain http anyway. The browser drops the write silently. So on a dev server the toggle moves, the chrome re-renders, and the setting is gone on reload. That is expected and is not worth working around: the write is deliberately scoped to the one domain where the four apps can share it.

If you need to exercise a particular state locally, drive it from the host instead:

```tsx
const [appsVisible, setAppsVisible] = useState(true);
<Chrome appsVisible={appsVisible} onAppsVisibleChange={setAppsVisible} ... />
```

Supplying `appsVisible` makes the chrome fully controlled and it stops touching the cookie. That is also the route to backing the preference with a profile column: seed from `readAppsCookie()`, reconcile with your own store, and own the value yourself.

---

## `--pd-chrome-height`

The chrome has two heights: **94px** with the strip, **56px** without, plus the iOS status-bar inset on a device that has one. The strip is a per person preference and the inset is a per device one, so the height is not a constant, and nothing below the chrome may treat it as one.

The chrome publishes the current value as a CSS custom property. `chrome.css` declares it on `.pd-chrome`, and `Chrome.tsx` re-declares it on `:root`, because the chrome is a sibling of your page content rather than an ancestor of it and a sticky element elsewhere in the tree cannot inherit it.

**Anything sticky below the chrome must read it:**

```css
.stock-filter-bar {
  position: sticky;
  top: var(--pd-chrome-height);   /* correct */
}
```

```css
.stock-filter-bar {
  position: sticky;
  top: 94px;                      /* wrong: breaks the moment the strip is off */
}
```

Stock Control's stock filter bar and the Proofs sticky admin header both hardcode this today, and both will break on adoption. Grep your repo for `top: 56px`, `top: 94px`, `top-14`, `top-\[56px\]` and their Tailwind equivalents before you ship.

There is exactly one `:root` value, so mount exactly one `Chrome`.

### The safe-area term

The chrome sits at the top of the page, so in a home-screen web app it is what the status bar covers. `chrome.css` declares

```css
:root { --pd-chrome-safe-top: env(safe-area-inset-top, 0px); }
```

pads the bar by it, paints that band white so scrolling content cannot read through behind the clock, and folds it into `--pd-chrome-height` so your sticky offsets stay correct. On anything without a status bar over the page — every desktop browser, and any host that has not set `viewport-fit=cover` — it resolves to `0px` and nothing moves.

The mobile bar is deliberately outside this: it has carried its own `env(safe-area-inset-top)` padding since the reference, and its fixed 54px height would be eaten by a floor set on the variable.

If you meet a platform that under-reports the inset, raise the floor in your own stylesheet rather than forking the package — one line, and it reaches the bar and the offsets together:

```css
:root { --pd-chrome-safe-top: max(env(safe-area-inset-top), 24px); }
```

---

## Mobile tab icons

The bottom tab bar draws each tab's glyph from its `ChromeNavItem.id`, so two apps that
call a destination the same thing get the same picture. The ids with a glyph today:

| id | glyph |
| --- | --- |
| `proofs`, `dashboard` | layers |
| `overview` | panels |
| `orders`, `run` | package |
| `customers` | users |
| `history` | history |
| `chat`, `messages` | speech bubbles |
| `activity`, `notifications` | bell |
| `insights`, `analytics` | bars |

Anything else falls back to the panels glyph. **A bar showing several identical panels is
the smell that says an entry is missing** — add it to `TAB_GLYPHS` in `src/icons.tsx`.
Do not rename a host's nav ids to borrow a glyph: the id is load-bearing for `activeNavId`
matching and `mobileTabIds` resolution, and a semantically false one outlives the person
who chose it.

There is deliberately no per-item icon override. The package inlines its own path data and
takes no runtime dependencies, so an icon prop would mean each host shipping its own SVG
and the four bars drifting apart, which is the drift this package exists to remove.

---

## The mobile tab bar: `tabBarPosition` and `--pd-chrome-tabbar-height`

`chrome.css` positions the bottom tab bar `absolute`, not `fixed`, and says why: iOS pans a fixed bar away from the screen edge when the keyboard opens, and proof-viewer learned that the hard way. `absolute` avoids it by resolving against **the host's viewport locked app frame**.

That frame was an unstated requirement, and only one app has one. proof-viewer's `#app-scroll` owns all the scrolling below `md:`, so `bottom: 0` means the bottom of the screen. Stock Control scrolls the document and has no positioned ancestor at all, so the bar's containing block falls back to the initial containing block: it is painted 100vh down the **page**, looks right at the top and scrolls away with everything else. Measured there before the fix, at `scrollY: 600` the bar sat at `y: 145` instead of `y: 745`.

**If your app scrolls the document, pass `tabBarPosition="fixed"`.** The iOS pan comes back, which is why it is not the default, but a bar that pans briefly beats a bar that is not there.

```tsx
<Chrome tabBarPosition="fixed" ... />   // document scrolls
<Chrome ... />                          // an inner frame scrolls: leave it alone
```

As it turns out, `absolute` is the minority case across the four apps: only proof-viewer
locks its frame. Stock Control, Card Programme and vCard Studio all scroll the document
and all pass `fixed`. The default stays `absolute` anyway, because getting it wrong that
way is a visible bug on one app rather than a silent iOS regression on the one app that
does it properly.

Either way the chrome publishes the bar's height, and nothing may hardcode it:

```css
main            { padding-bottom: var(--pd-chrome-tabbar-height); }
.my-bottom-bar  { bottom: var(--pd-chrome-tabbar-height); }
```

It is `0px` at every width where no tab bar renders — above 768px, and at every width under `variant="switcher-only"` — so both rules above are safe to write unconditionally, with no media query of your own.

---

## What keeps it portable

These are the constraints that let one package serve four apps on three different CSS setups. They are not style preferences.

- **No Tailwind.** The hosts are Tailwind v3, v4, v4 and hand written CSS. Agreeing on a version is what forced the old copy verbatim rule in the first place; depending on none of them is the fix. Every class is prefixed `pd-chrome`, and every visual property is declared outright rather than inherited, because each host reset differs.
- **No router.** Routing is a prop.
- **No data access.** `apps`, `nav` and `user` come in as props. `fetchMyApps.ts` stays in each repo and is already correct there. Only `appSwitcher.ts` is deleted.
- **No feature flags or role logic.** `nav` arrives filtered. If the chrome ever needs to know a role in order to decide what to show, something has gone wrong.
- **One stylesheet, shipped built.** No CSS in the JS bundle, no build step for the consumer.
- **Rules that must beat a host `a:hover` are written two classes deep.** vCard Studio styles bare `a` with a `border-bottom` and will find any rule that is not.
- **No React 19 only APIs**, and no `RefObject` in a public signature: the two `@types/react` majors disagree about what that type means, so `useDismissable` types its refs structurally instead.

Accessibility is part of the contract, not a nicety: both popovers close on outside click and `Escape` and return focus to their trigger, opening one closes the other, `aria-current="page"` marks the active nav item and the current strip link, `role="list"` survives Safari's list semantics bug, icon only controls carry both `aria-label` and `title`, and every transition is disabled under `prefers-reduced-motion`.

---

## Working on this package

```
npm install        # devDependencies only; also runs the build through prepare
npm run typecheck  # tsc over src/ and demo/, no emit
npm run build      # tsc to dist/ plus dist/chrome.css
npm run demo       # the parity harness at http://localhost:5180
```

The build is `tsc` and a file copy. There is no bundler: `tsc` emits ES modules and `.d.ts` files side by side, a small script gives the emitted relative imports their `.js` extension so `dist/` resolves under bundlers and under raw Node ESM alike, and another copies `src/chrome.css` to `dist/chrome.css` unchanged. A bundler would have to be told that React is external, that CSS is not an entry point, and that JSX must stay untransformed for the host's React version, all to produce one fewer file.

`demo/` is a Vite page that rebuilds every section of `docs/handoff/reference/chrome-reference.html` out of the real components, plus a section for the props the static reference cannot show. Open the demo and the reference side by side after any change: a visual difference between them is a real difference. It imports `../src` directly, so there is nothing to build first.

### If you are changing this package

- **Do not add Tailwind, a router, a data client, or an icon library.** If a change seems to need one, it belongs in the host app instead. A dependency here is a dependency in all four apps at once, and it is the thing that stops the fifth app adopting this.
- **Do not add a runtime dependency at all** without a very good reason. There are currently none. `peerDependencies` is React and only React.
- **Colours, sizes and copy live in `src/chrome.css`.** Do not restate a hex value in a component, in this README, or in the demo; a second copy is a second thing to keep in step. `docs/handoff/README.md` holds the reasoning behind the values, including the contrast corrections.
- **Add props, do not rename them.** Four apps upgrade on their own schedule, so a rename is a coordinated release across four repos.
- **`src/types.ts` is a public contract.** Anything optional stays optional.
- **If an app needs a change to be served properly, change the package.** A workaround in the app is the drift this whole exercise exists to remove.
- Tag the release, then bump the four apps one at a time.
