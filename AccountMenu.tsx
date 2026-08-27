/* ─────────────────────────────────────────────────────────────
   The account menu — the one place sign out exists.

   The preference row here reads as a setting rather than as "keep
   this open", so it is tinted (chrome.css does that off the
   --account panel modifier) and it carries the hint copy.
   ─────────────────────────────────────────────────────────── */

import type { JSX, ReactNode } from 'react';
import type { ChromeAccountLinks, ChromeLinkComponent, ChromeUser } from './types';
import { cx, firstName } from './types';
import { useDismissable } from './useDismissable';
import { PREF_TITLE, Toggle, prefHint } from './Toggle';

export function Avatar({
  user,
  large,
  size,
}: {
  user: ChromeUser;
  large?: boolean;
  size?: number;
}): JSX.Element {
  const style = size
    ? { background: user.colour, width: size, height: size }
    : { background: user.colour };
  return (
    <span className={cx('pd-chrome__avatar', large && 'pd-chrome__avatar--lg')} style={style}>
      {user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : user.initials}
    </span>
  );
}

export interface AccountPanelBodyProps {
  user: ChromeUser;
  appsVisible: boolean;
  onAppsVisibleChange: (next: boolean) => void;
  onSignOut: () => void;
  onEditProfile?: () => void;
  accountLinks?: ChromeAccountLinks;
  linkComponent?: ChromeLinkComponent;
  /** Rendered between the identity block and the preference row.
      The mobile sheet puts the app list here, because that is where
      app switching lives on a phone. */
  extra?: ReactNode;
}

/** Shared by the desktop popover and the mobile account sheet. */
export function AccountPanelBody({
  user,
  appsVisible,
  onAppsVisibleChange,
  onSignOut,
  onEditProfile,
  accountLinks,
  linkComponent,
  extra,
}: AccountPanelBodyProps): JSX.Element {
  const Link: ChromeLinkComponent | 'a' = linkComponent ?? 'a';
  return (
    <>
      <div className="pd-chrome__identity">
        <Avatar user={user} large />
        <span className="pd-chrome__identity-text">
          <span className="pd-chrome__identity-name">{user.name}</span>
          <span className="pd-chrome__identity-meta">
            {user.email} · {user.roleLabel}
          </span>
        </span>
      </div>
      <span className="pd-chrome__panel-divider" style={{ margin: '0 10px 6px' }} />
      {extra}
      <button
        className="pd-chrome__pref"
        type="button"
        role="menuitemcheckbox"
        aria-checked={appsVisible}
        onClick={() => onAppsVisibleChange(!appsVisible)}
      >
        <span className="pd-chrome__pref-text">
          <span className="pd-chrome__pref-title">{PREF_TITLE}</span>
          <span className="pd-chrome__pref-hint">{prefHint(appsVisible)}</span>
        </span>
        <Toggle on={appsVisible} />
      </button>
      {accountLinks?.notifications ? (
        <Link
          className="pd-chrome__menu-row"
          role="menuitem"
          href={accountLinks.notifications}
        >
          Notifications
        </Link>
      ) : null}
      {onEditProfile ? (
        <button
          className="pd-chrome__menu-row"
          type="button"
          role="menuitem"
          onClick={onEditProfile}
        >
          Edit profile
        </button>
      ) : null}
      {accountLinks?.feedback ? (
        <Link
          className="pd-chrome__menu-row"
          role="menuitem"
          href={accountLinks.feedback}
        >
          Feedback
        </Link>
      ) : null}
      <span className="pd-chrome__panel-divider" />
      <button
        className="pd-chrome__menu-row pd-chrome__signout"
        type="button"
        role="menuitem"
        onClick={onSignOut}
      >
        Sign out
      </button>
    </>
  );
}

export interface AccountMenuProps extends AccountPanelBodyProps {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}

export function AccountMenu({
  open,
  onOpen,
  onClose,
  ...body
}: AccountMenuProps): JSX.Element {
  const { containerRef, triggerRef } = useDismissable(open, onClose);
  const { user } = body;

  return (
    <div className="pd-chrome__account-wrap" ref={containerRef}>
      <button
        className="pd-chrome__account"
        type="button"
        ref={triggerRef}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Account menu"
        onClick={() => (open ? onClose() : onOpen())}
      >
        <Avatar user={user} />
        <span className="pd-chrome__account-name">{firstName(user.name)}</span>
        <span className="pd-chrome__chevron" aria-hidden="true" />
      </button>
      {open ? (
        <div className="pd-chrome__panel pd-chrome__panel--account" role="menu">
          <AccountPanelBody
            {...body}
            onSignOut={() => {
              onClose();
              body.onSignOut();
            }}
            onEditProfile={
              body.onEditProfile
                ? () => {
                    onClose();
                    body.onEditProfile?.();
                  }
                : undefined
            }
          />
        </div>
      ) : null}
    </div>
  );
}
