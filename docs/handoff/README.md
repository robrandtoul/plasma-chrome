# Handoff: `@plasma/chrome` — shared navigation for the four PlasmaDesign staff apps

## Overview

Four staff apps share one SSO session on `.plasmadesign.co.uk`: Proofs (`proofs.`), vCard Studio (`qr.`), Card Programme (`programme.`) and Stock Control (`stock.`). Today they share exactly one navigation file — `appSwitcher.ts`, copied verbatim into all four repos — and nothing else. Each app then draws its own header, and those four headers have drifted badly: four different nav idioms, four different account treatments, four different mobile answers (two of which are "nothing"), and the brand stated twice within 100px.

**The job:** extract one shared chrome package, adopt it in all four apps, and delete the four bespoke headers along with the four copies of `appSwitcher.ts`.

The design review that produced this brief is bundled as `prototype/Navigation Review.dc.html` — it contains the findings, two design directions, the mobile treatment, and a live prototype of the final chrome with a working preference toggle.

## About the design files

The files in `prototype/` are **design references written in HTML**. They are not production code and should not be copied into the repos. They exist so you can see and click the intended result: hover states, the app menu, the account menu, the preference toggle, and app/destination switching all work.

Your task is to **rebuild this chrome as a real React package** in the four target codebases, following each app's own conventions for routing and data access. Every measurement, colour and piece of copy you need is specified below; the prototype is the tiebreaker if anything here is ambiguous.

## Fidelity

**High fidelity.** Colours, type, spacing, radii and states are final and specified to the pixel below. Values are lifted from the apps' own `design-tokens.css`, so nothing here introduces a new colour into the estate.

The fastest faithful path: **take `reference/chrome.css` as-is** and write the React components against it. It is complete, prefixed, dependency-free and already carries the contrast corrections; the specification tables below then serve as verification rather than as something to translate.

One exception is called out explicitly in **Contrast corrections** — a value in the prototype that is wrong and should NOT be reproduced.

---

## Contrast corrections — read this before you start

The prototype uses `#ff5b3a` (`--c-brand-500`) as the fill behind white text on the active nav item and on count badges. This is what Proofs does today, and it fails WCAG AA:

| Combination | Ratio | Verdict |
| --- | --- | --- |
| `#ffffff` on `#ff5b3a` | 3.07:1 | Fails AA for 13.5px text (needs 4.5:1) |
| `#ffffff` on `#e8421f` (`brand-600`) | 4.03:1 | Still fails |
| `#ffffff` on `#c2301a` (`brand-700`) | **5.63:1** | Passes |
| `#161311` on `#ff5b3a` | **5.36:1** | Passes |

**Build it with `#c2301a` behind white text** — active nav item fill, count badge fill, notification badge fill. Everything else keeps `#ff5b3a`: the 2px strip underline (5.36:1 against ink, non-text needs 3:1), the "HERE" label in the app menu, the toggle track, the active mobile tab glyph and label on `#fff3ee`.

The alternative, if you want to keep the brighter coral on the active pill, is ink text on `#ff5b3a` at 5.36:1. Do not ship white on `#ff5b3a`.

Second correction: the strip's inactive link colour `#a89e92` on `#161311` measures ~6.6:1 and is fine, but `#766b62` (used for the role label) measures ~4.9:1 at 9.5px. Lift the role label to `#a89e92` for consistency with the links.

---

## The system

Six rules. These are the whole point of the exercise — if an implementation detail conflicts with one of these, the rule wins.

