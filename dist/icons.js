import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
export function SearchIcon() {
    return (_jsxs("svg", { className: "pd-chrome__search-icon", width: "13", height: "13", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2.2", strokeLinecap: "round", "aria-hidden": "true", children: [_jsx("circle", { cx: "11", cy: "11", r: "8" }), _jsx("path", { d: "m21 21-4.35-4.35" })] }));
}
/** The collapsed-search and mobile-bar glyph: 18px, stroke 1.8. */
export function SearchButtonIcon() {
    return (_jsxs("svg", { width: "18", height: "18", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", "aria-hidden": "true", children: [_jsx("circle", { cx: "11", cy: "11", r: "8" }), _jsx("path", { d: "m21 21-4.35-4.35" })] }));
}
export function ChatIcon() {
    return (_jsxs("svg", { width: "18", height: "18", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [_jsx("path", { d: "M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2Z" }), _jsx("path", { d: "M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1" })] }));
}
export function BellIcon() {
    return (_jsxs("svg", { width: "18", height: "18", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [_jsx("path", { d: "M10.3 21a1.94 1.94 0 0 0 3.4 0" }), _jsx("path", { d: "M21 15H3a2 2 0 0 0 2-2V9a7 7 0 0 1 14 0v4a2 2 0 0 0 2 2Z" })] }));
}
/* ── Mobile tab glyphs: 22px, stroke 1.6 ─────────────────── */
function tabSvg(children, linejoin = true) {
    return (_jsx("svg", { width: "22", height: "22", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round", strokeLinejoin: linejoin ? 'round' : undefined, "aria-hidden": "true", children: children }));
}
const LAYERS = (_jsxs(_Fragment, { children: [_jsx("path", { d: "m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" }), _jsx("path", { d: "m6.08 11-3.5 1.6a1 1 0 0 0 0 1.81l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9a1 1 0 0 0 0-1.83L17.9 11" })] }));
const PACKAGE = (_jsxs(_Fragment, { children: [_jsx("path", { d: "m7.5 4.27 9 5.15" }), _jsx("path", { d: "M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" }), _jsx("path", { d: "M3.3 7 12 12l8.7-5" }), _jsx("path", { d: "M12 22V12" })] }));
const CHAT = (_jsxs(_Fragment, { children: [_jsx("path", { d: "M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2Z" }), _jsx("path", { d: "M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1" })] }));
const BELL = (_jsxs(_Fragment, { children: [_jsx("path", { d: "M10.3 21a1.94 1.94 0 0 0 3.4 0" }), _jsx("path", { d: "M21 15H3a2 2 0 0 0 2-2V9a7 7 0 0 1 14 0v4a2 2 0 0 0 2 2Z" })] }));
const PANELS = (_jsxs(_Fragment, { children: [_jsx("rect", { x: "3", y: "3", width: "7", height: "9" }), _jsx("rect", { x: "14", y: "3", width: "7", height: "5" }), _jsx("rect", { x: "14", y: "12", width: "7", height: "9" }), _jsx("rect", { x: "3", y: "16", width: "7", height: "5" })] }));
const BARS = (_jsxs(_Fragment, { children: [_jsx("path", { d: "M3 3v16a2 2 0 0 0 2 2h16" }), _jsx("path", { d: "M18 17V9" }), _jsx("path", { d: "M13 17V5" }), _jsx("path", { d: "M8 17v-3" })] }));
const ELLIPSIS = (_jsxs(_Fragment, { children: [_jsx("circle", { cx: "12", cy: "12", r: "1" }), _jsx("circle", { cx: "19", cy: "12", r: "1" }), _jsx("circle", { cx: "5", cy: "12", r: "1" })] }));
/* lucide "users". Card Programme's Customers tab; any app with a list of
   people it serves. */
const USERS = (_jsxs(_Fragment, { children: [_jsx("path", { d: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" }), _jsx("circle", { cx: "9", cy: "7", r: "4" }), _jsx("path", { d: "M22 21v-2a4 4 0 0 0-3-3.87" }), _jsx("path", { d: "M16 3.13a4 4 0 0 1 0 7.75" })] }));
/* lucide "history": a clock with a counter-clockwise arrow. Past runs,
   past orders, an audit log — the tab that looks backwards. */
const HISTORY = (_jsxs(_Fragment, { children: [_jsx("path", { d: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" }), _jsx("path", { d: "M3 3v5h5" }), _jsx("path", { d: "M12 7v5l4 2" })] }));
/* Keyed on the nav item's id, so two apps that call a destination the
   same thing get the same glyph — which is the point. An id with no
   entry falls back to PANELS, and a bar of several PANELS is the smell
   that says entries are missing: add them here rather than renaming a
   host's ids to borrow a glyph, which would put a semantically false id
   into activeNavId and every future debugging session.

   `overview` is mapped to PANELS explicitly rather than left to the
   fallback. Same picture, but it records that a summary screen is what
   PANELS is FOR, so the next person adding a tab does not read the
   fallback as a deliberate choice. */
const TAB_GLYPHS = {
    proofs: LAYERS,
    dashboard: LAYERS,
    overview: PANELS,
    orders: PACKAGE,
    run: PACKAGE,
    customers: USERS,
    history: HISTORY,
    chat: CHAT,
    messages: CHAT,
    activity: BELL,
    notifications: BELL,
    insights: BARS,
    analytics: BARS,
};
export function TabIcon({ id }) {
    return tabSvg(TAB_GLYPHS[id] ?? PANELS);
}
export function MoreIcon() {
    return tabSvg(ELLIPSIS, false);
}
/* ── App marks ──────────────────────────────────────────────
   Each app's own glyph, not its initial. These are the marks the four
   apps carried in their own headers before the chrome existed: Layers
   for Proofs, Boxes for Stock Control, an engraved card for Card
   Programme, a contact card for vCard Studio. Two came from lucide and
   are inlined here at their published path data, for the same reason
   every other icon in this file is inlined: the package takes no
   runtime dependencies, and one of the four consuming apps has no
   lucide.

   Keyed on the app id from my_apps(), because the app menu draws marks
   for apps the current host knows nothing about. An unknown id falls
   back to the initial, so a fifth app added to public.apps still
   renders something sensible before its glyph is added here. */
const APP_GLYPH_PATHS = {
    proofs: [
        'm12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z',
        'm22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65',
        'm22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65',
    ],
    stock: [
        'M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5.5l-5-3-4.03 2.42Z',
        'm7 16.5-4.74-2.85',
        'm7 16.5 5-3',
        'M7 16.5v5.17',
        'M12 13.5V19l3.97 2.38a2 2 0 0 0 2.06 0l3-1.8a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71L17 10.5l-5 3Z',
        'm17 16.5-5-3',
        'm17 16.5 4.74-2.85',
        'M17 16.5v5.17',
        'M7.97 4.42A2 2 0 0 0 7 6.13v4.37l5 3 5-3V6.13a2 2 0 0 0-.97-1.71l-3-1.8a2 2 0 0 0-2.06 0l-3 1.8Z',
        'M12 8 7.26 5.15',
        'm12 8 4.74-2.85',
        'M12 13.5V8',
    ],
    programme: ['M7 11h7', 'M7 14.5h4'],
    qr: [
        'M6 14.4c.5-1.1 1.5-1.7 2.6-1.7s2.1.6 2.6 1.7',
        'M14 10h4.2',
        'M14 12.9h3.2',
        'M6.2 16.8h11.6',
    ],
};
/** Shapes that are not paths, drawn before the paths above. */
function AppGlyphExtras({ app }) {
    if (app === 'programme')
        return _jsx("rect", { x: "3", y: "6", width: "18", height: "12.5", rx: "2.5" });
    if (app === 'qr') {
        return (_jsxs(_Fragment, { children: [_jsx("rect", { x: "3", y: "5", width: "18", height: "14", rx: "2.5" }), _jsx("circle", { cx: "8.6", cy: "10.5", r: "1.7" })] }));
    }
    return null;
}
export function hasAppGlyph(app) {
    return Object.prototype.hasOwnProperty.call(APP_GLYPH_PATHS, app);
}
export function AppGlyph({ app, size }) {
    const paths = APP_GLYPH_PATHS[app];
    if (!paths)
        return null;
    return (_jsxs("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: app === 'qr' ? 1.7 : 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [_jsx(AppGlyphExtras, { app: app }), paths.map((d) => (_jsx("path", { d: d }, d)))] }));
}
/**
 * The mark for an app: its own glyph where we have one, otherwise the
 * initial of its name. The fallback matters because the app menu lists
 * whatever `my_apps()` returns, which can include an app added to
 * `public.apps` before a glyph for it is added here.
 */
export function appGlyph(app, size, fallbackName) {
    if (hasAppGlyph(app))
        return _jsx(AppGlyph, { app: app, size: size });
    const trimmed = fallbackName.trim();
    return trimmed ? trimmed[0].toUpperCase() : '?';
}
//# sourceMappingURL=icons.js.map