interface Ink {
  name: string
  hex: string
}

interface InkSwatchProps {
  ink: Ink
  /** Pixel size of the square. Default 28. */
  size?: number
  /** Render the ink name inline next to the swatch. */
  showLabel?: boolean
  className?: string
}

// Square colour swatch with a hairline border. Tooltips on hover via
// the native `title` attribute; aria-label exposes the ink name to
// screen readers. When showLabel is true, the swatch + name render
// as a single inline-flex chip (8px gap, 14px text).
export function InkSwatch({ ink, size = 28, showLabel = false, className = '' }: InkSwatchProps) {
  const square = (
    <span
      title={ink.name}
      aria-label={ink.name}
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: 4,
        backgroundColor: ink.hex,
      }}
      className={['border border-line flex-shrink-0', !showLabel ? className : ''].filter(Boolean).join(' ')}
    />
  )
  if (!showLabel) return square
  return (
    <span className={['inline-flex items-center gap-2 text-sm text-ink', className].filter(Boolean).join(' ')}>
      {square}
      <span>{ink.name}</span>
    </span>
  )
}

export default InkSwatch
