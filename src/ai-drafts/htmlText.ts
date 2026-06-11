// Minimal HTML -> plain text normalisation for email bodies. Help Scout
// returns thread bodies as HTML fragments; the pipeline wants readable text
// with paragraph breaks preserved. Deliberately dependency-free and
// conservative — formatting fidelity matters less than not losing content.

const BLOCK_BREAK = /<\/(p|div|h[1-6]|li|tr|table|blockquote)>/gi
const LINE_BREAK = /<br\s*\/?>/gi

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  pound: '£',
  euro: '€',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => {
      const code = Number.parseInt(hex, 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : ''
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = Number.parseInt(dec, 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : ''
    })
    .replace(/&([a-zA-Z]+);/g, (whole, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? whole)
}

export function htmlToText(html: string): string {
  if (!html) return ''
  let text = html
    // Drop invisible content wholesale before stripping tags.
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
  text = text.replace(LINE_BREAK, '\n').replace(BLOCK_BREAK, '$&\n\n')
  text = text.replace(/<[^>]+>/g, '')
  text = decodeEntities(text)
  // Collapse exotic whitespace email clients love, then tidy blank lines.
  text = text.replace(/[ ​‌‍﻿͏]/g, ' ')
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text
}

// True when a body looks like HTML rather than plain text.
export function looksLikeHtml(body: string): boolean {
  return /<\s*(p|div|br|html|body|span|table|a)\b/i.test(body)
}

export function normaliseBody(body: string): string {
  return looksLikeHtml(body) ? htmlToText(body) : body.trim()
}
