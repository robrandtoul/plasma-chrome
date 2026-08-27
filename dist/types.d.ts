import type { ComponentType, MouseEvent, ReactNode } from 'react';
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
    onClick?: (event: MouseEvent<HTMLElement>) => void;
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
export interface ChromeAccountAction {
    id: string;
    label: string;
    onClick: () => void;
}
export interface ChromeAccountLinks {
    notifications?: string;
    feedback?: string;
}
export interface ChromeProps {
    apps: ChromeApp[];
    currentApp: string;
    appName?: string;
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
    notifications?: ReactNode;
    notificationsUnread?: number;
    appsVisible?: boolean;
    onAppsVisibleChange?: (next: boolean) => void;
    onSignOut: () => void;
    onEditProfile?: () => void;
    accountLinks?: ChromeAccountLinks;
    accountActions?: ChromeAccountAction[];
    variant?: 'full' | 'switcher-only';
    tabBarPosition?: 'absolute' | 'fixed';
}
/** Counts read as `9+` above nine. */
export declare function formatCount(n: number): string;
/** The app mark is the first letter of the full name, never artwork. */
export declare function markLetter(fullLabel: string): string;
/**
 * The bar shows one word. `name` is meant to be a full name, but every
 * host has some account with no name on file and falls back to the
 * email, and an address has no whitespace to split on — so this used to
 * paint the whole of
 * `someone.with.a.long.name@plasmadesign.co.uk` into a bar whose
 * container is `flex: 0 0 auto` and never shrinks. Degrade to the local
 * part instead: still identifying, and bounded. The account menu's
 * identity block still shows the address in full.
 */
export declare function firstName(name: string): string;
export declare function cx(...parts: Array<string | false | null | undefined>): string;
//# sourceMappingURL=types.d.ts.map