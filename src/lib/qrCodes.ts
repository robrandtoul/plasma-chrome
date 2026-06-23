// QR-code decoder + payload parser utility.
//
// The proof-viewer's QR workflow (000168 / 000169) needs three
// things in the browser: read a QR JPEG into a pixel buffer, decode
// it, then classify and parse the decoded string. This file is the
// single place those three steps live.
//
// The decoder is ZXing (@zxing/library). It replaced jsQR after a
// real designer upload — a stylised "dotted" QR with rounded finder
// patterns — failed to decode. jsQR is unreliable on stylised codes:
// across tiny pixel differences it returns null, decodes, or throws
// an internal "Invalid module size", and that throw surfaced to the
// designer as a raw "Unknown decode error". ZXing read the same file
// cleanly at every resolution. See decodeQrFromImageData() for the
// exact recipe.
//
// All entry points are pure async/sync functions — no React, no
// DOM-specific assumptions beyond the browser globals (HTMLImage-
// Element, HTMLCanvasElement). The designer's upload pipeline calls
// decodeQrFromFile() the moment a file lands in the drop zone; the
// customer page reads pre-decoded `qr_decoded_data` straight from
// the DB and passes it through formatVCard / formatWifi /
// formatMecard.
//
// ZXing is imported dynamically inside decodeQrFromImageData() so
// the pure-string parsers (classifyQrData, parseVCard, parseWifi,
// parseMecard, isShortenedUrl) can be exercised by the unit-test
// runner without the decoder installed, and so the main bundle only
// pays the decoder cost when a decode is actually triggered.

// ── Public types ─────────────────────────────────────────────────────

export type QrKind =
  | 'vcard'
  | 'url'
  | 'wifi'
  | 'mecard'
  | 'email'
  | 'phone'
  | 'sms'
  | 'text'
  // hosted_vcard: a Plasma hosted vCard QR — the encoded payload is a
  // short URL (https://qcrd.uk/<slug>) that resolves to an editable
  // contact page. classifyQrData() does NOT emit 'hosted_vcard' (the
  // decoder can't tell a qcrd.uk URL apart from any other URL and
  // mis-classifying a stray qcrd.uk link would let it skip the
  // hosted-vCard codepath). hosted_vcard rows are only ever created
  // via the designer's explicit "Add Plasma vCard QR" action; uploaded
  // QR images stay on the eight decoder-derived kinds.
  | 'hosted_vcard'

export interface DecodedQr {
  /** Raw decoded payload — the exact bytes the QR encodes. */
  data: string
  /** Classifier output. Drives which formatter runs on the customer page. */
  kind: QrKind
}

/** Thrown by decodeQrFromFile when the image doesn't contain a QR. */
export class QrDecodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QrDecodeError'
  }
}

// ── classifyQrData ───────────────────────────────────────────────────
//
// Returns the QR kind for a decoded payload. Order matters — vCard
// is checked before URL because some QR generators wrap a vCard's
// URL field in such a way that the leading characters technically
// match a URL prefix on a substring level. The leading-token
// approach below is byte-strict so that doesn't bite us, but it's
// worth keeping vCard / MeCard / wifi above the URL check anyway.

const URL_PREFIX_RE = /^https?:\/\//i
const EMAIL_PREFIX_RE = /^mailto:/i
const PHONE_PREFIX_RE = /^tel:/i
const SMS_PREFIX_RE = /^sms(?:to)?:/i
// Bare-email match (PV-2026W21-089). Conservative single-line shape:
// one or more non-whitespace, non-@ characters before the @, then the
// same after, then a single dot followed by at least one
// non-whitespace, non-@ character. Strict enough to keep "12.34" or
// "@plasma" out, loose enough for the real-world QR cases we care
// about. The kind maps to the existing 'email' value rather than a
// new enum — the 000168 CHECK constraint on qr_kind would reject
// anything new.
const BARE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// Bare E.164 phone match (PV-2026W21-089). Leading +, then 8-15
// digits. Same constraint reasoning — maps to 'phone'.
const BARE_PHONE_RE = /^\+\d{8,15}$/

