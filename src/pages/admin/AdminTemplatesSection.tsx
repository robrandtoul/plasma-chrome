// Admin section for editing customer-reply templates. Lives inside
// AdminSettingsPage between Integrations and Materials.
//
// Two template families, rendered in their own sub-sections:
//   * Pre-send messages — first_proof, revision. Composed by the
//     designer in the new-version flow before they hit Send. Routed
//     through the send-helpscout-reply edge function.
//   * Post-action confirmations — proof_approval_confirmation,
//     proof_change_request_confirmation, proof_variant_selection_
//     confirmation. Sent automatically by the proof-action edge
//     function when a customer approves, requests changes, or picks
//     a variant on a variant round. Edits affect every customer's
//     confirmation email.
//
// Per template: insert toolbar (variable chips filtered by scope +
// if-block button), blur-saving textarea, live preview pane with
// sample data, and a Reset button. The preview substitutes <br>
// tags for newlines so post-action templates (which use <br><br>
// for paragraph breaks per the Help Scout convention) render
// honestly. Audit log fires on every save and on Reset.

import { useEffect, useRef, useState, type RefObject } from 'react'
import { supabase } from '../../lib/supabase'
import { logAudit } from '../../lib/audit'
import {
  renderTemplate,
  TEMPLATE_VARIABLES,
  DEFAULT_BODIES,
  type TemplateContext,
  type TemplateVariableScope,
} from '../../lib/replyTemplates'
import { invalidateRepliesEnabled } from '../../lib/repliesEnabled'

// ── Types ────────────────────────────────────────────────────────────────────

interface ReplyTemplate {
  id: string
  display_name: string
  description: string
  body: string
  updated_at: string
}

// Two sample-data toggles for the preview. The "with company" axis
// drives whether the {? company}…{/?} block renders; the "v1 / v2+"
// axis drives version_number so the revision template's value cell
// stays meaningful.
type CompanyMode = 'with' | 'without'
type VersionMode = 'v1' | 'v2'

const SAMPLE_BASE = {
  first_name: 'Kevin',
  full_name: 'Kevin Knowles',
  url: 'https://proofs.plasmadesign.co.uk/p/abcd-1234',
  designer_first_name: '',
}

function buildSampleContext(company: CompanyMode, version: VersionMode): TemplateContext {
  const versionN = version === 'v1' ? 1 : 2
  return {
    ...SAMPLE_BASE,
    company: company === 'with' ? 'Plasma Design' : null,
    version_number: versionN,
    // Sample values for the proof-viewer (post-action) templates.
    // The version toggle drives version_label too so the two stay
    // visually consistent when the same toggle is on screen for a
    // proof-viewer card. The other proof-viewer fields are baked-in
    // representative values so admins see what each variable
    // resolves to. recipient_name defaults to empty (shared / all-
    // shared proof) — the more common case.
    version_label: `version ${versionN}`,
    change_notes: 'Please make the logo larger.',
    chosen_variant: 'Charcoal',
    actor_name: 'Kevin',
    recipient_name: '',
  }
}

// System-triggered templates have ids prefixed `proof_*` and are
// rendered into their own sub-section of the editor with a different
// variable scope. See the convention comment in
// src/lib/replyTemplates.ts for the rule.
function templateScope(id: string): TemplateVariableScope {
  return id.startsWith('proof_') ? 'proof_viewer' : 'designer_picked'
}

// ── Section ──────────────────────────────────────────────────────────────────

