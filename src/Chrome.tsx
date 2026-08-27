/* ─────────────────────────────────────────────────────────────
   The shell. One component with an optional layer; there is no
   second layout.

     switcher strip · 38px · #161311 · only when appsVisible
     header bar     · 56px · #ffffff

   Sticky in every app, and it does not condense, resize or animate
   on scroll.
   ─────────────────────────────────────────────────────────── */

import { useEffect } from 'react';
import type { JSX } from 'react';
import type { ChromeProps } from './types';
import { cx } from './types';
import { SwitcherStrip } from './SwitcherStrip';
import { HeaderBar } from './HeaderBar';
import { MobileChrome } from './MobileChrome';
import { useAppsVisible } from './useAppsVisible';

/* Desktop / mobile switching.

   chrome.css owns display through media queries — the collapsed
   search field is the worked example: `.pd-chrome__search-toggle` has
   no base rule at all, both elements sit in the markup permanently,
   and the two media queries decide which one is `display: none`. It
   ships no equivalent rule for swapping the desktop bar for the
   mobile one, so that swap is declared here in the same idiom rather
   than as a JS breakpoint: both trees always in the DOM, CSS decides.

   768px is the `md:` boundary the migration's definition of done
   names ("every app has a bottom tab bar under md:"). chrome.css's
   own 560px rule, which trims the strip and bar padding, then covers
   the one case that has no mobile counterpart: variant
   "switcher-only", which renders the strip at every width. That is
   why the desktop tree is hidden by a data attribute rather than by
   its class — the strip-only chrome does not carry it.

   `display: contents` on the mobile wrapper is load-bearing: the tab
   bar is `position: absolute` against the host's app frame, and the
   top bar is `position: sticky`. A wrapper with a real box would
   become the containing block for the first and would cap the
   scrolling range of the second. */
/* The tab bar's own height, published the same way --pd-chrome-height
   is and for the same reason: a host cannot place anything above a bar
   whose height it is not allowed to know, and the DoD forbids
   hardcoding the number. 67px is chrome.css's own geometry — 6px top
   padding + a 49px tab + 12px bottom padding — and chrome.css is frozen
   byte-for-byte against the reference, so it cannot drift without a
   deliberate amendment. Zero at every width where no tab bar renders,
   so `padding-bottom: var(--pd-chrome-tabbar-height)` is safe to write
   unconditionally. */
const TABBAR_HEIGHT = 'calc(67px + env(safe-area-inset-bottom))';

/* absolute, chrome.css's default, needs a viewport-locked app frame to
   be its containing block: proof-viewer has one (#app-scroll owns the
   scrolling below md), and iOS then cannot pan the bar away from the
   screen edge the way it pans a fixed one when the keyboard opens.
   A host that scrolls the DOCUMENT has no such frame, so the bar's
   containing block falls back to the initial containing block and it
   is painted 100vh down the page — correct at the top, gone the moment
   you scroll. Measured in Stock Control: at scrollY 600 the bar sat at
   y=145 instead of the viewport bottom. `fixed` is the answer for those
   hosts, and it is strictly better than a bar that scrolls away, but it
   is opt-in rather than the default because it reintroduces the iOS
   keyboard pan that proof-viewer learned the hard way. */
function responsiveCss(hasMobile: boolean, tabBarPosition: 'absolute' | 'fixed'): string {
  /* The attribute value is deliberately unquoted. React escapes the
     text children of <style>, so a quoted value renders as &quot; and
     the selector stops matching under renderToString. None of the four
     hosts server-render today; `true` is a valid CSS identifier, so
     this costs nothing and removes the trap. */
  return (
    '@media (max-width: 767px) {' +
    ' .pd-chrome[data-pd-chrome-has-mobile=true] { display: none; }' +
    ' .pd-chrome-mobile { display: contents; }' +
    ' :root { --pd-chrome-tabbar-height: ' + (hasMobile ? TABBAR_HEIGHT : '0px') + '; }' +
    (tabBarPosition === 'fixed' ? ' .pd-chrome__tabs { position: fixed; }' : '') +
    '}' +
    '@media (min-width: 768px) {' +
    ' .pd-chrome-mobile { display: none; }' +
    ' :root { --pd-chrome-tabbar-height: 0px; }' +
    '}'
  );
}

