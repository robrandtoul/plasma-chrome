/* ─────────────────────────────────────────────────────────────
   @plasma/chrome — public surface.

   The stylesheet is a separate, single import the consumer adds
   once:  import '@plasma/chrome/chrome.css'   (here: './chrome.css')
   It is deliberately not imported from this module, so the package
   stays consumable from plain JS and from hosts whose bundler does
   not handle CSS imports inside a dependency.
   ─────────────────────────────────────────────────────────── */
export { Chrome } from './Chrome.js';
export { SwitcherStrip } from './SwitcherStrip.js';
export { HeaderBar } from './HeaderBar.js';
export { AppMenu } from './AppMenu.js';
export { AccountMenu } from './AccountMenu.js';
export { MobileChrome } from './MobileChrome.js';
export { Toggle } from './Toggle.js';
export { useDismissable } from './useDismissable.js';
export { APPS_COOKIE, defaultAppsVisible, readAppsCookie, useAppsVisible, writeAppsCookie, } from './useAppsVisible.js';
//# sourceMappingURL=index.js.map