export function classifyQrData(data: string): QrKind {
  const trimmed = data.trim()
  if (/^BEGIN:VCARD/i.test(trimmed)) return 'vcard'
  if (/^MECARD:/i.test(trimmed)) return 'mecard'
  if (/^WIFI:/i.test(trimmed)) return 'wifi'
  if (EMAIL_PREFIX_RE.test(trimmed)) return 'email'
  if (PHONE_PREFIX_RE.test(trimmed)) return 'phone'
  if (SMS_PREFIX_RE.test(trimmed)) return 'sms'
  if (URL_PREFIX_RE.test(trimmed)) return 'url'
  if (BARE_EMAIL_RE.test(trimmed)) return 'email'
  if (BARE_PHONE_RE.test(trimmed)) return 'phone'
  return 'text'
}

// ── decodeQrFromFile ─────────────────────────────────────────────────
//
// Browser-side path: File → HTMLImageElement → canvas → ImageData
// → ZXing. Every failure mode is funnelled into a QrDecodeError so
// the upload UI always shows a friendly, actionable message and
// never a raw "Unknown decode error". An undecodable JPEG never
// makes it past this gate into storage.

export async function decodeQrFromFile(file: File): Promise<DecodedQr> {
  if (!/^image\//i.test(file.type)) {
    throw new QrDecodeError(
      `File is not an image (mime type "${file.type || 'unknown'}").`,
    )
  }

  const imageData = await loadImageData(file)
  const data = await decodeQrFromImageData(imageData)
  return { data, kind: classifyQrData(data) }
}

// ── decodeQrFromImageData ────────────────────────────────────────────
//
// The ZXing recipe, verified against the real designer upload that
// jsQR couldn't read: RGBA → luminance → RGBLuminanceSource →
// HybridBinarizer → QRCodeReader, with TRY_HARDER on and the format
// pinned to QR. We try the image then its inverse, so a QR printed
// light-on-dark still decodes (the case jsQR's inversionAttempts:
// 'attemptBoth' used to cover). ZXing is imported dynamically so the
// bundle only pays for it when a decode runs and the pure parsers
// stay testable without the dependency.

async function decodeQrFromImageData(imageData: ImageData): Promise<string> {
  let ZXing: typeof import('@zxing/library')
  try {
    ZXing = await import('@zxing/library')
  } catch {
    throw new QrDecodeError(
      "Couldn't load the QR decoder. Check your connection and try again.",
    )
  }
  const {
    RGBLuminanceSource,
    BinaryBitmap,
    HybridBinarizer,
    QRCodeReader,
    DecodeHintType,
    BarcodeFormat,
  } = ZXing

  const { data, width, height } = imageData
  // ZXing reads a Uint8ClampedArray of length width*height as a
  // luminance buffer (an Int32Array would instead be read as packed
  // ARGB). Convert our RGBA pixels with the standard luma weights.
  const luminances = new Uint8ClampedArray(width * height)
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4]
    const g = data[i * 4 + 1]
    const b = data[i * 4 + 2]
    luminances[i] = (r * 0.299 + g * 0.587 + b * 0.114) | 0
  }

  const hints = new Map()
  hints.set(DecodeHintType.TRY_HARDER, true)
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE])

  const source = new RGBLuminanceSource(luminances, width, height)
  for (const candidate of [source, source.invert()]) {
    try {
      const result = new QRCodeReader().decode(
        new BinaryBitmap(new HybridBinarizer(candidate)),
        hints,
      )
      const text = result.getText()
      if (text) return text
    } catch {
      // ZXing throws NotFoundException / FormatException /
      // ChecksumException when a pass can't read a QR. Swallow it and
      // try the next candidate; if both fail we throw our own
      // QrDecodeError below.
    }
  }

  throw new QrDecodeError(
    "No QR code detected in this image. If it's a stylised QR, try a clearer or higher-contrast export.",
  )
}

