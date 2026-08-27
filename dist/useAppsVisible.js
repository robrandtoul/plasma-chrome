/* ─────────────────────────────────────────────────────────────
   The `appsVisible` preference.

   A cookie, never localStorage: the four apps are four origins, so
   localStorage would give each one its own setting, which is worse
   than having none. The cookie sits beside the SSO session on
   `.plasmadesign.co.uk`.

   The value is resolved synchronously in useState's initialiser, not
   in an effect — reading it a tick late would flick the chrome
   between its two heights on every load.
   ─────────────────────────────────────────────────────────── */
import { useCallback, useState } from 'react';
export const APPS_COOKIE = 'pd_chrome_apps';
const COOKIE_DOMAIN = '.plasmadesign.co.uk';
const COOKIE_MAX_AGE = 31536000; // one year
/** Number of apps at which the strip is on by default. */
const DEFAULT_ON_AT = 3;
export function readAppsCookie() {
    if (typeof document === 'undefined')
        return null;
    const match = document.cookie.match(new RegExp('(?:^|;\\s*)' + APPS_COOKIE + '=([^;]*)'));
    if (!match)
        return null;
    return match[1] === '1';
}
export function writeAppsCookie(next) {
    if (typeof document === 'undefined')
        return;
    document.cookie =
        APPS_COOKIE +
            '=' +
            (next ? '1' : '0') +
            '; Domain=' +
            COOKIE_DOMAIN +
            '; Path=/; Max-Age=' +
            COOKIE_MAX_AGE +
            '; SameSite=Lax; Secure';
}
/**
 * Default: on at three or more apps, off at two. People who cross apps
 * are shown the door before they go looking for it; people who don't
 * are not charged 38px for a switcher they use monthly.
 */
export function defaultAppsVisible(appCount) {
    return appCount >= DEFAULT_ON_AT;
}
/* WHY THE DEFAULT IS NOT LATCHED.
   This used to seed useState with defaultAppsVisible(appCount) and keep
   whatever that first render produced. Every host fetches its app list
   asynchronously, so appCount is ALWAYS 0 on the first render, and the
   seeded value was therefore always false. The "on at three or more"
   default had never once fired in any of the four apps: a person signing
   in for the first time got no strip, whatever their access, and had to
   find the app menu and switch it on by hand — which is the discovery
   problem the strip exists to solve, restored in full.

   So the stored preference is held as null-until-chosen and the default
   is derived on every render instead. A person who has expressed a
   preference keeps it from the first paint, because the cookie is read
   synchronously; a person who has not follows their app count as it
   arrives.

   The cost is that the strip appears a moment after load rather than
   with it, moving the page down 38px once. That settle is the same one
   every app's own switcher accepted before this package existed, and it
   is the honest trade: reserving the space instead would charge a
   permanent empty band to every single-app user. */
export function useAppsVisible(appCount, controlled, onChange) {
    // null means "no preference expressed", NOT false. Seeded from the
    // cookie synchronously so a stored choice is right on the first paint.
    const [chosen, setChosen] = useState(() => readAppsCookie());
    const isControlled = controlled !== undefined;
    const value = isControlled
        ? controlled
        : (chosen ?? defaultAppsVisible(appCount));
    const set = useCallback((next) => {
        if (!isControlled) {
            setChosen(next);
            writeAppsCookie(next);
        }
        if (onChange)
            onChange(next);
    }, [isControlled, onChange]);
    return [value, set];
}
//# sourceMappingURL=useAppsVisible.js.map