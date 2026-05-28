// Project-level flag(s) that bail out of numeric quoting entirely.
// NFC orders are the only such trigger today: they always need a
// custom quote because the chip + bonded layer cost lives outside
// the standard price grid.
//
// The previous "Each card has unique content" flag was removed in
// migration 000172 — the personalisation add-on now prices unique-
// per-card content directly, so the bailout is no longer needed
// for that case.
//
// Styled with a warm-amber border so the designer's eye registers
// "this is the bailout zone" and doesn't confuse it with the spec
// extras above. Same checkbox-chip shape as those toggles, but
// inside an amber-trimmed section header.
//
// Flags persist across material and currency switches — they
// describe the project, not the pricing context.

export interface CustomQuoteFlagsState {
  nfc: boolean
}

export const EMPTY_CUSTOM_QUOTE_FLAGS: CustomQuoteFlagsState = {
  nfc: false,
}

export function isCustomQuote(flags: CustomQuoteFlagsState): boolean {
  return flags.nfc
}

export function CustomQuoteFlags({
  value,
  onChange,
}: {
  value: CustomQuoteFlagsState
  onChange: (next: CustomQuoteFlagsState) => void
}) {
  function set<K extends keyof CustomQuoteFlagsState>(key: K, next: boolean) {
    onChange({ ...value, [key]: next })
  }

  return (
    <fieldset className="rounded-lg border border-low bg-low-soft p-4">
      <p className="text-xs font-semibold uppercase tracking-widest text-low">
        Special card types
      </p>
      <p className="mb-3 mt-1 text-xs text-low">
        Pick if this applies — it always needs a custom quote, no live pricing.
      </p>
      <div className="flex flex-col gap-2">
        <Trigger
          label="Includes NFC chip"
          caption="NFC orders always need a custom quote."
          checked={value.nfc}
          onChange={(v) => set('nfc', v)}
        />
      </div>
    </fieldset>
  )
}

function Trigger({
  label,
  caption,
  checked,
  onChange,
}: {
  label: string
  caption: string
  checked: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <label
      className={[
        'flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 transition-colors',
        'focus-within:ring-2 focus-within:ring-low focus-within:ring-offset-1',
        checked
          ? 'border-low bg-low-soft text-low'
          : 'border-low bg-surface text-ink-soft hover:bg-low-soft',
      ].join(' ')}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="sr-only"
      />
      <span
        aria-hidden
        className={[
          'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border',
          checked
            ? 'border-low bg-low text-on-ink'
            : 'border-low bg-surface',
        ].join(' ')}
      >
        {checked && (
          <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M2.5 6.5l2.5 2.5 5-5.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-low">{caption}</span>
      </span>
    </label>
  )
}
