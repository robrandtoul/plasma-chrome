// JSON schemas for the two structured-output calls. Kept hand-written (not
// zod) so the exact wire shape is visible and the same objects can later be
// reused verbatim by the Deno edge function.

export const CATEGORY_VALUES = [
  'quote_request',
  'lead_time',
  'capability_question',
  'sample_request',
  'order_details_collection',
  'order_status',
  'invoice_copy',
  'artwork',
  'complaint',
  'other',
] as const

export const CONFIDENCE_VALUES = ['high', 'medium', 'low'] as const
export const CURRENCY_VALUES = ['GBP', 'EUR', 'USD'] as const

export const CLASSIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'is_genuine_customer_email',
    'category',
    'confidence',
    'summary',
    'mentioned_materials',
    'mentioned_quantities',
    'currency_hint',
  ],
  properties: {
    is_genuine_customer_email: {
      type: 'boolean',
      description:
        'True only for a real customer (or prospective customer) writing to Plasma Design. False for marketing, spam, automated notifications, supplier emails.',
    },
    category: { type: 'string', enum: [...CATEGORY_VALUES] },
    confidence: { type: 'string', enum: [...CONFIDENCE_VALUES] },
    summary: { type: 'string', description: 'One or two sentences: what the customer wants.' },
    mentioned_materials: {
      type: 'array',
      items: { type: 'string' },
      description: 'Card materials the email refers to, verbatim-ish (e.g. "gold metal", "acrylic").',
    },
    mentioned_quantities: {
      type: 'array',
      items: { type: 'integer' },
      description: 'Card quantities mentioned (e.g. 20, 250). Not thicknesses or dates.',
    },
    currency_hint: {
      type: 'string',
      enum: [...CURRENCY_VALUES, 'unknown'],
      description: 'From explicit currency symbols, country clues, or the email domain. unknown if unclear.',
    },
  },
} as const

export const DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['should_draft', 'abstain_reason', 'draft_body', 'note_body', 'figures_used', 'links_used'],
  properties: {
    should_draft: {
      type: 'boolean',
      description: 'False when a human should write this one instead; silence is preferred over a risky draft.',
    },
    abstain_reason: {
      type: ['string', 'null'],
      description: 'Required when should_draft is false: one sentence on why.',
    },
    draft_body: {
      type: ['string', 'null'],
      description: 'The reply, plain text, house voice. Null when abstaining.',
    },
    note_body: {
      type: ['string', 'null'],
      description:
        'Internal working shown to the team: category, key reasoning, every figure with its source, anything to double-check. Null when abstaining.',
    },
    figures_used: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['amount', 'currency', 'source'],
        properties: {
          amount: { type: 'number' },
          currency: { type: 'string', enum: [...CURRENCY_VALUES] },
          source: { type: 'string', description: 'Where this figure came from in the briefing data.' },
        },
      },
    },
    links_used: { type: 'array', items: { type: 'string' } },
  },
} as const
