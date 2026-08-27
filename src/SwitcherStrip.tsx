/* ─────────────────────────────────────────────────────────────
   The ink row. Rendered only when appsVisible (and only at two or
   more apps — below that mountAppSwitcher renders nothing today and
   so do we).

   Links point at other origins, so they are always plain anchors:
   linkComponent is a router seam and there is no route to another
   app's domain.
   ─────────────────────────────────────────────────────────── */

import type { JSX } from 'react';
import type { ChromeApp } from './types';

export interface SwitcherStripProps {
  apps: ChromeApp[];
  currentApp: string;
}

export function SwitcherStrip({ apps, currentApp }: SwitcherStripProps): JSX.Element {
  const current = apps.find((app) => app.app === currentApp);

  return (
    <nav className="pd-chrome__strip" aria-label="PlasmaDesign apps">
      <span className="pd-chrome__strip-brand">
        <span className="pd-chrome__strip-mark" />
        <span className="pd-chrome__strip-wordmark">PlasmaDesign</span>
      </span>
      <ul className="pd-chrome__strip-nav" role="list">
        {apps.map((app) =>
          app.app === currentApp ? (
            <li key={app.app}>
              <span
                className="pd-chrome__strip-link pd-chrome__strip-link--current"
                aria-current="page"
              >
                {app.label}
                <span className="pd-chrome__strip-rule" />
              </span>
            </li>
          ) : (
            <li key={app.app}>
              <a className="pd-chrome__strip-link" href={app.url}>
                {app.label}
              </a>
            </li>
          ),
        )}
      </ul>
      {current ? <span className="pd-chrome__strip-role">{current.role}</span> : null}
    </nav>
  );
}
