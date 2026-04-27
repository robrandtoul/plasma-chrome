// Two project-level flags that bail out of numeric quoting entirely:
// NFC chips and unique-content runs. Either or both on => the whole
// pricing column collapses to a CustomQuotePanel saying "this needs
// a custom quote — flag for Rob".
//
// These are deliberately styled with a warm-amber border so the
// designer's eye registers "this is the bailout zone" and doesn't
// confuse them with the spec extras above. Same checkbox-chip
// shape as those toggles, but inside an amber-trimmed section
// header.
//
// Flags persist across material and currency switches — they
// describe the project, not the pricing context.

export interface CustomQuoteFlagsState {
  nfc: boolean
  uniqueContent: boolean
}

export const EMPTY_CUSTOM_QUOTE_FLAGS: CustomQuoteFlagsState = {
  nfc: false,
  uniqueContent: false,
}

export function isCustomQuote(flags: CustomQuoteFlagsState): boolean {
  return flags.nfc || flags.uniqueContent
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
    <fieldset className="rounded-lg border border-amber-200 bg-amber-50/40 p-4">
      <legend className="block px-1 text-xs font-semibold uppercase tracking-widest text-amber-700">
        Special card types
      </legend>
      <p className="mb-2 text-xs text-amber-700/80">
        Pick if either applies — these always need a custom quote, no live pricing.
      </p>
      <div className="flex flex-col gap-2">
        <Trigger
          label="Includes NFC chip"
          caption="NFC orders always need a custom quote."
          checked={value.nfc}
          onChange={(v) => set('nfc', v)}
        />
        <Trigger
          label="Each card has unique content"
          caption="e.g. numbering, sequential IDs, individual names, membership numbers."
          checked={value.uniqueContent}
          onChange={(v) => set('uniqueContent', v)}
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
        'focus-within:ring-2 focus-within:ring-amber-400 focus-within:ring-offset-1',
        checked
          ? 'border-amber-300 bg-amber-100/60 text-amber-900'
          : 'border-amber-200 bg-white text-gray-700 hover:bg-amber-50',
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
            ? 'border-amber-600 bg-amber-600 text-white'
            : 'border-amber-300 bg-white',
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
        <span className="block text-xs text-amber-700/80">{caption}</span>
      </span>
    </label>
  )
}
