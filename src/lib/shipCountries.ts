// Shared destination-country list for shipping.
//
// Used by the order builder (the designer's optional country hint) and the
// customer pay-page (delivery destination), and mirrored in the
// create-checkout-session edge function's Stripe `shipping_address_collection`
// allow-list (Deno can't import this module, so the code list is duplicated
// there — keep the two in step).
//
// Codes are ISO 3166-1 alpha-2; display names are derived via
// `Intl.DisplayNames` so we don't hand-maintain ~190 labels (and they
// localise / stay spelled correctly). Embargoed or non-serviceable
// destinations are deliberately omitted (Cuba, Iran, North Korea, Syria,
// Russia, Belarus) — both FedEx and Stripe decline these. United Kingdom is
// included. If FedEx doesn't quote a particular lane the checkout falls back
// to "we'll confirm shipping", so the list errs on the side of inclusion.

export interface ShipCountry {
  code: string
  name: string
}

// FedEx-serviceable destinations (broad). Sorted into display order below.
export const SHIP_COUNTRY_CODES: string[] = [
  'AD', 'AE', 'AG', 'AI', 'AL', 'AM', 'AO', 'AR', 'AT', 'AU', 'AW', 'AZ',
  'BA', 'BB', 'BD', 'BE', 'BF', 'BH', 'BI', 'BJ', 'BM', 'BN', 'BO', 'BR',
  'BS', 'BT', 'BW', 'BZ', 'CA', 'CD', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM',
  'CN', 'CO', 'CR', 'CV', 'CW', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM', 'DO',
  'DZ', 'EC', 'EE', 'EG', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FK', 'FO',
  'FR', 'GA', 'GB', 'GD', 'GE', 'GF', 'GG', 'GH', 'GI', 'GL', 'GM', 'GN',
  'GP', 'GQ', 'GR', 'GT', 'GU', 'GW', 'GY', 'HK', 'HN', 'HR', 'HT', 'HU',
  'ID', 'IE', 'IL', 'IM', 'IN', 'IS', 'IT', 'JE', 'JM', 'JO', 'JP', 'KE',
  'KG', 'KH', 'KN', 'KR', 'KW', 'KY', 'KZ', 'LA', 'LB', 'LC', 'LI', 'LK',
  'LR', 'LS', 'LT', 'LU', 'LV', 'MA', 'MC', 'MD', 'ME', 'MG', 'MK', 'ML',
  'MM', 'MN', 'MO', 'MQ', 'MR', 'MS', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY',
  'MZ', 'NA', 'NC', 'NE', 'NG', 'NI', 'NL', 'NO', 'NP', 'NZ', 'OM', 'PA',
  'PE', 'PF', 'PG', 'PH', 'PK', 'PL', 'PR', 'PT', 'PY', 'QA', 'RE',
  'RO', 'RS', 'RW', 'SA', 'SB', 'SC', 'SE', 'SG', 'SI', 'SK', 'SL', 'SM',
  'SN', 'SR', 'ST', 'SV', 'SZ', 'TC', 'TD', 'TG', 'TH', 'TJ', 'TL', 'TN',
  'TO', 'TR', 'TT', 'TW', 'TZ', 'UA', 'UG', 'US', 'UY', 'UZ', 'VC', 'VE',
  'VG', 'VN', 'VU', 'WS', 'YE', 'ZA', 'ZM', 'ZW',
]

const REGION_NAMES =
  typeof Intl !== 'undefined' && 'DisplayNames' in Intl
    ? new Intl.DisplayNames(['en'], { type: 'region' })
    : null

// Display list: code → name, sorted alphabetically by name. Falls back to the
// raw code if a runtime can't resolve a name.
export const SHIP_COUNTRIES: ShipCountry[] = SHIP_COUNTRY_CODES
  .map((code) => ({ code, name: REGION_NAMES?.of(code) ?? code }))
  .sort((a, b) => a.name.localeCompare(b.name))

// Representative postcode per country, for the order builder's *indicative*
// shipping estimate (the designer rarely knows the customer's real postcode at
// order-creation time). A central business-district postcode per country —
// enough for FedEx to return a zone-accurate ballpark, which is all the
// goodwill-discount decision needs; the real rate is computed from the
// customer's actual postcode at checkout. Countries absent here simply show
// "estimate not available" (e.g. those without a postcode system, where a
// guessed value would just make FedEx reject the quote). GB is mainland
// (deliberately not a BT/NI postcode) so the estimate reflects the common case.
export const REPRESENTATIVE_POSTCODES: Record<string, string> = {
  GB: 'EC1A 1BB',
  IE: 'D02 AF30',
  US: '10001',
  CA: 'M5H 2N2',
  AU: '2000',
  NZ: '1010',
  FR: '75001',
  DE: '10115',
  ES: '28001',
  IT: '00184',
  NL: '1011 AC',
  BE: '1000',
  SE: '111 29',
  DK: '1050',
  NO: '0010',
  CH: '8001',
  AT: '1010',
  PT: '1100-148',
  FI: '00100',
  PL: '00-001',
  CZ: '110 00',
  GR: '105 57',
  HU: '1051',
  RO: '010011',
  SK: '811 01',
  SI: '1000',
  HR: '10000',
  BG: '1000',
  LT: '01100',
  LV: '1050',
  EE: '10111',
  LU: '1009',
  JP: '100-0001',
  KR: '04524',
  SG: '178957',
  IN: '110001',
  CN: '100000',
  ZA: '2000',
  BR: '01310-100',
  MX: '06000',
  AR: 'C1001AAA',
  CL: '8320000',
  TR: '34000',
  IL: '6100000',
  TH: '10200',
  MY: '50050',
  ID: '10110',
  PH: '1000',
  VN: '100000',
}