export default function AdminTemplatesSection() {
  const [templates, setTemplates] = useState<ReplyTemplate[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  // Global on/off switch for the customer-reply send (migration
  // 000104). Lives here alongside the templates because it gates
  // the same feature; admin sees enable/disable + content
  // configuration in one place. The flag is persisted on
  // settings.replies_enabled and the value is cached client-side
  // via repliesEnabled.ts; saving here invalidates that cache so
  // designer surfaces in other tabs pick up the change faster
  // than the 60s TTL.
  const [repliesEnabled, setRepliesEnabled] = useState<boolean | null>(null)
  const [togglingReplies, setTogglingReplies] = useState(false)
  const [toggleError, setToggleError] = useState<string | null>(null)

  useEffect(() => { void load() }, [])

  async function load() {
    const [templatesResult, settingsResult] = await Promise.all([
      supabase
        .from('reply_templates')
        .select('id, display_name, description, body, updated_at')
        .order('id'),
      supabase
        .from('settings')
        .select('replies_enabled')
        .eq('id', 1)
        .single(),
    ])
    if (templatesResult.error) {
      setLoadError(templatesResult.error.message)
      return
    }
    setTemplates((templatesResult.data ?? []) as ReplyTemplate[])
    if (!settingsResult.error && settingsResult.data) {
      setRepliesEnabled(!!settingsResult.data.replies_enabled)
    } else if (settingsResult.error) {
      // Don't leave the Send-replies toggle stuck on a silent
      // 'Loading…' — surface the failure so the admin can retry.
      console.error(
        '[admin-templates] Failed to load replies_enabled setting:',
        settingsResult.error.message,
      )
      setToggleError('Could not load the reply-templates on/off state. Reload to retry.')
    }
  }

  function handleSaved(updated: ReplyTemplate) {
    setTemplates((prev) => prev.map((t) => t.id === updated.id ? updated : t))
  }

  async function handleToggleReplies(next: boolean) {
    if (repliesEnabled === null) return
    if (next === repliesEnabled) return
    setTogglingReplies(true)
    setToggleError(null)
    const prev = repliesEnabled
    // Optimistic state.
    setRepliesEnabled(next)
    const { error } = await supabase
      .from('settings')
      .update({ replies_enabled: next, updated_at: new Date().toISOString() })
      .eq('id', 1)
    setTogglingReplies(false)
    if (error) {
      setRepliesEnabled(prev)
      setToggleError(error.message)
      return
    }
    invalidateRepliesEnabled()
    void logAudit({
      action: 'setting.replies_enabled_updated',
      targetType: 'setting',
      targetId: 'replies_enabled',
      targetLabel: 'Send replies',
      beforeValue: { replies_enabled: prev },
      afterValue: { replies_enabled: next },
    })
  }

  if (loadError) {
    return (
      <section className="rounded-2xl bg-rose-50 p-6 text-sm text-rose-700 ring-1 ring-rose-200">
        Failed to load reply templates: {loadError}
      </section>
    )
  }

  return (
    <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-gray-900">Customer replies</h3>
        <p className="mt-1 text-xs text-gray-500">
          Enable replies, customise the message text, see how each variant renders.
        </p>
      </div>

      {/* Global on/off toggle. Sits at the top of the section so
          enable/disable is the first thing an admin sees. The
          template cards below are still editable when replies are
          off — admins can refine the copy in advance and flip the
          feature on once happy. */}
      <div className="mb-6 flex items-start justify-between gap-4 rounded-xl border border-gray-200 bg-gray-50/40 p-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-gray-900">Send replies</p>
          <p className="mt-1 text-xs text-gray-500">
            Off: designers can compose messages but Send is disabled.
            On: replies route through Help Scout to the customer.
          </p>
          {toggleError && (
            <p className="mt-2 text-xs text-rose-600">{toggleError}</p>
          )}
        </div>
        <div className="shrink-0 pt-0.5">
          {repliesEnabled === null ? (
            <span className="text-xs text-gray-400">Loading…</span>
          ) : (
            <Toggle
              value={repliesEnabled}
              onChange={(v) => void handleToggleReplies(v)}
              disabled={togglingReplies}
              label="Send replies"
            />
          )}
        </div>
      </div>

      {templates.length === 0 ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : (
        <>
          <TemplateGroup
            heading="Pre-send messages"
            blurb="Composed by the designer in the new-version flow before they hit Send."
            templates={templates.filter((t) => templateScope(t.id) === 'designer_picked')}
            onSaved={handleSaved}
          />
          <TemplateGroup
            heading="Post-action confirmations"
            blurb="Sent automatically by the proof viewer when a customer approves, requests changes, or picks a variant. Edits affect every customer's confirmation email."
            templates={templates.filter((t) => templateScope(t.id) === 'proof_viewer')}
            onSaved={handleSaved}
          />
          <VariableHelpPanel />
        </>
      )}
    </section>
  )
}

// ── Template group (sub-section) ────────────────────────────────────────────
//
// Splits the editor into two visually-distinct groups so admins can
// see at a glance which templates are designer-composed vs system-
// triggered. The "Post-action confirmations" blurb spells out the
// "edits affect every customer's confirmation email" warning so the
// difference in editing impact is obvious before any change is made.

function TemplateGroup({
  heading, blurb, templates, onSaved,
}: {
  heading: string
  blurb: string
  templates: ReplyTemplate[]
  onSaved: (t: ReplyTemplate) => void
}) {
  if (templates.length === 0) return null
  return (
    <div className="mb-6 last:mb-0">
      <h4 className="mb-1 text-xs font-semibold uppercase tracking-wider text-gray-400">
        {heading}
      </h4>
      <p className="mb-3 text-xs text-gray-500">{blurb}</p>
      <div className="space-y-6">
        {templates.map((t) => (
          <TemplateCard key={t.id} template={t} onSaved={onSaved} />
        ))}
      </div>
    </div>
  )
}

// ── Toggle ───────────────────────────────────────────────────────────────────
//
// Local copy of the app-wide toggle pattern (gray-900 / gray-200,
// h-6 w-11, role="switch") so AdminTemplatesSection stays self-
// contained. Same shape used elsewhere (Shared toggle on
// NewVersionPage, Keep toggle on CarryCard, Show archived in
// AdminSettingsPage) so the visual register is consistent.

function Toggle({
  value, onChange, disabled = false, label,
}: {
  value: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!value)}
      className={[
        'relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors',
        value ? 'bg-gray-900' : 'bg-gray-200',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
      ].join(' ')}
    >
      <span
        className={[
          'inline-block h-5 w-5 translate-y-0.5 transform rounded-full bg-white transition-transform',
          value ? 'translate-x-[1.375rem]' : 'translate-x-0.5',
        ].join(' ')}
      />
    </button>
  )
}

