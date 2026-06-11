// Cross-runtime env access: the same core runs under Node (tsx backtest
// harness) and the Supabase Edge runtime (Deno). Names differ per runtime —
// callers ask by purpose, not variable name.

declare const Deno: { env: { get(name: string): string | undefined } } | undefined

function read(...names: string[]): string | undefined {
  for (const name of names) {
    const fromDeno = typeof Deno !== 'undefined' ? Deno.env.get(name) : undefined
    if (fromDeno) return fromDeno
    const fromNode =
      typeof process !== 'undefined' && process.env ? process.env[name] : undefined
    if (fromNode) return fromNode
  }
  return undefined
}

export function supabaseUrl(): string | undefined {
  return read('SUPABASE_URL', 'VITE_SUPABASE_URL')
}

export function supabaseAnonKey(): string | undefined {
  return read('SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY')
}

export function anthropicApiKey(): string | undefined {
  return read('ANTHROPIC_API_KEY')
}

export function draftModel(): string | undefined {
  return read('AI_DRAFT_MODEL')
}
