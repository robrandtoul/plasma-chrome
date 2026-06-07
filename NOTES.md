# Session 1 notes — 19 April 2026

## What was completed

### Toolchain
Node v22.14.0 was already present. Installed: pnpm 10.33.0 (via get.pnpm.io), Homebrew, Supabase CLI 2.90.0, Netlify CLI 25.0.1, GitHub CLI (gh).

### GitHub
Private repo created at github.com/robrandtoul/proof-viewer. GitHub CLI used for auth. All commits pushed to `main`.

### Database (Supabase project: xpcjanqrcgzjmwketxtt)
Ten migrations applied in order:

| Migration | What it does |
|---|---|
| 000001–000008 | Types, profiles, proofs, proof_versions (v1 schema), pricing_tables (later dropped), app_settings, public views, storage bucket |
| 000009 | Drops old pricing_tables; installs five-table pricing model (materials, material_variants, price_tiers, add_ons, add_on_prices) |
| 000010 | Rebuilds proof_versions to v2 schema (material_variant_id FK + material_display/variant_display text); adds RLS to all five pricing tables; recreates triggers and public_proof_versions view |

seed.sql applied: 17 materials, 47 variants, 16,047 price tiers, 3 add-ons, 393 add-on prices.

### App pages built
All routes stubbed and functional (placeholder Tailwind, no design system yet):

- `/p/:id` — customer proof page: loads proof + versions from public views, resolves signed image URLs, version tabs, spec panel, pricing table with per-card unit price, change notes, disclaimer
- `/login` — email/password login via Supabase Auth
- `/` — designer dashboard: lists all proofs, current version, customer link
- `/proofs/new` — new-proof form (customer name, company, Help Scout URL, internal notes)
- `/proofs/:id` — proof detail: version list, make-current button, internal metadata panel
- `/proofs/:id/versions/new` — add-version form: image upload (JPEG/PNG ≤10MB), material → variant → currency cascade, live pricing pre-fill from price_tiers with per-row overrides, ink names, change notes

Auth is handled by a React context (AuthProvider) with a RequireAuth guard on all designer routes.

### Netlify
Site live at https://proofs.plasmadesign.co.uk. Connected to the GitHub repo; auto-deploys on push to `main`. Build command: `pnpm build`, publish directory: `dist`. VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY set in Netlify environment variables. First designer login confirmed working.

## Next session

1. Create a test proof and version through the UI to smoke-test the full flow end to end.
2. Configure Hostinger DNS for the custom subdomain pointing at Netlify.
3. Apply the Claude Design handoff bundle (once produced) to all unstyled pages — design tokens go in `src/index.css` under `@theme {}`.

## Known gaps / not yet done

- Pricing seed for missing add-on prices: `metal_finish_upgrade`, `letterpress_gilding`, `carbon_cnc` have rows in add_ons but no prices seeded.
- No logout route — sign-out is a button in the dashboard header only.
- No 404 route for unknown paths (falls through to the login redirect).
- Design system not applied — all pages use placeholder Tailwind classes.
- Hostinger DNS / custom subdomain not yet configured.

# Session notes — 7 June 2026: password recovery completion

## Auth / password recovery (Supabase project: xpcjanqrcgzjmwketxtt, "proof-viewer")

Password resets are **admin-triggered** (designers / admins; customers never sign
in). The admin Users tab already fires the recovery email via the
`admin-user-password` edge function (`mode: 'reset_email'`, which calls
`generateLink({ type: 'recovery' })`). This session added the missing frontend
piece so the link actually completes:

- `src/lib/auth.tsx` — `AuthProvider` now exposes `recovery` / `recoveryError` /
  `endRecovery`. It catches the `PASSWORD_RECOVERY` auth event, and also reads the
  URL hash at module load (captured before supabase-js consumes it) as a backstop,
  so it works even if the event fires before the listener subscribes, and so it can
  recognise an expired / already-used link (`#error=...&error_code=otp_expired`).
- `src/pages/SetNewPasswordPage.tsx` — new full-screen set-new-password view
  (LoginPage styling), min 8 chars, `supabase.auth.updateUser({ password })`, with
  a friendly "link expired" state.
- `src/App.tsx` — `AppShell` renders the recovery screen whenever `recovery !== 'none'`,
  before the router, so a recovery link no longer drops the user on the dashboard.

No self-service "Forgot your password?" on the login screen (deliberate; admin-only).

## Supabase Auth config (already done, on this project — do not change)

Configured 7 June 2026:
- URL Configuration: Site URL `https://proofs.plasmadesign.co.uk`; redirect URLs
  `https://proofs.plasmadesign.co.uk` and `https://proofs.plasmadesign.co.uk/**`.
- Custom SMTP via Resend (Supabase secret/key name `supabase-proofs-smtp`), sender
  `PlasmaDesign Proof Viewer <noreply@invite.plasmadesign.co.uk>`.
- Branded "Reset password" and "Invite user" email templates (Proof Viewer wording),
  `{{ .ConfirmationURL }}` intact.

Recovery emails are admin-triggered; there is no self-service reset.
