// Cache-invalidation hook for the Phase 2 customer-approval settings.
//
// Phase 2 originally cached approvals_enabled + the two confirmation-
// copy strings here, but the migrations moved both surfaces — copy
// strings to the public_settings() RPC (000120), approvals_enabled to
// the public_proof_versions view (000120 / 000121) — so the customer
// page reads them through publicSettings.ts and the version fetch
// rather than this module. The cache + getters this file used to
// expose became dead and were removed; only the invalidate-on-
// admin-save hook stays.
//
// AdminSettingsPage calls invalidateApprovalSettings() after saving
// any of the three fields. The body is a no-op today (there is no
// cache to invalidate) — the export is preserved as a stable hook
// so a future caller (a polling consumer, a designer-tab cross-
// invalidation broadcast, etc.) does not have to rewire
// AdminSettingsPage when it lands.

/** Invalidate any locally-held copy of the approval settings. No-op
 *  today — see file header. Preserved as a stable extension point. */
export function invalidateApprovalSettings(): void {
  // intentional no-op
}
