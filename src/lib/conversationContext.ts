// Shared client for the Help Scout conversation context behind a proof.
// One thin wrapper over the fetch-helpscout-conversation-context edge
// function so the surfaces that read the conversation thread — the
// message editor's context panel and the activity timeline's inline
// "Show message" reveal — share one shape and one fetch path rather
// than drifting apart. The edge function does the auth, the Help Scout
// OAuth, and the HTML→plain-text cleanup; this just types the result.

import { supabase } from './supabase'

export interface ConversationThread {
  id: number
  /** 'customer' | 'reply' | 'note' | … (Help Scout thread type). */
  type: string
  authorName: string
  authorType: 'customer' | 'user' | 'unknown'
  /** HTML stripped to plain text, email cruft removed, by the edge fn. */
  bodyText: string
  createdAt: string
}

export interface ConversationContext {
  conversation_id: number
  /** Deep link to the conversation in Help Scout. */
  url: string
  /** Newest-first; empty-body system rows included (filter at the call site). */
  threads: ConversationThread[]
}

// Fetch the linked conversation's thread history for one proof. Throws
// with a readable message on any failure (no linked conversation, Help
// Scout unreachable, etc.) so the caller can show a quiet fallback.
export async function fetchConversationContext(
  proofId: string,
): Promise<ConversationContext> {
  const { data, error } = await supabase.functions.invoke(
    'fetch-helpscout-conversation-context',
    { body: { proof_id: proofId } },
  )
  if (error) throw new Error(error.message ?? 'Failed to load conversation')
  const payload = data as ConversationContext | { error: string }
  if (payload && 'error' in payload) throw new Error(payload.error)
  return payload as ConversationContext
}
