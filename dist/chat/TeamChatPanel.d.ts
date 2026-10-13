import { type ReactNode } from 'react';
import { type ChatLinkComponent } from './types.js';
/**
 * One entry in the panel's ⋯ menu, provided by the host surface: where chat
 * lives (pop out, dock, the full page) and whether it stays open. The panel
 * owns the rest of the menu (sounds, alerts, status) itself.
 */
export interface ChatPlacementItem {
    key: string;
    label: string;
    icon?: ReactNode;
    /** An action. Closing the menu is the panel's job. */
    onSelect?: () => void;
    /** A router link instead of an action, rendered through `linkComponent`. */
    to?: string;
    /** A toggle: drawn with its state, as "on" / "off". */
    checked?: boolean;
}
interface TeamChatPanelProps {
    variant: 'dropdown' | 'page' | 'docked' | 'popout';
    /** The ⋯ menu's first section. See `ChatPlacementItem`. */
    placementItems?: ChatPlacementItem[];
    /** A control at the far right of the header: close, undock, back. */
    headerAction?: ReactNode;
    /** The host's router link, for `to` items. Defaults to a plain anchor. */
    linkComponent?: ChatLinkComponent;
}
export declare function BotTag(): import("react").JSX.Element;
export default function TeamChatPanel({ variant, placementItems, headerAction, linkComponent, }: TeamChatPanelProps): import("react").JSX.Element;
export {};
//# sourceMappingURL=TeamChatPanel.d.ts.map