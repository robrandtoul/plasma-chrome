// Injected styles for the contact form. Scoped under
// .plasma-contact-form so the rules cannot bleed into Squarespace's
// own selectors, and conversely so Squarespace's site CSS doesn't
// silently override us.
//
// Typography deliberately inherits where it can — `font-family:
// inherit` on inputs picks up Squarespace's site font, and the
// container itself does not set a font family. The brand still
// looks like itself; we only style geometry, focus rings, the
// button, and the status states.

const STYLE_TAG_ID = 'plasma-contact-form-styles'

const STYLES = `
.plasma-contact-form,
.plasma-contact-form * {
  box-sizing: border-box;
}
.plasma-contact-form {
  background: #ffffff;
  color: #1f2937;
  font-size: 16px;
  line-height: 1.5;
  max-width: 720px;
  margin: 0 auto;
}
.plasma-contact-form fieldset {
  border: 0;
  padding: 0;
  margin: 0;
}
.plasma-contact-form .pcf-row {
  display: grid;
  gap: 16px;
  grid-template-columns: 1fr 1fr;
  margin-bottom: 16px;
}
.plasma-contact-form .pcf-row.pcf-row-single {
  grid-template-columns: 1fr;
}
@media (max-width: 540px) {
  .plasma-contact-form .pcf-row {
    grid-template-columns: 1fr;
  }
}
.plasma-contact-form .pcf-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.plasma-contact-form label {
  font-size: 14px;
  font-weight: 600;
  color: #111827;
}
.plasma-contact-form .pcf-optional {
  font-weight: 400;
  color: #6b7280;
  margin-left: 4px;
}
.plasma-contact-form input[type="text"],
.plasma-contact-form input[type="email"],
.plasma-contact-form input[type="tel"],
.plasma-contact-form select,
.plasma-contact-form textarea {
  width: 100%;
  font: inherit;
  font-family: inherit;
  color: inherit;
  background: #ffffff;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  padding: 10px 12px;
  transition: border-color 120ms ease, box-shadow 120ms ease;
  appearance: none;
  -webkit-appearance: none;
}
.plasma-contact-form select {
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'><path fill='%236b7280' d='M6 8 0 0h12z'/></svg>");
  background-repeat: no-repeat;
  background-position: right 12px center;
  padding-right: 36px;
}
.plasma-contact-form textarea {
  min-height: 140px;
  resize: vertical;
}
.plasma-contact-form input:focus,
.plasma-contact-form select:focus,
.plasma-contact-form textarea:focus {
  outline: none;
  border-color: #2563eb;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.18);
}
.plasma-contact-form .pcf-field.pcf-invalid input,
.plasma-contact-form .pcf-field.pcf-invalid select,
.plasma-contact-form .pcf-field.pcf-invalid textarea {
  border-color: #dc2626;
}
.plasma-contact-form .pcf-field-error {
  color: #b91c1c;
  font-size: 13px;
  min-height: 1em;
}
.plasma-contact-form .pcf-file {
  border: 1px dashed #d1d5db;
  border-radius: 6px;
  padding: 14px;
  background: #f9fafb;
  font-size: 14px;
}
.plasma-contact-form .pcf-file input[type="file"] {
  display: block;
  margin-top: 6px;
  font: inherit;
  font-family: inherit;
}
.plasma-contact-form .pcf-file-hint {
  color: #6b7280;
  font-size: 13px;
  margin-top: 4px;
}
.plasma-contact-form .pcf-honeypot {
  position: absolute !important;
  left: -10000px !important;
  top: auto !important;
  width: 1px !important;
  height: 1px !important;
  overflow: hidden !important;
}
.plasma-contact-form .pcf-turnstile {
  margin-bottom: 16px;
  min-height: 65px;
}
.plasma-contact-form .pcf-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
.plasma-contact-form button[type="submit"] {
  font: inherit;
  font-family: inherit;
  font-weight: 600;
  background: #111827;
  color: #ffffff;
  border: 0;
  border-radius: 6px;
  padding: 12px 24px;
  cursor: pointer;
  transition: background-color 120ms ease, transform 120ms ease;
}
.plasma-contact-form button[type="submit"]:hover:not(:disabled) {
  background: #1f2937;
}
.plasma-contact-form button[type="submit"]:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 2px;
}
.plasma-contact-form button[type="submit"]:disabled {
  background: #9ca3af;
  cursor: not-allowed;
}
.plasma-contact-form .pcf-status {
  font-size: 14px;
  color: #4b5563;
}
.plasma-contact-form .pcf-status.pcf-status-error {
  color: #b91c1c;
}
.plasma-contact-form .pcf-thanks {
  background: #f0fdf4;
  border: 1px solid #bbf7d0;
  border-radius: 8px;
  padding: 24px;
  color: #065f46;
}
.plasma-contact-form .pcf-thanks h3 {
  margin: 0 0 8px 0;
  font-size: 18px;
}
.plasma-contact-form .pcf-thanks p {
  margin: 0;
}
.plasma-contact-form .pcf-error-banner {
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 6px;
  padding: 12px 14px;
  color: #b91c1c;
  font-size: 14px;
  margin-bottom: 16px;
}
.plasma-contact-form .pcf-error-banner a {
  color: inherit;
  text-decoration: underline;
}
`

export function ensureStylesInjected(doc: Document = document): void {
  if (doc.getElementById(STYLE_TAG_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_TAG_ID
  style.textContent = STYLES
  doc.head.appendChild(style)
}
