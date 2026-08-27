/* ─────────────────────────────────────────────────────────────
   Mobile: the 54px top bar, the bottom tab bar, and the account
   sheet that app switching lives in on a phone.

   The tab bar is `absolute`, not `fixed` (chrome.css says why): iOS
   pans a fixed bar away from the screen edge when the keyboard opens.
   Its containing block is therefore the host's viewport-locked app
   frame, which is also why this component's own wrapper is
   `display: contents` — a real box here would become the containing
   block and would break the top bar's `position: sticky` besides.

   The sheet shell uses `pd-chrome__sheet-overlay` and
   `pd-chrome__sheet`; everything inside it is the specified panel
   classes. The shell also carries `pd-chrome` so the rules that are
   written two classes deep still bite inside it, which is why the
   sheet needed no mobile-scoped hover or focus rules of its own.
   ─────────────────────────────────────────────────────────── */

import type { JSX } from 'react';
import { useState } from 'react';
import type { ChromeApp, ChromeLinkComponent, ChromeNavItem, ChromeSearch, ChromeUser, ChromeAccountAction, ChromeAccountLinks } from './types';
import { cx, formatCount } from './types';
import { AccountPanelBody } from './AccountMenu';
import { NavLinkish } from './HeaderBar';
import { appGlyph, MoreIcon, SearchButtonIcon, TabIcon } from './icons';
import { useDismissable } from './useDismissable';

export interface MobileChromeProps {
  apps: ChromeApp[];
  currentApp: string;
  appName: string;
  nav: ChromeNavItem[];
  activeNavId: string | null;
  mobileTabIds: string[];
  mobileTabs?: ChromeNavItem[];
  accountLinks?: ChromeAccountLinks;
  accountActions?: ChromeAccountAction[];
  user: ChromeUser;
  linkComponent?: ChromeLinkComponent;
  search?: ChromeSearch;
  appsVisible: boolean;
  onAppsVisibleChange: (next: boolean) => void;
  onSignOut: () => void;
  onEditProfile?: () => void;
}

