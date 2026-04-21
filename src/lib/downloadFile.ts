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
