import { type InputHTMLAttributes, forwardRef } from 'react'

type InputSize = 'sm' | 'md'

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: InputSize
  /** Render an out-coloured border + ring to signal a validation error. */
  invalid?: boolean
}

const SIZE_CLASS: Record<InputSize, string> = {
  sm: 'h-[34px] rounded-[6px] text-[13px] px-2.5',
  md: 'h-[38px] rounded-[8px] text-sm px-3',
}

// 38px (md) / 34px (sm) tall, hairline border, surface fill. Focus
// ring is a brand-500/30 halo. iOS Safari quirk (auto-zoom on <16px
// inputs) is already handled by the @media rule in design-tokens.css.
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { size = 'md', invalid = false, className = '', ...rest },
  ref,
) {
  // Focus styling notes:
  // - `outline-none` at the base is intentionally omitted: in
  //   Tailwind v4 it pins `--tw-outline-style: none` on the element,
  //   which `focus:outline-2` then reads back inside the focus state,
  //   collapsing the halo to invisible.
  // - Focus colour utilities reference the raw `--c-*` properties via
  //   arbitrary-value syntax rather than the bridged `--color-*`
  //   names. The bridged colours work for non-focus utilities, but
  //   Tailwind v4's nested `&:focus { border-color: var(--color-...) }`
  //   rule isn't reliably winning the cascade against the static
  //   `border-line` / `border-out` setters on the same element.
  //   Arbitrary values sidestep that.
  const focusBorder = invalid
    ? 'focus:border-[var(--c-out)] focus:outline-[var(--c-out)]'
    : 'focus:border-[var(--c-brand)] focus:outline-[var(--c-focus)]'
  const cls = [
    'w-full bg-surface text-ink font-sans border transition-colors',
    'focus:outline-2 focus:outline-offset-1',
    SIZE_CLASS[size],
    invalid ? 'border-out' : 'border-line',
    focusBorder,
    'disabled:bg-canvas disabled:text-ink-mute disabled:cursor-not-allowed',
    className,
  ]
    .filter(Boolean)
    .join(' ')
  return <input ref={ref} className={cls} {...rest} />
})

export default Input