export function MobileChrome(props: MobileChromeProps): JSX.Element {
  const {
    apps,
    currentApp,
    appName,
    nav,
    activeNavId,
    mobileTabIds,
    mobileTabs,
    accountLinks,
    accountActions,
    user,
    linkComponent,
    search,
    appsVisible,
    onAppsVisibleChange,
    onSignOut,
    onEditProfile,
  } = props;

  const [sheet, setSheet] = useState<'account' | 'more' | null>(null);

  const account = useDismissable(sheet === 'account', () => setSheet(null));
  const more = useDismissable(sheet === 'more', () => setSheet(null));

  // Four destinations plus More. Never five, never the whole nav list —
  // the fifth slot is always overflow.
  // `mobileTabs` wins when the host supplies it, because the mobile bar
  // is not a subset of the desktop nav: Chat is a right-cluster button
  // everywhere and Activity is a Proofs-only route, so neither can be
  // found in `nav`. Falling back to resolving ids against `nav` keeps
  // the simpler hosts working without passing the longer prop.
  const tabs = (mobileTabs ?? mobileTabIds
    .map((id) => nav.find((item) => item.id === id))
    .filter((item): item is ChromeNavItem => Boolean(item)))
    .slice(0, 4);

  const openAccount = () => setSheet(sheet === 'account' ? null : 'account');

  return (
    <div className="pd-chrome-mobile">
      <div className="pd-chrome__mobile-bar">
        {appsVisible ? (
          <>
            <span
              className="pd-chrome__app-mark"
              style={{ width: 28, height: 28, borderRadius: 8 }}
            >
              {appGlyph(currentApp, 16, appName)}
            </span>
            <span className="pd-chrome__mobile-title">{appName}</span>
          </>
        ) : (
          <button
            type="button"
            onClick={openAccount}
            aria-haspopup="dialog"
            aria-expanded={sheet === 'account'}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              minWidth: 0,
              margin: 0,
              padding: 0,
              border: 0,
              background: 'transparent',
              font: 'inherit',
              cursor: 'pointer',
            }}
          >
            <span
              className="pd-chrome__app-mark"
              style={{ width: 28, height: 28, borderRadius: 8 }}
            >
              {appGlyph(currentApp, 16, appName)}
            </span>
            <span className="pd-chrome__mobile-title">{appName}</span>
            <span
              className="pd-chrome__chevron"
              style={{
                width: 6,
                height: 6,
                borderRightWidth: 1.5,
                borderBottomWidth: 1.5,
                margin: '-3px 0 0 -2px',
              }}
              aria-hidden="true"
            />
          </button>
        )}

        <span className="pd-chrome__spacer" />

        {search?.onPalette ? (
          <button
            className="pd-chrome__icon-btn"
            type="button"
            title="Search"
            aria-label="Search"
            onClick={search.onPalette}
          >
            <SearchButtonIcon />
          </button>
        ) : null}

        <button
          className="pd-chrome__avatar"
          type="button"
          ref={account.triggerRef}
          onClick={openAccount}
          aria-haspopup="dialog"
          aria-expanded={sheet === 'account'}
          aria-label="Account and apps"
          style={{ width: 28, height: 28, background: user.colour, border: 0, padding: 0, cursor: 'pointer' }}
        >
          {user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : user.initials}
        </button>
      </div>

      <nav className="pd-chrome__tabs" aria-label="Primary">
        {tabs.map((item) => {
          const active = item.id === activeNavId;
          return (
            <NavLinkish
              key={item.id}
              linkComponent={linkComponent}
              item={item}
              active={active}
              className={cx('pd-chrome__tab', active && 'pd-chrome__tab--active')}
            >
              <TabIcon id={item.id} />
              <span className="pd-chrome__tab-label">{item.label}</span>
            </NavLinkish>
          );
        })}
        <button
          className="pd-chrome__tab"
          type="button"
          ref={more.triggerRef}
          aria-haspopup="dialog"
          aria-expanded={sheet === 'more'}
          onClick={() => setSheet(sheet === 'more' ? null : 'more')}
        >
          <MoreIcon />
          <span className="pd-chrome__tab-label">More</span>
        </button>
      </nav>

      {sheet === 'account' ? (
        <div className="pd-chrome pd-chrome__sheet-overlay">
          <div
            className="pd-chrome__panel pd-chrome__panel--account pd-chrome__sheet"
            role="dialog"
            aria-modal="true"
            aria-label="Account"
            ref={account.containerRef}
          >
            <AccountPanelBody
              user={user}
              appsVisible={appsVisible}
              onAppsVisibleChange={onAppsVisibleChange}
              onSignOut={onSignOut}
              onEditProfile={onEditProfile}
              accountLinks={accountLinks}
              accountActions={accountActions}
              linkComponent={linkComponent}
              extra={
                apps.length >= 2 ? (
                  <>
                    <span className="pd-chrome__panel-label">Your apps</span>
                    {apps.map((app) =>
                      app.app === currentApp ? (
                        <span
                          key={app.app}
                          className="pd-chrome__app-row pd-chrome__app-row--current"
                          aria-current="page"
                        >
                          <span className="pd-chrome__app-row-mark">
                            {appGlyph(app.app, 14, app.fullLabel)}
                          </span>
                          <span className="pd-chrome__app-row-text">
                            <span className="pd-chrome__app-row-title">{app.fullLabel}</span>
                            <span className="pd-chrome__app-row-desc">{app.description}</span>
                          </span>
                          <span className="pd-chrome__here">Here</span>
                        </span>
                      ) : (
                        <a key={app.app} className="pd-chrome__app-row" href={app.url}>
                          <span className="pd-chrome__app-row-mark">
                            {appGlyph(app.app, 14, app.fullLabel)}
                          </span>
                          <span className="pd-chrome__app-row-text">
                            <span className="pd-chrome__app-row-title">{app.fullLabel}</span>
                            <span className="pd-chrome__app-row-desc">{app.description}</span>
                          </span>
                        </a>
                      ),
                    )}
                    <span className="pd-chrome__panel-divider" />
                  </>
                ) : null
              }
            />
          </div>
        </div>
      ) : null}

      {sheet === 'more' ? (
        <div className="pd-chrome pd-chrome__sheet-overlay">
          <div
            className="pd-chrome__panel pd-chrome__panel--account pd-chrome__sheet"
            role="dialog"
            aria-modal="true"
            aria-label="More"
            ref={more.containerRef}
          >
            <span className="pd-chrome__panel-label">Go to</span>
            {nav.map((item) => {
              const active = item.id === activeNavId;
              return (
                <NavLinkish
                  key={item.id}
                  linkComponent={linkComponent}
                  item={item}
                  active={active}
                  className="pd-chrome__menu-row"
                >
                  {item.label}
                  {item.badge && item.badge > 0 ? (
                    <span className="pd-chrome__count">{formatCount(item.badge)}</span>
                  ) : null}
                </NavLinkish>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
