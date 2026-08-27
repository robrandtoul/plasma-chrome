/* ─────────────────────────────────────────────────────────────
   @plasma/chrome — public contracts.

   This folder must stay liftable into a standalone package with
   zero edits, so nothing in it imports anything but `react`.
   Data arrives as props; routing arrives as `linkComponent`.
   ─────────────────────────────────────────────────────────── */

import type { ComponentType, ReactNode } from 'react';

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

export interface ChromeAccountLinks {
  notifications?: string;
  feedback?: string;
}

export interface ChromeProps {
  apps: ChromeApp[]; // from the host's own my_apps() call
  currentApp: string;
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
  variant?: 'full' | 'switcher-only'; // 'switcher-only' for the no-role screen
}

/** Counts read as `9+` above nine. */
export function formatCount(n: number): string {
  return n > 9 ? '9+' : String(n);
}

/** The app mark is the first letter of the full name, never artwork. */
export function markLetter(fullLabel: string): string {
  return (fullLabel.trim().charAt(0) || '?').toUpperCase();
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
