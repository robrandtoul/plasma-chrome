// Cached access to the public_settings() RPC. The customer-facing proof
// page is the main caller; in-flight requests are de-duplicated and
// completed fetches are cached for 60s so a surge of page loads doesn't
// hammer the database.

import { supabase } from './supabase'
import {
  DEFAULT_METAL_THICKNESS_NOTES,
  normaliseMetalThicknessNotes,
  type MetalThicknessNotes,
} from './metalThicknessNotes'
import {
  LOGIN_HEADLINE_DEFAULT,
  LOGIN_DESCRIPTION_DEFAULT,
  LOGIN_STATS_DEFAULT,
  LOGIN_FORM_HEADING_DEFAULT,
  LOGIN_FORM_SUBCOPY_DEFAULT,
  normaliseLoginStats,
  type LoginStat,
} from './loginCopy'

export interface PublicSettings {
  disclaimer_text: string
  company_name: string
  reply_email: string
  // Phase 2 customer approval flow modal copy. Editable in admin
  // (000116); falls back to the spec defaults below if the RPC ever
  // returns null/empty so the modal still renders readable text.
  approve_confirmation_copy: string
  request_changes_confirmation_copy: string
  // Metal Thickness card copy (migration 000199). Editable in admin;
  // normalised against the defaults so a null / malformed column can
  // never blank the panel.
  metal_thickness_notes: MetalThicknessNotes
  // "About this proof" footer note (migration 000199). Editable in
  // admin; falls back to the shipped default if null/empty.
  about_proof_copy: string
  // "QR code contents" panel copy (migration 000200). Two paragraphs,
  // editable in admin; each falls back to the shipped default if
  // null/empty so the panel always renders readable copy.
  qr_panel_intro_copy: string
  qr_panel_vcard_copy: string
  // Login-page copy (migration 000206). Editable in admin; each falls
  // back to the shipped default if null/empty/malformed so the login
  // page never blanks. login_headline carries newlines (rendered
  // white-space: pre-line); login_stats is normalised to <=3 rows.
  login_headline: string
  login_description: string
  login_stats: LoginStat[]
  login_form_heading: string
  login_form_subcopy: string
}

const TTL_MS = 60_000

let cache: { value: PublicSettings; fetchedAt: number } | null = null
let inFlight: Promise<PublicSettings> | null = null

const APPROVE_COPY_DEFAULT =
  "By approving, you're confirming that you've reviewed the proof and we're cleared to print as shown. Approval is final and triggers production scheduling."
const REQUEST_CHANGES_COPY_DEFAULT =
  "We'll update your proof based on your feedback. The team will reply within one working day."
// Mirrors the migration 000199 seed for settings.about_proof_copy and
// the copy that previously lived inline in CustomerProofPage.tsx.
export const ABOUT_PROOF_COPY_DEFAULT =
  'The proof shows etching colour, ink finish, layout and copy at the closest faithful representation we can make on screen. The real card will differ slightly in the way the material catches light, the depth of any embossing or etch, and the weight in hand. Plasma Design hand-finishes every set in Stoke-on-Trent.'
// Mirrors the migration 000200 seeds for the QR-panel copy and the copy
// that previously lived inline in src/components/QrCodePanel.tsx.
export const QR_PANEL_INTRO_COPY_DEFAULT =
  "Please double-check the contents of each QR code. Scan with your phone or read the decoded text alongside each one. The on-screen QR is the exact image we'll print."
export const QR_PANEL_VCARD_COPY_DEFAULT =
  'For Plasma vCards, scanning the QR saves the contact details to a phone. The look of the page it opens — the photo, colours, and layout — is yours to personalise after your cards arrive.'

