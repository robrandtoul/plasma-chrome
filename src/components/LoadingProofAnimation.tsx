import { useState } from 'react'

// Six on-brand loading animations, one picked at random per page load.
// The useState initialiser runs once per mount, so the choice is
// stable across re-renders but varies each time the loading screen
// appears. Styles + keyframes live in design-tokens.css (`.pl-*`);
// all honour prefers-reduced-motion. A minimum display floor in
// CustomerProofPage.loadProof keeps the animation on screen long
// enough to play even on a fast fetch.
const VARIANTS = [
  'registration',
  'stacking',
  'plotter',
  'halftone',
  'emboss',
  'roller',
] as const
type Variant = (typeof VARIANTS)[number]

const CAPTION: Record<Variant, string> = {
  registration: 'Preparing proof',
  stacking: 'Loading proof',
  plotter: 'Drawing proof',
  halftone: 'Resolving proof',
  emboss: 'Pressing proof',
  roller: 'Inking proof',
}

// Halftone: a 7×7 dot grid, each dot's animation delayed by its
// distance from the centre so the pulse blooms outward in a ripple.
const HALFTONE_DOTS = Array.from({ length: 49 }, (_, n) => {
  const row = Math.floor(n / 7)
  const col = n % 7
  const dist = Math.hypot(row - 3, col - 3)
  return { key: n, delay: `${(dist * 0.16).toFixed(2)}s` }
})

export function LoadingProofAnimation() {
  const [variant] = useState<Variant>(
    () => VARIANTS[Math.floor(Math.random() * VARIANTS.length)],
  )

  return (
    <div
      className="flex flex-col items-center"
      role="status"
      aria-label="Loading proof"
    >
      <div className="pl-stage" style={{ height: 130 }}>
        {variant === 'registration' && (
          <div className="pl-reg">
            <span className="pl-cmark tl" />
            <span className="pl-cmark tr" />
            <span className="pl-cmark bl" />
            <span className="pl-cmark br" />
            <span className="pl-layer pl-cy" />
            <span className="pl-layer pl-ma" />
            <span className="pl-layer pl-ye" />
          </div>
        )}

        {variant === 'stacking' && (
          <div className="pl-stack">
            <span className="pl-card pl-c1" />
            <span className="pl-card pl-c2" />
            <span className="pl-card pl-c3" />
            <span className="pl-card pl-c4" />
          </div>
        )}

        {variant === 'plotter' && (
          <svg className="pl-plot" viewBox="0 0 170 120" aria-hidden="true">
            <g className="pl-marks">
              <line x1="20" y1="8" x2="20" y2="20" /><line x1="8" y1="20" x2="20" y2="20" />
              <line x1="150" y1="8" x2="150" y2="20" /><line x1="162" y1="20" x2="150" y2="20" />
              <line x1="20" y1="112" x2="20" y2="100" /><line x1="8" y1="100" x2="20" y2="100" />
              <line x1="150" y1="112" x2="150" y2="100" /><line x1="162" y1="100" x2="150" y2="100" />
            </g>
            <rect className="pl-outline" x="28" y="28" width="114" height="64" rx="8" />
          </svg>
        )}

        {variant === 'halftone' && (
          <div className="pl-halftone" aria-hidden="true">
            {HALFTONE_DOTS.map((d) => (
              <i key={d.key} style={{ animationDelay: d.delay }} />
            ))}
          </div>
        )}

        {variant === 'emboss' && (
          <div className="pl-emb" aria-hidden="true">
            <span className="pl-relief" />
          </div>
        )}

        {variant === 'roller' && (
          <div className="pl-roll" aria-hidden="true">
            <span className="pl-ink" />
            <span className="pl-bar" />
          </div>
        )}
      </div>

      <p className="eyebrow mt-8" style={{ letterSpacing: '0.24em' }}>
        {CAPTION[variant]}
      </p>
    </div>
  )
}

export default LoadingProofAnimation
