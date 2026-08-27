import type { ComponentType, ReactNode } from 'react';
export interface ChromeApp {
    app: string;
    label: string;
    fullLabel: string;
    description: string;
    url: string;
    role: string;
}
export interface ChromeNavItem {
    id: string;
    label: string;
    href: string;
    badge?: number;
    end?: boolean;
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
    apps: ChromeApp[];
    currentApp: string;
    nav: ChromeNavItem[];
    activeNavId: string | null;
    mobileTabIds: string[];
    mobileTabs?: ChromeNavItem[];
    user: ChromeUser;
    linkComponent?: ChromeLinkComponent;
    search?: ChromeSearch;
    actions?: ReactNode;
    chat?: ReactNode;
    chatUnread?: number;
    chatMentionUnread?: number;
    notificationsUnread?: number;
    appsVisible?: boolean;
    onAppsVisibleChange?: (next: boolean) => void;
    onSignOut: () => void;
    onEditProfile?: () => void;
    accountLinks?: ChromeAccountLinks;
    variant?: 'full' | 'switcher-only';
}
/** Counts read as `9+` above nine. */
export declare function formatCount(n: number): string;
/** The app mark is the first letter of the full name, never artwork. */
export declare function markLetter(fullLabel: string): string;
export declare function firstName(name: string): string;
export declare function cx(...parts: Array<string | false | null | undefined>): string;
//# sourceMappingURL=types.d.ts.map