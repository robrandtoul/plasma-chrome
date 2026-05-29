// CSS custom-property aliases for inline-style use. Tailwind utility
// classes (bg-canvas, text-ink, border-line, etc.) cover almost every
// case — drop down to these only inside SVGs, for runtime-coloured
// props (e.g. <StatusRule colour={tokens.brand} />), or where Tailwind
// utilities don't reach. Names mirror src/styles/design-tokens.css.
export const tokens = {
  bg: 'var(--c-bg)',
  bgPanel: 'var(--c-bg-panel)',
  surface: 'var(--c-surface)',
  line: 'var(--c-line)',
  lineSoft: 'var(--c-line-soft)',

  ink: 'var(--c-ink)',
  inkSoft: 'var(--c-ink-soft)',
  inkMute: 'var(--c-ink-mute)',
  inkDim: 'var(--c-ink-dim)',

  brand: 'var(--c-brand)',
  brandSoft: 'var(--c-brand-soft)',
  brand50: 'var(--c-brand-50)',
  brand900: 'var(--c-brand-900)',

  inStock: 'var(--c-in-stock)',
  inStockSoft: 'var(--c-in-stock-soft)',
  low: 'var(--c-low)',
  lowSoft: 'var(--c-low-soft)',
  out: 'var(--c-out)',
  outSoft: 'var(--c-out-soft)',
  allocated: 'var(--c-allocated)',
  allocatedSoft: 'var(--c-allocated-soft)',
  critical: 'var(--c-critical)',
  criticalSoft: 'var(--c-critical-soft)',

  onBrand: 'var(--c-on-brand)',
  onInk: 'var(--c-on-ink)',

  ruleW: 'var(--rule-w)',
  radiusSm: 'var(--radius-sm)',
  radiusMd: 'var(--radius-md)',
  radiusLg: 'var(--radius-lg)',
  radiusFull: 'var(--radius-pill)',

  fontDisplay: 'var(--font-display)',
  fontBody: 'var(--font-body)',
  fontMono: 'var(--font-mono)',
  numFeatures: 'var(--num-features)',
} as const

export type TokenName = keyof typeof tokens
