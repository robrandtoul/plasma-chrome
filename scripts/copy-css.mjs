/* Ship src/chrome.css to dist/chrome.css unchanged.

   There is no CSS build step and there must not be one. The stylesheet
   is hand-written, prefixed and dependency-free precisely so that four
   hosts on Tailwind v3, v4, v4 and no-Tailwind can each import one
   file without agreeing on anything. A processor here would be a fifth
   opinion about CSS in a package whose job is to have none. */

import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const from = fileURLToPath(new URL('../src/chrome.css', import.meta.url));
const toDir = fileURLToPath(new URL('../dist', import.meta.url));
const to = fileURLToPath(new URL('../dist/chrome.css', import.meta.url));

mkdirSync(toDir, { recursive: true });
copyFileSync(from, to);
console.log('copied src/chrome.css -> dist/chrome.css');
