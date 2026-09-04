// The per-person identity palette — one source of truth for every surface that
// renders "who did this" in colour: the header avatar, the dashboard designer
// chip, feedback cards, announcements and team chat.
//
// This module exists because the same four-entry map had been copy-pasted into
// five files (DesignerHeader, DesignerAvatar, feedback.ts, teamChat.ts, plus the
// type in dashboardGrouping.ts). Each copy carried a comment explaining it was
// deliberately duplicated "to keep this module standalone" — which was fine at
// four fixed colours, and stopped being fine the moment we needed a fifth:
// adding a colour to four of the five files leaves the fifth rendering that
// person grey, silently, on one screen only. Add a colour here and everywhere
// picks it up.
//
// Keep DESIGNER_COLOURS in lockstep with the CHECK constraint on
// profiles.designer_colour (migration 000330) — the database is what stops an
// unknown name being stored in the first place.

export type DesignerColour =
  | 'blue'
  | 'teal'
  | 'coral'
  | 'purple'
  | 'gold'
  | 'pink'
  | 'cyan'

// Assignment order for new staff: the first free colour down this list wins, so
// the most visually distinct pairs get used first and near-neighbours (gold
// against coral, cyan against blue) only come into play on a bigger team.
export const DESIGNER_COLOURS: DesignerColour[] = [
  'blue',
  'teal',
  'coral',
  'purple',
  'gold',
  'pink',
  'cyan',
]

// The first four map onto reskin tokens so a person's colour tracks the design
// system; purple never had a token match and the three added in 000330 are
// hand-picked to sit clear of the existing hues at avatar size.
// ⚠ Each token carries its literal as a FALLBACK, and that is what makes this
// module portable. In proof-viewer these resolved against that app's own
// design tokens; two of the four apps define no such variables at all, so a
// bare var() would have rendered every avatar and every chat bubble in the
// unknown-colour grey. With the fallback, an app that HAS the tokens still
// tracks its design system, and an app that does not gets the intended colour.
const COLOUR_CSS: Record<DesignerColour, string> = {
  blue: 'var(--c-allocated, #2b6df5)',
  teal: 'var(--c-in-stock, #0e9b4e)', // reads green
  coral: 'var(--c-brand, #ff5b3a)', // reads orange
  purple: '#7b3ff2',
  gold: '#b07d00',
  pink: '#db2777',
  cyan: '#0891b2',
}

// Human-facing names for the picker. "Teal" and "Coral" are the stored names
// and predate the reskin that moved them to green and orange; the labels say
// what you actually see, since that is what someone is choosing between.
const COLOUR_LABELS: Record<DesignerColour, string> = {
  blue: 'Blue',
  teal: 'Green',
  coral: 'Orange',
  purple: 'Purple',
  gold: 'Gold',
  pink: 'Pink',
  cyan: 'Cyan',
}

const UNKNOWN = 'var(--c-ink-mute, #8a8a8a)'

export function isDesignerColour(value: string | null | undefined): value is DesignerColour {
  return value != null && value in COLOUR_CSS
}

/** Solid identity colour — avatar fills, badge backgrounds, chip text. */
export function designerColourCss(colour: string | null | undefined, fallback?: DesignerColour): string {
  if (isDesignerColour(colour)) return COLOUR_CSS[colour]
  return fallback ? COLOUR_CSS[fallback] : UNKNOWN
}

export function designerColourLabel(colour: DesignerColour): string {
  return COLOUR_LABELS[colour]
}

/**
 * A wash of someone's colour over whatever sits behind it — the house tint
 * idiom already used by DesignerAvatar, ProofStatusPill and PanelShell.
 * 14% is the established strength for small chips; large filled areas such as
 * a chat bubble want roughly 10% or the colour stops reading as a background.
 */
export function designerTint(colour: string | null | undefined, percent = 14): string {
  return `color-mix(in srgb, ${designerColourCss(colour)} ${percent}%, transparent)`
}
