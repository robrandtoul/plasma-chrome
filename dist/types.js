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
/**
 * The bar shows one word. `name` is meant to be a full name, but every
 * host has some account with no name on file and falls back to the
 * email, and an address has no whitespace to split on — so this used to
 * paint the whole of
 * `someone.with.a.long.name@plasmadesign.co.uk` into a bar whose
 * container is `flex: 0 0 auto` and never shrinks. Degrade to the local
 * part instead: still identifying, and bounded. The account menu's
 * identity block still shows the address in full.
 */
export function firstName(name) {
    const trimmed = name.trim();
    const first = trimmed.split(/\s+/)[0] || trimmed;
    const at = first.indexOf('@');
    return at > 0 ? first.slice(0, at) : first;
}
export function cx(...parts) {
    return parts.filter(Boolean).join(' ');
}
//# sourceMappingURL=types.js.map