import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/* ─────────────────────────────────────────────────────────────
   The shell. One component with an optional layer; there is no
   second layout.

     switcher strip · 38px · #161311 · only when appsVisible
     header bar     · 56px · #ffffff

   Sticky in every app, and it does not condense, resize or animate
   on scroll.
   ─────────────────────────────────────────────────────────── */
import { useEffect } from 'react';
import { cx } from './types.js';
import { SwitcherStrip } from './SwitcherStrip.js';
import { HeaderBar } from './HeaderBar.js';
import { MobileChrome } from './MobileChrome.js';
import { useAppsVisible } from './useAppsVisible.js';
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
const RESPONSIVE_CSS = '@media (max-width: 767px) {' +
    ' .pd-chrome[data-pd-chrome-has-mobile="true"] { display: none; }' +
    ' .pd-chrome-mobile { display: contents; }' +
    '}' +
    '@media (min-width: 768px) {' +
    ' .pd-chrome-mobile { display: none; }' +
    '}';
export function Chrome(props) {
    const { apps, currentApp, nav, activeNavId, mobileTabIds, mobileTabs, accountLinks, accountActions, user, linkComponent, search, actions, chat, chatUnread, chatMentionUnread, notificationsUnread, appsVisible: controlledAppsVisible, onAppsVisibleChange, onSignOut, onEditProfile, variant = 'full', } = props;
    const [appsVisible, setAppsVisible] = useAppsVisible(apps.length, controlledAppsVisible, onAppsVisibleChange);
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
    const appName = apps.find((app) => app.app === currentApp)?.fullLabel ?? currentApp;
    return (_jsxs(_Fragment, { children: [_jsx("style", { children: RESPONSIVE_CSS }), _jsxs("div", { className: cx('pd-chrome', stripVisible && 'pd-chrome--with-strip'), "data-pd-chrome-has-mobile": switcherOnly ? undefined : 'true', children: [stripVisible ? _jsx(SwitcherStrip, { apps: apps, currentApp: currentApp }) : null, switcherOnly ? null : (_jsx(HeaderBar, { apps: apps, currentApp: currentApp, appName: appName, nav: nav, activeNavId: activeNavId, user: user, linkComponent: linkComponent, search: search, actions: actions, chat: chat, chatUnread: chatUnread, chatMentionUnread: chatMentionUnread, notificationsUnread: notificationsUnread, appsVisible: appsVisible, onAppsVisibleChange: setAppsVisible, onSignOut: onSignOut, onEditProfile: onEditProfile, accountLinks: accountLinks, accountActions: accountActions }))] }), switcherOnly ? null : (_jsx(MobileChrome, { apps: apps, currentApp: currentApp, appName: appName, nav: nav, activeNavId: activeNavId, mobileTabIds: mobileTabIds, mobileTabs: mobileTabs, accountLinks: accountLinks, accountActions: accountActions, user: user, linkComponent: linkComponent, search: search, appsVisible: appsVisible, onAppsVisibleChange: setAppsVisible, onSignOut: onSignOut, onEditProfile: onEditProfile }))] }));
}
//# sourceMappingURL=Chrome.js.map