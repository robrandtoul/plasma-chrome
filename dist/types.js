/* ─────────────────────────────────────────────────────────────
   @plasma/chrome — public contracts.

   This folder must stay liftable into a standalone package with
   zero edits, so nothing in it imports anything but `react`.
   Data arrives as props; routing arrives as `linkComponent`.
   ─────────────────────────────────────────────────────────── */
/** Counts read as `9+` above nine. */
export function formatCount(n) {
    return n > 9 ? '9+' : String(n);
}
/** The app mark is the first letter of the full name, never artwork. */
export function markLetter(fullLabel) {
    return (fullLabel.trim().charAt(0) || '?').toUpperCase();
}
export function firstName(name) {
    return name.trim().split(/\s+/)[0] || name;
}
export function cx(...parts) {
    return parts.filter(Boolean).join(' ');
}
//# sourceMappingURL=types.js.map