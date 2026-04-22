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
