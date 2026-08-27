/* ─────────────────────────────────────────────────────────────
   @plasma/chrome — public surface.

   The stylesheet is a separate, single import the consumer adds
   once:  import '@plasma/chrome/chrome.css'   (here: './chrome.css')
   It is deliberately not imported from this module, so the package
   stays consumable from plain JS and from hosts whose bundler does
   not handle CSS imports inside a dependency.
   ─────────────────────────────────────────────────────────── */

export { Chrome } from './Chrome';
export { SwitcherStrip } from './SwitcherStrip';
export { HeaderBar } from './HeaderBar';
export { AppMenu } from './AppMenu';
export { AccountMenu } from './AccountMenu';
export { MobileChrome } from './MobileChrome';
export { Toggle } from './Toggle';

export { useDismissable } from './useDismissable';
export {
  APPS_COOKIE,
  defaultAppsVisible,
  readAppsCookie,
  useAppsVisible,
  writeAppsCookie,
} from './useAppsVisible';

export type {
  ChromeApp,
  ChromeLinkComponent,
  ChromeNavItem,
  ChromeProps,
  ChromeSearch,
  ChromeUser,
} from './types';
