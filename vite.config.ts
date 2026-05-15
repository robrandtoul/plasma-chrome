import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  build: {
    // Pin the SPA build to exactly index.html so sibling HTML files
    // at the project root (e.g. price-list-preview.html, a dev-only
    // harness for the marketing-site price-list script) are never
    // copied into dist/. The Vite default already only picks up
    // index.html when rollupOptions.input is unset, but stating it
    // here makes the exclusion explicit and stops any future Vite
    // version that auto-includes sibling HTML from leaking the
    // harness into the deploy.
    rollupOptions: {
      // Key kept as 'index' so the emitted asset filenames stay
      // identical to the pre-pin default (dist/assets/index-*.{js,css}).
      input: {
        index: resolve(__dirname, 'index.html'),
      },
    },
  },
})
