import type { ReactNode } from 'react'

// Shared field primitives for the admin settings-family pages.
// Extracted from AdminSettingsPage when the Customer-facing card moved
// to its own /admin/site-copy tab, so both pages render identical
// blur-saving field rows without duplicating the markup. Toggle +
// RadioGroup joined the shared set when the Artwork check moved to its
// own tab (they're used by both pages now).

export const inputClass = 'w-full rounded border border-line px-3 py-2 text-[17px] sm:text-sm focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none'

// A pill segmented control — the admin-standard picker for a small closed set.
export function RadioGroup<T extends string | null>({ value, onChange, options }: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value ?? '__none__'}
            type="button"
            onClick={() => onChange(o.value)}
            className={[
              'rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
              active
                ? 'bg-ink text-on-ink'
                : 'bg-surface text-ink-soft ring-1 ring-line hover:bg-canvas',
            ].join(' ')}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

// The admin-standard on/off switch.
export function Toggle({ value, onChange, disabled = false, label }: {
  value: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!value)}
      className={[
        'relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors',
        value ? 'bg-ink' : 'bg-line',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
      ].join(' ')}
    >
      <span
        className={[
          'inline-block h-5 w-5 translate-y-0.5 transform rounded-full bg-surface transition-transform',
          value ? 'translate-x-[1.375rem]' : 'translate-x-0.5',
        ].join(' ')}
      />
    </button>
  )
}

export function FieldRow({ label, help, saved, working, error, children }: {
  label: string
  help: string
  saved?: boolean
  working?: boolean
  error?: string
  children: ReactNode
}) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-3">
        <label className="text-sm font-medium text-ink-soft">{label}</label>
        {working && <span className="text-xs text-ink-dim">Saving…</span>}
        {saved && !working && <span className="text-xs text-in-stock">Saved</span>}
        {error && <span className="text-xs text-out">{error}</span>}
      </div>
      {children}
      <p className="mt-1.5 text-xs text-ink-mute">{help}</p>
    </div>
  )
}
