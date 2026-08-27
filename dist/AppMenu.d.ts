import type { JSX } from 'react';
import type { ChromeApp } from './types.js';
export interface AppMenuProps {
    apps: ChromeApp[];
    currentApp: string;
    appName: string;
    open: boolean;
    onOpen: () => void;
    onClose: () => void;
    appsVisible: boolean;
    onAppsVisibleChange: (next: boolean) => void;
}
export declare function AppMenu({ apps, currentApp, appName, open, onOpen, onClose, appsVisible, onAppsVisibleChange, }: AppMenuProps): JSX.Element;
//# sourceMappingURL=AppMenu.d.ts.map