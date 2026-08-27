import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/* The demo is a parity harness, not a product. It imports `../src`
   directly rather than the built `dist/`, so a change to a component
   is visible on save without a build, and it imports the real
   `../src/chrome.css` rather than a copy.

   `root` is relative to the working directory, which is the package
   root when this is run as `npm run demo`. That keeps the config free
   of `node:url` and so keeps @types/node out of the devDependencies. */
export default defineConfig({
  root: 'demo',
  plugins: [react()],
  server: { port: 5180 },
  build: { outDir: 'dist', emptyOutDir: true },
});
