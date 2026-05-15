// DOM construction and submit wiring for the contact form. Renders
// once into a placeholder, then runs a single submit handler that:
//   * Reads field values
//   * Surfaces per-field error messages (only after first submit
//     attempt, the same "submitAttempted" pattern the proof-viewer
//     dashboard uses for its own forms — quieter UX than live
//     validation on first blur)
//   * Reads the Turnstile token via window.turnstile.getResponse
//   * Posts a multipart payload to the edge function
//   * Swaps the form for a thank-you on success
//   * Surfaces an error banner with a mailto fallback on failure

import {
  ALLOWED_MIME_EXACT,
  ALLOWED_MIME_PREFIXES,
  MAX_FILE_BYTES,
  SUBMIT_ENDPOINT,
  TURNSTILE_SITE_KEY_PUBLIC,
  isAllowedMime,
} from './config'
import { REST_OF_WORLD, TOP_COUNTRIES } from './countries'
import { loadTurnstile } from './turnstile'

const SUPPORT_EMAIL = 'support@plasmadesign.co.uk'

interface FieldRefs {
  firstName: HTMLInputElement
  lastName: HTMLInputElement
  email: HTMLInputElement
  company: HTMLInputElement
  phone: HTMLInputElement
  country: HTMLSelectElement
  subject: HTMLInputElement
  message: HTMLTextAreaElement
  attachment: HTMLInputElement
  honeypot: HTMLInputElement
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v
    else node.setAttribute(k, v)
  }
  for (const c of children) {
    if (typeof c === 'string') node.appendChild(document.createTextNode(c))
    else node.appendChild(c)
  }
  return node
}

function field(opts: {
  id: string
  label: string
  optional?: boolean
  control: HTMLElement
}): HTMLDivElement {
  const wrap = el('div', { class: 'pcf-field', 'data-field': opts.id })
  const labelText: Array<Node | string> = [opts.label]
  if (opts.optional) {
    labelText.push(el('span', { class: 'pcf-optional' }, ['(optional)']))
  }
  wrap.appendChild(el('label', { for: opts.id }, labelText))
  wrap.appendChild(opts.control)
  wrap.appendChild(el('div', { class: 'pcf-field-error', id: `${opts.id}-error` }))
  return wrap
}

function buildCountrySelect(): HTMLSelectElement {
  const select = el('select', { id: 'pcf-country', name: 'country', required: 'true' })
  select.appendChild(el('option', { value: '', disabled: 'true', selected: 'true' }, ['Select a country']))
  const topGroup = el('optgroup', { label: 'Most common' })
  for (const c of TOP_COUNTRIES) topGroup.appendChild(el('option', { value: c }, [c]))
  select.appendChild(topGroup)
  const restGroup = el('optgroup', { label: 'All countries' })
  for (const c of REST_OF_WORLD) restGroup.appendChild(el('option', { value: c }, [c]))
  select.appendChild(restGroup)
  select.appendChild(el('option', { value: 'Other / not listed' }, ['Other / not listed']))
  return select
}