// Cap very large print exports before reading pixels: keeps
// getImageData under the browser's max-canvas-area limit (a separate
// source of the old "Unknown decode error") and keeps decoding fast.
// A QR has a fixed module count, so downscaling within reason doesn't
// hurt readability — ZXing read this proof's QR fine down to ~200px.
const MAX_DECODE_DIMENSION = 2000

async function loadImageData(file: File): Promise<ImageData> {
  const url = URL.createObjectURL(file)
  try {
    const img = await loadHtmlImage(url)
    const naturalW = img.naturalWidth
    const naturalH = img.naturalHeight
    if (!naturalW || !naturalH) {
      throw new QrDecodeError('Image has no readable dimensions.')
    }
    const scale = Math.min(1, MAX_DECODE_DIMENSION / Math.max(naturalW, naturalH))
    const width = Math.max(1, Math.round(naturalW * scale))
    const height = Math.max(1, Math.round(naturalH * scale))

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      throw new QrDecodeError('Browser failed to provide a 2D canvas context.')
    }
    ctx.drawImage(img, 0, 0, width, height)
    try {
      return ctx.getImageData(0, 0, width, height)
    } catch {
      throw new QrDecodeError(
        'Browser failed to read the image pixels (the image may be too large).',
      )
    }
  } finally {
    URL.revokeObjectURL(url)
  }
}

function loadHtmlImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new QrDecodeError('Browser failed to load the image.'))
    img.src = src
  })
}

// ── vCard parser ─────────────────────────────────────────────────────
//
// vCard 3.0 / 4.0 in the wild. Supports unfolded lines (RFC 6350
// allows a logical line to be split across multiple physical lines
// with a leading whitespace continuation; we fold them back before
// splitting on newlines). Parameter parsing handles the `TEL;TYPE=
// CELL,VOICE` and `TEL;TYPE=cell` shapes both. Values are decoded
// from quoted-printable for the rare encoder that uses it.
//
// PHOTO is intentionally stripped: Rob never produces vCards with
// embedded photos (they bloat the QR to densities that don't print
// or scan well on metal), so a PHOTO field in the wild is noise.
// Stripping at parse time keeps it out of both the formatted view
// and the raw-data disclosure.

export interface VCardTel {
  value: string
  types: string[]
}

export interface VCardEmail {
  value: string
  types: string[]
}

export interface VCardFields {
  formattedName: string | null
  names: { family: string; given: string; additional: string; prefix: string; suffix: string } | null
  org: string | null
  title: string | null
  tels: VCardTel[]
  emails: VCardEmail[]
  urls: string[]
  addresses: string[]
  note: string | null
  /** Lines we couldn't classify — shown in the raw-data disclosure. */
  rawOtherLines: string[]
}

