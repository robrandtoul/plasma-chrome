export declare const APPS_COOKIE = "pd_chrome_apps";
export declare function readAppsCookie(): boolean | null;
export declare function writeAppsCookie(next: boolean): void;
/**
 * Default: on at three or more apps, off at two. People who cross apps
 * are shown the door before they go looking for it; people who don't
 * are not charged 38px for a switcher they use monthly.
 */
export declare function defaultAppsVisible(appCount: number): boolean;
export declare function useAppsVisible(appCount: number, controlled?: boolean, onChange?: (next: boolean) => void): [boolean, (next: boolean) => void];
//# sourceMappingURL=useAppsVisible.d.ts.map