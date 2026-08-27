/* The preference switch. Presentational only — the row around it owns
   the button semantics, so this carries aria-hidden and nothing else. */

import type { JSX } from 'react';
import { cx } from './types';

export function Toggle({ on }: { on: boolean }): JSX.Element {
  return (
    <span
      className={cx('pd-chrome__switch', on && 'pd-chrome__switch--on')}
      aria-hidden="true"
    >
      <span className="pd-chrome__switch-knob" />
    </span>
  );
}

/** Both controls write the same value, so both say the same thing. */
export const PREF_TITLE = 'Keep apps visible';

export function prefHint(on: boolean): string {
  return on ? 'A strip lists all four, always' : 'Switch from the app menu instead';
}
