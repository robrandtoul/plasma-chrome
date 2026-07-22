// QR decoding for the artwork check — the SAME engine the version-form
// scanner uses (zxing-wasm, pinned 3.1.2), run server-side over the approved
// proof images the check already downloads for Leg C. This lets the check
// verify a QR's actual contents instead of only flagging "nothing on file to
// check it against" when a designer never registered the code on the proof
// (the Top Hampers case: a QR printed on the card, registered on v1 but not
// carried onto the current version).
//
// Two deliberate boundaries:
//   * Raster only. readBarcodes needs pixels; the print files are vector
//     PDF/.ai, so we decode from the approved-proof JPEGs — the same source
//     the browser scanner reads, and what the customer signed off. Verifying
//     the print file's own QR byte-for-byte would need a PDF rasteriser, the
//     one heavy dependency deliberately avoided; parked (Leg C already
//     compares proof vs print visually, and a swapped QR has never been seen).
//   * Strictly fail-safe. Any failure — the wasm not initialising in this
//     runtime, a decode throw — returns [], so the check degrades to exactly
//     its prior behaviour (flag when the DB has no payload). Deploying this
//     can only match or improve today's output; it can never regress it.
//
// Loading: the library's own default locateFile fetches the pinned-version
// wasm from jsdelivr (zxing-wasm@3.1.2/dist/reader/zxing_reader.wasm), so no
// override is needed server-side — same trust model as the function's
// Anthropic / Dropbox fetches. The import is dynamic so the wasm cost is only
// paid when a decode actually runs, and so the pure classifier below stays
// importable by the (npm-free) test runner.

// Pure — no dependency, safe for the test runner. A light copy of
// classifyQrData in src/lib/qrCodes.ts; the check only needs a rough kind for
// labelling, the model reads the raw payload itself.
export function classifyQrPayload(data: string): string {
  const t = data.trim()
  if (/^BEGIN:VCARD/i.test(t)) return 'vcard'
  if (/^MECARD:/i.test(t)) return 'mecard'
  if (/^WIFI:/i.test(t)) return 'wifi'
  if (/^mailto:/i.test(t) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return 'email'
  if (/^tel:/i.test(t) || /^\+\d{8,15}$/.test(t)) return 'phone'
  if (/^sms(?:to)?:/i.test(t)) return 'sms'
  if (/^https?:\/\//i.test(t)) return 'url'
  return 'text'
}

export interface DecodedArtworkQr {
  data: string
  kind: string
}

// The recipe benchmarked in src/lib/qrCodes.ts against 123 real proof QRs:
// exhaustive search + downscale (a small code in a big frame — the artwork
// case) + invert (light-on-dark). Pinned to QRCode so a stray barcode
// elsewhere on the sheet can't be mistaken for the card's QR.
const READER_OPTIONS = {
  formats: ['QRCode'],
  tryHarder: true,
  tryDownscale: true,
  tryInvert: true,
  maxNumberOfSymbols: 6,
}

// Latched off for the whole instance the first time the wasm proves it won't
// run here — so a broken runtime pays the failed init once, not per image.
let engineDead = false

// Decode every QR in one image's bytes. Returns [] on ANYTHING — no QR,
// unreadable pixels, or the engine failing to initialise — so the caller's
// behaviour degrades cleanly to "no scan".
export async function decodeQrsFromImage(bytes: Uint8Array): Promise<DecodedArtworkQr[]> {
  if (engineDead) return []
  let readBarcodes: (input: Uint8Array, opts: unknown) => Promise<{ text?: string; isValid?: boolean }[]>
  try {
    ;({ readBarcodes } = await import('npm:zxing-wasm@3.1.2/reader') as unknown as {
      readBarcodes: (input: Uint8Array, opts: unknown) => Promise<{ text?: string; isValid?: boolean }[]>
    })
  } catch (err) {
    engineDead = true
    console.error('[artwork-check] QR decoder failed to load — skipping QR scans:', (err as Error)?.message)
    return []
  }
  try {
    const results = await readBarcodes(bytes, READER_OPTIONS)
    const out: DecodedArtworkQr[] = []
    const seen = new Set<string>()
    for (const r of results) {
      const text = r.text ?? ''
      if (r.isValid === false || !text || seen.has(text)) continue
      seen.add(text)
      out.push({ data: text, kind: classifyQrPayload(text) })
    }
    return out
  } catch (err) {
    // A wasm-init-shaped failure kills the engine for the instance; an
    // ordinary per-image decode error just yields nothing for that image.
    const msg = (err as Error)?.message ?? ''
    if (/wasm|WebAssembly|instantiate|abort(?:ed)?|out of memory/i.test(msg)) {
      engineDead = true
      console.error('[artwork-check] QR decoder wasm failed — skipping further scans:', msg)
    }
    return []
  }
}
