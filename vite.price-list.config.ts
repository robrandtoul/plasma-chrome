// Second Vite build target for the marketing-site price-list script.
//
// The SPA build (vite.config.ts) emits dist/ for proofs.plasmadesign.co.uk;
// this build emits dist/price-list/price-list.js, the single asset the
// Squarespace pages will reference via <script src>.
//
// We use library mode in IIFE format so the file works as a classic
// script tag (no type="module" required on Squarespace). Output name
// is pinned to `price-list.js` with no content hash — the Squarespace
// embed needs a stable URL.
//
// Run via `pnpm build:price-list` (called as part of `pnpm build`).
// Output goes inside the main dist/ so Netlify ships everything in a
// single deploy.

import { defineConfig } from 'vite'

export default defineConfig({
  // No public/ copy — the SPA build already ships everything in
  // public/, and this entry only produces a single JS asset.
  publicDir: false,
  build: {
    outDir: 'dist/price-list',
    emptyOutDir: true,
    cssCodeSplit: false,
    target: 'es2019',
    lib: {
      entry: 'src/price-list/main.ts',
      name: 'PlasmaPriceList',
      formats: ['iife'],
      fileName: () => 'price-list.js',
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        assetFileNames: 'price-list.[ext]',
      },
    },
  },
})
