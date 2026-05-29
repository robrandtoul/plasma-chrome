// Customer proof URL helpers.
//
// The customer-facing proof page lives at /p/:id. Two variants
// of this URL are constructed around the app: the plain one
// (for sending to the customer, e.g. Copy customer URL) and a
// designer-preview variant that opens the same page but signals
// "this is the designer looking, don't record a view".
//
// CustomerProofPage reads the ?preview=1 flag at view-recording
// time and skips the record_proof_view RPC when present (see the
// designer-preview bypass comment in CustomerProofPage.tsx).
// Keeping the flag centralised here means any change to the
// suppression mechanism — rename the param, move it to a cookie,
// add a second flag — touches one file.
//
// Use `customerProofPath` anywhere the URL is going to the
// customer (copy to clipboard, email body, Help Scout reply).
// Use `designerPreviewPath` anywhere a designer-facing control
// opens the page (Preview buttons on the dashboard, the
// Preview-as-customer iframe on the detail page).

export function customerProofPath(proofId: string): string {
  return `/p/${proofId}`
}

export function designerPreviewPath(proofId: string): string {
  return `${customerProofPath(proofId)}?preview=1`
}

// Open the designer-preview of the customer page. Tries a new tab first
// (the preferred UX — the designer keeps their place), but window.open
// returns null when the tab is blocked: a popup blocker, or a sandboxed
// embed (e.g. a preview pane) without allow-popups. In that case fall
// back to same-tab navigation so the action never silently does nothing.
// Used by every "Preview" / "Open customer view" control.
export function openDesignerPreview(proofId: string): void {
  const path = designerPreviewPath(proofId)
  const opened = window.open(path, '_blank', 'noopener,noreferrer')
  if (!opened) window.location.assign(path)
}
