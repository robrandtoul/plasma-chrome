import type { ReactNode } from 'react'

// Shared field primitives for the admin settings-family pages.
// Extracted from AdminSettingsPage when the Customer-facing card moved
// to its own /admin/site-copy tab, so both pages render identical
// blur-saving field rows without duplicating the markup. Toggle,
// RadioGroup and the Help Scout status row stay local to
// AdminSettingsPage — Site copy doesn't use them.

export const inputClass = 'w-full rounded border border-line px-3 py-2 text-[17px] sm:text-sm focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none'

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
