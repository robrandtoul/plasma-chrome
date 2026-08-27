import type { JSX, ReactNode } from 'react';
import type { ChromeAccountLinks, ChromeLinkComponent, ChromeUser } from './types.js';
export declare function Avatar({ user, large, size, }: {
    user: ChromeUser;
    large?: boolean;
    size?: number;
}): JSX.Element;
export interface AccountPanelBodyProps {
    user: ChromeUser;
    appsVisible: boolean;
    onAppsVisibleChange: (next: boolean) => void;
    onSignOut: () => void;
    onEditProfile?: () => void;
    accountLinks?: ChromeAccountLinks;
    linkComponent?: ChromeLinkComponent;
    /** Rendered between the identity block and the preference row.
        The mobile sheet puts the app list here, because that is where
        app switching lives on a phone. */
    extra?: ReactNode;
}
/** Shared by the desktop popover and the mobile account sheet. */
export declare function AccountPanelBody({ user, appsVisible, onAppsVisibleChange, onSignOut, onEditProfile, accountLinks, linkComponent, extra, }: AccountPanelBodyProps): JSX.Element;
export interface AccountMenuProps extends AccountPanelBodyProps {
    open: boolean;
    onOpen: () => void;
    onClose: () => void;
}
export declare function AccountMenu({ open, onOpen, onClose, ...body }: AccountMenuProps): JSX.Element;
//# sourceMappingURL=AccountMenu.d.ts.map