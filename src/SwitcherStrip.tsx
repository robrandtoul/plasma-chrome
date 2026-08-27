/* ─────────────────────────────────────────────────────────────
   The ink row. Rendered only when appsVisible (and only at two or
   more apps — below that mountAppSwitcher renders nothing today and
   so do we).

   Links point at other origins, so they are always plain anchors:
   linkComponent is a router seam and there is no route to another
   app's domain.

   NO WORDMARK, by product decision 2026-08-27. The handoff spec puts a
   15px white mark and the word PLASMADESIGN at the head of this row.
   Both are gone: every app's own lockup sits 38px below saying the same
   company name, and the strip already names the app you are in, so the
   lockup was the third telling of one thing on one screen. The ink
   surface itself stays — that is what the spec's "two surfaces, not
   four" argument is actually about, and it still separates estate-level
   navigation from the app cleanly.

   `aria-label` keeps the company name because the accessible name of
   this landmark still has to say what the row is; a screen-reader user
   never had the duplication a sighted one did.
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
