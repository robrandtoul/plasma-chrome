// Browser-side file download helper.
//
// Trigger a download from a Blob (CSV, ZIP, image) by synthesising an
// anchor click. The single non-obvious bit is the revoke delay: if we
// call URL.revokeObjectURL immediately after a.click(), some browsers
// free the blob before the download stream has been handed off to the
// OS-level download manager, and the download silently fails. Setting
// a 1s timeout lets the click propagate first. DevTools being open
// happens to slow the tab enough that the synchronous revoke used to
// "work" — only in dev.
//
// All file downloads in the app should go through this helper; inline
// blob-URL download patterns must not be reintroduced.

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Delay the revoke so the browser finishes handing the blob off to
  // its download handler. 1s is plenty and doesn't leak meaningfully.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// Force a Supabase Storage signed URL to download under a chosen
// filename. Supabase signed URLs sit on the storage domain
// (…supabase.co), a different origin from the app, so the browser
// ignores the `<a download="…">` attribute on them — the customer's
// saved file ends up named after the opaque storage path instead of
// what they uploaded. Supabase honours a `download` query parameter on
// the object endpoint and answers with
// `Content-Disposition: attachment; filename="…"`, which the browser
// obeys regardless of origin. The token in a signed URL covers only the
// path + expiry, not this parameter, so appending it client-side is
// safe and needs no re-signing. Returns the URL unchanged when there's
// no filename to apply (e.g. legacy rows with a null original_filename).
export function withDownloadName(signedUrl: string, filename?: string | null): string {
  const name = (filename ?? '').trim()
  if (!signedUrl || !name) return signedUrl
  const sep = signedUrl.includes('?') ? '&' : '?'
  return `${signedUrl}${sep}download=${encodeURIComponent(name)}`
}
