// Artwork sanity check — shared types (docs/artwork-check-spec.md).
//
// The check compares what the customer supplied (the Help Scout thread — the
// PRIMARY reference), the stored QR contents (corroborator), and the recipient
// roster against what's actually on the Dropbox print files. The model returns
// ModelReport (schema.ts); the function wraps it into ArtworkCheckReport with
// a code-derived verdict (report.ts) and persists it on the order.

// The contact fields the comparison is keyed on — the 8 fields of the manual
// check plus 'qr' (QR payload vs card face vs supplied) and 'other' (anything
// visibly wrong that fits no named field).
export type FindingField =
  | 'name'
  | 'job_title'
  | 'company'
  | 'address'
  | 'tel'
  | 'mob'
  | 'website'
  | 'email'
  | 'qr'
  | 'other'

// match        — printed value agrees with the best reference for that field.
// flag         — a visible discrepancy a human should adjudicate.
// not_supplied — printed on the card but no reference exists to check against
//                (recorded for the reviewer's table, never an error).
export type FindingStatus = 'match' | 'flag' | 'not_supplied'

export interface Finding {
  field: FindingField
  // What the reference says, with its source in brackets — e.g.
  // "derrick@plak8.com (request form)". Empty when not_supplied.
  supplied: string
  // What's actually on the card / in the QR.
  printed: string
  status: FindingStatus
  note: string
}

export interface CardReport {
  // One entry per person/card design, e.g. "Derrick Smith — front/back".
  label: string
  findings: Finding[]
}

export interface Correction {
  // Verbatim-ish quote of the customer's later revision/correction.
  quote: string
  // True when the current artwork reflects the corrected value.
  resolved: boolean
  note: string
}

// What the model returns (schema.ts enforces this shape).
export interface ModelReport {
  summary: string
  cards: CardReport[]
  corrections: Correction[]
  notes: string[]
  reference_gaps: string[]
}

export type ArtworkCheckVerdict = 'clear' | 'flagged' | 'error'

// What actually gets fetched and fed to the model — stored on the report so a
// shadow-mode review can see what each run was grounded on.
export interface ReportInputs {
  print_files: string[]
  skipped_files: { name: string; reason: string }[]
  thread_messages: number
  thread_found: boolean
  qr_count: number
  recipients: string[]
}

export interface ReportUsage {
  input_tokens: number
  output_tokens: number
  cache_write_tokens: number
  cache_read_tokens: number
}

// The persisted shape (orders.artwork_check).
export interface ArtworkCheckReport extends ModelReport {
  verdict: ArtworkCheckVerdict
  inputs: ReportInputs
  model: string
  usage: ReportUsage | null
  checked_at: string
  // Set only on verdict 'error' — why the run couldn't complete.
  error?: string
}