1. **Two surfaces, not four.** Ink `#161311` for anything estate-level, white `#ffffff` for the app. Cream `#fbf7f0` remains the page canvas below the chrome. No third warm neutral inside the chrome. (Today's strip is `#ece5d8` on a `#fbf7f0` canvas with `#ffffff` tabs — three neutrals inside 5% lightness of each other.)
2. **One accent, for state only.** Coral for the active destination and unread counts; `#e8421f` for focus rings. Per-app colours (coral/purple/orange/teal) are **removed entirely** — this is a deliberate decision, not an oversight. Colour now means "state", never "identity".
3. **One nav-item shape everywhere.** 32px tall, 8px radius, IBM Plex Sans 13.5px/500. Identical in all four apps. (Today: 36px coral pills, 26px uppercase mono pills, bare text links, and no nav at all.)
4. **A fixed right-cluster order.** Page actions → search → chat → notifications → account. Always that sequence, always those shapes. **Sign out lives only inside the account menu**, never on the bar.
5. **The name is said once.** The mark carries the brand; the header carries the app name in sentence case, once. No tagline, no `PLASMADESIGN` under a product name, no second casing of the same word.
6. **Sticky, and nothing else.** The chrome sticks in all four apps and does **not** condense, resize or animate on scroll. Proofs' `useScrolled` condense behaviour is removed.

---

## Anatomy

The chrome is **one component with an optional layer**. There is no second layout.

```
┌──────────────────────────────────────────────────────────┐
│  switcher strip · 38px · #161311 · only when appsVisible  │
├──────────────────────────────────────────────────────────┤
│  header bar · 56px · #ffffff                             │
└──────────────────────────────────────────────────────────┘
```

Total chrome height: **94px** with the strip, **56px** without. Both are sticky. Nothing below may assume a constant — see **The `appsVisible` preference**.

### Shell

| Property | Value |
| --- | --- |
| Position | `sticky`, `top: 0`, above page content |
| Horizontal padding | `0 22px` (both rows) |
| Gap between bar groups | `14px` |
| Header bar background | `#ffffff` |
| Header bar bottom border | `1px solid #ece4d3` |
| Max content width | none — the chrome is full-bleed; the page content below keeps its existing `max-w-[1280px]` |

The bar's real minimum width is about **1220px** with a six-item nav plus search. Below that, drop the search field to an icon button first, then let the nav scroll horizontally. Do not let nav items shrink — they are `white-space: nowrap` with fixed padding and will overlap the search field.

### Switcher strip (rendered only when `appsVisible`)

| Element | Spec |
| --- | --- |
| Row | height `38px`, background `#161311`, `align-items: stretch` |
| Mark | `15×15px`, radius `4px`, background `#ffffff` |
| Wordmark | text `PlasmaDesign`, IBM Plex Mono `9.5px`/500, letter-spacing `0.16em`, uppercase, `#a89e92`, `gap: 9px` from mark, `padding-right: 20px` |
| App link | IBM Plex Sans `12.5px`, letter-spacing `0.005em`, `padding: 0 14px`, full row height, `white-space: nowrap` |
| — current | colour `#ffffff`, weight `600`, plus a 2px underline |
| — current underline | `position: absolute; left: 14px; right: 14px; bottom: 0; height: 2px; border-radius: 2px 2px 0 0; background: #ff5b3a` |
| — other | colour `#a89e92`, weight `400`; hover `#ffffff` |
| Role label (far right) | IBM Plex Mono `9.5px`/500, letter-spacing `0.14em`, uppercase, `#a89e92` |

Labels in the strip are **short**: `Proofs`, `vCards`, `Programme`, `Stock`. The full name is stated once, in the header below.

No dots. No tab shapes. No cream. The strip is a different surface, not a different shade of the same one.

### Header bar — app identity (left)

Two modes, driven by the preference:

**Menu mode** (`appsVisible === false`) — the app name is a button that opens the app menu.

| Element | Spec |
| --- | --- |
| Button | height `38px`, padding `0 10px 0 8px`, radius `9px`, background transparent; hover `#f4ede0`; open `#f4ede0` |
| Mark | `26×26px`, radius `7px`, background `#161311`, colour `#ffffff`, IBM Plex Mono `11px`/600, app initial |
| Name | IBM Plex Sans `14.5px`/600, letter-spacing `-0.01em`, `#161311`, nowrap |
| Chevron | `7×7px`, `border-right`/`border-bottom` `1.6px solid #766b62`, `rotate(45deg)` closed, `rotate(225deg)` open, `margin: -3px 2px 0 2px` |
| Gap | `10px` |

**Label mode** (`appsVisible === true`) — the apps are already listed above, so the menu is redundant and the app name reverts to a plain label. **The chevron is not rendered.** This is the only structural difference between the two modes.

| Element | Spec |
| --- | --- |
| Mark | `28×28px`, radius `8px`, background `#161311`, colour `#ffffff`, IBM Plex Mono `11px`/600 |
| Name | IBM Plex Sans `15.5px`/600, letter-spacing `-0.015em`, `#161311` |

Both modes are followed by a `1px × 24px` `#ece4d3` divider.

### Header bar — nav

| Element | Spec |
| --- | --- |
| Nav row | `display: flex; gap: 3px` |
| Item | height `32px`, padding `0 13px`, radius `8px`, IBM Plex Sans `13.5px`/500, letter-spacing `-0.005em`, `white-space: nowrap`, `gap: 7px` |
| — active | background `#c2301a`, colour `#ffffff`, `aria-current="page"` |
| — inactive | background transparent, colour `#3d342d`; hover background `#f4ede0` |
| Count badge | `min-width: 17px`, height `17px`, padding `0 4px`, radius `999px`, IBM Plex Mono `10px`/600, `line-height: 1` |
| — on active item | background `rgba(255,255,255,0.3)`, colour `#ffffff` |
| — on inactive item | background `#c2301a`, colour `#ffffff` |

Counts show as `9+` above 9.

### Header bar — right cluster

Fixed order, then a `1px × 24px` `#ece4d3` divider with `margin: 0 3px`, then the account control.

**Search field** (omit entirely on screens that have nothing to search)

| Property | Value |
| --- | --- |
| Box | width `240px`, height `32px`, padding `0 11px`, radius `8px`, border `1px solid #ece4d3`, background `#fbf7f0`, `gap: 8px` |
| Placeholder | IBM Plex Sans `12.5px`, `#837868` |
| Shortcut badge | IBM Plex Mono `10px`, `#837868`, letter-spacing `0.06em`, content `⌘K` — a real button that opens the command palette |
| Focus-within | border `#ff5b3a`, plus `outline: 2px solid #e8421f; outline-offset: -1px` |

**Icon buttons** (chat, notifications)

| Property | Value |
| --- | --- |
| Button | `32×32px`, radius `8px`, background transparent; hover `#f4ede0` |
| Icon | 18px lucide glyph, stroke `1.5px`, colour `#3d342d` |
| Notification badge | `min-width: 14px`, height `14px`, padding `0 3px`, radius `999px`, background `#c2301a`, colour `#ffffff`, IBM Plex Mono `9px`/600, `box-shadow: 0 0 0 2px #ffffff`, positioned `top: 4px; right: 4px` |

**Account button**

| Property | Value |
| --- | --- |
| Button | height `32px`, padding `0 10px 0 4px`, radius `8px`, `gap: 8px`, transparent; hover and open `#f4ede0` |
| Avatar | `24×24px`, circle, IBM Plex Mono `10px`/600, white text on the user's assigned colour, or their photo |
| Name | first name only, IBM Plex Sans `13px`, `#3d342d` |
| Chevron | `6×6px`, `1.5px solid #837868` borders, `rotate(45deg)` / `rotate(225deg)` |

### App menu popover (menu mode only)

| Property | Value |
| --- | --- |
| Panel | `top: 46px; left: 0`, width `296px`, padding `7px`, radius `12px`, background `#ffffff`, border `1px solid #ece4d3` |
| Shadow | `0 24px 64px rgba(22,19,17,0.18), 0 2px 6px rgba(22,19,17,0.08)` |
| Section label | text `Your apps`, padding `8px 10px 9px`, IBM Plex Mono `9px`/500, letter-spacing `0.14em`, uppercase, `#837868` |
| Row | padding `9px 10px`, radius `8px`, `gap: 11px`; hover `#f4ede0`; current row background `#fbf7f0` |
| Row mark | `26×26px`, radius `7px`; current `#161311`/`#ffffff`, other `#f4ede0`/`#766b62` |
| Row title | IBM Plex Sans `13.5px`, weight `600` current / `500` other, `#161311` |
| Row description | IBM Plex Sans `11.5px`, `#766b62`, `margin-top: 1px` |
| "Here" marker | IBM Plex Mono `9px`/500, letter-spacing `0.1em`, uppercase, `#ff5b3a` |
| Divider | `1px` `#f4ede0`, `margin: 6px 10px` |
| Preference row | text `Keep apps visible` + switch, padding `9px 10px 10px` |

App descriptions, exactly as written:

| App | Short label | Full name | Description |
| --- | --- | --- | --- |
| `proofs` | Proofs | Proofs | Proof approvals, orders, logbook |
| `qr` | vCards | vCard Studio | Digital cards and QR codes |
| `programme` | Programme | Card Programme | Membership card runs and credits |
| `stock` | Stock | Stock Control | Materials, production, dispatch |

Order comes from `my_apps().sort_order`, as it does today.

### Account menu

The single answer to finding 04 — today sign out is a purple text link, a hidden menu item, an unlabelled door glyph, and (in Card Programme) **the avatar itself**.

| Property | Value |
| --- | --- |
| Panel | `top: 40px; right: 0`, width `288px`; same shell, radius, border and shadow as the app menu |
| Identity block | padding `10px 10px 12px`, `gap: 11px`; avatar `32×32px`; name IBM Plex Sans `13.5px`/600 `#161311`; meta `11.5px` `#766b62`, format `email · Role` |
| Divider | `1px` `#f4ede0`, `margin: 0 10px 6px` |
| Preference row | padding `10px`, radius `8px`, background `#fbf7f0`, hover `#f4ede0`; title `13px` `#161311`; hint `11.5px` `#766b62`, `margin-top: 2px` |
| Menu rows | `Notifications`, `Edit profile`, `Feedback` — padding `9px 10px`, radius `8px`, `13px` `#3d342d`, hover `#f4ede0` |
| Divider | `1px` `#f4ede0`, `margin: 6px 10px` |
| Sign out | `13px`/500, `#d11e3d`, hover background `#fcd0d6` |

Preference hint copy: `A strip lists all four, always` when on, `Switch from the app menu instead` when off.

### Toggle switch

| Property | Value |
| --- | --- |
| Track | `32×19px`, radius `999px`; on `#ff5b3a`, off `#dcd2c0` |
| Knob | `15×15px`, circle, `#ffffff`, `top: 2px`; `left: 15px` on, `left: 2px` off |
| Knob shadow | `0 1px 2px rgba(22,19,17,0.3)` |
| Transition | `left 0.16s ease, background-color 0.16s ease`; none under `prefers-reduced-motion` |

---

## Mobile

Both design directions converge here, so there is one mobile treatment. Proofs already has most of it (`BottomTabBar`, `AccountSheet`) and is the best starting point.

**Top bar**

| Property | Value |
| --- | --- |
| Row | height `54px`, padding `0 14px`, `gap: 10px`, background `#ffffff`, border-bottom `1px solid #ece4d3` |
| Mark | `28×28px`, radius `8px`, `#161311`/`#ffffff` |
| App name | IBM Plex Sans `15px`/600, letter-spacing `-0.015em`, ellipsis on overflow |
| Chevron | only in menu mode, same `6×6px` glyph |
| Right | search icon button, then avatar `28×28px` |

Add `padding-top: env(safe-area-inset-top)` so the bar never tucks under a notch.

**Bottom tab bar**

| Property | Value |
| --- | --- |
| Bar | border-top `1px solid #ece4d3`, background `#ffffff`, padding `6px 4px 12px` plus `env(safe-area-inset-bottom)` |
| Tab | `flex: 1`, column, `gap: 5px`, `min-height: 48px`, padding `4px 2px`, radius `10px` |
| — active | background `#fff3ee`, glyph and label `#ff5b3a` |
| — inactive | transparent, `#766b62` |
| Icon | 22px lucide glyph |
| Label | IBM Plex Sans `10.5px`/500, `line-height: 1`, nowrap |

Rules:

1. **Four destinations plus More.** Never five, never the whole nav list — the fifth slot is always overflow.
2. **Every app gets one**, including the two with no mobile nav today. Stock Control has three destinations, so it ships three plus More.
3. **App switching moves into the account sheet**, reached from the avatar. Today's strip is `overflow-x: auto` with `scrollbar-width: none`, so on a narrow phone the fourth app can sit off-screen with nothing indicating it exists. That is not a navigation control.
4. **48px minimum tap targets**, and the bar is `absolute` inside the app frame, **not** `fixed`. Proofs already learned this: iOS pans a fixed bar away from the screen edge when the keyboard opens or the page is short.

Per-app tab sets:

| App | Tabs |
| --- | --- |
| Proofs | Dashboard · Orders · Chat · Activity · More |
| vCard Studio | Cards · QR codes · Users · Chat · More |
| Card Programme | Overview · This run · Customers · Chat · More |
| Stock Control | Dashboard · Insights · Chat · More |

---

## The `appsVisible` preference

The two design directions differ by one boolean, so both ship and the person chooses.

**Storage — a cookie, not `localStorage`.** The four apps are four origins (`stock.`, `proofs.`, `qr.`, `programme.`), so `localStorage` would give each app an independent setting, which is worse than having none. Set it on `.plasmadesign.co.uk` beside the SSO session cookie:

```
pd_chrome_apps=1; Domain=.plasmadesign.co.uk; Path=/; Max-Age=31536000; SameSite=Lax; Secure
```

A column on the shared profile works too and survives cookie clearing, at the cost of a round trip before first paint. If you go that route, seed from the cookie and reconcile — the chrome must never flicker between heights on load.

**Default:** `true` when `my_apps()` returns three or more apps, `false` at two. People who cross apps are shown the door before they go looking for it; people who don't are not charged 38px for a switcher they use monthly.

**Two controls, one state.** The app menu row reads as "keep this open" (where someone discovers it); the account menu row reads as a setting (where they go to undo it). Both write the same value.

**The cost, which is real:** every screen now has two possible chrome heights. Anything sticky below the chrome must read the offset from the component rather than assume a constant. **Stock Control's stock-filter bar and the Proofs sticky admin header both hardcode this today** and will break. Export the height as a CSS custom property on the chrome root — `--pd-chrome-height: 94px | 56px` — and have those elements use `top: var(--pd-chrome-height)`.

---

## Package shape

### Why a package and not four more copies

`appSwitcher.ts` is copied verbatim into four repos and has **not** drifted. The four headers, which were never shared, have drifted into nine review findings. Copying is not the disease; not sharing is.

But the rule that makes that copy safe — presentational, stateless, dependency-free — does not survive this scope. The chrome needs router-aware links, a controlled input, focus handling in two popovers, a bottom sheet, and a cookie contract. That is behaviour, and four copies of behaviour is where drift stops being cosmetic: one app reading a differently-named cookie means a person's setting silently fails to follow them and nothing looks broken.

### The constraint that actually mattered

Not React 18 vs 19 — Tailwind v3 vs v4 vs none.

- `plasmadesign-stock-control` — React 18, Tailwind v3, plain JS, **no router**
- `proof-viewer` — React 19, Tailwind v4, react-router
- `card-programme` — React 19, Tailwind v4, react-router
- `vcard-creator` — React 18, hand-written CSS, **no Tailwind**, react-router

**So the package ships no Tailwind.** One built stylesheet of `pd-chrome-*` prefixed classes, or inline styles. Every app's Tailwind version then stops being the package's problem. This is exactly the instinct `appSwitcher.ts` already had — just packaged instead of pasted.

React is easy: `peerDependencies: { "react": "^18 || ^19" }`, and avoid React 19-only APIs.

### API

```ts
export interface ChromeApp {
  app: string;        // 'proofs' | 'qr' | 'programme' | 'stock'
  label: string;      // short, for the strip
  fullLabel: string;  // for the header and the app menu
  description: string;
  url: string;
  role: string;
}

export interface ChromeNavItem {
  id: string;
  label: string;
  href: string;
  badge?: number;
  end?: boolean;      // exact-match highlighting
}

export interface ChromeUser {
  name: string;
  email: string;
  initials: string;
  colour: string;
  avatarUrl?: string | null;
  roleLabel: string;
}

export interface ChromeProps {
  apps: ChromeApp[];              // from the host's own my_apps() call
  currentApp: string;
  nav: ChromeNavItem[];           // already filtered for role and feature flags
  activeNavId: string | null;
  mobileTabIds: string[];         // up to 4; More is appended by the chrome
  user: ChromeUser;
  linkComponent?: React.ComponentType<any>;   // NavLink, Link, or 'a'
  search?: { value: string; onChange: (v: string) => void; placeholder?: string; onPalette?: () => void };
  actions?: React.ReactNode;      // page CTAs, left of the right cluster
  chatUnread?: number;
  chatMentionUnread?: number;
  notificationsUnread?: number;
  appsVisible?: boolean;          // controlled; omit to let the chrome own the cookie
  onAppsVisibleChange?: (next: boolean) => void;
  onSignOut: () => void;
  onEditProfile?: () => void;
  variant?: 'full' | 'switcher-only';   // 'switcher-only' for the no-role screen
}
```

Three seams that keep the package honest:

- **`linkComponent`** — the chrome renders whatever it is handed: `NavLink` in three apps, a plain `<a>` in Stock Control, which has no router. The package never imports react-router.
- **`apps` in, not fetched** — data access stays per-app. `fetchMyApps.ts` is already correct in each repo and should be kept as-is; only `appSwitcher.ts` is deleted. This boundary is already right — do not move it.
- **`variant="switcher-only"`** — Card Programme renders the switcher above its no-role explanation on purpose, so someone who followed a link to a surface they hold no role on can get back out. The chrome needs a mode that keeps the strip and drops the nav.

### Distribution

A git dependency pinned to a tag:

```json
"@plasma/chrome": "github:robrandtoul/plasma-chrome#v1.0.0"
```

Versioning and a deliberate per-app upgrade, with no registry to maintain and no monorepo migration. For four private apps and one maintainer that beats both alternatives.

### Behaviour and accessibility

- Both popovers close on outside click and `Escape`, and return focus to their trigger. Opening one closes the other.
- `aria-current="page"` on the active nav item and the current strip link.
- Strip `<nav aria-label="PlasmaDesign apps">`; header `<nav aria-label="{app} navigation">`.
- Focus-visible: `outline: 2px solid #e8421f`, `outline-offset: 1px` (`-2px` where the ring would be clipped). Never `#ff5b3a` — it measures 2.89:1 on cream, under the 3:1 non-text minimum, which is why the apps already keep `--c-focus` as its own token.
- Safari drops list semantics from a `list-style: none` `<ul>`; keep the `role="list"` that `appSwitcher.ts` sets.
- Every transition respects `prefers-reduced-motion: reduce`.
- Icon-only controls need `aria-label` and a `title`. Stock Control's current key and door glyphs have neither.

---

## Design tokens

All from the apps' existing `design-tokens.css`. Nothing new.

**Type**

| Token | Value |
| --- | --- |
| Sans | `'IBM Plex Sans', system-ui, -apple-system, sans-serif` |
| Mono | `'Geist Mono', 'IBM Plex Mono', ui-monospace, monospace` |
| Numeric features | `'tnum' 1, 'lnum' 1` on every mono numeral |

**Scale used by the chrome**

| Use | Size / weight / tracking |
| --- | --- |
| App name, label mode | 15.5px / 600 / -0.015em |
| App name, menu mode | 14.5px / 600 / -0.01em |
| Nav item | 13.5px / 500 / -0.005em |
| Account name, menu rows | 13px / 400 |
| Strip link | 12.5px / 400 or 600 / 0.005em |
| Search placeholder | 12.5px / 400 |
| Menu row description | 11.5px / 400 |
| Mobile tab label | 10.5px / 500 |
| Count badge (mono) | 10px / 600 |
| Eyebrow, wordmark, role (mono) | 9–9.5px / 500 / 0.1–0.16em uppercase |

**Colour**

| Token | Hex | Use in the chrome |
| --- | --- | --- |
| `--c-ink` | `#161311` | switcher strip surface, app mark, primary text |
| `--c-ink-soft` | `#3d342d` | inactive nav label, icon strokes, menu rows |
| `--c-ink-mute` | `#766b62` | chevrons, secondary text |
| `--c-ink-dim` | `#837868` | placeholders, eyebrows |
| — | `#a89e92` | strip inactive link and role label (on ink) |
| `--c-surface` | `#ffffff` | header bar, popovers |
| `--c-bg` | `#fbf7f0` | search field, current-row tint, page canvas |
| `--c-line` | `#ece4d3` | borders, dividers |
| `--c-line-soft` | `#f4ede0` | hover fill, in-panel dividers |
| — | `#dcd2c0` | toggle track, off |
| `--c-brand-500` | `#ff5b3a` | strip underline, "Here", toggle on, mobile active tab |
| `--c-brand-700` | `#c2301a` | **active nav fill and badge fills** (see corrections) |
| `--c-brand-600` | `#e8421f` | focus rings |
| `--c-brand-50` | `#fff3ee` | mobile active tab background |
| `--c-out` | `#d11e3d` | sign out |
| `--c-out-soft` | `#fcd0d6` | sign out hover |

**Geometry**

| Use | Value |
| --- | --- |
| Radii | `4px` mark (strip) · `7px` menu row mark · `8px` nav item, icon button, menu row · `9px` app menu button · `10px` mobile tab · `12px` popover · `999px` badges, toggle |
| Heights | `38px` strip and app-menu button · `32px` nav item, icon button, search, account · `56px` header bar · `54px` mobile top bar · `48px` minimum mobile tap target |
| Padding | `0 22px` chrome rows · `0 13px` nav item · `0 14px` strip link · `0 11px` search · `7px` popover · `9px 10px` menu row |
| Gaps | `14px` bar groups · `3px` nav items · `11px` menu row · `10px` app identity · `8px` account/search · `7px` nav badge |
| Shadow, popover | `0 24px 64px rgba(22,19,17,0.18), 0 2px 6px rgba(22,19,17,0.08)` |
| Divider | `1px × 24px`, `#ece4d3` |

---

## Assets

No new assets. Icons are **lucide-react**, already a dependency in Proofs, Stock Control and Card Programme; vCard Studio hand-rolls inline SVGs and should adopt lucide with the package. Icons used: `Search`, `MessagesSquare`, `Bell`, `ChevronDown`, `LogOut`, `UserCircle`, `Settings`, `MessageSquare`, `MoreHorizontal`, plus each app's tab glyphs.

The mark is a `border-radius` square, not artwork.

The four PNGs in `before/` are screenshots of today's navigation, for reference only.

---

## Files in this bundle

| Path | What it is |
| --- | --- |
| `README.md` | This brief — self-sufficient; everything needed to build is here |
| `MIGRATION.md` | Per-repo change list, in the order to do it |
| `HANDOFF-PROMPTS.md` | Where to put this bundle, and the exact prompts for the five Claude Code sessions |
| `reference/chrome.css` | **The stylesheet, production-ready.** Every class in it is specified above. Ship it as the package's `dist/chrome.css` — it is the thing that makes the result faithful, and the contrast corrections are already applied |
| `reference/chrome-reference.html` | Static reference page: every state rendered by `chrome.css`, with hover and focus live. Open it in a browser next to your implementation |
| `screenshots/01–12-chrome.png` | Flat captures of the reference page, in reading order, for review without opening anything |
| `prototype/Navigation Review.dc.html` | The full design review — nine findings, both directions, the preference. `support.js` must sit beside it |
| `prototype/support.js` | Runtime for the prototype file |
| `before/*.png` | The four current navigation bars |

**Start from `reference/chrome.css`.** It is real, complete CSS with the reasoning in comments; you should be copying it into the package rather than deriving it from the tables above. The tables exist so you can verify it and so the spec survives if the file is lost.

Two notes on the bundled files:

- `chrome-reference.html` has a small block of clearly-marked page furniture at the top, including two overrides that force the desktop search field visible and give an isolated strip link its row height. Neither belongs in the package.
- The prototype has a controls panel for accent colour, density and badge visibility. Those are review affordances, not product features — do not build them. Where the prototype and this README disagree on the active-fill colour, **this README is right** (see Contrast corrections).

## Screenshot index

| File | Shows |
| --- | --- |
| `01` | Both modes: 94px with strip, 56px without |
| `02` | Menu mode bar, with the search field |
| `03` | App menu open, preference row off |
| `04` | Account menu open, preference on |
| `05` | Switch in its off state with the alternate hint copy |
| `06`–`09` | The same chrome in vCard Studio, Card Programme and Stock Control |
| `10` | `variant="switcher-only"` — the no-role screen |
| `11` | Item states: nav rest / count / active, strip link, right cluster |
| `12` | Mobile, both modes, with bottom tab bars |

Captures are taken at a 924px-wide window, so the desktop bars are shown left-anchored inside a scroll frame; the right cluster is captured in isolation in `11`. Open `chrome-reference.html` at full width to see a complete bar in one piece.
