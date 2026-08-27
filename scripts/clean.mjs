/* Remove dist/ before a build. A five-line script rather than rimraf:
   the package's whole point is that it drags nothing in with it, and
   that discipline is cheapest to keep if it also applies to the
   toolchain. */

import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist', import.meta.url));
rmSync(dist, { recursive: true, force: true });
