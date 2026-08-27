/* The four real apps, and the nav arrays the reference page renders.

   Nothing app-specific beyond this: the descriptions and short labels
   are the ones fixed in the specification's own table, and the nav
   arrives here already filtered exactly as a host would filter it:
   Card Programme's set has no Admin item because that fixture is the
   Production role, and the chrome holds no role logic to hide it. */

import type { ChromeApp, ChromeNavItem, ChromeUser } from '../src/types';

export const APPS: ChromeApp[] = [
  {
    app: 'proofs',
    label: 'Proofs',
    fullLabel: 'Proofs',
    description: 'Proof approvals, orders, logbook',
    url: 'https://proofs.plasmadesign.co.uk',
    role: 'Admin',
  },
  {
    app: 'qr',
    label: 'vCards',
    fullLabel: 'vCard Studio',
    description: 'Digital cards and QR codes',
    url: 'https://qr.plasmadesign.co.uk',
    role: 'Admin',
  },
  {
    app: 'programme',
    label: 'Programme',
    fullLabel: 'Card Programme',
    description: 'Membership card runs and credits',
    url: 'https://programme.plasmadesign.co.uk',
    role: 'Production',
  },
  {
    app: 'stock',
    label: 'Stock',
    fullLabel: 'Stock Control',
    description: 'Materials, production, dispatch',
    url: 'https://stock.plasmadesign.co.uk',
    role: 'Admin',
  },
];

/** The no-role screen: signed in, but holds no role on this app. */
export const APPS_WITHOUT_PROGRAMME: ChromeApp[] = APPS.filter(
  (app) => app.app !== 'programme',
);

/** One app: the strip suppresses itself, the header bar does not. */
export const APPS_ONE: ChromeApp[] = APPS.filter((app) => app.app === 'proofs');

export const USER: ChromeUser = {
  name: 'Rob Randtoul',
  email: 'rob@plasmadesign.co.uk',
  initials: 'RR',
  colour: '#2b6df5',
  roleLabel: 'Admin',
};

export const USER_PRODUCTION: ChromeUser = {
  ...USER,
  colour: '#0d9488',
  roleLabel: 'Production',
};

export const PROOFS_NAV: ChromeNavItem[] = [
  { id: 'dashboard', label: 'Dashboard', href: '#dashboard', end: true },
  { id: 'orders', label: 'Orders', href: '#orders', badge: 1 },
  { id: 'logbook', label: 'Logbook', href: '#logbook' },
  { id: 'flagged', label: 'Flagged', href: '#flagged', badge: 1 },
  { id: 'quote', label: 'Quote', href: '#quote' },
  { id: 'admin', label: 'Admin', href: '#admin' },
];

/* Mobile tabs are supplied outright rather than resolved from `nav`.
   The specification asks every app for a Chat tab and asks Proofs for
   an Activity tab, and neither is a desktop destination. Chat is a
   right-cluster icon button under rule 4, Activity is a route with no
   nav item. This is the gap `mobileTabs` exists to close. */
export const PROOFS_MOBILE_TABS: ChromeNavItem[] = [
  { id: 'dashboard', label: 'Dashboard', href: '#dashboard' },
  { id: 'orders', label: 'Orders', href: '#orders' },
  { id: 'chat', label: 'Chat', href: '#chat' },
  { id: 'activity', label: 'Activity', href: '#activity' },
];

export const QR_NAV: ChromeNavItem[] = [
  { id: 'cards', label: 'Cards', href: '#cards' },
  { id: 'qr-codes', label: 'QR codes', href: '#qr-codes' },
  { id: 'users', label: 'Users', href: '#users' },
  { id: 'analytics', label: 'Analytics', href: '#analytics' },
  { id: 'deleted', label: 'Deleted', href: '#deleted' },
  { id: 'settings', label: 'Settings', href: '#settings' },
];

export const PROGRAMME_NAV: ChromeNavItem[] = [
  { id: 'overview', label: 'Overview', href: '#overview' },
  { id: 'this-run', label: 'This run', href: '#this-run' },
  { id: 'customers', label: 'Customers', href: '#customers' },
  { id: 'history', label: 'History', href: '#history' },
];

export const STOCK_NAV: ChromeNavItem[] = [
  { id: 'dashboard', label: 'Dashboard', href: '#dashboard' },
  { id: 'insights', label: 'Insights', href: '#insights' },
  { id: 'admin', label: 'Admin', href: '#admin' },
];

/** Three destinations plus More. Never padded to five. */
export const STOCK_MOBILE_TABS: ChromeNavItem[] = [
  { id: 'dashboard', label: 'Dashboard', href: '#dashboard' },
  { id: 'insights', label: 'Insights', href: '#insights' },
  { id: 'chat', label: 'Chat', href: '#chat' },
];

export const ACCOUNT_LINKS = {
  notifications: '#settings/notifications',
  feedback: '#feedback',
};

export const noop = (): void => {};
