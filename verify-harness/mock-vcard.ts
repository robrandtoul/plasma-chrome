// Fixture stand-in for src/lib/vcardClient.ts, swapped in by the
// resolveId plugin in vite.verify.config.ts (same mechanism as the
// supabase and auth mocks).
//
// The real client makes a plain `fetch` to the vCard app's anon RPCs on
// another origin. The harness runs fully offline with external hosts
// failing fast, and the vCard env vars are not set locally — so without
// this mock the hosted-vCard QR panel throws VcardConfigError before it
// gets anywhere near rendering, and every branch of it is unverifiable.
// It has been unverifiable since the integration shipped; this closes
// that, for the redirect view and the contact-fields view alike.
//
// Slugs are chosen to cover the states that render differently:
//   qr-redirect  → an external_url card (a short link to a web page)
//   qr-draft     → the same, not yet live
//   qr-noaddress → a redirect card with no address saved
//   qr-vcard     → a hosted vCard with real contact fields
//   anything else → not_found

import type {
  VcardBundle,
  VcardCard,
  VcardContactMethod,
  VcardLink,
  VcardResult,
} from '../src/lib/vcardClient'

export type { VcardBundle, VcardCard, VcardContactMethod, VcardLink, VcardResult }

export class VcardConfigError extends Error {
  constructor() {
    super('vCard app env vars not configured (harness mock).')
    this.name = 'VcardConfigError'
  }
}

// A destination of realistic SHAPE and LENGTH — the live one behind the
// job that prompted this feature is 1,009 characters, of which the only
// part identifying where it goes is the search term. The business is
// invented; the parameter names, the opaque token lengths and the
// trailing fragment are true to life, because those are what the layout
// has to survive. A 40-character placeholder would prove nothing about
// how the panel handles the real thing.
const LONG_DESTINATION =
  'https://www.google.com/search?sca_esv=31d0bfb7a33f7a8b&biw=384&bih=693' +
  '&sxsrf=APpeQnvWuG-OjUZStUELXXk1nudR_HOXxg:1786157850107' +
  '&q=harborline+plumbing+reviews' +
  '&uds=AJ5uw1-KIEBMDzKttSTPo005nyq2YFY-0my5VxO9uX0b9RjGU81ImDGMfLnAWDNdmicNXTXwGaCTT' +
  'JzUAjDbxAhBTNyZzTZ2zNDSekJ7Fss87tQca6v6QtJPE4JbyfnE1VWN9tsjiZfS7t7WOAg3YwlRmWWx1-4' +
  'lX46FBX5XhwSE15OgckKzwXpdeYWkoQ1G8GaugohmJ8U36Rjx0CtJW3UeAYBF8_I8_nIfpncTASOMU2kUi' +
  '_8Ve5f0IN5A_zyDB-7KRh27KT0BpUvUcSN0cKG-J9zsMJ9FsAjGfG3FBe0N2T7lifgFKVpruhRvIAIQb0R' +
  'ZDxxlL_9EdJqExtVQfT1DJA65SZXw89An0OgQJAXQ1Fw9XhRzSqqQ8E5KftR9ISnOuhHSo2can8zojJxyd' +
  '&si=APenkKm7iecQ4G6P-TsbSMFKIQtv3EFIqRAFw-i8uEbk55Z-_wE4Rv5qb2Iryc-J8RRgqgEfd6FQ04' +
  'w_6YqlJGflaJ4MNaCJdwSPWMrBMtlTRmLc7D9__LUa1HCo570oX-MWWwLEIxSWnOZBvmiy-a5WyUF_DSeK' +
  '&sa=X&ved=2ahUKEwjWhqzBhJCWAxUFSjABHYuWNzsQk8gLegQIGxAB' +
  '&ictx=1&stq=1&cs=1&lei=Gpt2ataRBoWUwbkPi63e2QM#ebo=1'

const BLANK: Omit<VcardCard, 'id' | 'slug' | 'status' | 'target_type' | 'external_url'> = {
  first_name: null,
  last_name: null,
  nickname: null,
  job_title: null,
  company: null,
  birthday: null,
  primary_email: null,
  email_label: null,
  primary_phone: null,
  phone_label: null,
  bio: null,
  address_street: null,
  address_city: null,
  address_region: null,
  address_postcode: null,
  address_country: null,
  profile_image_path: null,
  logo_image_path: null,
  cover_image_path: null,
  theme_mode: null,
  theme_font: null,
  theme_accent: null,
  card_updated_at: null,
}

const CARDS: Record<string, VcardCard> = {
  'qr-redirect': {
    ...BLANK,
    id: 'card-redirect',
    slug: 'qr-redirect',
    status: 'live',
    target_type: 'external_url',
    external_url: LONG_DESTINATION,
  },
  'qr-draft': {
    ...BLANK,
    id: 'card-draft',
    slug: 'qr-draft',
    status: 'draft',
    target_type: 'external_url',
    external_url: 'https://harborlineplumbing.co.uk/book',
  },
  'qr-noaddress': {
    ...BLANK,
    id: 'card-noaddress',
    slug: 'qr-noaddress',
    status: 'live',
    target_type: 'external_url',
    external_url: null,
  },
  'qr-vcard': {
    ...BLANK,
    id: 'card-vcard',
    slug: 'qr-vcard',
    status: 'live',
    target_type: 'vcard',
    external_url: null,
    first_name: 'Dana',
    last_name: 'Rowe',
    job_title: 'Operations Director',
    company: 'Harborline Plumbing',
    primary_email: 'dana@harborlineplumbing.co.uk',
    email_label: 'Work',
    primary_phone: '+44 20 7946 0812',
    phone_label: 'Mobile',
    address_street: '14 Wharf Road',
    address_city: 'Bristol',
    address_postcode: 'BS1 4RN',
    address_country: 'United Kingdom',
  },
}

export async function lookupCardBySlug(slug: string): Promise<VcardResult<VcardCard>> {
  const card = CARDS[slug]
  return card ? { ok: true, data: card } : { ok: false, reason: 'not_found' }
}

export async function lookupCardLinks(): Promise<VcardLink[]> {
  return []
}

export async function lookupCardContactMethods(): Promise<VcardContactMethod[]> {
  return []
}

export async function fetchVcardForSlug(slug: string): Promise<VcardResult<VcardBundle>> {
  const result = await lookupCardBySlug(slug)
  if (!result.ok) return result
  return { ok: true, data: { card: result.data, links: [], contactMethods: [] } }
}
