// Dev-only Vite config for the visual-verification harness in
// verify-harness/. Serves the real designer pages against a fixture
// supabase client (no project, no auth, no network) so UI changes can be
// screenshotted and click-tested headlessly:
//   pnpm vite --config vite.verify.config.ts
//   → http://localhost:5199/verify-harness/index.html
// Not part of `pnpm build` — nothing here ships.
import { defineConfig, type Plugin } from 'vite'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const ROOT = __dirname

// Swap the real supabase client + auth context for fixtures, wherever they're
// imported from. Match on the RESOLVED id so every relative specifier
// ('./supabase', '../lib/supabase') is caught.
function mockDataLayer(): Plugin {
  return {
    name: 'verify-mock-data-layer',
    enforce: 'pre',
    async resolveId(source, importer) {
      if (!importer || importer.includes('verify-harness')) return null
      // Match '../lib/supabase', './supabase' (sibling imports inside lib/),
      // './auth' etc. — anything whose basename is supabase or auth.
      if (!/(^|\/)(supabase|auth)(\.tsx?)?$/.test(source)) return null
      const resolved = await this.resolve(source, importer, { skipSelf: true })
      if (!resolved) return null
      if (resolved.id.endsWith(path.join('src', 'lib', 'supabase.ts'))) {
        return path.resolve(ROOT, 'verify-harness/mock-supabase.ts')
      }
      if (resolved.id.endsWith(path.join('src', 'lib', 'auth.tsx'))) {
        return path.resolve(ROOT, 'verify-harness/mock-auth.tsx')
      }
      return null
    },
  }
}

export default defineConfig({
  plugins: [mockDataLayer(), react(), tailwindcss()],
  define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://example.supabase.co'),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('verify-anon-key'),
  },
  server: { port: 5199, strictPort: true },
})