// ── One template card ────────────────────────────────────────────────────────

function TemplateCard({
  template,
  onSaved,
}: {
  template: ReplyTemplate
  onSaved: (t: ReplyTemplate) => void
}) {
  const [draft, setDraft] = useState(template.body)
  const [working, setWorking] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [companyMode, setCompanyMode] = useState<CompanyMode>('with')
  const [versionMode, setVersionMode] = useState<VersionMode>(template.id === 'revision' ? 'v2' : 'v1')

  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Sync draft to template.body when the parent reloads (e.g. after
  // a Reset writes through the section's onSaved → state update).
  useEffect(() => { setDraft(template.body) }, [template.body])

  async function save(nextBody: string, action: 'template.body_updated' | 'template.reset_to_default') {
    if (nextBody === template.body) return
    setWorking(true)
    setError(null)
    const prevBody = template.body
    const { data, error: err } = await supabase
      .from('reply_templates')
      .update({ body: nextBody, updated_at: new Date().toISOString() })
      .eq('id', template.id)
      .select('id, display_name, description, body, updated_at')
      .single()
    setWorking(false)
    if (err || !data) {
      setError(err?.message ?? 'Save failed')
      // Roll back the draft if the optimistic state diverged.
      setDraft(prevBody)
      return
    }
    onSaved(data as ReplyTemplate)
    setDraft((data as ReplyTemplate).body)
    setSavedAt(Date.now())

    void logAudit({
      action,
      targetType: 'template',
      targetId: template.id,
      targetLabel: template.display_name,
      beforeValue: { body: prevBody },
      afterValue: { body: nextBody },
    })
  }

  function handleBlur() {
    void save(draft, 'template.body_updated')
  }

  function handleReset() {
    const def = DEFAULT_BODIES[template.id]
    if (def == null) {
      setError(`No default available for template ${template.id}`)
      return
    }
    if (def === template.body) return
    const ok = window.confirm('Discard your customisations and restore the default copy?')
    if (!ok) return
    void save(def, 'template.reset_to_default')
  }

  function handleInsertVariable(name: string) {
    insertAtCursor(textareaRef, `{${name}}`)
    syncDraftFromRef(textareaRef, setDraft)
  }

  function handleInsertIfBlock() {
    // Inserts a skeleton with the variable name placeholder selected
    // for immediate edit. The selection lands on the variable_name
    // token between {? and }, so the admin can type the variable
    // they want without first navigating the cursor.
    const before = '{? '
    const placeholder = 'variable_name'
    const after = '}your conditional content{/?}'
    insertSelectableAtCursor(textareaRef, before, placeholder, after)
    syncDraftFromRef(textareaRef, setDraft)
  }

  const recentlySaved = savedAt != null && Date.now() - savedAt < 2000

  const cardScope = templateScope(template.id)
  const cardVariables = TEMPLATE_VARIABLES.filter((v) => v.scope === cardScope)

  const previewCtx = buildSampleContext(companyMode, versionMode)
  // Render the template, then convert <br> / <br/> tags to real
  // newlines for the preview so the whitespace-pre-wrap div shows
  // paragraph breaks instead of literal "<br><br>" text. Help Scout's
  // text-mode reply renders <br> as a line break in the customer's
  // email, so this substitution makes the preview honest about what
  // the customer actually sees. Other HTML tags (e.g. <ul><li>)
  // would still render literally — none of the seed defaults use
  // them, and admins who introduce them are signalling a more
  // advanced template that warrants a closer look at the live email.
  const previewText = renderTemplate(draft, previewCtx).replace(/<br\s*\/?>/gi, '\n')

  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50/40 p-4">
      <div className="mb-1 flex items-center gap-3">
        <h4 className="text-sm font-semibold text-gray-900">{template.display_name}</h4>
        {working && <span className="text-xs text-gray-400">Saving…</span>}
        {recentlySaved && !working && <span className="text-xs text-emerald-600">Saved</span>}
        {error && <span className="text-xs text-rose-600">{error}</span>}
      </div>
      <p className="mb-3 text-xs text-gray-500">{template.description}</p>

      {/* Insert toolbar — variables filtered by template scope so each
          card only shows the chips that are meaningful inside its
          template's runtime context. Pre-send and post-action templates
          have disjoint variable sets. */}
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs font-medium text-gray-500">Insert:</span>
        {cardVariables.map((v) => (
          <button
            key={v.name}
            type="button"
            onClick={() => handleInsertVariable(v.name)}
            title={v.description}
            className="rounded-full bg-white px-2.5 py-1 text-xs font-medium text-gray-700 ring-1 ring-gray-200 transition-colors hover:bg-gray-100"
          >
            {`{${v.name}}`}
          </button>
        ))}
        <button
          type="button"
          onClick={handleInsertIfBlock}
          title="Insert a conditional block. Renders only when the named variable has a value."
          className="rounded-full bg-white px-2.5 py-1 text-xs font-medium text-violet-700 ring-1 ring-violet-200 transition-colors hover:bg-violet-50"
        >
          + if-block
        </button>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* Editor */}
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500">Body</label>
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={handleBlur}
            rows={10}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-xs leading-relaxed focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
          />
        </div>

        {/* Preview */}
        <div>
          <div className="mb-1 flex flex-wrap items-center gap-3">
            <label className="text-xs font-medium text-gray-500">Preview</label>
            <PreviewToggle<CompanyMode>
              value={companyMode}
              onChange={setCompanyMode}
              options={[
                { value: 'with',    label: 'with company' },
                { value: 'without', label: 'without company' },
              ]}
            />
            <PreviewToggle<VersionMode>
              value={versionMode}
              onChange={setVersionMode}
              options={[
                { value: 'v1', label: 'v1' },
                { value: 'v2', label: 'v2+' },
              ]}
            />
          </div>
          <div className="min-h-[14rem] whitespace-pre-wrap rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs leading-relaxed text-gray-700">
            {previewText}
          </div>
        </div>
      </div>

      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={handleReset}
          className="text-xs font-medium text-gray-500 underline-offset-2 hover:text-gray-900 hover:underline"
        >
          Reset to default
        </button>
      </div>
    </div>
  )
}