export function Chrome(props: ChromeProps): JSX.Element {
  const {
    apps,
    currentApp,
    appName: appNameProp,
    nav,
    activeNavId,
    mobileTabIds,
    mobileTabs,
    accountLinks,
    accountActions,
    user,
    linkComponent,
    search,
    actions,
    chat,
    chatUnread,
    chatMentionUnread,
    notifications,
    notificationsUnread,
    appsVisible: controlledAppsVisible,
    onAppsVisibleChange,
    onSignOut,
    onEditProfile,
    variant = 'full',
    tabBarPosition = 'absolute',
  } = props;

  const [appsVisible, setAppsVisible] = useAppsVisible(
    apps.length,
    controlledAppsVisible,
    onAppsVisibleChange,
  );

  const switcherOnly = variant === 'switcher-only';

  // Below two apps the strip does not render at all — the same
  // no-op mountAppSwitcher returns today. The header bar still does.
  const stripVisible = apps.length >= 2 && (switcherOnly || appsVisible);

  /* chrome.css declares --pd-chrome-height on .pd-chrome, but the
     chrome is a sibling of page content rather than an ancestor of
     it, so a sticky element elsewhere in the tree cannot inherit it.
     Re-declare it on :root, and take it back down on unmount. */
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--pd-chrome-height', stripVisible ? '94px' : '56px');
    return () => {
      root.style.removeProperty('--pd-chrome-height');
    };
  }, [stripVisible]);

  // The host's own name wins. The registry lookup is the fallback, and
  // `currentApp` behind that is a last resort that should never be what
  // a person reads: it is the lowercase database key.
  const appName =
    appNameProp ?? apps.find((app) => app.app === currentApp)?.fullLabel ?? currentApp;

  return (
    <>
      <style>{responsiveCss(!switcherOnly, tabBarPosition)}</style>
      <div
        className={cx('pd-chrome', stripVisible && 'pd-chrome--with-strip')}
        data-pd-chrome-has-mobile={switcherOnly ? undefined : 'true'}
      >
        {stripVisible ? <SwitcherStrip apps={apps} currentApp={currentApp} /> : null}
        {switcherOnly ? null : (
          <HeaderBar
            apps={apps}
            currentApp={currentApp}
            appName={appName}
            nav={nav}
            activeNavId={activeNavId}
            user={user}
            linkComponent={linkComponent}
            search={search}
            actions={actions}
            chat={chat}
            chatUnread={chatUnread}
            chatMentionUnread={chatMentionUnread}
            notifications={notifications}
            notificationsUnread={notificationsUnread}
            appsVisible={appsVisible}
            onAppsVisibleChange={setAppsVisible}
            onSignOut={onSignOut}
            onEditProfile={onEditProfile}
            accountLinks={accountLinks}
            accountActions={accountActions}
          />
        )}
      </div>
      {switcherOnly ? null : (
        <MobileChrome
          apps={apps}
          currentApp={currentApp}
          appName={appName}
          nav={nav}
          activeNavId={activeNavId}
          mobileTabIds={mobileTabIds}
          mobileTabs={mobileTabs}
          accountLinks={accountLinks}
          accountActions={accountActions}
          user={user}
          linkComponent={linkComponent}
          search={search}
          chat={chat}
          notifications={notifications}
          appsVisible={appsVisible}
          onAppsVisibleChange={setAppsVisible}
          onSignOut={onSignOut}
          onEditProfile={onEditProfile}
        />
      )}
    </>
  );
}
