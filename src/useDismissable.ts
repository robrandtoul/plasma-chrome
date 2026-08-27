/* ─────────────────────────────────────────────────────────────
   Popover dismissal: outside click, Escape, and focus return.

   React 18 compatible — refs and effects only, no React 19 APIs.
   ─────────────────────────────────────────────────────────── */

import { useEffect, useRef } from 'react';

const FOCUSABLE =
  'a[href], button, input, select, textarea, summary, [contenteditable], [tabindex]:not([tabindex="-1"])';

/* The refs are typed structurally rather than as React's own
   `RefObject`, because the two supported majors disagree about what
   that type means. @types/react 18 declares `readonly current: T |
   null`; 19 declares `current: T` and moves the null into `Ref<T>`.
   So `RefObject<HTMLDivElement | null>` passes on 19 and fails 18's
   variance check, while `RefObject<HTMLDivElement>` does the reverse:
   no spelling of React's own type satisfies both. `{ current: T |
   null }` is what both versions structurally are, and is assignable
   to the `ref` prop under either. */
export interface Dismissable {
  /** Wrap trigger + panel. Clicks inside are not "outside". */
  containerRef: { current: HTMLDivElement | null };
  /** The control that opened the panel; focus returns here. */
  triggerRef: { current: HTMLButtonElement | null };
}

export function useDismissable(open: boolean, onClose: () => void): Dismissable {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // Held in a ref so a fresh inline closure from the parent does not
  // tear down and re-subscribe the listeners on every render.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    const focusTrigger = () => {
      const trigger = triggerRef.current;
      if (trigger && document.contains(trigger)) trigger.focus();
    };

    const onPointerDown = (event: Event) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (containerRef.current && containerRef.current.contains(target)) return;
      // The trigger sits inside the container for the two popovers, but not
      // for the mobile sheets, whose panel is a sibling of the avatar.
      // Letting a press on the trigger count as "outside" would close on
      // mousedown and reopen again on the click that follows.
      if (triggerRef.current && triggerRef.current.contains(target)) return;

      const element =
        target instanceof Element ? target : (target.parentElement as Element | null);
      // Returning focus to the trigger is right when the click landed on
      // dead page space. When it landed on something that will take focus
      // itself, yanking focus back to the trigger would be worse than not
      // returning it, so we leave it where the person put it.
      const landsOnFocusable = !!element?.closest(FOCUSABLE);

      closeRef.current();
      if (!landsOnFocusable) focusTrigger();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      closeRef.current();
      focusTrigger();
    };

    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('touchstart', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('touchstart', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  return { containerRef, triggerRef };
}
