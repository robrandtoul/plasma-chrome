// Third Vite build target (after the SPA and price-list bundles).
//
// Emits dist/contact-form/contact-form.js, a single IIFE asset
// loaded by the Squarespace support page via <script src>. Stable
// unhashed filename so the embed URL is permanent.
//
// Build-time env vars (interpolated via import.meta.env):
//   * VITE_SUPABASE_URL          — derives the edge function URL
//   * VITE_TURNSTILE_SITE_KEY    — public Cloudflare Turnstile site key
//
// Run via `pnpm build:contact-form`, called as part of `pnpm build`
// after the SPA and price-list bundles.

import { defineConfig } from 'vite'

export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist/contact-form',
    emptyOutDir: true,
    cssCodeSplit: false,
    target: 'es2019',
    lib: {
      entry: 'src/contact-form/main.ts',
      name: 'PlasmaContactForm',
      formats: ['iife'],
      fileName: () => 'contact-form.js',
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        assetFileNames: 'contact-form.[ext]',
      },
    },
  },
})
