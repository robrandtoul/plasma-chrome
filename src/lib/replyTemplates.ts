// Reply-template substitution helpers. Foundation for the customer-
// reply feature (Ship 1 of intervention 3). Today this only powers
// the admin preview pane; Ship 2 wires it into the new-version flow's
// designer-facing message editor, and Ship 3 routes the rendered text
// through the Help Scout API send.
//
// Two pieces:
//
//   * renderTemplate(template, ctx): apply variable substitution and
//     conditional rendering to a template string. Two passes —
//     conditional blocks first, then bare variables — so a variable
//     used inside a conditional resolves correctly even when the same
//     variable name is also used outside the block.
//
//   * TEMPLATE_VARIABLES: declarative metadata about each supported
//     variable, used by the admin UI to render insert chips and the
//     help panel below the template cards.
//
// Conditional syntax: {? variable_name}…{/?}
//   * Renders the contained block iff ctx[variable_name] is non-empty
//     (string with .trim().length > 0 after coercion). Empty,
//     whitespace-only, null, and undefined all collapse the block to
//     nothing. The opener carries the variable name; the closer is
//     generic ({/?}) so unnamed conditionals stay possible if we ever
//     add them. No nesting in v1 — documented constraint.
//
// Variable syntax: {variable_name}
//   * Substitutes ctx[variable_name] coerced to string. null and
//     undefined both substitute empty.

// ── Context shape ────────────────────────────────────────────────────────────
//
// Open-ended via the index signature so future variables (e.g.
// card_type, designer_email, customer_phone) can be added by
// extending TEMPLATE_VARIABLES without changing the renderer.

export interface TemplateContext {
  first_name?: string
  full_name?: string
  company?: string | null
  version_number?: number | string
  url?: string
  designer_first_name?: string
  [key: string]: string | number | null | undefined
}

// ── Render ───────────────────────────────────────────────────────────────────

export function renderTemplate(template: string, ctx: TemplateContext): string {
  // Pass 1: conditional blocks. Match {? var}body{/?} non-greedily so
  // multiple blocks in one template resolve independently. The body
  // recurses through substituteVariables so {var} tokens inside a
  // surviving block render correctly. Empty / whitespace / null /
  // undefined ctx values trim the whole block.
  let s = template.replace(
    /\{\?\s*(\w+)\s*\}([\s\S]*?)\{\/\?\}/g,
    (_match, varName: string, body: string) => {
      const v = ctx[varName]
      const empty = v == null || (typeof v === 'string' && v.trim() === '')
      return empty ? '' : substituteVariables(body, ctx)
    },
  )
  // Pass 2: bare variables outside conditional blocks.
  s = substituteVariables(s, ctx)
  return s
}

export function substituteVariables(text: string, ctx: TemplateContext): string {
  return text.replace(/\{(\w+)\}/g, (_match, v: string) => {
    const val = ctx[v]
    return val == null ? '' : String(val)
  })
}

// ── Variable metadata ────────────────────────────────────────────────────────
//
// Drives the admin UI: each entry produces an insert chip with the
// shown name as label and the description as a hover hint or
// underneath-the-toolbar caption. The conditional flag indicates
// "this value can be empty in real usage; consider wrapping in
// {? var}…{/?} if you reference it from a template". Doesn't affect
// renderer behaviour — the renderer treats empty/undefined identically
// for every variable.

export interface TemplateVariableMeta {
  // Variable name as it appears between braces in templates. Plain
  // string (rather than keyof TemplateContext) because the context
  // interface has a string index signature that makes keyof resolve
  // to string | number, and the UI's insert chips need a string.
  // The TEMPLATE_VARIABLES array below is the source of truth for
  // which names render in the toolbar.
  name: string
  description: string
  conditional: boolean
}

export const TEMPLATE_VARIABLES: TemplateVariableMeta[] = [
  { name: 'first_name',          description: "Customer's first name",                                                            conditional: false },
  { name: 'full_name',           description: "Customer's full name",                                                             conditional: false },
  { name: 'company',             description: 'Company name (when set)',                                                          conditional: true  },
  { name: 'version_number',      description: 'Proof version number',                                                             conditional: false },
  { name: 'url',                 description: 'Customer-facing proof URL',                                                        conditional: false },
  { name: 'designer_first_name', description: "Designer's first name (deferred, resolves to empty until designer accounts ship)", conditional: true  },
]

// ── Default bodies ───────────────────────────────────────────────────────────
//
// Source-of-truth defaults for the Reset button. Must stay in sync
// with the seed inserts in supabase/migrations/000102_add_reply_
// templates.sql. The migration seeds these once on first apply;
// subsequent edits are admin-driven through the Settings page. Reset
// reads from this constant rather than re-fetching the migration.
//
// Both bodies use {? company} to demonstrate the conditional syntax
// in the seeded copy so admins see a working example before touching
// anything.

export const DEFAULT_BODIES: Record<string, string> = {
  first_proof:
    `Hi {first_name},\n\nHere's the first proof of your cards{? company} for {company}{/?}. Have a look and let us know what you think.\n\n{url}\n\nMany thanks,\nPlasma Design`,
  revision:
    `Hi {first_name},\n\nHere's v{version_number} of your cards{? company} for {company}{/?} with the changes you asked for. Take another look when you have a moment.\n\n{url}\n\nMany thanks,\nPlasma Design`,
}
