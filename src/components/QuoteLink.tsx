// Persistent "Quote" link rendered in every authenticated page's
// header so a designer can jump to the quote compiler the moment
// the phone rings, without losing their current tab. Opens
// /quote in a new tab (target=_blank) per the brief — context in
// the originating tab stays exactly as the designer left it.
//
// Pairs with src/lib/useQuoteShortcut.ts which fires the same
// navigation from a Cmd-K / Ctrl-K shortcut. The "⌘K" hint inside
// the link teaches the shortcut without a separate help layer.
//
// Today this is dropped into six different page headers. A
// future "extract shared dashboard header" pass should inline
// this once and remove the per-page insertions.

export function QuoteLink({ variant = 'header' }: { variant?: 'header' | 'inline' }) {
  if (variant === 'inline') {
    return (
      <a
        href="/quote"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-2 text-sm font-medium text-ink-mute hover:text-ink"
      >
        <span>Quote compiler</span>
        <kbd className="rounded border border-line bg-canvas px-1.5 py-0.5 font-mono text-[10px] text-ink-mute">⌘K</kbd>
      </a>
    )
  }
  return (
    <a
      href="/quote"
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-ink ring-1 ring-line hover:bg-surface"
    >
      <span>Quote compiler</span>
      <kbd className="rounded border border-line bg-canvas px-1.5 py-0.5 font-mono text-[10px] text-ink-mute">⌘K</kbd>
    </a>
  )
}