const DEFAULTS: PublicSettings = {
  disclaimer_text: '',
  company_name: 'PlasmaDesign Ltd',
  reply_email: '',
  approve_confirmation_copy: APPROVE_COPY_DEFAULT,
  request_changes_confirmation_copy: REQUEST_CHANGES_COPY_DEFAULT,
  metal_thickness_notes: DEFAULT_METAL_THICKNESS_NOTES,
  about_proof_copy: ABOUT_PROOF_COPY_DEFAULT,
  qr_panel_intro_copy: QR_PANEL_INTRO_COPY_DEFAULT,
  qr_panel_vcard_copy: QR_PANEL_VCARD_COPY_DEFAULT,
  login_headline: LOGIN_HEADLINE_DEFAULT,
  login_description: LOGIN_DESCRIPTION_DEFAULT,
  login_stats: LOGIN_STATS_DEFAULT,
  login_form_heading: LOGIN_FORM_HEADING_DEFAULT,
  login_form_subcopy: LOGIN_FORM_SUBCOPY_DEFAULT,
}

// Trim-guarded string pick: returns the RPC value when it's a non-empty
// string, else the default. Mirrors the inline checks used for the other
// editable-copy fields.
function pickStr(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim().length > 0 ? v : fallback
}

export async function getPublicSettings(): Promise<PublicSettings> {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache.value
  if (inFlight) return inFlight

  inFlight = (async () => {
    try {
      const { data } = await supabase.rpc('public_settings')
      const approveCopy = data?.approve_confirmation_copy
      const rcCopy = data?.request_changes_confirmation_copy
      const value: PublicSettings = {
        disclaimer_text: (data?.disclaimer_text as string) ?? DEFAULTS.disclaimer_text,
        company_name:    (data?.company_name as string)    ?? DEFAULTS.company_name,
        reply_email:     (data?.reply_email as string)     ?? DEFAULTS.reply_email,
        approve_confirmation_copy:
          typeof approveCopy === 'string' && approveCopy.trim().length > 0
            ? approveCopy
            : DEFAULTS.approve_confirmation_copy,
        request_changes_confirmation_copy:
          typeof rcCopy === 'string' && rcCopy.trim().length > 0
            ? rcCopy
            : DEFAULTS.request_changes_confirmation_copy,
        metal_thickness_notes: normaliseMetalThicknessNotes(data?.metal_thickness_notes),
        about_proof_copy:
          typeof data?.about_proof_copy === 'string' && data.about_proof_copy.trim().length > 0
            ? data.about_proof_copy
            : DEFAULTS.about_proof_copy,
        qr_panel_intro_copy:
          typeof data?.qr_panel_intro_copy === 'string' && data.qr_panel_intro_copy.trim().length > 0
            ? data.qr_panel_intro_copy
            : DEFAULTS.qr_panel_intro_copy,
        qr_panel_vcard_copy:
          typeof data?.qr_panel_vcard_copy === 'string' && data.qr_panel_vcard_copy.trim().length > 0
            ? data.qr_panel_vcard_copy
            : DEFAULTS.qr_panel_vcard_copy,
        login_headline:     pickStr(data?.login_headline, DEFAULTS.login_headline),
        login_description:  pickStr(data?.login_description, DEFAULTS.login_description),
        login_stats:        normaliseLoginStats(data?.login_stats),
        login_form_heading: pickStr(data?.login_form_heading, DEFAULTS.login_form_heading),
        login_form_subcopy: pickStr(data?.login_form_subcopy, DEFAULTS.login_form_subcopy),
      }
      cache = { value, fetchedAt: Date.now() }
      return value
    } catch {
      // Transport-level failure (network drop, edge runtime crash).
      // Cache the spec defaults so the page still renders readable
      // copy and subsequent calls within the TTL don't re-throw.
      cache = { value: DEFAULTS, fetchedAt: Date.now() }
      return DEFAULTS
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

/** Invalidate the cache — the admin settings page calls this after saves
 *  so a quick preview in another tab picks up the change faster than the
 *  60-second TTL. */
export function invalidatePublicSettings(): void {
  cache = null
}
