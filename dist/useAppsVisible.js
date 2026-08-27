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
export function useAppsVisible(appCount, controlled, onChange) {
    const [owned, setOwned] = useState(() => {
        const stored = readAppsCookie();
        return stored === null ? defaultAppsVisible(appCount) : stored;
    });
    const isControlled = controlled !== undefined;
    const value = isControlled ? controlled : owned;
    const set = useCallback((next) => {
        if (!isControlled) {
            setOwned(next);
            writeAppsCookie(next);
        }
        if (onChange)
            onChange(next);
    }, [isControlled, onChange]);
    return [value, set];
}
//# sourceMappingURL=useAppsVisible.js.map