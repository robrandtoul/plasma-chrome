/* ─────────────────────────────────────────────────────────────
   The app menu. Menu mode only (appsVisible === false) — when the
   strip is up the apps are already listed, so the menu is redundant
   and the header name reverts to a plain label.

   The preference row here reads as "keep this open": this is where
   someone discovers the strip. It carries no hint copy; the account
   menu's copy of the same control does.
   ─────────────────────────────────────────────────────────── */

import type { JSX } from 'react';
import type { ChromeApp } from './types';
import { markLetter } from './types';
import { useDismissable } from './useDismissable';
import { PREF_TITLE, Toggle } from './Toggle';

export interface AppMenuProps {
  apps: ChromeApp[];
  currentApp: string;
  appName: string;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  appsVisible: boolean;
  onAppsVisibleChange: (next: boolean) => void;
}

export function AppMenu({
  apps,
  currentApp,
  appName,
  open,
  onOpen,
  onClose,
  appsVisible,
  onAppsVisibleChange,
}: AppMenuProps): JSX.Element {
  const { containerRef, triggerRef } = useDismissable(open, onClose);

  return (
    <div className="pd-chrome__app-wrap" ref={containerRef}>
      <button
        className="pd-chrome__app"
        type="button"
        ref={triggerRef}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => (open ? onClose() : onOpen())}
      >
        <span className="pd-chrome__app-mark">{markLetter(appName)}</span>
        <span className="pd-chrome__app-name">{appName}</span>
        <span className="pd-chrome__chevron" aria-hidden="true" />
      </button>
      {open ? (
        <div className="pd-chrome__panel pd-chrome__panel--apps" role="menu">
          <span className="pd-chrome__panel-label">Your apps</span>
          {apps.map((app) =>
            app.app === currentApp ? (
              <span
                key={app.app}
                className="pd-chrome__app-row pd-chrome__app-row--current"
                role="menuitem"
                aria-current="page"
              >
                <span className="pd-chrome__app-row-mark">{markLetter(app.fullLabel)}</span>
                <span className="pd-chrome__app-row-text">
                  <span className="pd-chrome__app-row-title">{app.fullLabel}</span>
                  <span className="pd-chrome__app-row-desc">{app.description}</span>
                </span>
                <span className="pd-chrome__here">Here</span>
              </span>
            ) : (
              <a key={app.app} className="pd-chrome__app-row" role="menuitem" href={app.url}>
                <span className="pd-chrome__app-row-mark">{markLetter(app.fullLabel)}</span>
                <span className="pd-chrome__app-row-text">
                  <span className="pd-chrome__app-row-title">{app.fullLabel}</span>
                  <span className="pd-chrome__app-row-desc">{app.description}</span>
                </span>
              </a>
            ),
          )}
          <span className="pd-chrome__panel-divider" />
          <button
            className="pd-chrome__pref"
            type="button"
            role="menuitemcheckbox"
            aria-checked={appsVisible}
            onClick={() => onAppsVisibleChange(!appsVisible)}
          >
            <span className="pd-chrome__pref-text">
              <span className="pd-chrome__pref-title">{PREF_TITLE}</span>
            </span>
            <Toggle on={appsVisible} />
          </button>
        </div>
      ) : null}
    </div>
  );
}
