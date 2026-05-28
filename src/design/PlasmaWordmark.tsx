import { Layers } from 'lucide-react'

type WordmarkSize = 'sm' | 'md' | 'lg' | 'xl'

interface PlasmaWordmarkProps {
  size?: WordmarkSize
  /** Mono-uppercase label under the wordmark. Pass null to hide.
      Default null. */
  tagline?: string | null
  className?: string
}

const DIM: Record<WordmarkSize, { box: number; icon: number; font: number; tag: number }> = {
  sm: { box: 28, icon: 14, font: 14, tag: 8 },
  md: { box: 32, icon: 18, font: 16, tag: 9 },
  lg: { box: 40, icon: 20, font: 22, tag: 11 },
  // xl is md scaled ~1.5x — used on the customer proof page header
  // where the wordmark is the only branding the customer sees.
  xl: { box: 48, icon: 27, font: 24, tag: 13 },
}

// Ink-filled rounded square with a Layers glyph, "PlasmaDesign" set
// in display sans next to it. Tagline (when set) sits below in
// monospace, uppercase, 0.2em tracking. Used on the customer page
// header, login brand panel, and designer chrome.
export function PlasmaWordmark({ size = 'md', tagline = null, className = '' }: PlasmaWordmarkProps) {
  const d = DIM[size]
  return (
    <div className={['inline-flex items-center gap-2.5', className].filter(Boolean).join(' ')}>
      <span
        className="inline-flex items-center justify-center bg-ink text-on-ink rounded-[8px]"
        style={{ width: d.box, height: d.box }}
      >
        <Layers size={d.icon} aria-hidden="true" />
      </span>
      <div className="leading-none">
        <div
          className="font-display font-medium tracking-[-0.02em] text-ink"
          style={{ fontSize: d.font }}
        >
          PlasmaDesign
        </div>
        {tagline !== null && (
          <div
            className="font-mono font-medium text-ink-mute uppercase mt-0.5"
            style={{ fontSize: d.tag, letterSpacing: '0.2em' }}
          >
            {tagline}
          </div>
        )}
      </div>
    </div>
  )
}

export default PlasmaWordmark
