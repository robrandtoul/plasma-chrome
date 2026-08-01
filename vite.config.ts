import { defineConfig, type Plugin } from 'vite'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Emit dist/version.json naming the commit this bundle was built from.
//
// WHY: the Tier 3 synthetic check (.github/workflows/proof-view-check.yml)
// runs a real browser against PRODUCTION after a push to main. Netlify takes
// a couple of minutes to build, so a check that starts immediately tests the
// PREVIOUS deploy — and since the previous deploy is by definition working,
// every assertion passes and the run goes green without ever having looked at
// the commit that was just pushed. That vacuous pass is the exact failure the
// check exists to eliminate, so the workflow polls this file until it reports
// the SHA it is meant to be testing, and only then runs the assertions.
//
// COMMIT_REF is set by Netlify automatically — no build-command or dashboard
// configuration to keep in sync. Locally it is absent and this reads 'dev',
// which is correct: nothing polls it outside CI.
//
// Deliberately a separate asset rather than a value baked into the bundle:
// the app never reads it, so it adds no runtime code, cannot affect the
// customer page, and is cheap to fetch on a poll. It doubles as a plain
// answer to "what is actually deployed right now?".
function emitVersionJson(): Plugin {
  return {
    name: 'plasma-emit-version-json',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({
          commit: process.env.COMMIT_REF ?? 'dev',
          builtAt: new Date().toISOString(),
        }),
      })
    },
  }
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    emitVersionJson(),
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
