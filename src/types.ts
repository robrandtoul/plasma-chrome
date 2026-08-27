/* ─────────────────────────────────────────────────────────────
   @plasma/chrome — public contracts.

   This folder must stay liftable into a standalone package with
   zero edits, so nothing in it imports anything but `react`.
   Data arrives as props; routing arrives as `linkComponent`.
   ─────────────────────────────────────────────────────────── */

import type { ComponentType, MouseEvent, ReactNode } from 'react';

export interface ChromeApp {
  app: string; // 'proofs' | 'qr' | 'programme' | 'stock'
  label: string; // short, for the strip
  fullLabel: string; // for the header and the app menu
  description: string;
  url: string;
  role: string;
}

export interface ChromeNavItem {
  id: string;
  label: string;
  href: string;
  badge?: number;
  end?: boolean; // exact-match highlighting
  /* ADDITION to the README's ChromeProps, forced by a gap in it.
     MIGRATION's option B for a router-less host is a nav array "with
     `href="#"` and an `onClick`", and says "the chrome does not care".
     It did care: NavLinkish forwarded href, aria-current and end, and
     nothing else, so the click did nothing and option B could not be
     taken without a bespoke linkComponent in the app — the drift this
     package exists to remove. Forwarded to whatever link component is
     in use, the default plain <a> included. A host that supplies this
     owns the preventDefault. */
  onClick?: (event: MouseEvent<HTMLElement>) => void;
}

export interface ChromeUser {
  name: string;
  email: string;
  initials: string;
  colour: string;
  avatarUrl?: string | null;
  roleLabel: string;
}

export interface ChromeSearch {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  onPalette?: () => void;
}

/** Whatever the host hands us: NavLink, Link, or the default 'a'. */
export type ChromeLinkComponent = ComponentType<any>;

export interface ChromeAccountAction {
  id: string;
  label: string;
  onClick: () => void;
}

export interface ChromeAccountLinks {
  notifications?: string;
  feedback?: string;
}

