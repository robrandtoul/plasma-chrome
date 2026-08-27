import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/* ─────────────────────────────────────────────────────────────
   The white 56px row: app identity, nav, right cluster.

   Right-cluster order is fixed and never negotiable:
   page actions → search → chat → notifications → account.
   Sign out is not on the bar; it lives in the account menu.
   ─────────────────────────────────────────────────────────── */
import { useState } from 'react';
import { cx, formatCount } from './types.js';
import { AppMenu } from './AppMenu.js';
import { AccountMenu } from './AccountMenu.js';
import { appGlyph, BellIcon, ChatIcon, SearchButtonIcon, SearchIcon } from './icons.js';
/**
 * The router seam. The chrome renders whatever it is handed and never
 * imports react-router: `href` always goes through, and `end` goes
 * through only when the item declares it and the host supplied a
 * component (a bare `<a>` has no use for it).
 */
export function NavLinkish({ linkComponent, item, className, active, children, }) {
    const Comp = linkComponent ?? 'a';
    const extra = {};
    if (linkComponent && item.end !== undefined)
        extra.end = item.end;
    return (_jsx(Comp, { className: className, href: item.href, "aria-current": active ? 'page' : undefined, ...extra, children: children }));
}
export function HeaderBar(props) {
    const { apps, currentApp, appName, nav, activeNavId, user, linkComponent, accountLinks, search, actions, chat, chatUnread, chatMentionUnread, notificationsUnread, appsVisible, onAppsVisibleChange, onSignOut, onEditProfile, } = props;
    // One popover at a time: opening either closes the other.
    const [openMenu, setOpenMenu] = useState(null);
    const chatCount = chatUnread ?? 0;
    const mentionCount = chatMentionUnread ?? 0;
    const showChat = chat !== undefined || chatUnread !== undefined || chatMentionUnread !== undefined;
    const showNotifications = notificationsUnread !== undefined;
    const notificationCount = notificationsUnread ?? 0;
    const chatLabel = mentionCount > 0
        ? 'Team chat — ' + mentionCount + ' mentioning you'
        : chatCount > 0
            ? 'Team chat — ' + chatCount + ' unread'
            : 'Team chat';
    return (_jsxs("div", { className: "pd-chrome__bar", children: [appsVisible ? (_jsxs("span", { className: "pd-chrome__app--static", children: [_jsx("span", { className: "pd-chrome__app-mark", children: appGlyph(currentApp, 15, appName) }), _jsx("span", { className: "pd-chrome__app-name", children: appName })] })) : (_jsx(AppMenu, { apps: apps, currentApp: currentApp, appName: appName, open: openMenu === 'apps', onOpen: () => setOpenMenu('apps'), onClose: () => setOpenMenu((current) => (current === 'apps' ? null : current)), appsVisible: appsVisible, onAppsVisibleChange: onAppsVisibleChange })), _jsx("span", { className: "pd-chrome__divider" }), _jsx("ul", { className: "pd-chrome__nav", role: "list", "aria-label": appName + ' navigation', children: nav.map((item) => {
                    const active = item.id === activeNavId;
                    return (_jsx("li", { children: _jsxs(NavLinkish, { linkComponent: linkComponent, item: item, active: active, className: cx('pd-chrome__nav-item', active && 'pd-chrome__nav-item--active'), children: [item.label, item.badge && item.badge > 0 ? (_jsx("span", { className: "pd-chrome__count", children: formatCount(item.badge) })) : null] }) }, item.id));
                }) }), _jsx("span", { className: "pd-chrome__spacer" }), actions, search ? (_jsxs(_Fragment, { children: [_jsxs("label", { className: "pd-chrome__search", children: [_jsx(SearchIcon, {}), _jsx("input", { className: "pd-chrome__search-input", type: "search", placeholder: search.placeholder ?? 'Search', value: search.value, onChange: (event) => search.onChange(event.target.value) }), search.onPalette ? (_jsx("button", { className: "pd-chrome__kbd", type: "button", "aria-label": "Open the search palette", onClick: search.onPalette, children: "\u2318K" })) : null] }), search.onPalette ? (_jsx("button", { className: "pd-chrome__icon-btn pd-chrome__search-toggle", type: "button", title: "Search", "aria-label": "Search", onClick: search.onPalette, children: _jsx(SearchButtonIcon, {}) })) : null] })) : null, showChat
                ? (chat ?? (_jsxs("button", { className: "pd-chrome__icon-btn", type: "button", title: "Team chat", "aria-label": chatLabel, children: [_jsx(ChatIcon, {}), chatCount > 0 ? (_jsx("span", { className: "pd-chrome__dot", "aria-hidden": "true", children: formatCount(chatCount) })) : null] })))
                : null, showNotifications ? (_jsxs("button", { className: "pd-chrome__icon-btn", type: "button", title: "Notifications", "aria-label": notificationCount > 0
                    ? 'Notifications — ' + notificationCount + ' new'
                    : 'Notifications', children: [_jsx(BellIcon, {}), notificationCount > 0 ? (_jsx("span", { className: "pd-chrome__dot", "aria-hidden": "true", children: formatCount(notificationCount) })) : null] })) : null, _jsx("span", { className: "pd-chrome__divider pd-chrome__divider--account" }), _jsx(AccountMenu, { user: user, open: openMenu === 'account', onOpen: () => setOpenMenu('account'), onClose: () => setOpenMenu((current) => (current === 'account' ? null : current)), appsVisible: appsVisible, onAppsVisibleChange: onAppsVisibleChange, onSignOut: onSignOut, onEditProfile: onEditProfile, accountLinks: accountLinks, linkComponent: linkComponent })] }));
}
//# sourceMappingURL=HeaderBar.js.map