// Cloudflare Turnstile loader. The widget script is injected once
// per page (idempotent); subsequent calls resolve to the existing
// global so multiple form instances on one page reuse the same
// runtime.
//
// We avoid the implicit `data-callback` flow Turnstile auto-renders
// and instead drive the widget through `window.turnstile.render`
// so we can:
//   * Read the response token at submit time via `getResponse(id)`
//     rather than relying on the auto-injected hidden input.
//   * Call `reset(id)` after a submit failure so the visitor gets
//     a fresh token without reloading the page (tokens are single-
//     use; replays are rejected by the Cloudflare verify endpoint).

import { TURNSTILE_SCRIPT_URL } from './config'

// Minimal surface of the Turnstile global we use. The full API has
// more methods (remove, isExpired, etc.); we only need these three.
interface TurnstileGlobal {
  render: (
    container: HTMLElement | string,
    options: {
      sitekey: string
      theme?: 'light' | 'dark' | 'auto'
      size?: 'normal' | 'compact' | 'flexible'
      'error-callback'?: () => void
      'expired-callback'?: () => void
    },
  ) => string
  getResponse: (widgetId: string) => string | undefined
  reset: (widgetId: string) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileGlobal
  }
}

const SCRIPT_TAG_ID = 'plasma-contact-form-turnstile-script'

let scriptPromise: Promise<TurnstileGlobal> | null = null

export function loadTurnstile(): Promise<TurnstileGlobal> {
  if (scriptPromise) return scriptPromise
  scriptPromise = new Promise<TurnstileGlobal>((resolve, reject) => {
    // Already loaded on the page (e.g. another form instance or the
    // marketing site embedded the script directly).
    if (window.turnstile) {
      resolve(window.turnstile)
      return
    }
    const existing = document.getElementById(SCRIPT_TAG_ID) as HTMLScriptElement | null
    const tag = existing ?? document.createElement('script')
    if (!existing) {
      tag.id = SCRIPT_TAG_ID
      tag.src = TURNSTILE_SCRIPT_URL
      tag.async = true
      tag.defer = true
      document.head.appendChild(tag)
    }
    const onReady = () => {
      if (window.turnstile) resolve(window.turnstile)
      else reject(new Error('Turnstile loaded but window.turnstile is unset'))
    }
    // Poll for the global — the api.js script doesn't fire a custom
    // event, and using `onload` alone races against the script's own
    // initialisation that happens just after the script's load event.
    const start = Date.now()
    const poll = () => {
      if (window.turnstile) {
        onReady()
        return
      }
      if (Date.now() - start > 10000) {
        reject(new Error('Turnstile failed to initialise within 10 seconds'))
        return
      }
      setTimeout(poll, 60)
    }
    tag.addEventListener('load', poll, { once: true })
    tag.addEventListener('error', () => reject(new Error('Failed to load Turnstile script')), { once: true })
    // Start polling immediately too in case the script tag is
    // already resolved (cached) and onload won't fire.
    poll()
  })
  return scriptPromise
}
