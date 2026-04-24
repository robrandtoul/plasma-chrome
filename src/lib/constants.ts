// Shared constants used across multiple components.

// Fallback quantity tiers highlighted on a price grid when a
// material does not set its own display_quantities (migration
// 000095 — replaces the legacy featured_quantities column).
// Kept in sync with the Standard Paper default pricing page so
// the customer sees the same set whether or not the material
// has been curated.
export const DEFAULT_DISPLAY_QUANTITIES = [100, 250, 500, 750, 1000]
