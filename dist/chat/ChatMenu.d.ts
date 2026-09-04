import { type ChatLinkComponent } from './types.js';
export declare function reopenKey(prefix: string): string;
export interface ChatMenuProps {
    /** We are already on the full chat page, so the dropdown stays shut. */
    active?: boolean;
    /**
     * Whether the host is currently showing somewhere the panel can dock.
     *
     * The host decides, because only the host knows: proof-viewer's dock is a
     * rail that exists on its dashboard at large widths and nowhere else. This
     * used to be `useLocation().pathname === '/'` inside the component, which
     * both hard-coded one app's route and dragged react-router into a package
     * that must not have it (one of the four apps has no router at all).
     */
    dockAvailable?: boolean;
    /**
     * The host's router link, same seam as the chrome's own `linkComponent`.
     * Defaults to a plain anchor, which is correct for an app linking across to
     * another subdomain, and for an app with no router.
     */
    linkComponent?: ChatLinkComponent;
}
export default function ChatMenu({ active, dockAvailable, linkComponent, }: ChatMenuProps): import("react").JSX.Element | null;
//# sourceMappingURL=ChatMenu.d.ts.map