export interface ChromeProps {
  apps: ChromeApp[]; // from the host's own my_apps() call
  currentApp: string;
  /* ADDITION to the README's ChromeProps, forced by a defect in it. The
     header's app name was derived as
     `apps.find(a => a.app === currentApp)?.fullLabel ?? currentApp`,
     which reads its own name out of a NETWORK CALL. Every host fetches
     `apps` asynchronously, so on the first paint of every load the bar
     showed the raw registry key — "programme", "proofs", "stock" — and
     it stayed that way for good whenever my_apps() returned nothing or
     failed, which it does silently by design. An app always knows its
     own name; pass it. Omit this and the derivation still applies, so
     nothing that already works breaks. */
  appName?: string;
  nav: ChromeNavItem[]; // already filtered for role and feature flags
  activeNavId: string | null;
  mobileTabIds: string[]; // up to 4; More is appended by the chrome
  /* ADDITION to the README's ChromeProps, forced by a gap in it.
     `mobileTabIds` can only be resolved against `nav`, but README's own
     mobile table asks every app for a Chat tab and asks Proofs for an
     Activity tab, and neither is a desktop destination: rule 4 makes
     Chat a right-cluster icon button in all four apps, and Activity is
     a Proofs-only route that is not in its nav. So the declared API
     cannot express the mobile bar the same document specifies.
     Supplying `mobileTabs` gives the tab set directly; omitting it
     falls back to resolving `mobileTabIds` against `nav`. */
  mobileTabs?: ChromeNavItem[];
  user: ChromeUser;
  linkComponent?: ChromeLinkComponent; // NavLink, Link, or 'a'
  search?: ChromeSearch;
  actions?: ReactNode; // page CTAs, left of the right cluster
  /* ADDITION to the README's ChromeProps. MIGRATION §1 says proof-viewer's
     ChatMenu is "passed through the chrome's chat slot rather than
     reimplemented in the package" because it owns a realtime
     subscription, but README's ChromeProps declares no such slot. This
     is that slot: rendered at the chat position in the fixed
     right-cluster order. Omit it and the chrome draws its own chat
     icon button from chatUnread / chatMentionUnread. */
  chat?: ReactNode;
  chatUnread?: number;
  chatMentionUnread?: number;
  /* ADDITION to the README's ChromeProps, the same shape and for the
     same reason as `chat`. MIGRATION §2 says Stock Control's
     `NotificationsToggle.jsx` is passed through "as slots" alongside
     ChatMenu, but the declared props offered only `notificationsUnread`
     — a number. That bell is not a count: it owns the per-device push
     subscription and its own popover, so a number would have drawn a
     dead duplicate beside the real control. Omit this and the chrome
     draws its own bell from notificationsUnread, exactly as before. */
  notifications?: ReactNode;
  notificationsUnread?: number;
  appsVisible?: boolean; // controlled; omit to let the chrome own the cookie
  onAppsVisibleChange?: (next: boolean) => void;
  onSignOut: () => void;
  onEditProfile?: () => void;
  /* ADDITION to the README's ChromeProps, forced by a second gap in it.
     README specifies three account-menu rows - Notifications, Edit
     profile, Feedback - and the reference markup renders all three as
     links, but the declared props carry a handler for Edit profile
     only. Proof-viewer has real routes behind the other two
     (/settings/notifications and /feedback) and its old header linked
     to both, so rendering only Edit profile would make them
     unreachable. Hosts supply the hrefs they actually have; a row with
     no href is not rendered, so an app without a feedback page does not
     get a dead menu item. */
  accountLinks?: ChromeAccountLinks;
  /* Extra account-menu rows that run an action rather than navigate,
     rendered after the specified rows and before sign out.
     Stock Control forced this: MIGRATION requires its change-password
     key glyph to move into the account menu, and change password is a
     modal, not a route. Routing it through `onEditProfile` would have
     put a row labelled "Edit profile" in front of a password dialog,
     and dropping it would have removed the only way to change a
     password in that app. Keep the list short: this is an escape hatch
     for a genuinely app-specific action, not a general menu builder. */
  accountActions?: ChromeAccountAction[];
  variant?: 'full' | 'switcher-only'; // 'switcher-only' for the no-role screen
  /* ADDITION to the README's ChromeProps, forced by a host the package
     had silently assumed away. chrome.css positions the mobile tab bar
     `absolute` on purpose, against the host's viewport-locked app
     frame; proof-viewer has one, Stock Control scrolls the document and
     has none, so there the bar is painted 100vh down the page and
     scrolls out of sight. Pass 'fixed' when the DOCUMENT scrolls. The
     cost is the iOS keyboard pan that made `absolute` the default in
     the first place, which is why this is opt-in — but a bar that pans
     briefly beats a bar that is not there at all.
     Either way the chrome publishes --pd-chrome-tabbar-height (0px
     above 768px), which is what a host should pad its content with
     rather than hardcoding the number. */
  tabBarPosition?: 'absolute' | 'fixed';
}

/** Counts read as `9+` above nine. */
export function formatCount(n: number): string {
  return n > 9 ? '9+' : String(n);
}

/** The app mark is the first letter of the full name, never artwork. */
export function markLetter(fullLabel: string): string {
  return (fullLabel.trim().charAt(0) || '?').toUpperCase();
}

/**
 * The bar shows one word. `name` is meant to be a full name, but every
 * host has some account with no name on file and falls back to the
 * email, and an address has no whitespace to split on — so this used to
 * paint the whole of
 * `someone.with.a.long.name@plasmadesign.co.uk` into a bar whose
 * container is `flex: 0 0 auto` and never shrinks. Degrade to the local
 * part instead: still identifying, and bounded. The account menu's
 * identity block still shows the address in full.
 */
export function firstName(name: string): string {
  const trimmed = name.trim();
  const first = trimmed.split(/\s+/)[0] || trimmed;
  const at = first.indexOf('@');
  return at > 0 ? first.slice(0, at) : first;
}

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
