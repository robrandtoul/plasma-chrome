// Designer message editor + context panel that takes over the
// new-version page after a successful save (Ship 2 of intervention 3).
// Pre-populates the reply body from a Help Scout-bound template,
// shows the customer's recent conversation history above, and posts
// the edited reply via the send-helpscout-reply edge function on
// click.
//
// The panel handles the no-conversation case gracefully: when the
// proof has no helpscout_conversation_id, the editor is hidden and
// the only action is "Continue to project". Lets v2+ creations on
// proofs that were never linked to a Help Scout thread still use
// the new page chrome without crashing.
//
// State machine:
//   idle    → editor enabled, Send enabled
//   sending → editor disabled, Send shows spinner
//   sent    → ~600ms confirmation, then onSent (parent navigates)
//   error   → editor enabled, Send re-enabled, error text above editor
//
// Re-send guard: stored thread_id from a successful send turns
// subsequent Send clicks into no-ops. The disabled-Send-during-
// sending window is short, but the local guard catches the rare
// rapid double-click after sent before the redirect fires.

import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { logAudit } from '../lib/audit'
import {
  renderTemplate,
  DEFAULT_BODIES,
  type TemplateContext,
} from '../lib/replyTemplates'

// ── Types ────────────────────────────────────────────────────────────────────

interface ContextThread {
  id: number
  type: string  // 'customer' | 'reply' | 'note' | ...
  authorName: string
  authorType: 'customer' | 'user' | 'unknown'
  bodyText: string
  createdAt: string
}

interface ContextResponse {
  conversation_id: number
  url: string
  threads: ContextThread[]
}

type EditorState = 'idle' | 'sending' | 'sent' | 'error'

// ── Component ────────────────────────────────────────────────────────────────

export interface MessageSendPanelProps {
  proofId: string
  versionId: string
  versionNumber: number
  templateId: 'first_proof' | 'revision'
  context: TemplateContext
  hasHelpScoutConversation: boolean
  onSent: () => void
  onSkip: () => void
}

