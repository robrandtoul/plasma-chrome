/* ─────────────────────────────────────────────────────────────
   The white 56px row: app identity, nav, right cluster.

   Right-cluster order is fixed and never negotiable:
   page actions → search → chat → notifications → account.
   Sign out is not on the bar; it lives in the account menu.
   ─────────────────────────────────────────────────────────── */

import { useState } from 'react';
import type { ComponentType, JSX, ReactNode } from 'react';
import type { ChromeLinkComponent, ChromeNavItem, ChromeSearch, ChromeUser , ChromeAccountAction, ChromeAccountLinks} from './types';
import { cx, formatCount } from './types';
import { AppMenu } from './AppMenu';
import { AccountMenu } from './AccountMenu';
import { appGlyph, BellIcon, ChatIcon, SearchButtonIcon, SearchIcon } from './icons';
import type { ChromeApp } from './types';

/**
 * The router seam. The chrome renders whatever it is handed and never
 * imports react-router: `href` always goes through, and `end` goes
 * through only when the item declares it and the host supplied a
 * component (a bare `<a>` has no use for it).
 */
export function NavLinkish({
  linkComponent,
  item,
  className,
  active,
  children,
}: {
  linkComponent: ChromeLinkComponent | undefined;
  item: ChromeNavItem;
  className: string;
  active: boolean;
  children: ReactNode;
}): JSX.Element {
  const Comp: ComponentType<any> | 'a' = linkComponent ?? 'a';
  const extra: Record<string, unknown> = {};
  if (linkComponent && item.end !== undefined) extra.end = item.end;
  // Only set when the host asked for it, so a link component that
  // treats the presence of onClick as "this is a button" is not
  // handed an undefined one on every ordinary nav item.
  if (item.onClick) extra.onClick = item.onClick;
  return (
    <Comp
      className={className}
      href={item.href}
      aria-current={active ? 'page' : undefined}
      {...extra}
    >
      {children}
    </Comp>
  );
}

export interface HeaderBarProps {
  apps: ChromeApp[];
  currentApp: string;
  appName: string;
  nav: ChromeNavItem[];
  activeNavId: string | null;
  user: ChromeUser;
  linkComponent?: ChromeLinkComponent;
  accountLinks?: ChromeAccountLinks;
  accountActions?: ChromeAccountAction[];
  search?: ChromeSearch;
  actions?: ReactNode;
  chat?: ReactNode;
  chatUnread?: number;
  chatMentionUnread?: number;
  notifications?: ReactNode;
  notificationsUnread?: number;
  appsVisible: boolean;
  onAppsVisibleChange: (next: boolean) => void;
  onSignOut: () => void;
  onEditProfile?: () => void;
}

export function HeaderBar(props: HeaderBarProps): JSX.Element {
  const {
    apps,
    currentApp,
    appName,
    nav,
    activeNavId,
    user,
    linkComponent,
    accountLinks,
    accountActions,
    search,
    actions,
    chat,
    chatUnread,
    chatMentionUnread,
    notifications,
    notificationsUnread,
    appsVisible,
    onAppsVisibleChange,
    onSignOut,
    onEditProfile,
  } = props;

  // One popover at a time: opening either closes the other.
  const [openMenu, setOpenMenu] = useState<'apps' | 'account' | null>(null);

  const chatCount = chatUnread ?? 0;
  const mentionCount = chatMentionUnread ?? 0;
  const showChat =
    chat !== undefined || chatUnread !== undefined || chatMentionUnread !== undefined;
  const showNotifications = notifications !== undefined || notificationsUnread !== undefined;
  const notificationCount = notificationsUnread ?? 0;

  const chatLabel =
    mentionCount > 0
      ? 'Team chat — ' + mentionCount + ' mentioning you'
      : chatCount > 0
        ? 'Team chat — ' + chatCount + ' unread'
        : 'Team chat';

  return (
    <div className="pd-chrome__bar">
      {appsVisible ? (
        <span className="pd-chrome__app--static">
          <span className="pd-chrome__app-mark">{appGlyph(currentApp, 15, appName)}</span>
          <span className="pd-chrome__app-name">{appName}</span>
        </span>
      ) : (
        <AppMenu
          apps={apps}
          currentApp={currentApp}
          appName={appName}
          open={openMenu === 'apps'}
          onOpen={() => setOpenMenu('apps')}
          onClose={() => setOpenMenu((current) => (current === 'apps' ? null : current))}
          appsVisible={appsVisible}
          onAppsVisibleChange={onAppsVisibleChange}
        />
      )}

      <span className="pd-chrome__divider" />

      <ul className="pd-chrome__nav" role="list" aria-label={appName + ' navigation'}>
        {nav.map((item) => {
          const active = item.id === activeNavId;
          return (
            <li key={item.id}>
              <NavLinkish
                linkComponent={linkComponent}
                item={item}
                active={active}
                className={cx(
                  'pd-chrome__nav-item',
                  active && 'pd-chrome__nav-item--active',
                )}
              >
                {item.label}
                {item.badge && item.badge > 0 ? (
                  <span className="pd-chrome__count">{formatCount(item.badge)}</span>
                ) : null}
              </NavLinkish>
            </li>
          );
        })}
      </ul>

      <span className="pd-chrome__spacer" />

      {actions}

      {search ? (
        <>
          <label className="pd-chrome__search">
            <SearchIcon />
            <input
              className="pd-chrome__search-input"
              type="search"
              placeholder={search.placeholder ?? 'Search'}
              value={search.value}
              onChange={(event) => search.onChange(event.target.value)}
            />
            {search.onPalette ? (
              <button
                className="pd-chrome__kbd"
                type="button"
                aria-label="Open the search palette"
                onClick={search.onPalette}
              >
                ⌘K
              </button>
            ) : null}
          </label>
          {/* Below 1180px chrome.css collapses the field and shows this
              instead — the nav must never shrink, so search goes first. */}
          {search.onPalette ? (
            <button
              className="pd-chrome__icon-btn pd-chrome__search-toggle"
              type="button"
              title="Search"
              aria-label="Search"
              onClick={search.onPalette}
            >
              <SearchButtonIcon />
            </button>
          ) : null}
        </>
      ) : null}

      {showChat
        ? (chat ?? (
            <button className="pd-chrome__icon-btn" type="button" title="Team chat" aria-label={chatLabel}>
              <ChatIcon />
              {chatCount > 0 ? (
                <span className="pd-chrome__dot" aria-hidden="true">
                  {formatCount(chatCount)}
                </span>
              ) : null}
            </button>
          ))
        : null}

      {showNotifications
        ? (notifications ?? (
            <button
              className="pd-chrome__icon-btn"
              type="button"
              title="Notifications"
              aria-label={
                notificationCount > 0
                  ? 'Notifications — ' + notificationCount + ' new'
                  : 'Notifications'
              }
            >
              <BellIcon />
              {notificationCount > 0 ? (
                <span className="pd-chrome__dot" aria-hidden="true">
                  {formatCount(notificationCount)}
                </span>
              ) : null}
            </button>
          ))
        : null}

      <span className="pd-chrome__divider pd-chrome__divider--account" />

      <AccountMenu
        user={user}
        open={openMenu === 'account'}
        onOpen={() => setOpenMenu('account')}
        onClose={() => setOpenMenu((current) => (current === 'account' ? null : current))}
        appsVisible={appsVisible}
        onAppsVisibleChange={onAppsVisibleChange}
        onSignOut={onSignOut}
        onEditProfile={onEditProfile}
        accountLinks={accountLinks}
        accountActions={accountActions}
        linkComponent={linkComponent}
      />
    </div>
  );
}
