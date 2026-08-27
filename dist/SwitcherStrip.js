import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export function SwitcherStrip({ apps, currentApp }) {
    const current = apps.find((app) => app.app === currentApp);
    return (_jsxs("nav", { className: "pd-chrome__strip", "aria-label": "PlasmaDesign apps", children: [_jsx("ul", { className: "pd-chrome__strip-nav", role: "list", children: apps.map((app) => app.app === currentApp ? (_jsx("li", { children: _jsxs("span", { className: "pd-chrome__strip-link pd-chrome__strip-link--current", "aria-current": "page", children: [app.label, _jsx("span", { className: "pd-chrome__strip-rule" })] }) }, app.app)) : (_jsx("li", { children: _jsx("a", { className: "pd-chrome__strip-link", href: app.url, children: app.label }) }, app.app))) }), current ? _jsx("span", { className: "pd-chrome__strip-role", children: current.role }) : null] }));
}
//# sourceMappingURL=SwitcherStrip.js.map