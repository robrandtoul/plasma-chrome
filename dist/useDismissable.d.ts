export interface Dismissable {
    /** Wrap trigger + panel. Clicks inside are not "outside". */
    containerRef: {
        current: HTMLDivElement | null;
    };
    /** The control that opened the panel; focus returns here. */
    triggerRef: {
        current: HTMLButtonElement | null;
    };
}
export declare function useDismissable(open: boolean, onClose: () => void): Dismissable;
//# sourceMappingURL=useDismissable.d.ts.map