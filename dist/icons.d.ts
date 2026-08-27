import type { JSX } from 'react';
export declare function SearchIcon(): JSX.Element;
/** The collapsed-search and mobile-bar glyph: 18px, stroke 1.8. */
export declare function SearchButtonIcon(): JSX.Element;
export declare function ChatIcon(): JSX.Element;
export declare function BellIcon(): JSX.Element;
export declare function TabIcon({ id }: {
    id: string;
}): JSX.Element;
export declare function MoreIcon(): JSX.Element;
export declare function hasAppGlyph(app: string): boolean;
export declare function AppGlyph({ app, size }: {
    app: string;
    size: number;
}): JSX.Element | null;
/**
 * The mark for an app: its own glyph where we have one, otherwise the
 * initial of its name. The fallback matters because the app menu lists
 * whatever `my_apps()` returns, which can include an app added to
 * `public.apps` before a glyph for it is added here.
 */
export declare function appGlyph(app: string, size: number, fallbackName: string): JSX.Element | string;
//# sourceMappingURL=icons.d.ts.map