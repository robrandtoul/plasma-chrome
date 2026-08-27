import { jsx as _jsx } from "react/jsx-runtime";
import { cx } from './types.js';
export function Toggle({ on }) {
    return (_jsx("span", { className: cx('pd-chrome__switch', on && 'pd-chrome__switch--on'), "aria-hidden": "true", children: _jsx("span", { className: "pd-chrome__switch-knob" }) }));
}
/** Both controls write the same value, so both say the same thing. */
export const PREF_TITLE = 'Keep apps visible';
export function prefHint(on) {
    return on ? 'A strip lists all four, always' : 'Switch from the app menu instead';
}
//# sourceMappingURL=Toggle.js.map