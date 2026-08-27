import type { JSX, ReactNode } from 'react';
import type { ChromeLinkComponent, ChromeNavItem, ChromeSearch, ChromeUser, ChromeAccountAction, ChromeAccountLinks } from './types.js';
import type { ChromeApp } from './types.js';
/**
 * The router seam. The chrome renders whatever it is handed and never
 * imports react-router: `href` always goes through, and `end` goes
 * through only when the item declares it and the host supplied a
 * component (a bare `<a>` has no use for it).
 */
export declare function NavLinkish({ linkComponent, item, className, active, children, }: {
    linkComponent: ChromeLinkComponent | undefined;
    item: ChromeNavItem;
    className: string;
    active: boolean;
    children: ReactNode;
}): JSX.Element;
export interface HeaderBarProps {
    apps: ChromeApp[];
    currentApp: string;
    appName: string;
    nav: ChromeNavItem[];
    activeNavId: string | null;
    user: ChromeUser;
    linkComponent?: ChromeLinkComponent;
    accountLinks?: ChromeAccountLinks;
    accountActions?: ChromeAccountAction[];
    search?: ChromeSearch;
    actions?: ReactNode;
    chat?: ReactNode;
    chatUnread?: number;
    chatMentionUnread?: number;
    notifications?: ReactNode;
    notificationsUnread?: number;
    appsVisible: boolean;
    onAppsVisibleChange: (next: boolean) => void;
    onSignOut: () => void;
    onEditProfile?: () => void;
}
export declare function HeaderBar(props: HeaderBarProps): JSX.Element;
//# sourceMappingURL=HeaderBar.d.ts.map