function buildForm(): { form: HTMLFormElement; refs: FieldRefs; turnstileMount: HTMLDivElement; banner: HTMLDivElement; status: HTMLDivElement; submitBtn: HTMLButtonElement } {
  const form = el('form', { class: 'plasma-contact-form', novalidate: 'true' })

  const banner = el('div', { class: 'pcf-error-banner', hidden: 'true', role: 'alert' })

  const firstName = el('input', { type: 'text', id: 'pcf-first-name', name: 'firstName', autocomplete: 'given-name', required: 'true' })
  const lastName = el('input', { type: 'text', id: 'pcf-last-name', name: 'lastName', autocomplete: 'family-name', required: 'true' })
  const email = el('input', { type: 'email', id: 'pcf-email', name: 'email', autocomplete: 'email', required: 'true' })
  const company = el('input', { type: 'text', id: 'pcf-company', name: 'company', autocomplete: 'organization' })
  const phone = el('input', { type: 'tel', id: 'pcf-phone', name: 'phone', autocomplete: 'tel' })
  const country = buildCountrySelect()
  const subject = el('input', { type: 'text', id: 'pcf-subject', name: 'subject', required: 'true' })
  const message = el('textarea', { id: 'pcf-message', name: 'message', required: 'true', rows: '6' })
  const attachment = el('input', { type: 'file', id: 'pcf-attachment', name: 'attachment' })

  // Set the accept attribute from the same config the edge function
  // enforces, so the file picker only offers allowed types.
  const acceptList = [
    ...Array.from(ALLOWED_MIME_PREFIXES).map((p) => `${p}*`),
    ...Array.from(ALLOWED_MIME_EXACT),
  ].join(',')
  attachment.setAttribute('accept', acceptList)

  // Honeypot. Real visitors don't see it (CSS pushes it off-screen)
  // and screen readers skip it via aria-hidden + tabindex=-1.
  const honeypot = el('input', {
    type: 'text',
    id: 'pcf-website',
    name: 'website',
    autocomplete: 'off',
    tabindex: '-1',
    'aria-hidden': 'true',
  })
  const honeypotWrap = el('div', { class: 'pcf-honeypot', 'aria-hidden': 'true' }, [
    el('label', { for: 'pcf-website' }, ['Website (leave blank)']),
    honeypot,
  ])

  // First and last name row.
  const nameRow = el('div', { class: 'pcf-row' }, [
    field({ id: 'pcf-first-name', label: 'First name', control: firstName }),
    field({ id: 'pcf-last-name', label: 'Last name', control: lastName }),
  ])

  const emailRow = el('div', { class: 'pcf-row pcf-row-single' }, [
    field({ id: 'pcf-email', label: 'Email', control: email }),
  ])

  const companyRow = el('div', { class: 'pcf-row' }, [
    field({ id: 'pcf-company', label: 'Company', optional: true, control: company }),
    field({ id: 'pcf-phone', label: 'Phone', optional: true, control: phone }),
  ])

  const countryRow = el('div', { class: 'pcf-row pcf-row-single' }, [
    field({ id: 'pcf-country', label: 'Country', control: country }),
  ])

  const subjectRow = el('div', { class: 'pcf-row pcf-row-single' }, [
    field({ id: 'pcf-subject', label: 'Subject', control: subject }),
  ])

  const messageRow = el('div', { class: 'pcf-row pcf-row-single' }, [
    field({ id: 'pcf-message', label: 'Message', control: message }),
  ])

  const fileLabel = el('label', { for: 'pcf-attachment' }, [
    'Attachment',
    el('span', { class: 'pcf-optional' }, ['(optional)']),
  ])
  const fileHint = el('div', { class: 'pcf-file-hint' }, [
    `Images, PDF, Word or text. Max ${MAX_FILE_BYTES / (1024 * 1024)} MB.`,
  ])
  const fileWrap = el('div', { class: 'pcf-field', 'data-field': 'pcf-attachment' }, [
    el('div', { class: 'pcf-file' }, [
      fileLabel,
      attachment,
      fileHint,
    ]),
    el('div', { class: 'pcf-field-error', id: 'pcf-attachment-error' }),
  ])

  const turnstileMount = el('div', { class: 'pcf-turnstile' }) as HTMLDivElement

  const submitBtn = el('button', { type: 'submit' }, ['Send message'])
  const status = el('div', { class: 'pcf-status', role: 'status', 'aria-live': 'polite' })
  const actions = el('div', { class: 'pcf-actions' }, [submitBtn, status])

  const fieldset = el('fieldset', {}, [
    banner,
    nameRow,
    emailRow,
    companyRow,
    countryRow,
    subjectRow,
    messageRow,
    fileWrap,
    honeypotWrap,
    turnstileMount,
    actions,
  ])
  form.appendChild(fieldset)

  const refs: FieldRefs = {
    firstName, lastName, email, company, phone, country, subject, message, attachment, honeypot,
  }
  return { form, refs, turnstileMount: turnstileMount as HTMLDivElement, banner, status, submitBtn }
}

