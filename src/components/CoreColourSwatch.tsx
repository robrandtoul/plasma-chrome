// Reusable colour swatch for the letterpress core-colour palette
// (migration 000133). Used by:
//   * the customer proof page's Specification spec row
//   * the designer new/edit version dropdown options
//   * the admin /admin/core-colours management table
// Keeping a single component means the visual treatment stays
// consistent across all three surfaces.
//
// The hex value is rendered as an inline style rather than a
// Tailwind class because tokens are user-supplied and Tailwind
// would JIT-strip arbitrary colour classes. A subtle inset ring
// keeps light swatches (e.g. Natural #f5efe0) visible against a
// white background.

import type { CSSProperties } from 'react'

interface CoreColourSwatchProps {
  hex: string
  size?: number
  ariaLabel?: string
  className?: string
  style?: CSSProperties
}

export function CoreColourSwatch({
  hex,
  size = 16,
  ariaLabel,
  className,
  style,
}: CoreColourSwatchProps) {
  return (
    <span
      role={ariaLabel ? 'img' : 'presentation'}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
      className={['inline-block shrink-0 rounded-md', className ?? ''].join(' ')}
      style={{
        width: size,
        height: size,
        backgroundColor: hex,
        boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.10)',
        ...style,
      }}
    />
  )
}
