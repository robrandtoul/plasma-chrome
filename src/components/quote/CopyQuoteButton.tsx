import { useEffect, useRef, useState } from 'react'

// Primary action below the price column. Writes a multi-format
// quote (HTML + plain-text, formatted by
// src/lib/quote/formatQuoteForCopy.ts) to the system clipboard so
// a designer can paste straight into Help Scout's rich-text
// editor (gets the bolded HTML version) or any plain-text
// destination (gets the spaced plain-text version).
//
// Three-tier copy strategy. The Async Clipboard API rejects with
// NotAllowedError on Netlify (and similar Permissions-Policy-
// hardened hosts) even with a real user gesture, so we keep two
// fallbacks behind it. Tier 2 preserves rich text via a
// contenteditable + execCommand selection, so Help Scout pastes
// still arrive with the bolded Total. Tier 3 is the plain-text-
// only safety net.
//
//   1. Async Clipboard API via ClipboardItem with text/plain +
//      text/html blobs. Called synchronously in the click handler
//      so the user-activation token is still alive when the
//      browser checks permissions.
//   2. Contenteditable <div> + Range/Selection +
//      document.execCommand('copy'). Browser writes the selected
//      DOM (including <strong> and <br>) as text/html AND derives
//      text/plain from the text content — both formats land on
//      the clipboard from a single call. Works on hosts where
//      tier 1 is denied because execCommand has historically had
//      looser activation requirements than the Async API.
//   3. Legacy textarea + execCommand('copy'). Plain-text only.
//      Last resort for environments where contenteditable +
//      execCommand also fails.
//
// State machine:
//   idle    — default. Label "Copy quote".
//   copied  — write succeeded by either tier. Label "Copied",
//             emerald tint, with a tick. Reverts to idle after
//             ~1.8s.
//   error   — both tiers failed. Surfaces the underlying error
//             message inline so the designer can fall back to
//             manual select-all-copy from the headline + spec
//             readout above.
//
// The handler is intentionally a regular function (not async) so
// the call to `clipboard.write` lands inside the same synchronous
// tick as the click event — `await` would queue everything after
// it as a microtask, and some hosts check user activation at
// every tick.
export function CopyQuoteButton({
  plainText,
  html,
  disabled = false,
}: {
  plainText: string
  html: string
  // Caller-side gate, e.g. while pricing is still loading. The
  // button still renders but greys out.
  disabled?: boolean
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  function markCopied() {
    if (timerRef.current) clearTimeout(timerRef.current)
    setState('copied')
    setErrorMsg(null)
    timerRef.current = setTimeout(() => setState('idle'), 1800)
  }

  function markError(msg: string) {
    setState('error')
    setErrorMsg(msg)
  }

  function handleClick() {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }

    // Tier 1: Async Clipboard API with a multi-format ClipboardItem.
    // Synchronous call inside the click handler — the user-activation
    // token is still alive here. The Promise resolves/rejects later,
    // but the API has already registered the request.
    let asyncWrite: Promise<void> | null = null
    try {
      const hasClipboardWrite =
        typeof navigator !== 'undefined' &&
        navigator.clipboard &&
        typeof navigator.clipboard.write === 'function'
      const hasClipboardItem = typeof ClipboardItem !== 'undefined'
      if (hasClipboardWrite && hasClipboardItem) {
        const item = new ClipboardItem({
          'text/plain': new Blob([plainText], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        })
        asyncWrite = navigator.clipboard.write([item])
      }
    } catch (e) {
      // Some browsers throw synchronously for clipboard-write
      // policy denial rather than rejecting; treat the same as a
      // rejection so the legacy fallback kicks in.
      asyncWrite = Promise.reject(e)
    }

    if (asyncWrite) {
      asyncWrite
        .then(() => markCopied())
        .catch((primaryErr) => {
          // Tier 2: contenteditable + execCommand. Preserves
          // rich-text — the browser auto-populates both
          // text/html and text/plain from the selection.
          if (richCopy(html)) {
            markCopied()
            return
          }
          // Tier 3: legacy textarea fallback. Plain-text only —
          // execCommand on a textarea can't carry rich types.
          // Pasting into a rich editor still lands the plain
          // version, no bolding.
          if (legacyCopy(plainText)) {
            markCopied()
            return
          }
          const detail = primaryErr instanceof Error && primaryErr.message
            ? primaryErr.message
            : 'permission denied'
          markError(`Copy failed (${detail}) — copy manually from above.`)
        })
      return
    }

    // No Async API or ClipboardItem at all — try the rich
    // fallback first (preserves bold for Help Scout etc.), then
    // the textarea last-resort.
    if (richCopy(html)) {
      markCopied()
      return
    }
    if (legacyCopy(plainText)) {
      markCopied()
      return
    }
    markError('Clipboard not available — copy manually from above.')
  }

  const isCopied = state === 'copied'
  const isError = state === 'error'

  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled}
        aria-live="polite"
        className={[
          'inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1',
          disabled
            ? 'cursor-not-allowed bg-line text-ink-dim'
            : isCopied
              ? 'bg-in-stock text-on-ink focus-visible:ring-in-stock'
              : 'bg-ink text-on-ink hover:opacity-90 focus-visible:ring-brand',
        ].join(' ')}
      >
        {isCopied && (
          <svg viewBox="0 0 12 12" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
            <path d="M2.5 6.5l2.5 2.5 5-5.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        {isCopied ? 'Copied' : 'Copy quote'}
      </button>
      {isError && errorMsg && (
        <p className="mt-2 text-xs text-out">{errorMsg}</p>
      )}
    </div>
  )
}

// Tier 2 — rich-text-preserving fallback. Builds an off-screen
// contenteditable div, sets its innerHTML, selects the contents
// via Range/Selection, then calls document.execCommand('copy').
// Browser writes the selection's serialised HTML as text/html
// AND derives text/plain from the text content, so both formats
// land on the clipboard from a single call. Returns true on
// success. Saves and restores any pre-existing user selection so
// designers don't lose what they had highlighted.
//
// execCommand is deprecated but works on hosts where the Async
// Clipboard API rejects on Permissions-Policy grounds —
// historically execCommand has had looser activation
// requirements. Wrapped in try/catch because some hardened
// browser configs throw outright.
function richCopy(html: string): boolean {
  if (typeof document === 'undefined') return false
  const sel = window.getSelection?.() ?? null
  // Snapshot any existing selection so we can put it back.
  const savedRanges: Range[] = []
  if (sel) {
    for (let i = 0; i < sel.rangeCount; i++) {
      savedRanges.push(sel.getRangeAt(i).cloneRange())
    }
  }
  let div: HTMLDivElement | null = null
  try {
    div = document.createElement('div')
    div.contentEditable = 'true'
    // innerHTML is set from the formatter's html field which is
    // produced by formatQuoteForCopy.ts with all user-controlled
    // values HTML-escaped, so injection isn't a risk here.
    div.innerHTML = html
    div.style.position = 'fixed'
    div.style.left = '-9999px'
    div.style.top = '0'
    div.style.opacity = '0'
    div.style.pointerEvents = 'none'
    div.setAttribute('aria-hidden', 'true')
    document.body.appendChild(div)

    const range = document.createRange()
    range.selectNodeContents(div)
    sel?.removeAllRanges()
    sel?.addRange(range)

    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    if (div && div.parentNode) div.parentNode.removeChild(div)
    if (sel) {
      sel.removeAllRanges()
      for (const r of savedRanges) sel.addRange(r)
    }
  }
}

// Tier 3 — plain-text fallback. Builds an off-screen textarea,
// selects its content, calls execCommand('copy'), and tears down.
// Returns true on success. Plain-text only — execCommand on a
// textarea can't carry rich types. Wrapped in try/catch because
// execCommand can throw on hardened browser configs; we treat
// any error as a failure and let the caller surface the inline
// error message.
function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined') return false
  let ta: HTMLTextAreaElement | null = null
  try {
    ta = document.createElement('textarea')
    ta.value = text
    // Off-screen but still in the DOM so the selection is real.
    ta.setAttribute('readonly', '')
    ta.setAttribute('aria-hidden', 'true')
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    ta.style.top = '0'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    const ok = document.execCommand('copy')
    return ok
  } catch {
    return false
  } finally {
    if (ta && ta.parentNode) ta.parentNode.removeChild(ta)
  }
}
