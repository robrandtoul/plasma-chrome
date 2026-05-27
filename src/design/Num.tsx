import { type HTMLAttributes } from 'react'

type NumSize = 'sm' | 'md' | 'xl' | '2xl' | '3xl'

interface NumProps extends HTMLAttributes<HTMLSpanElement> {
  size?: NumSize
  children: React.ReactNode
}

const SIZE_CLASS: Record<NumSize, string> = {
  sm: 'num num-sm',
  md: 'num num-md',
  xl: 'num num-xl',
  '2xl': 'num num-2xl',
  '3xl': 'num num-3xl',
}

// Numeric specimen — monospace with tabular numerals on. Wraps the
// .num + .num-* classes from design-tokens.css so callers don't have
// to know the class names.
export function Num({ size = 'md', className = '', children, ...rest }: NumProps) {
  return (
    <span className={[SIZE_CLASS[size], className].filter(Boolean).join(' ')} {...rest}>
      {children}
    </span>
  )
}

export default Num
