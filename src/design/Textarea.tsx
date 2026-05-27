import { type TextareaHTMLAttributes, forwardRef } from 'react'

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean
}

// Auto-height textarea. Same border/focus rules as Input but with
// 12px padding all round and a 1.5 line-height. Pair with Field for
// the eyebrow label + hint stack.
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid = false, className = '', rows = 4, ...rest },
  ref,
) {
  // See Input.tsx for the rationale. Focus colour utilities target the
  // raw `--c-*` properties via arbitrary-value syntax because
  // Tailwind v4's nested-`&:focus { border-color: var(--color-...) }`
  // pattern isn't reliably winning the cascade against the static
  // `border-line` setter on the same element.
  const focusBorder = invalid
    ? 'focus:border-[var(--c-out)] focus:outline-[var(--c-out)]'
    : 'focus:border-[var(--c-brand)] focus:outline-[var(--c-brand)]'
  const cls = [
    'w-full bg-surface text-ink font-sans text-sm border transition-colors',
    'rounded-[8px] p-3 leading-[1.5] resize-y',
    'focus:outline-2 focus:outline-offset-1',
    invalid ? 'border-out' : 'border-line',
    focusBorder,
    'disabled:bg-canvas disabled:text-ink-mute disabled:cursor-not-allowed',
    className,
  ]
    .filter(Boolean)
    .join(' ')
  return <textarea ref={ref} rows={rows} className={cls} {...rest} />
})

export default Textarea
