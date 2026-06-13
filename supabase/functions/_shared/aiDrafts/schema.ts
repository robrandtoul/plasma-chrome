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

// When an email is NOT a genuine customer enquiry, which kind of non-customer
// email it is. 'spam' is reserved strictly for unsolicited junk — a supplier
// or an automated notification is NOT spam, even though neither needs a reply.
// 'genuine' is the value for a real customer email (is_genuine_customer_email
// true), so this field is always populated.
export const NON_CUSTOMER_KIND_VALUES = [
  'genuine',
  'spam',
  'supplier',
  'automated_notification',
  'other',
] as const

export const CLASSIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'is_genuine_customer_email',
    'non_customer_kind',
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
    non_customer_kind: {
      type: 'string',
      enum: [...NON_CUSTOMER_KIND_VALUES],
      description:
        "When is_genuine_customer_email is TRUE, set 'genuine'. When FALSE, say which kind of non-customer email this is: 'spam' = unsolicited marketing, cold sales pitches, promotions, list-blasts, junk — someone selling TO Plasma or mass-mailing a list; 'supplier' = a genuine business email from a supplier, vendor, courier account or partner (NOT spam, even if no reply is needed); 'automated_notification' = a system-generated message such as a payment receipt, shipping/courier update, platform or order alert; 'other' = any other non-customer email that fits none of those. Reserve 'spam' for genuine unsolicited junk only.",
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
      description:
        "ONLY from explicit evidence in the thread: currency symbols or codes, a stated country/city/address, a phone country code, or an email/web domain (.co.uk, .com.au, .de...). With no such evidence you MUST answer 'unknown' — never guess a default.",
    },
  },
} as const

// The internal note is now STRUCTURED: the model fills discrete fields, and
// composeNote() renders them into a consistent, scannable layout for the
// reviewer (header · summary · figures · assumptions · before-you-send checks
// · action · guardrail status) rather than a wall of free prose.
export const DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'should_draft',
    'abstain_reason',
    'draft_body',
    'note_summary',
    'assumptions',
    'checks',
    'action',
    'figures_used',
    'links_used',
  ],
  properties: {
    should_draft: {
      type: 'boolean',
      description: 'False when a human should write this one instead; silence is preferred over a risky draft.',
    },
    abstain_reason: {
      type: ['string', 'null'],
      description: 'Required when should_draft is false: one sentence on why a human should take this.',
    },
    draft_body: {
      type: ['string', 'null'],
      description: 'The reply, plain text, house voice. Null when abstaining.',
    },
    note_summary: {
      type: ['string', 'null'],
      description:
        'ONE short, plain-English sentence for the reviewer: what this is and what you did, naming the actual material/product precisely (keep qualifiers that change meaning — a colour/finish/ink name is not the card material; "gun metal ink on satin black plastic" is not "gun metal cards"). No spec dumps or reasoning — those go in the other fields. For an abstention, one line on why it needs a human.',
    },
    assumptions: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Assumptions the reviewer should know about, one per item as a short plain phrase (e.g. "assumed UK-based", "read \'polished\' as natural finish, not mirror"). Empty array if none.',
    },
    checks: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Things the reviewer must verify or decide BEFORE sending, one per item, each a short action (e.g. "Confirm gun metal comes brushed at this price", "Decide whether to apply the discount they asked for"). Empty array if nothing needs checking.',
    },
    action: {
      type: ['string', 'null'],
      description:
        'For an abstention or handoff, ONE short next step for the team, specs kept to the bare essentials (e.g. "Route to Graphics", "Ready to invoice — send the order link; qty 50 matte black 500µm"). Null when a draft is provided and no special action is needed.',
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