export default function MessageSendPanel({
  proofId,
  versionId,
  versionNumber,
  templateId,
  context,
  hasHelpScoutConversation,
  onSent,
  onSkip,
}: MessageSendPanelProps) {
  // Editor body. Seeded from the rendered template once on mount;
  // subsequent edits don't re-render against the template (what you
  // see is what gets sent).
  const [body, setBody] = useState('')
  const [bodyReady, setBodyReady] = useState(false)
  const [templateFallback, setTemplateFallback] = useState(false)

  // Send state machine.
  const [editorState, setEditorState] = useState<EditorState>('idle')
  const [sendError, setSendError] = useState<string | null>(null)
  const sentThreadIdRef = useRef<number | null>(null)

  // Conversation context.
  const [contextLoading, setContextLoading] = useState(hasHelpScoutConversation)
  const [contextData, setContextData] = useState<ContextResponse | null>(null)
  const [contextError, setContextError] = useState<string | null>(null)
  const [showOlder, setShowOlder] = useState(false)

  // ── Mount: load template + render initial body ─────────────────────────────
  useEffect(() => {
    let cancelled = false
    async function loadTemplate() {
      const { data, error } = await supabase
        .from('reply_templates')
        .select('body')
        .eq('id', templateId)
        .maybeSingle()
      if (cancelled) return
      // Fallback to the source-of-truth default if the template row
      // is missing or unreadable (e.g. RLS quirk, deleted by direct
      // DB edit). Audit metadata flags the fallback so we can spot
      // the case in the activity feed if it ever happens.
      const sourceBody =
        !error && data?.body
          ? (data.body as string)
          : (DEFAULT_BODIES[templateId] ?? '')
      if (!error && data?.body) {
        setTemplateFallback(false)
      } else {
        setTemplateFallback(true)
      }
      setBody(renderTemplate(sourceBody, context))
      setBodyReady(true)
    }
    void loadTemplate()
    return () => { cancelled = true }
    // context is intentionally stable for the lifetime of the panel;
    // the parent rebuilds it from saved values. Re-seeding the body
    // mid-edit would clobber the designer's typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId])

  // ── Mount: load conversation context ──────────────────────────────────────
  useEffect(() => {
    if (!hasHelpScoutConversation) return
    let cancelled = false
    async function loadContext() {
      const { data, error } = await supabase.functions.invoke('fetch-helpscout-conversation-context', {
        body: { proof_id: proofId },
      })
      if (cancelled) return
      setContextLoading(false)
      if (error) {
        setContextError(await extractServerError(error, error.message))
        return
      }
      const payload = data as ContextResponse | { error: string }
      if (payload && 'error' in payload) {
        setContextError(payload.error)
        return
      }
      setContextData(payload as ContextResponse)
    }
    void loadContext()
    return () => { cancelled = true }
  }, [hasHelpScoutConversation, proofId])

  // ── Send ──────────────────────────────────────────────────────────────────
  async function handleSend() {
    if (editorState === 'sending') return
    if (sentThreadIdRef.current != null) {
      // Already sent, just navigate.
      onSent()
      return
    }
    if (body.trim() === '') {
      setSendError('Reply body is empty.')
      setEditorState('error')
      return
    }
    setSendError(null)
    setEditorState('sending')

    const { data, error } = await supabase.functions.invoke('send-helpscout-reply', {
      body: { proof_id: proofId, body },
    })

    if (error) {
      // supabase-js wraps non-2xx into a FunctionsHttpError whose
      // .message is the generic "Edge Function returned a non-2xx
      // status code". The actual function-emitted JSON body sits on
      // .context (the underlying Response). Read it explicitly so
      // the designer sees our error copy ("HELPSCOUT_DEFAULT_USER_ID
      // not set", "Help Scout reply error (400): ...", etc) rather
      // than the meaningless wrapper text.
      const fallback = (error as Error).message ?? 'Send failed.'
      setSendError(await extractServerError(error, fallback))
      setEditorState('error')
      return
    }
    const payload = data as { thread_id?: number; error?: string }
    if (payload?.error) {
      setSendError(payload.error)
      setEditorState('error')
      return
    }
    const threadId = payload?.thread_id ?? 0
    sentThreadIdRef.current = threadId
    setEditorState('sent')

    void logAudit({
      action: 'proof.reply_sent',
      targetType: 'proof',
      targetId: proofId,
      targetLabel: `v${versionNumber} reply`,
      metadata: {
        version_id: versionId,
        version_number: versionNumber,
        template_id: templateId,
        template_fallback: templateFallback,
        conversation_id: contextData?.conversation_id ?? null,
        thread_id: threadId,
        body_length: body.length,
        sent_at: new Date().toISOString(),
      },
    })

    // ~600ms confirmation so the designer sees the affirmation
    // before the redirect snaps to the project page.
    window.setTimeout(() => onSent(), 600)
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const editorDisabled = editorState === 'sending' || editorState === 'sent'

  // No-conversation case: hide editor, only Continue.
  if (!hasHelpScoutConversation) {
    return (
      <div className="space-y-4">
        <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
          <p className="text-sm text-gray-500">
            No Help Scout conversation is linked to this proof. The customer-facing
            URL has been saved with the version; you can copy it from the project
            page and reply manually.
          </p>
        </div>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onSkip}
            className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-700"
          >
            Continue to project
          </button>
        </div>
      </div>
    )
  }

  const lastCustomerThread = contextData?.threads.find((t) => t.authorType === 'customer')
  const lastReplyThread = contextData?.threads.find((t) => t.type === 'reply')
  const olderThreads = contextData?.threads.filter(
    (t) => t.id !== lastCustomerThread?.id && t.id !== lastReplyThread?.id,
  ).slice(0, 5) ?? []

  return (
    <div className="space-y-4">
      {/* Context panel */}
      <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
        <h3 className="mb-4 text-xs font-semibold uppercase tracking-wider text-gray-400">
          Conversation context
        </h3>

        {contextLoading && (
          <p className="text-sm text-gray-400">Loading recent messages…</p>
        )}

        {contextError && (
          <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">
            Couldn't load conversation history: {contextError}
          </div>
        )}

        {contextData && (
          <div className="space-y-4">
            {lastCustomerThread ? (
              <ThreadCard label="Customer's last message" thread={lastCustomerThread} />
            ) : (
              <p className="text-sm text-gray-400">No customer messages yet.</p>
            )}
            {lastReplyThread && (
              <ThreadCard label="Your last reply" thread={lastReplyThread} muted />
            )}
            {olderThreads.length > 0 && !showOlder && (
              <button
                type="button"
                onClick={() => setShowOlder(true)}
                className="text-xs font-medium text-gray-500 underline-offset-2 hover:text-gray-900 hover:underline"
              >
                Show more of the thread ({olderThreads.length})
              </button>
            )}
            {showOlder && olderThreads.map((t) => (
              <ThreadCard key={t.id} thread={t} muted />
            ))}
            <div>
              <a
                href={contextData.url}
                target="_blank"
                rel="noreferrer"
                className="text-xs font-medium text-gray-500 underline-offset-2 hover:text-gray-900 hover:underline"
              >
                Open in Help Scout
              </a>
            </div>
          </div>
        )}
      </section>

      {/* Editor */}
      <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
        <div className="mb-2 flex items-center gap-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">
            Reply
          </h3>
          {editorState === 'sent' && (
            <span className="text-xs font-medium text-emerald-600">Sent</span>
          )}
          {templateFallback && (
            <span className="text-xs text-gray-400">Using built-in default</span>
          )}
        </div>

        {sendError && (
          <div className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-rose-200">
            {sendError}
          </div>
        )}

        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          disabled={editorDisabled || !bodyReady}
          rows={12}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm leading-relaxed focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900 disabled:bg-gray-50 disabled:text-gray-400"
          placeholder={bodyReady ? '' : 'Loading template…'}
        />
      </section>

      {/* Actions */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onSkip}
          disabled={editorState === 'sending'}
          className="text-sm font-medium text-gray-500 hover:text-gray-900 disabled:opacity-50"
        >
          Skip and go to project
        </button>
        <button
          type="button"
          onClick={handleSend}
          disabled={editorDisabled || !bodyReady}
          className={[
            'rounded-lg px-4 py-2 text-sm font-semibold text-white transition-colors',
            editorState === 'sending' || editorState === 'sent'
              ? 'bg-gray-900/60 cursor-not-allowed'
              : 'bg-gray-900 hover:bg-gray-700',
          ].join(' ')}
        >
          {editorState === 'sending' ? 'Sending…' : editorState === 'sent' ? 'Sent ✓' : 'Send reply'}
        </button>
      </div>
    </div>
  )
}

// ── ThreadCard ───────────────────────────────────────────────────────────────

function ThreadCard({
  label,
  thread,
  muted,
}: {
  label?: string
  thread: ContextThread
  muted?: boolean
}) {
  return (
    <div
      className={[
        'rounded-xl border p-4',
        muted ? 'border-gray-100 bg-gray-50/40' : 'border-gray-200 bg-white',
      ].join(' ')}
    >
      {label && (
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
          {label}
        </p>
      )}
      <div className="mb-2 flex items-center gap-2 text-xs text-gray-500">
        <span className="font-medium text-gray-700">{thread.authorName}</span>
        <span>·</span>
        <span>{formatThreadTimestamp(thread.createdAt)}</span>
      </div>
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-800">
        {thread.bodyText || <span className="italic text-gray-400">(empty body)</span>}
      </p>
    </div>
  )
}

function formatThreadTimestamp(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// supabase-js wraps every non-2xx function response in a
// FunctionsHttpError whose .message is the generic "Edge Function
// returned a non-2xx status code". The actual function-emitted body
// is on err.context (the underlying Response). Read it explicitly
// so the designer sees our error copy ("HELPSCOUT_DEFAULT_USER_ID
// not set", "Help Scout reply error (400): ...") rather than the
// wrapper. Falls back to fallbackMessage when the body is missing,
// not JSON, or doesn't contain an error field.
async function extractServerError(err: unknown, fallbackMessage: string): Promise<string> {
  const ctx = (err as { context?: Response }).context
  if (!ctx || typeof ctx.clone !== 'function') return fallbackMessage
  try {
    const cloned = ctx.clone()
    const parsed = await cloned.json()
    if (parsed && typeof parsed === 'object' && typeof parsed.error === 'string') {
      return parsed.error
    }
  } catch {
    // Body not JSON, body already consumed, etc — fall through.
  }
  return fallbackMessage
}
