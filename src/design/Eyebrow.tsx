import { type HTMLAttributes } from 'react'

interface EyebrowProps extends HTMLAttributes<HTMLSpanElement> {
  children: React.ReactNode
}

// Tiny wrapper around the `.eyebrow` class from design-tokens.css.
// Use when consumers want a typed component rather than a raw span.
export function Eyebrow({ className = '', children, ...rest }: EyebrowProps) {
  return (
    <span className={['eyebrow', className].filter(Boolean).join(' ')} {...rest}>
      {children}
    </span>
  )
}

export default Eyebrow
