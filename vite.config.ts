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
      output: {
        // Pull the framework libraries that every route needs into their
        // own stable chunks. These change far less often than app code, so
        // once a browser has cached them they survive an app-code deploy —
        // a day of frequent deploys no longer forces a full re-download.
        //
        // Deliberately scoped to react/router/supabase only. The heavy
        // route-specific libraries (xlsx, jszip, qrcode, @zxing) are left
        // for Rollup to place in the page chunks that actually use them, so
        // the customer page and dashboard never pull admin-only weight.
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) {
            return 'react-vendor'
          }
          if (/[\\/]node_modules[\\/]@supabase[\\/]/.test(id)) return 'supabase-vendor'
        },
      },
    },
  },
})
