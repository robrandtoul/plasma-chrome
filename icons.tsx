/* ─────────────────────────────────────────────────────────────
   @plasma/chrome — inline SVG.

   Copied verbatim from reference/chrome-reference.html rather than
   imported from lucide-react: the reference markup inlines them,
   and inlining is also what keeps this folder dependency-free.

   Only the glyphs the reference actually renders live here. An id
   with no entry falls back to the reference's own panel glyph
   rather than to artwork invented outside the design.
   ─────────────────────────────────────────────────────────── */

import type { JSX } from 'react';

export function SearchIcon(): JSX.Element {
  return (
    <svg
      className="pd-chrome__search-icon"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  );
}

/** The collapsed-search and mobile-bar glyph: 18px, stroke 1.8. */
export function SearchButtonIcon(): JSX.Element {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  );
}

export function ChatIcon(): JSX.Element {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2Z" />
      <path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1" />
    </svg>
  );
}

export function BellIcon(): JSX.Element {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      <path d="M21 15H3a2 2 0 0 0 2-2V9a7 7 0 0 1 14 0v4a2 2 0 0 0 2 2Z" />
    </svg>
  );
}

/* ── Mobile tab glyphs: 22px, stroke 1.6 ─────────────────── */

function tabSvg(children: JSX.Element, linejoin = true): JSX.Element {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin={linejoin ? 'round' : undefined}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const LAYERS = (
  <>
    <path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" />
    <path d="m6.08 11-3.5 1.6a1 1 0 0 0 0 1.81l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9a1 1 0 0 0 0-1.83L17.9 11" />
  </>
);

const PACKAGE = (
  <>
    <path d="m7.5 4.27 9 5.15" />
    <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
    <path d="M3.3 7 12 12l8.7-5" />
    <path d="M12 22V12" />
  </>
);

const CHAT = (
  <>
    <path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2Z" />
    <path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1" />
  </>
);

const BELL = (
  <>
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    <path d="M21 15H3a2 2 0 0 0 2-2V9a7 7 0 0 1 14 0v4a2 2 0 0 0 2 2Z" />
  </>
);

const PANELS = (
  <>
    <rect x="3" y="3" width="7" height="9" />
    <rect x="14" y="3" width="7" height="5" />
    <rect x="14" y="12" width="7" height="9" />
    <rect x="3" y="16" width="7" height="5" />
  </>
);

const BARS = (
  <>
    <path d="M3 3v16a2 2 0 0 0 2 2h16" />
    <path d="M18 17V9" />
    <path d="M13 17V5" />
    <path d="M8 17v-3" />
  </>
);

const ELLIPSIS = (
  <>
    <circle cx="12" cy="12" r="1" />
    <circle cx="19" cy="12" r="1" />
    <circle cx="5" cy="12" r="1" />
  </>
);

const TAB_GLYPHS: Record<string, JSX.Element> = {
  proofs: LAYERS,
  dashboard: LAYERS,
  orders: PACKAGE,
  chat: CHAT,
  messages: CHAT,
  activity: BELL,
  notifications: BELL,
  insights: BARS,
  analytics: BARS,
};

export function TabIcon({ id }: { id: string }): JSX.Element {
  return tabSvg(TAB_GLYPHS[id] ?? PANELS);
}

export function MoreIcon(): JSX.Element {
  return tabSvg(ELLIPSIS, false);
}