// ── Help panel ───────────────────────────────────────────────────────────────

function VariableHelpPanel() {
  // Variables grouped by scope so the help panel mirrors the
  // sub-section split above. Each scope renders the same dl shape.
  const designerPicked = TEMPLATE_VARIABLES.filter((v) => v.scope === 'designer_picked')
  const proofViewer = TEMPLATE_VARIABLES.filter((v) => v.scope === 'proof_viewer')

  return (
    <div className="mt-6 rounded-xl border border-gray-200 bg-gray-50/40 p-4">
      <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400">
        Pre-send variables
      </h4>
      <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-xs">
        {designerPicked.map((v) => (
          <div key={v.name} className="contents">
            <dt className="font-mono text-gray-700">{`{${v.name}}`}</dt>
            <dd className="text-gray-500">{v.description}</dd>
          </div>
        ))}
      </dl>

      <h4 className="mt-4 text-xs font-semibold uppercase tracking-wider text-gray-400">
        Post-action variables
      </h4>
      <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-xs">
        {proofViewer.map((v) => (
          <div key={v.name} className="contents">
            <dt className="font-mono text-gray-700">{`{${v.name}}`}</dt>
            <dd className="text-gray-500">{v.description}</dd>
          </div>
        ))}
      </dl>

      <h4 className="mt-4 text-xs font-semibold uppercase tracking-wider text-gray-400">Conditionals</h4>
      <p className="mt-2 text-xs text-gray-500">
        Wrap a block in <code className="rounded bg-white px-1 ring-1 ring-gray-200">{'{? variable}'}</code> and{' '}
        <code className="rounded bg-white px-1 ring-1 ring-gray-200">{'{/?}'}</code> to render only when the
        variable has a value. For example:
      </p>
      <pre className="mt-2 overflow-x-auto rounded-lg bg-white px-3 py-2 text-xs text-gray-700 ring-1 ring-gray-200">{`Hi {first_name}{? company} from {company}{/?}, here's…`}</pre>
    </div>
  )
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function PreviewToggle<T extends string>({ value, onChange, options }: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
}) {
  return (
    <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5">
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={[
              'rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors',
              active ? 'bg-gray-900 text-white' : 'text-gray-500 hover:text-gray-900',
            ].join(' ')}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

function insertAtCursor(ref: RefObject<HTMLTextAreaElement | null>, text: string) {
  const ta = ref.current
  if (!ta) return
  const start = ta.selectionStart ?? ta.value.length
  const end = ta.selectionEnd ?? ta.value.length
  ta.setRangeText(text, start, end, 'end')
  ta.focus()
}

// Insert {before}{placeholder}{after} and select {placeholder} so the
// admin can immediately overwrite it with the variable they want.
// Used by the if-block button so the conditional's variable name
// lands selected for edit, not just inserted as static text.
function insertSelectableAtCursor(
  ref: RefObject<HTMLTextAreaElement | null>,
  before: string,
  placeholder: string,
  after: string,
) {
  const ta = ref.current
  if (!ta) return
  const start = ta.selectionStart ?? ta.value.length
  const end = ta.selectionEnd ?? ta.value.length
  const insertedText = `${before}${placeholder}${after}`
  ta.setRangeText(insertedText, start, end, 'end')
  // Select the placeholder substring inside the just-inserted text.
  const placeholderStart = start + before.length
  const placeholderEnd = placeholderStart + placeholder.length
  ta.focus()
  ta.setSelectionRange(placeholderStart, placeholderEnd)
}

// React's value-controlled textarea doesn't see setRangeText edits as
// onChange-worthy on every browser, so push the textarea's current
// value back into local state explicitly after each programmatic
// insert.
function syncDraftFromRef(
  ref: RefObject<HTMLTextAreaElement | null>,
  setDraft: (v: string) => void,
) {
  const ta = ref.current
  if (!ta) return
  setDraft(ta.value)
}
