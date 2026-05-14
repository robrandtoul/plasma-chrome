// Shared FedEx Rate API client. Used by the fedex-rate edge function
// to fetch an account-rate quote for a parcel going from Plasma's
// fixed origin (Southampton, GB) to a designer-entered destination.
//
// What lives here:
//   * FedExError           — single canonical exception type
//   * getFedExToken        — OAuth client_credentials flow against
//                            FEDEX_API_KEY + FEDEX_API_SECRET,
//                            module-cached for the duration of the
//                            isolate so a flurry of compiler requests
//                            doesn't re-auth on every call
//   * requestRate          — POST /rate/v1/rates/quotes with the
//                            shipper/recipient/weight/currency body
//                            the Quote compiler needs
//   * parseRateResponse    — pulls the active service entry out of
//                            FedEx's nested response and flattens it
//                            into the shape the compiler renders
//                            (base, discount, fuel, other surcharges,
//                            net, service name)
//
// Why a separate file: mirrors _shared/helpscout.ts so callers can
// `import { ... } from '../_shared/fedex.ts'` rather than duplicating
// the OAuth + parse logic per function. There's only one consumer
// today (fedex-rate) but the shape matches the established pattern
// for outbound integrations.

// Plasma's fixed shipping origin. Used as the shipper.address on
// every rate request. Constant rather than a settings column because
// the origin doesn't change — if Plasma ever moves, that's a single
// edit here plus a deploy, not an admin-managed value.
export const FEDEX_ORIGIN = {
  postalCode: 'SO510QJ',
  countryCode: 'GB',
} as const

// Packaging type FedEx bills the rate against. "FEDEX_BOX" matches
// the operational requirement that every Plasma international order
// ships in a FedEx-supplied box.
//
// Note: the invoice-validation pass that signed this feature off was
// run with packagingType "YOUR_PACKAGING" and reconciled to the
// penny against a real FedEx invoice. Account rates for these
// services are weight-and-zone driven, so "FEDEX_BOX" is expected to
// produce identical figures, but if a post-launch invoice ever shows
// a mismatch the fallback is to swap this constant to
// "YOUR_PACKAGING" and redeploy.
const PACKAGING_TYPE = 'FEDEX_BOX' as const

// Single canonical error type. Every helper throws this on any non-
// success path so the calling function can branch on
// `err instanceof FedExError` and read `err.status` to categorise.
// Mirror of HsError in _shared/helpscout.ts.
export class FedExError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'FedExError'
  }
}

// Module-level token cache. FedEx OAuth tokens last ~1h; we treat
// any token with at least 60s remaining as good and otherwise re-
// fetch. Per-isolate, not shared across cold starts, which is fine
// for the ~hundreds-of-rate-requests-per-day volume this will see.
let cachedToken: { value: string; expiresAt: number } | null = null

export async function getFedExToken(
  apiKey: string,
  apiSecret: string,
): Promise<string> {
  const now = Date.now()
  if (cachedToken && cachedToken.expiresAt - 60_000 > now) {
    return cachedToken.value
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: apiKey,
    client_secret: apiSecret,
  })
  const resp = await fetch('https://apis.fedex.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '<body read failed>')
    throw new FedExError(resp.status, `FedEx token error (${resp.status}): ${text}`)
  }
  const data = await resp.json().catch(() => null) as
    | { access_token?: string; expires_in?: number }
    | null
  const token = data?.access_token
  if (!token || typeof token !== 'string') {
    throw new FedExError(500, 'FedEx token response missing access_token')
  }
  // FedEx returns expires_in in seconds; fall back to 3000s (just
  // under an hour) if missing so we still cache something useful.
  const ttlSeconds = typeof data?.expires_in === 'number' ? data.expires_in : 3000
  cachedToken = { value: token, expiresAt: now + ttlSeconds * 1000 }
  return token
}

// Inputs to a rate request. Currency is the same enum the compiler
// uses; the FedEx API accepts the three ISO codes directly via
// preferredCurrency. weightKg is the parcel weight after the
// per-card × quantity + box-tare maths has run in the edge function.
export interface RateRequest {
  destCountry: string
  destPostcode: string
  weightKg: number
  currency: 'GBP' | 'EUR' | 'USD'
  accountNumber: string
}

// POST /rate/v1/rates/quotes. Returns the parsed JSON body so the
// caller can pass it straight into parseRateResponse — no
// intermediate shape needs to leak out.
export async function requestRate(
  token: string,
  req: RateRequest,
): Promise<unknown> {
  const body = {
    accountNumber: { value: req.accountNumber },
    requestedShipment: {
      shipper:   { address: { postalCode: FEDEX_ORIGIN.postalCode, countryCode: FEDEX_ORIGIN.countryCode } },
      recipient: { address: { postalCode: req.destPostcode, countryCode: req.destCountry } },
      pickupType: 'USE_SCHEDULED_PICKUP',
      packagingType: PACKAGING_TYPE,
      rateRequestType: ['ACCOUNT'],
      preferredCurrency: req.currency,
      requestedPackageLineItems: [
        { weight: { units: 'KG', value: req.weightKg } },
      ],
    },
  }

  const resp = await fetch('https://apis.fedex.com/rate/v1/rates/quotes', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '<body read failed>')
    throw new FedExError(resp.status, `FedEx rate error (${resp.status}): ${text}`)
  }
  return await resp.json()
}

