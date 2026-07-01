import { Layers } from 'lucide-react'

type WordmarkSize = 'sm' | 'md' | 'lg' | 'xl'

interface PlasmaWordmarkProps {
  size?: WordmarkSize
  /** Mono-uppercase label under the wordmark. Pass null to hide.
      Default null. */
  tagline?: string | null
  /** Animate the tagline away (height + opacity) rather than removing it.
      Used by the designer header's condense-on-scroll. Default false — every
      other caller (customer page, login) renders the tagline at full height. */
  collapsed?: boolean
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
export function PlasmaWordmark({ size = 'md', tagline = null, collapsed = false, className = '' }: PlasmaWordmarkProps) {
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
            className={[
              'overflow-hidden font-mono font-medium text-ink-mute uppercase transition-all duration-200',
              collapsed ? 'opacity-0' : 'opacity-100 mt-0.5',
            ].join(' ')}
            style={{
              fontSize: d.tag,
              letterSpacing: '0.2em',
              // Fixed heights so the tuck animates (auto→0 can't). The expanded
              // box uses the tagline's natural 1.5 line-height so the uppercase
              // caps aren't clipped by overflow-hidden.
              height: collapsed ? 0 : d.tag * 1.5,
            }}
          >
            {tagline}
          </div>
        )}
      </div>
    </div>
  )
}

export default PlasmaWordmark
