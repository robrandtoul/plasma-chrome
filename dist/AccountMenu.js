import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { cx, firstName } from './types.js';
import { useDismissable } from './useDismissable.js';
import { PREF_TITLE, Toggle, prefHint } from './Toggle.js';
export function Avatar({ user, large, size, }) {
    const style = size
        ? { background: user.colour, width: size, height: size }
        : { background: user.colour };
    return (_jsx("span", { className: cx('pd-chrome__avatar', large && 'pd-chrome__avatar--lg'), style: style, children: user.avatarUrl ? _jsx("img", { src: user.avatarUrl, alt: "" }) : user.initials }));
}
/** Shared by the desktop popover and the mobile account sheet. */
export function AccountPanelBody({ user, appsVisible, onAppsVisibleChange, onSignOut, onEditProfile, accountLinks, accountActions, linkComponent, extra, showAppsPreference, }) {
    const Link = linkComponent ?? 'a';
    return (_jsxs(_Fragment, { children: [_jsxs("div", { className: "pd-chrome__identity", children: [_jsx(Avatar, { user: user, large: true }), _jsxs("span", { className: "pd-chrome__identity-text", children: [_jsx("span", { className: "pd-chrome__identity-name", children: user.name }), _jsxs("span", { className: "pd-chrome__identity-meta", children: [user.email, " \u00B7 ", user.roleLabel] })] })] }), _jsx("span", { className: "pd-chrome__panel-divider", style: { margin: '0 10px 6px' } }), extra, showAppsPreference === false ? null : (_jsxs("button", { className: "pd-chrome__pref", type: "button", role: "menuitemcheckbox", "aria-checked": appsVisible, onClick: () => onAppsVisibleChange(!appsVisible), children: [_jsxs("span", { className: "pd-chrome__pref-text", children: [_jsx("span", { className: "pd-chrome__pref-title", children: PREF_TITLE }), _jsx("span", { className: "pd-chrome__pref-hint", children: prefHint(appsVisible) })] }), _jsx(Toggle, { on: appsVisible })] })), accountLinks?.notifications ? (_jsx(Link, { className: "pd-chrome__menu-row", role: "menuitem", href: accountLinks.notifications, children: "Notifications" })) : null, onEditProfile ? (_jsx("button", { className: "pd-chrome__menu-row", type: "button", role: "menuitem", onClick: onEditProfile, children: "Edit profile" })) : null, accountLinks?.feedback ? (_jsx(Link, { className: "pd-chrome__menu-row", role: "menuitem", href: accountLinks.feedback, children: "Feedback" })) : null, (accountActions ?? []).map((action) => (_jsx("button", { className: "pd-chrome__menu-row", type: "button", role: "menuitem", onClick: action.onClick, children: action.label }, action.id))), _jsx("span", { className: "pd-chrome__panel-divider" }), _jsx("button", { className: "pd-chrome__menu-row pd-chrome__signout", type: "button", role: "menuitem", onClick: onSignOut, children: "Sign out" })] }));
}
export function AccountMenu({ open, onOpen, onClose, ...body }) {
    const { containerRef, triggerRef } = useDismissable(open, onClose);
    const { user } = body;
    return (_jsxs("div", { className: "pd-chrome__account-wrap", ref: containerRef, children: [_jsxs("button", { className: "pd-chrome__account", type: "button", ref: triggerRef, "aria-expanded": open, "aria-haspopup": "menu", "aria-label": "Account menu", onClick: () => (open ? onClose() : onOpen()), children: [_jsx(Avatar, { user: user }), _jsx("span", { className: "pd-chrome__account-name", children: firstName(user.name) }), _jsx("span", { className: "pd-chrome__chevron", "aria-hidden": "true" })] }), open ? (_jsx("div", { className: "pd-chrome__panel pd-chrome__panel--account", role: "menu", children: _jsx(AccountPanelBody, { ...body, onSignOut: () => {
                        onClose();
                        body.onSignOut();
                    }, onEditProfile: body.onEditProfile
                        ? () => {
                            onClose();
                            body.onEditProfile?.();
                        }
                        : undefined, accountActions: body.accountActions?.map((action) => ({
                        ...action,
                        onClick: () => {
                            onClose();
                            action.onClick();
                        },
                    })) }) })) : null] }));
}
//# sourceMappingURL=AccountMenu.js.map