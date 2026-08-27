import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { cx, formatCount } from './types.js';
import { AccountPanelBody } from './AccountMenu.js';
import { NavLinkish } from './HeaderBar.js';
import { appGlyph, MoreIcon, SearchButtonIcon, TabIcon } from './icons.js';
import { useDismissable } from './useDismissable.js';
export function MobileChrome(props) {
    const { apps, currentApp, appName, nav, activeNavId, mobileTabIds, mobileTabs, accountLinks, accountActions, user, linkComponent, search, chat, notifications, appsVisible, onAppsVisibleChange, onSignOut, onEditProfile, } = props;
    const [sheet, setSheet] = useState(null);
    const account = useDismissable(sheet === 'account', () => setSheet(null));
    const more = useDismissable(sheet === 'more', () => setSheet(null));
    // Four destinations plus More. Never five, never the whole nav list —
    // the fifth slot is always overflow.
    // `mobileTabs` wins when the host supplies it, because the mobile bar
    // is not a subset of the desktop nav: Chat is a right-cluster button
    // everywhere and Activity is a Proofs-only route, so neither can be
    // found in `nav`. Falling back to resolving ids against `nav` keeps
    // the simpler hosts working without passing the longer prop.
    const tabs = (mobileTabs ?? mobileTabIds
        .map((id) => nav.find((item) => item.id === id))
        .filter((item) => Boolean(item)))
        .slice(0, 4);
    const openAccount = () => setSheet(sheet === 'account' ? null : 'account');
    return (_jsxs("div", { className: "pd-chrome-mobile", children: [_jsxs("div", { className: "pd-chrome__mobile-bar", children: [appsVisible ? (_jsxs(_Fragment, { children: [_jsx("span", { className: "pd-chrome__app-mark", style: { width: 28, height: 28, borderRadius: 8 }, children: appGlyph(currentApp, 16, appName) }), _jsx("span", { className: "pd-chrome__mobile-title", children: appName })] })) : (_jsxs("button", { type: "button", onClick: openAccount, "aria-haspopup": "dialog", "aria-expanded": sheet === 'account', style: {
                            display: 'flex',
                            alignItems: 'center',
                            gap: 10,
                            minWidth: 0,
                            margin: 0,
                            padding: 0,
                            border: 0,
                            background: 'transparent',
                            font: 'inherit',
                            cursor: 'pointer',
                        }, children: [_jsx("span", { className: "pd-chrome__app-mark", style: { width: 28, height: 28, borderRadius: 8 }, children: appGlyph(currentApp, 16, appName) }), _jsx("span", { className: "pd-chrome__mobile-title", children: appName }), _jsx("span", { className: "pd-chrome__chevron", style: {
                                    width: 6,
                                    height: 6,
                                    borderRightWidth: 1.5,
                                    borderBottomWidth: 1.5,
                                    margin: '-3px 0 0 -2px',
                                }, "aria-hidden": "true" })] })), _jsx("span", { className: "pd-chrome__spacer" }), search?.onPalette ? (_jsx("button", { className: "pd-chrome__icon-btn", type: "button", title: "Search", "aria-label": "Search", onClick: search.onPalette, children: _jsx(SearchButtonIcon, {}) })) : null, chat, notifications, _jsx("button", { className: "pd-chrome__avatar", type: "button", ref: account.triggerRef, onClick: openAccount, "aria-haspopup": "dialog", "aria-expanded": sheet === 'account', "aria-label": "Account and apps", style: { width: 28, height: 28, background: user.colour, border: 0, padding: 0, cursor: 'pointer' }, children: user.avatarUrl ? _jsx("img", { src: user.avatarUrl, alt: "" }) : user.initials })] }), _jsxs("nav", { className: "pd-chrome__tabs", "aria-label": "Primary", children: [tabs.map((item) => {
                        const active = item.id === activeNavId;
                        return (_jsxs(NavLinkish, { linkComponent: linkComponent, item: item, active: active, className: cx('pd-chrome__tab', active && 'pd-chrome__tab--active'), children: [_jsx(TabIcon, { id: item.id }), _jsx("span", { className: "pd-chrome__tab-label", children: item.label })] }, item.id));
                    }), _jsxs("button", { className: "pd-chrome__tab", type: "button", ref: more.triggerRef, "aria-haspopup": "dialog", "aria-expanded": sheet === 'more', onClick: () => setSheet(sheet === 'more' ? null : 'more'), children: [_jsx(MoreIcon, {}), _jsx("span", { className: "pd-chrome__tab-label", children: "More" })] })] }), sheet === 'account' ? (_jsx("div", { className: "pd-chrome pd-chrome__sheet-overlay", children: _jsx("div", { className: "pd-chrome__panel pd-chrome__panel--account pd-chrome__sheet", role: "dialog", "aria-modal": "true", "aria-label": "Account", ref: account.containerRef, children: _jsx(AccountPanelBody, { user: user, appsVisible: appsVisible, onAppsVisibleChange: onAppsVisibleChange, onSignOut: onSignOut, onEditProfile: onEditProfile, accountLinks: accountLinks, accountActions: accountActions, linkComponent: linkComponent, extra: apps.length >= 2 ? (_jsxs(_Fragment, { children: [_jsx("span", { className: "pd-chrome__panel-label", children: "Your apps" }), apps.map((app) => app.app === currentApp ? (_jsxs("span", { className: "pd-chrome__app-row pd-chrome__app-row--current", "aria-current": "page", children: [_jsx("span", { className: "pd-chrome__app-row-mark", children: appGlyph(app.app, 14, app.fullLabel) }), _jsxs("span", { className: "pd-chrome__app-row-text", children: [_jsx("span", { className: "pd-chrome__app-row-title", children: app.fullLabel }), _jsx("span", { className: "pd-chrome__app-row-desc", children: app.description })] }), _jsx("span", { className: "pd-chrome__here", children: "Here" })] }, app.app)) : (_jsxs("a", { className: "pd-chrome__app-row", href: app.url, children: [_jsx("span", { className: "pd-chrome__app-row-mark", children: appGlyph(app.app, 14, app.fullLabel) }), _jsxs("span", { className: "pd-chrome__app-row-text", children: [_jsx("span", { className: "pd-chrome__app-row-title", children: app.fullLabel }), _jsx("span", { className: "pd-chrome__app-row-desc", children: app.description })] })] }, app.app))), _jsx("span", { className: "pd-chrome__panel-divider" })] })) : null }) }) })) : null, sheet === 'more' ? (_jsx("div", { className: "pd-chrome pd-chrome__sheet-overlay", children: _jsxs("div", { className: "pd-chrome__panel pd-chrome__panel--account pd-chrome__sheet", role: "dialog", "aria-modal": "true", "aria-label": "More", ref: more.containerRef, children: [_jsx("span", { className: "pd-chrome__panel-label", children: "Go to" }), nav.map((item) => {
                            const active = item.id === activeNavId;
                            // Choosing a destination has to dismiss the sheet, or it
                            // stays parked over whatever you just asked for. Nothing
                            // else closed it: a router host navigates underneath a
                            // still-open dialog, and a host doing view swaps never
                            // leaves the page at all. Composed rather than replacing,
                            // so a host's own onClick still runs.
                            const row = {
                                ...item,
                                onClick: (event) => {
                                    item.onClick?.(event);
                                    setSheet(null);
                                },
                            };
                            return (_jsxs(NavLinkish, { linkComponent: linkComponent, item: row, active: active, className: "pd-chrome__menu-row", children: [item.label, item.badge && item.badge > 0 ? (_jsx("span", { className: "pd-chrome__count", children: formatCount(item.badge) })) : null] }, item.id));
                        })] }) })) : null] }));
}
//# sourceMappingURL=MobileChrome.js.map