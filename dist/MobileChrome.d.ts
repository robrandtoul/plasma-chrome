import type { JSX } from 'react';
import type { ChromeApp, ChromeLinkComponent, ChromeNavItem, ChromeSearch, ChromeUser, ChromeAccountAction, ChromeAccountLinks } from './types.js';
export interface MobileChromeProps {
    apps: ChromeApp[];
    currentApp: string;
    appName: string;
    nav: ChromeNavItem[];
    activeNavId: string | null;
    mobileTabIds: string[];
    mobileTabs?: ChromeNavItem[];
    accountLinks?: ChromeAccountLinks;
    accountActions?: ChromeAccountAction[];
    user: ChromeUser;
    linkComponent?: ChromeLinkComponent;
    search?: ChromeSearch;
    appsVisible: boolean;
    onAppsVisibleChange: (next: boolean) => void;
    onSignOut: () => void;
    onEditProfile?: () => void;
}
export declare function MobileChrome(props: MobileChromeProps): JSX.Element;
//# sourceMappingURL=MobileChrome.d.ts.map