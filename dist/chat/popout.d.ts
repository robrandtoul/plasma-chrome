export declare const POPOUT_PARAM = "popout";
/**
 * The popout's URL, built from the host's own chat route.
 *
 * It is per-app rather than a constant because each app owns where its chat
 * page lives; opening `/chat` in an app that mounts it elsewhere would pop out
 * a 404.
 */
export declare function popoutPath(fullPagePath: string): string;
/**
 * A named window, so pressing "Pop out" twice focuses the one that exists
 * instead of opening a second.
 *
 * ⚠ Window names are keyed per BROWSER, not per origin, and the four staff
 * apps share one SSO session. A constant here would mean pressing "Pop out"
 * in Stock re-uses and navigates the window Proofs already had open, which is
 * why the name is derived from the app's own storage prefix.
 */
export declare function popoutWindowName(prefix: string): string;
export declare function popoutSessionKey(prefix: string): string;
export declare function popoutSizeKey(prefix: string): string;
/**
 * The same-origin channel that keeps an app's OWN windows in step: a second
 * tab, and the popped-out window.
 *
 * ⚠ It is origin-scoped, so it stops at the app boundary and can never carry
 * anything to another of the four apps. Cross-app agreement rides the shared
 * Supabase realtime topic instead (see the 'seen' broadcast in store.tsx);
 * this one exists for the popout handshake and single-window sound
 * ownership, both of which are genuinely local questions.
 */
export declare function syncChannelName(prefix: string): string;
export declare const POPOUT_HEARTBEAT_MS = 2000;
export declare const POPOUT_ALIVE_MS = 6000;
export type ChatSyncMessage = 
/** Someone read a thread in another window — clear it here too. */
{
    kind: 'seen';
    thread: string;
    at: string;
}
/** The popped-out window announcing itself (on open, then on every beat). */
 | {
    kind: 'popout-alive';
}
/** The popped-out window closing tidily. */
 | {
    kind: 'popout-closed';
}
/** "Bring chat back" pressed in the app — asks the popout to close itself.
 *  Needed because a reload of the main window loses its handle on the popout
 *  but not its ability to talk to it. */
 | {
    kind: 'popout-close-request';
};
export declare const DEFAULT_POPOUT_SIZE: {
    w: number;
    h: number;
};
export declare const MIN_POPOUT_W = 300;
export declare const MIN_POPOUT_H = 320;
export declare function clampPopoutSize(size: {
    w: number;
    h: number;
}): {
    w: number;
    h: number;
};
/** Whether a location's query string marks this window as the popout. */
export declare function isPopoutSearch(search: string): boolean;
/**
 * A popout stays a popout for the life of its window, even after it navigates
 * somewhere that drops the query string — so the answer is recorded once, in
 * tab-scoped storage, rather than re-read from the URL each time.
 */
export declare function isPopoutWindow(prefix: string): boolean;
/** Has the popped-out window been heard from recently enough to still count? */
export declare function popoutIsAlive(lastBeatAt: number, now: number): boolean;
/**
 * The stored popout size, or null when this browser has never saved one.
 * Distinguishing "never set" from "set to the default" is what lets the store
 * publish a pre-existing local size up to the profile without every app racing
 * to write the same default over each other.
 */
export declare function readStoredPopoutSize(prefix: string): {
    w: number;
    h: number;
} | null;
export declare function readPopoutSize(prefix: string): {
    w: number;
    h: number;
};
export declare function writePopoutSize(prefix: string, size: {
    w: number;
    h: number;
}): void;
/**
 * window.open features for the fallback route: a chrome-light window parked
 * just inside the right-hand edge of `anchor` — the app window's own position
 * and width — so the popout lands beside the app, on whichever screen the app
 * happens to be on, rather than always on the primary monitor.
 */
export declare function windowFeatures(size: {
    w: number;
    h: number;
}, anchor?: {
    x: number;
    y: number;
    width: number;
}): string;
export declare function supportsDocumentPip(): boolean;
/**
 * A picture-in-picture window starts as a blank document with none of the
 * app's styles, so copy them across. Links are re-linked by absolute URL
 * (their relative font/image URLs would otherwise resolve against the new
 * window's about:blank base); inline <style> blocks — which is how Vite serves
 * CSS in development — are copied verbatim.
 */
export declare function preparePopoutDocument(win: Window): void;
declare global {
    interface DocumentPictureInPictureOptions {
        width?: number;
        height?: number;
        disallowReturnToOpener?: boolean;
        preferInitialWindowPlacement?: boolean;
    }
    interface DocumentPictureInPicture extends EventTarget {
        requestWindow(options?: DocumentPictureInPictureOptions): Promise<Window>;
        readonly window: Window | null;
    }
    interface Window {
        documentPictureInPicture?: DocumentPictureInPicture;
    }
}
//# sourceMappingURL=popout.d.ts.map