export function parseVCard(raw: string): VCardFields {
  const unfolded = unfoldVCardLines(raw)
  const fields: VCardFields = {
    formattedName: null,
    names: null,
    org: null,
    title: null,
    tels: [],
    emails: [],
    urls: [],
    addresses: [],
    note: null,
    rawOtherLines: [],
  }

  for (const line of unfolded) {
    if (/^BEGIN:VCARD$/i.test(line)) continue
    if (/^END:VCARD$/i.test(line)) continue
    if (/^VERSION:/i.test(line)) continue
    if (/^PHOTO[;:]/i.test(line)) continue

    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) {
      if (line.trim()) fields.rawOtherLines.push(line)
      continue
    }

    const propertyPart = line.slice(0, colonIdx)
    const rawValue = line.slice(colonIdx + 1)
    const [propName, ...paramParts] = propertyPart.split(';')
    const params = parseVCardParams(paramParts)
    const value = decodeVCardValue(rawValue, params)

    const upper = (propName || '').toUpperCase()

    switch (upper) {
      case 'FN':
        fields.formattedName = value
        break
      case 'N': {
        const parts = value.split(';')
        fields.names = {
          family: parts[0] ?? '',
          given: parts[1] ?? '',
          additional: parts[2] ?? '',
          prefix: parts[3] ?? '',
          suffix: parts[4] ?? '',
        }
        break
      }
      case 'ORG':
        // ORG can be hierarchical (`Acme;Marketing;EMEA`). Join with " · " for display.
        fields.org = value.split(';').filter(Boolean).join(' · ')
        break
      case 'TITLE':
        fields.title = value
        break
      case 'TEL':
        fields.tels.push({ value, types: extractTypes(params) })
        break
      case 'EMAIL':
        fields.emails.push({ value, types: extractTypes(params) })
        break
      case 'URL':
        fields.urls.push(value)
        break
      case 'ADR': {
        // ADR is `pobox;ext;street;locality;region;postcode;country`.
        // Join non-empty pieces with commas for a single-line render.
        const pieces = value.split(';').map((p) => p.trim()).filter(Boolean)
        if (pieces.length > 0) fields.addresses.push(pieces.join(', '))
        break
      }
      case 'NOTE':
        fields.note = value
        break
      default:
        fields.rawOtherLines.push(line)
    }
  }

  // Fall back to N when FN is missing (vCard 3.0 requires both, but
  // 4.0 allows FN-only; some encoders ship N-only).
  if (!fields.formattedName && fields.names) {
    const { given, additional, family, prefix, suffix } = fields.names
    fields.formattedName = [prefix, given, additional, family, suffix]
      .map((p) => p.trim())
      .filter(Boolean)
      .join(' ')
  }

  return fields
}

function unfoldVCardLines(raw: string): string[] {
  // RFC 6350 §3.2: a logical line can be folded by inserting a
  // CRLF followed by a single whitespace. Reverse that here.
  const normalised = raw.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '')
  return normalised.split(/\r?\n/).map((l) => l.replace(/\r$/, ''))
}

function parseVCardParams(paramParts: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of paramParts) {
    const eqIdx = part.indexOf('=')
    if (eqIdx === -1) {
      // vCard 2.1 short-form: TEL;CELL:... — promote to TYPE=CELL
      const upper = part.toUpperCase()
      if (upper) {
        out['TYPE'] = out['TYPE'] ? `${out['TYPE']},${upper}` : upper
      }
      continue
    }
    const key = part.slice(0, eqIdx).toUpperCase()
    const val = part.slice(eqIdx + 1)
    out[key] = val
  }
  return out
}

