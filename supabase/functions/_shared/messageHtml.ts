// Turn a plain-text message body into the HTML Help Scout expects on a
// reply or note.
//
// Why this exists — the iPhone-404 bug (PV):
// Help Scout treats a reply's `text` field as HTML. When we hand it a
// plain-text body it runs two heuristics of its own: it converts newlines
// to <br>, and it auto-links any bare URL it finds. The trouble is the
// order — the <br> lands flush against the URL (no whitespace between
// them), and the auto-linker then swallows the following "<br><br>You're…"
// straight into the link's href, percent-encoding the angle brackets. A
// first-proof email whose template has copy after {url} therefore produced
// a link to
//   /p/<id>%3Cbr%3E%3Cbr%3EYou're
// which is a proof id that doesn't exist — a branded 404 the moment the
// customer tapped it (iOS Mail follows the mangled href faithfully).
//
// Handing Help Scout finished HTML sidesteps both heuristics. We escape the
// text ourselves, wrap real URLs in explicit <a> tags (so the href ends
// exactly at the URL and can never absorb trailing markup), and convert
// newlines to <br>. Because the body now contains tags, Help Scout renders
// it as-is and never re-linkifies — the link is unbreakable no matter what
// copy follows it in the template.

// Match an http/https URL up to the first whitespace. Angle brackets are
// already escaped to entities by the time this runs, so a raw '<' can't
// appear inside a match.
const URL_RE = /\bhttps?:\/\/\S+/g

// Sentence punctuation that commonly trails a URL in prose ("take a look:
// https://…/abc.") but is not part of the address. Pulled back out of the
// href so the link resolves and the punctuation still reads.
const TRAILING_PUNCT_RE = /^(.*?)([.,;:!?)\]]*)$/s

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function messageBodyToHtml(text: string): string {
  const linked = escapeHtml(text).replace(URL_RE, (raw) => {
    const m = raw.match(TRAILING_PUNCT_RE)
    const url = m ? m[1] : raw
    const trailer = m ? m[2] : ''
    return `<a href="${url}">${url}</a>${trailer}`
  })
  return linked.replace(/\n/g, '<br>')
}
