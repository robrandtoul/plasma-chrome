// Entry point for the Squarespace-embedded contact form. Mirrors
// the price-list pattern: bootstraps on DOMContentLoaded, finds
// every placeholder, renders into each one. The Squarespace block
// contains:
//
//   <div data-plasma-contact-form></div>
//   <script src="https://proofs.plasmadesign.co.uk/contact-form/contact-form.js" defer></script>
//
// Multiple placeholders are supported (one form per placeholder)
// in case a future page wants more than one. In practice we expect
// exactly one on /support.

import { renderContactFormInto } from './render'
import { ensureStylesInjected } from './styles'

function findPlaceholders(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-plasma-contact-form]'))
}

function bootstrap(): void {
  const hosts = findPlaceholders()
  if (hosts.length === 0) return
  ensureStylesInjected()
  for (const host of hosts) {
    // Defence-in-depth against the script running twice on the same
    // page (e.g. Squarespace's editor double-injecting). Skip a host
    // we've already populated.
    if (host.querySelector('.plasma-contact-form')) continue
    renderContactFormInto(host)
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { bootstrap() })
} else {
  bootstrap()
}
