import { type ButtonHTMLAttributes, forwardRef } from 'react'
import { Loader2, type LucideIcon } from 'lucide-react'

type ButtonSize = 'sm' | 'md'
type ButtonVariant = 'ink' | 'coral' | 'ghost'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: LucideIcon
  iconRight?: LucideIcon
  size?: ButtonSize
  busy?: boolean
  block?: boolean
}

// 38px (md) / 30px (sm) tall. Icon and label gap 8px. Loader2 spins
// in place of the icon while `busy` is true; the button is also
// disabled then so it can't be double-submitted. Variant-specific
// chrome lives on the {variant} className map below.
// Focus ring uses outline-2 + outline-offset-1 rather than ring-*
// (Tailwind v4 ring composition with bridged custom-property colours
// is shaky — see Input.tsx). focus-visible: so mouse-clicks don't
// paint the halo, only keyboard navigation. Colour references the
// raw --c-brand custom property via arbitrary-value syntax for the
// same cascade reasons documented on Input.
const BASE = 'inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium font-sans transition-colors disabled:opacity-60 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--c-brand)]'

// 4px corners on both sizes — matches the 4px chips / inputs / cells
// across the app for one consistent interactive-element radius.
const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'h-[30px] px-[10px] text-[13px] rounded-[4px]',
  md: 'h-[38px] px-4 text-sm rounded-[4px]',
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  ink: 'bg-ink text-on-ink hover:bg-ink-soft',
  coral: 'bg-brand text-on-brand hover:bg-brand-600',
  ghost: 'bg-surface text-ink-soft border border-line hover:bg-canvas',
}

function makeButton(variant: ButtonVariant) {
  const Component = forwardRef<HTMLButtonElement, ButtonProps>(function ButtonInner(
    {
      icon: Icon,
      iconRight: IconRight,
      size = 'md',
      busy = false,
      block = false,
      disabled,
      className = '',
      children,
      type = 'button',
      ...rest
    },
    ref,
  ) {
    const iconSize = size === 'sm' ? 12 : 14
    const cls = [BASE, SIZE_CLASS[size], VARIANT_CLASS[variant], block ? 'w-full' : '', className]
      .filter(Boolean)
      .join(' ')
    return (
      <button ref={ref} type={type} disabled={disabled || busy} className={cls} {...rest}>
        {busy ? (
          <Loader2 size={iconSize} className="animate-spin" aria-hidden="true" />
        ) : Icon ? (
          <Icon size={iconSize} aria-hidden="true" />
        ) : null}
        {children}
        {!busy && IconRight ? <IconRight size={iconSize} aria-hidden="true" /> : null}
      </button>
    )
  })
  Component.displayName = `Button${variant[0].toUpperCase()}${variant.slice(1)}`
  return Component
}

export const ButtonInk = makeButton('ink')
export const ButtonCoral = makeButton('coral')
export const ButtonGhost = makeButton('ghost')

export default ButtonInk
export type { ButtonProps }
