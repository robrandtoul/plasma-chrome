/* Give the emitted relative imports their `.js` extension.

   tsc copies module specifiers through verbatim, and the source
   writes them extensionless (`from './Chrome'`) because it is
   compiled under `moduleResolution: bundler`. That output is
   resolvable by every bundler and by none of the standards-compliant
   resolvers: raw Node ESM rejects it, and so does a host tsconfig set
   to `moduleResolution: node16`.

   Today all four hosts are Vite, so nothing would break. That is
   exactly the kind of assumption this package exists to stop making:
   the fifth consumer, or the first host to move its own tsconfig,
   would hit a resolution failure inside a dependency it does not
   build. Three regex-substituted characters per import line is a
   cheaper insurance premium than a bundler.

   `.d.ts` files get the same treatment: `./types.js` resolves to
   `types.d.ts` under bundler AND node16 resolution, where bare
   `./types` resolves only under bundler.

   Known wart: the .js.map and .d.ts.map column offsets after a
   rewritten specifier are three characters stale. It affects the tail
   of import lines only, and the alternative is shipping no maps.
   ─────────────────────────────────────────────────────────── */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist', import.meta.url));

/* Matches the specifier in `... from './x'` and in a bare side-effect
   `import './x'`. Only relative specifiers, and only those whose last
   segment carries no dot. Anything already extensioned is left be. */
const FROM = /(\bfrom\s*['"])(\.{1,2}\/[^'"]+)(['"])/g;
const BARE = /(\bimport\s*['"])(\.{1,2}\/[^'"]+)(['"])/g;

function addExtension(_match, open, specifier, close) {
  const last = specifier.split('/').pop() ?? '';
  if (last.includes('.')) return open + specifier + close;
  return open + specifier + '.js' + close;
}

let changed = 0;
for (const name of readdirSync(dist)) {
  if (!name.endsWith('.js') && !name.endsWith('.d.ts')) continue;
  const path = join(dist, name);
  const before = readFileSync(path, 'utf8');
  const after = before.replace(FROM, addExtension).replace(BARE, addExtension);
  if (after === before) continue;
  writeFileSync(path, after);
  changed += 1;
}

console.log(`extensions added to relative specifiers in ${changed} file(s)`);