function setFieldError(form: HTMLFormElement, fieldId: string, message: string | null): void {
  const fieldEl = form.querySelector<HTMLElement>(`[data-field="${fieldId}"]`)
  const errorEl = form.querySelector<HTMLElement>(`#${fieldId}-error`)
  if (!fieldEl || !errorEl) return
  if (message) {
    fieldEl.classList.add('pcf-invalid')
    errorEl.textContent = message
  } else {
    fieldEl.classList.remove('pcf-invalid')
    errorEl.textContent = ''
  }
}

function clearAllErrors(form: HTMLFormElement): void {
  for (const fieldEl of Array.from(form.querySelectorAll<HTMLElement>('[data-field]'))) {
    fieldEl.classList.remove('pcf-invalid')
  }
  for (const errEl of Array.from(form.querySelectorAll<HTMLElement>('.pcf-field-error'))) {
    errEl.textContent = ''
  }
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function validate(refs: FieldRefs, form: HTMLFormElement): boolean {
  let firstInvalid: string | null = null
  const set = (id: string, msg: string) => {
    setFieldError(form, id, msg)
    if (!firstInvalid) firstInvalid = id
  }
  clearAllErrors(form)

  if (!refs.firstName.value.trim()) set('pcf-first-name', 'First name is required')
  if (!refs.lastName.value.trim()) set('pcf-last-name', 'Last name is required')
  const emailVal = refs.email.value.trim()
  if (!emailVal) set('pcf-email', 'Email is required')
  else if (!isValidEmail(emailVal)) set('pcf-email', 'That email does not look right')
  if (!refs.country.value) set('pcf-country', 'Country is required')
  if (!refs.subject.value.trim()) set('pcf-subject', 'Subject is required')
  if (!refs.message.value.trim()) set('pcf-message', 'Message is required')

  // Attachment is optional, but validate type and size if present.
  const file = refs.attachment.files?.[0]
  if (file) {
    if (file.size > MAX_FILE_BYTES) {
      set('pcf-attachment', `File is too large. Max ${MAX_FILE_BYTES / (1024 * 1024)} MB.`)
    } else if (!isAllowedMime(file.type)) {
      set('pcf-attachment', 'File type not allowed.')
    }
  }

  if (firstInvalid) {
    const target = form.querySelector<HTMLElement>(`[data-field="${firstInvalid}"]`)
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    target?.querySelector<HTMLElement>('input, select, textarea')?.focus({ preventScroll: true })
    return false
  }
  return true
}

function renderThankYou(host: HTMLElement, name: string): void {
  host.replaceChildren(
    el('div', { class: 'plasma-contact-form pcf-thanks', role: 'status', tabindex: '-1' }, [
      el('h3', {}, [name ? `Thanks, ${name}` : 'Thanks for getting in touch']),
      el('p', {}, [
        'We have received your message and will be in touch shortly. If your enquiry is urgent, email us at ',
        el('a', { href: `mailto:${SUPPORT_EMAIL}` }, [SUPPORT_EMAIL]),
        '.',
      ]),
    ]),
  )
  // Move focus into the confirmation so screen readers and keyboard
  // users land on the new state instead of an empty container.
  const node = host.querySelector<HTMLElement>('.pcf-thanks')
  node?.focus()
}

export function renderContactFormInto(host: HTMLElement): void {
  const { form, refs, turnstileMount, banner, status, submitBtn } = buildForm()
  host.replaceChildren(form)

  let turnstileWidgetId: string | null = null
  let turnstileError = false

  // Kick off Turnstile load + render. Failures are non-fatal at this
  // point — the submit handler re-checks before allowing send.
  void loadTurnstile().then((api) => {
    try {
      turnstileWidgetId = api.render(turnstileMount, {
        sitekey: TURNSTILE_SITE_KEY_PUBLIC,
        theme: 'light',
        size: 'flexible',
        'error-callback': () => { turnstileError = true },
        'expired-callback': () => {
          if (turnstileWidgetId) api.reset(turnstileWidgetId)
        },
      })
    } catch (err) {
      console.error('Failed to render Turnstile widget', err)
      turnstileError = true
    }
  }).catch((err) => {
    console.error('Failed to load Turnstile', err)
    turnstileError = true
  })

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    banner.hidden = true
    status.textContent = ''
    status.classList.remove('pcf-status-error')

    if (!validate(refs, form)) return

    // Honeypot client-side — if any value is present we silently
    // drop the submit on the client and pretend it worked. The
    // edge function checks again, but bailing here saves a
    // round-trip.
    if (refs.honeypot.value.trim()) {
      renderThankYou(host, refs.firstName.value.trim())
      return
    }

    let turnstileToken = ''
    if (turnstileWidgetId && window.turnstile) {
      turnstileToken = window.turnstile.getResponse(turnstileWidgetId) ?? ''
    }
    if (!turnstileToken || turnstileError) {
      banner.hidden = false
      banner.replaceChildren(document.createTextNode(
        'Spam check has not finished loading. Please wait a moment and try again, or email ',
      ))
      banner.appendChild(el('a', { href: `mailto:${SUPPORT_EMAIL}` }, [SUPPORT_EMAIL]))
      banner.appendChild(document.createTextNode('.'))
      return
    }

    submitBtn.disabled = true
    status.textContent = 'Sending…'

    const data = new FormData()
    data.set('firstName', refs.firstName.value.trim())
    data.set('lastName', refs.lastName.value.trim())
    data.set('email', refs.email.value.trim())
    data.set('company', refs.company.value.trim())
    data.set('phone', refs.phone.value.trim())
    data.set('country', refs.country.value)
    data.set('subject', refs.subject.value.trim())
    data.set('message', refs.message.value.trim())
    data.set('website', refs.honeypot.value)
    data.set('cf-turnstile-response', turnstileToken)
    const file = refs.attachment.files?.[0]
    if (file) data.set('attachment', file, file.name)

    try {
      const resp = await fetch(SUBMIT_ENDPOINT, {
        method: 'POST',
        body: data,
      })
      const result = await resp.json().catch(() => null) as { ok?: boolean; error?: string } | null
      if (!resp.ok || !result?.ok) {
        if (turnstileWidgetId && window.turnstile) window.turnstile.reset(turnstileWidgetId)
        submitBtn.disabled = false
        status.textContent = ''
        banner.hidden = false
        banner.replaceChildren(
          document.createTextNode(result?.error ?? 'Sorry, something went wrong while sending your message. Please email '),
        )
        if (!result?.error) {
          banner.appendChild(el('a', { href: `mailto:${SUPPORT_EMAIL}` }, [SUPPORT_EMAIL]))
          banner.appendChild(document.createTextNode(' and we will pick it up that way.'))
        } else {
          banner.appendChild(document.createTextNode(' If the problem persists, please email '))
          banner.appendChild(el('a', { href: `mailto:${SUPPORT_EMAIL}` }, [SUPPORT_EMAIL]))
          banner.appendChild(document.createTextNode('.'))
        }
        return
      }
      renderThankYou(host, refs.firstName.value.trim())
    } catch (err) {
      console.error('Contact form submit error', err)
      if (turnstileWidgetId && window.turnstile) window.turnstile.reset(turnstileWidgetId)
      submitBtn.disabled = false
      status.textContent = ''
      banner.hidden = false
      banner.replaceChildren(
        document.createTextNode('Could not reach the server. Please check your connection and try again, or email '),
        el('a', { href: `mailto:${SUPPORT_EMAIL}` }, [SUPPORT_EMAIL]),
        document.createTextNode('.'),
      )
    }
  })
}
