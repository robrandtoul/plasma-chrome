/* ─────────────────────────────────────────────────────────────
   @plasma/chrome/chat — inline SVG.

   The panel came from proof-viewer, where it imported these from
   lucide-react. Three of the four hosts have lucide and one does
   not, and adding it as a dependency would break the package's one
   rule: no runtime dependencies, so that four apps on four different
   stacks can each take an upgrade without negotiating a version.

   So the twenty glyphs the chat actually renders are inlined, the
   same way the navigation chrome next door inlines the six it uses.
   The geometry is Lucide's (ISC licensed) at the version the apps
   already ship, `lucide-react` 0.439, so nothing changes visually
   for the two apps that had it.

   The props mirror lucide's: `size` sets both dimensions and
   defaults to 24, `className` passes through, and stroke follows
   `currentColor` so a colour utility on the element still works.
   ─────────────────────────────────────────────────────────── */

import type { JSX, SVGProps } from 'react';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'width' | 'height'> {
  size?: number | string;
}

function icon(name: string, children: JSX.Element) {
  function Glyph({ size = 24, ...rest }: IconProps): JSX.Element {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        {...rest}
      >
        {children}
      </svg>
    );
  }
  Glyph.displayName = name;
  return Glyph;
}

export const Send = icon(
  'Send',
  <>
    <path d="m22 2-7 20-4-9-9-4Z" />
    <path d="M22 2 11 13" />
  </>,
);

export const Trash2 = icon(
  'Trash2',
  <>
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <line x1="10" x2="10" y1="11" y2="17" />
    <line x1="14" x2="14" y1="11" y2="17" />
  </>,
);

export const ChevronDown = icon('ChevronDown', <path d="m6 9 6 6 6-6" />);

export const Check = icon('Check', <path d="M20 6 9 17l-5-5" />);

export const Volume2 = icon(
  'Volume2',
  <>
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
  </>,
);

export const VolumeX = icon(
  'VolumeX',
  <>
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <line x1="22" x2="16" y1="9" y2="15" />
    <line x1="16" x2="22" y1="9" y2="15" />
  </>,
);

export const SearchIcon = icon(
  'Search',
  <>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </>,
);

export const X = icon(
  'X',
  <>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </>,
);

export const Paperclip = icon(
  'Paperclip',
  <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />,
);

export const FileText = icon(
  'FileText',
  <>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    <path d="M10 9H8" />
    <path d="M16 13H8" />
    <path d="M16 17H8" />
  </>,
);

export const FileIcon = icon(
  'File',
  <>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
  </>,
);

export const Download = icon(
  'Download',
  <>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" x2="12" y1="15" y2="3" />
  </>,
);

export const Smile = icon(
  'Smile',
  <>
    <circle cx="12" cy="12" r="10" />
    <path d="M8 14s1.5 2 4 2 4-2 4-2" />
    <line x1="9" x2="9.01" y1="9" y2="9" />
    <line x1="15" x2="15.01" y1="9" y2="9" />
  </>,
);

export const MessagesSquare = icon(
  'MessagesSquare',
  <>
    <path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4c0-1.1.9-2 2-2h8a2 2 0 0 1 2 2Z" />
    <path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1" />
  </>,
);

export const Maximize2 = icon(
  'Maximize2',
  <>
    <polyline points="15 3 21 3 21 9" />
    <polyline points="9 21 3 21 3 15" />
    <line x1="21" x2="14" y1="3" y2="10" />
    <line x1="3" x2="10" y1="21" y2="14" />
  </>,
);

export const Pin = icon(
  'Pin',
  <>
    <path d="M12 17v5" />
    <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
  </>,
);

export const AtSign = icon(
  'AtSign',
  <>
    <circle cx="12" cy="12" r="4" />
    <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
  </>,
);

export const PanelRight = icon(
  'PanelRight',
  <>
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M15 3v18" />
  </>,
);

export const PictureInPicture2 = icon(
  'PictureInPicture2',
  <>
    <path d="M21 9V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4" />
    <rect width="10" height="7" x="12" y="13" rx="2" />
  </>,
);

export const CornerUpLeft = icon(
  'CornerUpLeft',
  <>
    <polyline points="9 14 4 9 9 4" />
    <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
  </>,
);
