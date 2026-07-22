// JSON schema for the artwork check's structured output (output_config
// json_schema — same mechanism as aiDrafts/schema.ts). Field-level docs live
// in the system prompt; the schema keeps the shape honest.

export const ARTWORK_CHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'cards', 'corrections', 'notes', 'reference_gaps'],
  properties: {
    summary: {
      type: 'string',
      description: 'One line, issues-first. E.g. "1 flag: printed email drops a letter vs the request form." or "All clear — every printed detail matches what the customer supplied."',
    },
    cards: {
      type: 'array',
      description: 'One entry per person / card design that carries checkable details.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'findings'],
        properties: {
          label: {
            type: 'string',
            description: 'Which card, e.g. "Derrick Smith — front/back" or "Shared front card".',
          },
          findings: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['field', 'supplied', 'printed', 'status', 'severity', 'note'],
              properties: {
                field: {
                  type: 'string',
                  enum: ['name', 'job_title', 'company', 'address', 'tel', 'mob', 'website', 'email', 'qr', 'other'],
                },
                supplied: {
                  type: 'string',
                  description: 'The reference value with its source in brackets, e.g. "derrick@plak8.com (request form)". Empty string when nothing was supplied.',
                },
                printed: {
                  type: 'string',
                  description: 'The value as it actually appears on the card (or in the QR payload).',
                },
                status: { type: 'string', enum: ['match', 'flag', 'not_supplied'] },
                severity: {
                  type: 'string',
                  enum: ['review', 'defect'],
                  description: 'Per the SEVERITY rules: defect is reserved for the three bet-a-reprint-on-it categories; everything else — and every match/not_supplied — is review.',
                },
                note: {
                  type: 'string',
                  description: 'For flags: what exactly differs. For matches: empty or a short qualifier. Never speculate past what is clearly visible.',
                },
              },
            },
          },
        },
      },
    },
    corrections: {
      type: 'array',
      description: 'Later customer revisions/corrections found in the thread (explicit or silent) whose outcome is VERIFIABLE on the print files, each with whether the current artwork reflects it. Unverifiable revisions (unread attachments; quantity/roster/construction changes) belong in reference_gaps instead — resolved=false means the artwork visibly fails to reflect the revision, never "could not check".',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['quote', 'resolved', 'severity', 'note'],
        properties: {
          quote: { type: 'string', description: 'Short verbatim quote of the revision, with its date if known.' },
          resolved: { type: 'boolean', description: 'True when the current artwork already carries the revised value.' },
          severity: {
            type: 'string',
            enum: ['review', 'defect'],
            description: 'defect only when resolved=false AND the quote is an explicit written instruction the artwork ignores (red category 2). resolved=true is always review.',
          },
          note: { type: 'string' },
        },
      },
    },
    notes: {
      type: 'array',
      items: { type: 'string' },
      description: 'Observations that are expected/no-action, e.g. "metal cut-through back — logo mirrored as expected".',
    },
    reference_gaps: {
      type: 'array',
      items: { type: 'string' },
      description: 'Things that could not be checked and why — e.g. "details supplied as attachment details.xlsx (not read)", "no request-form submission found in the thread". Gaps are never discrepancies.',
    },
  },
} as const
