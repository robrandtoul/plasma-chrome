// supabase-js wraps every non-2xx edge-function response in a
// FunctionsHttpError whose .message is the fixed string "Edge Function returned
// a non-2xx status code" and leaves `data` null. The function's own JSON body —
// the part that actually says what went wrong ("Customer replies are currently
// paused by an admin.", "No Help Scout conversation linked to this proof",
// "Help Scout reply error (400): …") — is only reachable through err.context,
// the underlying Response.
//
// Reading it is not optional polish: without it every distinct failure a
// function can report collapses into the same meaningless sentence, and the
// `data?.error` branch every call site writes is dead code, because `data` is
// null on exactly the responses that carry an error.
//
// This lived as a module-private copy inside MessageSendPanel; SendPayLinkModal,
// GroupOrdersModal and OrderBuilderModal each grew their own inline variant.
// New call sites should import this one rather than add a fifth.

export async function extractServerError(err: unknown, fallbackMessage: string): Promise<string> {
  const ctx = (err as { context?: Response }).context
  if (!ctx || typeof ctx.clone !== 'function') return fallbackMessage
  try {
    // Clone so the caller can still read the body if it wants to.
    const parsed = await ctx.clone().json()
    if (parsed && typeof parsed === 'object' && typeof parsed.error === 'string') {
      return parsed.error
    }
  } catch {
    // Body not JSON, body already consumed, etc — fall through.
  }
  return fallbackMessage
}
