// Minimal CSV utilities shared by the export + import edge functions.
// Format: LF-delimited rows, comma-separated cells, double-quoted if the
// value contains comma / quote / CR / LF (RFC 4180-ish). Our slugs and
// labels don't currently hit the escape path, but the quoter is in place
// for safety so values stay round-trippable if that changes.

export function csvCell(value: string): string {
  if (value == null) return ''
  const s = String(value)
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

export function toCsv(rows: (string | number | null)[][]): string {
  return rows
    .map((row) => row.map((v) => csvCell(v == null ? '' : String(v))).join(','))
    .join('\n')
}

/** Simple RFC-4180-ish parser. Returns a list of rows (each a list of cells). */
export function parseCsv(text: string): string[][] {
  const out: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  const input = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') { cell += '"'; i++ } // escaped quote
        else inQuotes = false
      } else {
        cell += ch
      }
    } else {
      if (ch === '"') inQuotes = true
      else if (ch === ',') { row.push(cell); cell = '' }
      else if (ch === '\n') { row.push(cell); out.push(row); row = []; cell = '' }
      else cell += ch
    }
  }
  // Flush trailing cell/row if the file didn't end on newline.
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    out.push(row)
  }
  // Drop trailing blank rows entirely.
  while (out.length > 0) {
    const last = out[out.length - 1]
    if (last.length === 1 && last[0].trim() === '') out.pop()
    else break
  }
  return out
}
