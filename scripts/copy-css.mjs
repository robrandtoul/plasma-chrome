/* Ship src/chrome.css to dist/chrome.css unchanged.

   There is no CSS build step and there must not be one. The stylesheet
   is hand-written, prefixed and dependency-free precisely so that four
   hosts on Tailwind v3, v4, v4 and no-Tailwind can each import one
   file without agreeing on anything. A processor here would be a fifth
   opinion about CSS in a package whose job is to have none. */

import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/* One entry per stylesheet the package ships. Two today: the navigation
   chrome, and the chat panel that lives beside it under ./chat. */
const SHEETS = [
  ['../src/chrome.css', '../dist/chrome.css'],
  ['../src/chat/chat.css', '../dist/chat/chat.css'],
];

for (const [fromRel, toRel] of SHEETS) {
  const from = fileURLToPath(new URL(fromRel, import.meta.url));
  const to = fileURLToPath(new URL(toRel, import.meta.url));
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  console.log(`copied ${fromRel.replace('../', '')} -> ${toRel.replace('../', '')}`);
}