function extractTypes(params: Record<string, string>): string[] {
  const raw = params['TYPE']
  if (!raw) return []
  // Strip quoting, then split on comma — vCard allows both
  // TYPE="cell,voice" and TYPE=cell,voice and (in concatenated
  // form via parseVCardParams above) TYPE=CELL,VOICE.
  return raw
    .replace(/^"/, '')
    .replace(/"$/, '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
}

function decodeVCardValue(rawValue: string, params: Record<string, string>): string {
  const encoding = (params['ENCODING'] || '').toUpperCase()
  if (encoding === 'QUOTED-PRINTABLE') return decodeQuotedPrintable(rawValue)
  // RFC 6350 §3.4: backslash escapes for newline, comma, semicolon, backslash.
  return rawValue
    .replace(/\\n/g, '\n')
    .replace(/\\N/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
}

function decodeQuotedPrintable(input: string): string {
  return input
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/gi, (_match, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
}

// ── parseWifi ────────────────────────────────────────────────────────
//
// WIFI:S:<ssid>;T:<security>;P:<password>;H:<hidden>;
// Order is not guaranteed and any field may be missing.

export interface WifiFields {
  ssid: string | null
  security: 'WPA' | 'WEP' | 'nopass' | string | null
  password: string | null
  hidden: boolean | null
}

export function parseWifi(raw: string): WifiFields {
  const body = raw.replace(/^WIFI:/i, '').replace(/;$/, '')
  const fields: WifiFields = { ssid: null, security: null, password: null, hidden: null }

  // Split on unescaped semicolons. WIFI uses backslash escaping for
  // semicolons and colons within values.
  const pairs = splitUnescaped(body, ';')
  for (const pair of pairs) {
    const colonIdx = findUnescaped(pair, ':')
    if (colonIdx === -1) continue
    const key = pair.slice(0, colonIdx).toUpperCase()
    const value = unescapeWifi(pair.slice(colonIdx + 1))

    switch (key) {
      case 'S':
        fields.ssid = value
        break
      case 'T':
        fields.security = value
        break
      case 'P':
        fields.password = value
        break
      case 'H':
        fields.hidden = /^true$/i.test(value)
        break
    }
  }

  return fields
}

function splitUnescaped(input: string, separator: string): string[] {
  const out: string[] = []
  let buf = ''
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === '\\' && i + 1 < input.length) {
      buf += ch + input[i + 1]
      i++
      continue
    }
    if (ch === separator) {
      out.push(buf)
      buf = ''
      continue
    }
    buf += ch
  }
  if (buf.length > 0) out.push(buf)
  return out
}

function findUnescaped(input: string, ch: string): number {
  for (let i = 0; i < input.length; i++) {
    if (input[i] === '\\' && i + 1 < input.length) {
      i++
      continue
    }
    if (input[i] === ch) return i
  }
  return -1
}

function unescapeWifi(input: string): string {
  return input.replace(/\\([\\;:,"])/g, '$1')
}

// ── parseMecard ──────────────────────────────────────────────────────
//
// MECARD:N:<name>;TEL:<phone>;EMAIL:<email>;URL:<url>;ADR:<addr>;;
// Field order varies; trailing double-semicolon is the spec
// terminator but optional.

export interface MecardFields {
  name: string | null
  tel: string | null
  email: string | null
  url: string | null
  address: string | null
  note: string | null
}

export function parseMecard(raw: string): MecardFields {
  const body = raw.replace(/^MECARD:/i, '').replace(/;+$/, '')
  const fields: MecardFields = {
    name: null,
    tel: null,
    email: null,
    url: null,
    address: null,
    note: null,
  }
  const pairs = splitUnescaped(body, ';')
  for (const pair of pairs) {
    const colonIdx = findUnescaped(pair, ':')
    if (colonIdx === -1) continue
    const key = pair.slice(0, colonIdx).toUpperCase()
    const value = pair.slice(colonIdx + 1)
    switch (key) {
      case 'N':
        // MeCard names are `Surname,Given`. Render as `Given Surname`.
        fields.name = value.includes(',')
          ? value.split(',').reverse().map((s) => s.trim()).join(' ')
          : value
        break
      case 'TEL':
        fields.tel = value
        break
      case 'EMAIL':
        fields.email = value
        break
      case 'URL':
        fields.url = value
        break
      case 'ADR':
        fields.address = value
        break
      case 'NOTE':
        fields.note = value
        break
    }
  }
  return fields
}

// ── isShortenedUrl ───────────────────────────────────────────────────
//
// Used by the customer page to render a "shortened link" badge so
// the customer knows the URL won't resolve to its display text.
// We deliberately do NOT expand: the goal is to show what the QR
// literally encodes. Add hosts here as new shorteners appear.

const SHORTENER_HOSTS = new Set([
  'bit.ly',
  't.co',
  'tinyurl.com',
  'lnkd.in',
  'goo.gl',
  'ow.ly',
  'is.gd',
  'buff.ly',
  'rebrand.ly',
  'cutt.ly',
  'shorturl.at',
  't.ly',
  'rb.gy',
  'qr.ae',
])

export function isShortenedUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return SHORTENER_HOSTS.has(host)
  } catch {
    return false
  }
}
