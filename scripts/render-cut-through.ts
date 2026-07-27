// Debug renderer for the cut-through check — draws exactly what the detector
// decided, so a human can agree or disagree with it rather than trusting a
// number. White = judged cut, blue = judged printed white, dark = metal,
// RED = metal the flood never reached (the claimed dropout).
//
// Usage: tsx scripts/render-cut-through.ts <face.ai> <opposite.ai> <out.png> [x y halfPt]

import { readFile, writeFile } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'
import {
  cardBox,
  components,
  parseFace,
  rasterise,
  reachableFromBorder,
  RASTER_SCALE,
  MIRROR_MATCH_MIN,
} from '../supabase/functions/_shared/artworkCheck/cutThrough.ts'

function png(w: number, h: number, rgb: Uint8Array): Uint8Array {
  const crcTable = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c
  }
  const crc = (b: Uint8Array) => {
    let c = -1
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8)
    return (c ^ -1) >>> 0
  }
  const chunk = (type: string, data: Uint8Array) => {
    const td = new TextEncoder().encode(type)
    const body = new Uint8Array(td.length + data.length)
    body.set(td); body.set(data, td.length)
    const out = new Uint8Array(8 + body.length + 4)
    const dv = new DataView(out.buffer)
    dv.setUint32(0, data.length)
    out.set(body, 4)
    dv.setUint32(4 + body.length, crc(body))
    return out.subarray(0, 4 + body.length + 4)
  }
  const raw = new Uint8Array(h * (w * 3 + 1))
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1)
  }
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, w); dv.setUint32(4, h)
  ihdr[8] = 8; ihdr[9] = 2
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array(0)),
  ]
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

async function main() {
  const [facePath, oppPath, outPath, xs, ys, hs] = process.argv.slice(2)
  const face = await parseFace(new Uint8Array(await readFile(facePath)))
  const opp = await parseFace(new Uint8Array(await readFile(oppPath)))
  if (!face || !opp) throw new Error('could not parse one of the files')
  const card = cardBox(face)!
  const oppCard = cardBox(opp) ?? card
  const scale = RASTER_SCALE
  const w = Math.round((card.x1 - card.x0) * scale) + 2
  const h = Math.round((card.y1 - card.y0) * scale) + 2

  const white = rasterise(face.cutPaths, w, h, scale, card.x0, card.y0, face.evenOdd)
  const backRaw = rasterise(opp.cutPaths, w, h, scale, oppCard.x0, oppCard.y0, opp.evenOdd)
  const mir = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) mir[y * w + x] = backRaw.data[y * w + (w - 1 - x)]
  }

  const cut = { w, h, data: new Uint8Array(w * h) }
  const printed = new Uint8Array(w * h)
  for (const c of components(white, 1)) {
    let hit = 0
    for (const i of c.pixels) if (mir[i]) hit++
    const isCut = hit / c.pixels.length >= MIRROR_MATCH_MIN
    for (const i of c.pixels) (isCut ? cut.data : printed)[i] = 1
  }
  const reach = reachableFromBorder(cut, 0)

  const px = (v: string | undefined, d: number) => (v === undefined ? d : Number(v))
  const halfPt = px(hs, 0)
  let x0 = 0, y0 = 0, x1 = w, y1 = h
  if (halfPt > 0) {
    const cx = (px(xs, 0) * scale) | 0
    const cy = (px(ys, 0) * scale) | 0
    const r = (halfPt * scale) | 0
    x0 = Math.max(0, cx - r); x1 = Math.min(w, cx + r)
    y0 = Math.max(0, cy - r); y1 = Math.min(h, cy + r)
  }
  const cw = x1 - x0, ch = y1 - y0
  const buf = new Uint8Array(cw * ch * 3)
  for (let yy = 0; yy < ch; yy++) {
    for (let xx = 0; xx < cw; xx++) {
      const i = (y0 + yy) * w + (x0 + xx)
      const o = ((ch - 1 - yy) * cw + xx) * 3   // PDF y-up -> PNG y-down
      if (cut.data[i]) { buf[o] = 255; buf[o + 1] = 255; buf[o + 2] = 255 }
      else if (printed[i]) { buf[o] = 70; buf[o + 1] = 130; buf[o + 2] = 220 }
      else if (!reach[i]) { buf[o] = 230; buf[o + 1] = 30; buf[o + 2] = 30 }
      else { buf[o] = 38; buf[o + 1] = 38; buf[o + 2] = 38 }
    }
  }
  await writeFile(outPath, png(cw, ch, buf))
  console.log(`wrote ${outPath} (${cw}x${ch})`)
}

main().catch((e) => { console.error(e); process.exit(1) })
