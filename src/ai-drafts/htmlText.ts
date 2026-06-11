// Minimal HTML -> plain text normalisation for email bodies. Help Scout
// returns thread bodies as HTML fragments; the pipeline wants readable text
// with paragraph breaks preserved. Deliberately dependency-free and
// conservative — formatting fidelity matters less than not losing content.

const BLOCK_BREAK = /<\/(p|div|h[1-6]|li|tr|table|blockquote)>/gi
const LINE_BREAK = /<br\s*\/?>/gi
// Without this, "<td>£39</td><td>99</td>" fuses to "£3999" — corrupting
// amounts that feed the money guardrail's allowed set.
const CELL_BREAK = /<\/(td|th|dt|dd)>/gi

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

// String.fromCodePoint throws RangeError on out-of-range references
// (e.g. "&#1114112;" or lone surrogates) — malformed email HTML must never
// crash the pipeline, so invalid references decode to nothing.
function safeCodePoint(code: number): string {
  try {
    return Number.isFinite(code) ? String.fromCodePoint(code) : ''
  } catch {
    return ''
  }
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(Number.parseInt(dec, 10)))
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
  text = text.replace(LINE_BREAK, '\n').replace(CELL_BREAK, '$& ').replace(BLOCK_BREAK, '$&\n\n')
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

// True when a body looks like HTML rather than plain text. Requires an
// unambiguous signal — a closing tag, <br>/<hr>, or an opening tag carrying
// an attribute — so plain-text spans like "<a few mm>" or "<jsmith@acme.com>"
// are not mistaken for markup and stripped.
export function looksLikeHtml(body: string): boolean {
  return (
    /<\/(p|div|span|table|a|td|tr|li|blockquote|h[1-6]|b|i|strong|em|u|ul|ol|font|body|html)\s*>/i.test(body) ||
    /<(br|hr)\s*\/?>/i.test(body) ||
    /<(p|div|span|table|a|body|html|img|font)\s+[a-z-]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)[^>]*>/i.test(body)
  )
}

export function normaliseBody(body: string): string {
  return looksLikeHtml(body) ? htmlToText(body) : body.trim()
}