// Flattened shape returned to the compiler. All numbers in the
// currency that was requested (preferredCurrency). available=false
// when neither International Priority Express nor International
// Priority is offered for the lane.
export interface ParsedRate {
  available: boolean
  service: string | null
  serviceName: string | null
  currency: 'GBP' | 'EUR' | 'USD' | null
  netCharge: number | null
  baseCharge: number | null
  discountAmount: number | null
  discountPercent: number | null
  fuelSurcharge: number | null
  fuelPercent: number | null
  otherSurcharges: Array<{ label: string; amount: number }>
}

// Selection order: International Priority Express first, then
// International Priority, then unavailable. Matches the brief —
// Plasma wants Express where FedEx offers it and falls back
// gracefully where it doesn't.
const PREFERRED_SERVICES = [
  'FEDEX_INTERNATIONAL_PRIORITY_EXPRESS',
  'FEDEX_INTERNATIONAL_PRIORITY',
] as const

interface RawSurcharge {
  type?: string
  description?: string
  amount?: number
}

interface RawRatedShipmentDetail {
  rateType?: string
  totalNetCharge?: number
  totalBaseCharge?: number
  shipmentRateDetail?: {
    fuelSurchargePercent?: number
    freightDiscount?: Array<{ amount?: number; percent?: number }>
    surCharges?: RawSurcharge[]
  }
}

interface RawRateReplyDetail {
  serviceType?: string
  serviceName?: string
  ratedShipmentDetails?: RawRatedShipmentDetail[]
}

interface RawRateResponse {
  output?: {
    rateReplyDetails?: RawRateReplyDetail[]
  }
}

export function parseRateResponse(
  json: unknown,
  currency: 'GBP' | 'EUR' | 'USD',
): ParsedRate {
  const details = (json as RawRateResponse)?.output?.rateReplyDetails ?? []

  // Walk the preferred-service list in order. The first match wins —
  // if FedEx returned both Express and Priority for the lane, the
  // designer sees Express.
  let chosen: RawRateReplyDetail | null = null
  for (const wanted of PREFERRED_SERVICES) {
    const found = details.find((d) => d.serviceType === wanted)
    if (found) { chosen = found; break }
  }

  if (!chosen) {
    return {
      available: false,
      service: null,
      serviceName: null,
      currency: null,
      netCharge: null,
      baseCharge: null,
      discountAmount: null,
      discountPercent: null,
      fuelSurcharge: null,
      fuelPercent: null,
      otherSurcharges: [],
    }
  }

  // Within the chosen service, pick the ACCOUNT-rated shipment. The
  // FedEx response can include LIST and ACCOUNT rates side by side;
  // we always want ACCOUNT for Plasma's negotiated pricing.
  const ratedList = chosen.ratedShipmentDetails ?? []
  const accountRate =
    ratedList.find((r) => r.rateType === 'ACCOUNT') ?? ratedList[0] ?? null
  if (!accountRate) {
    return {
      available: false,
      service: chosen.serviceType ?? null,
      serviceName: chosen.serviceName ?? null,
      currency: null,
      netCharge: null,
      baseCharge: null,
      discountAmount: null,
      discountPercent: null,
      fuelSurcharge: null,
      fuelPercent: null,
      otherSurcharges: [],
    }
  }

  const discount = accountRate.shipmentRateDetail?.freightDiscount?.[0] ?? null
  const allSurcharges = accountRate.shipmentRateDetail?.surCharges ?? []

  // Pull the FUEL surcharge out by name so it can render on its own
  // line — designers will recognise "Fuel surcharge" and expect to
  // see the percent next to it. Everything else collapses into the
  // "Other surcharges" group (Out of Delivery Area, Ancillary Fee,
  // etc.) so the breakdown stays readable on long-tail lanes.
  let fuelSurcharge: number | null = null
  const otherSurcharges: Array<{ label: string; amount: number }> = []
  for (const s of allSurcharges) {
    const amount = typeof s.amount === 'number' ? s.amount : null
    if (amount == null) continue
    if (s.type === 'FUEL') {
      fuelSurcharge = amount
      continue
    }
    const label = s.description ?? s.type ?? 'Surcharge'
    otherSurcharges.push({ label, amount })
  }

  return {
    available: true,
    service: chosen.serviceType ?? null,
    serviceName: chosen.serviceName ?? null,
    currency,
    netCharge: typeof accountRate.totalNetCharge === 'number' ? accountRate.totalNetCharge : null,
    baseCharge: typeof accountRate.totalBaseCharge === 'number' ? accountRate.totalBaseCharge : null,
    discountAmount: typeof discount?.amount === 'number' ? discount.amount : null,
    discountPercent: typeof discount?.percent === 'number' ? discount.percent : null,
    fuelSurcharge,
    fuelPercent:
      typeof accountRate.shipmentRateDetail?.fuelSurchargePercent === 'number'
        ? accountRate.shipmentRateDetail.fuelSurchargePercent
        : null,
    otherSurcharges,
  }
}
