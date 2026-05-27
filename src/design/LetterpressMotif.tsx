interface LetterpressMotifProps {
  /** Square pixel dimension. Default 320. */
  size?: number
  /** Stroke opacity. Default 0.18. */
  opacity?: number
  /** Absolute top offset. Default 64. */
  top?: number
  /** Absolute right offset. Default -40. */
  right?: number
  /** Stroke colour. Default 'white' (intended for ink-filled panels). */
  colour?: string
  className?: string
}

// Decorative three-line letterpress motif at 15°. Used on the login
// brand panel and the customer-page sign-off card. Parent must be
// position: relative; overflow: hidden so the absolute-positioned
// SVG can hang off the edge without clipping the layout.
export function LetterpressMotif({
  size = 320,
  opacity = 0.18,
  top = 64,
  right = -40,
  colour = 'white',
  className = '',
}: LetterpressMotifProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={colour}
      strokeOpacity={opacity}
      strokeWidth="0.4"
      aria-hidden="true"
      className={className}
      style={{ position: 'absolute', right, top, transform: 'rotate(15deg)', pointerEvents: 'none' }}
    >
      <rect x="3" y="9" width="18" height="2" />
      <rect x="3" y="11" width="18" height="2" />
      <rect x="3" y="13" width="18" height="2" />
    </svg>
  )
}

export default LetterpressMotif
