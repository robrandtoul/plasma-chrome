/**
 * Verification notes for this branch (proof-viewer-direction-b):
 *
 * Hover-state probes via programmatic synthetic events
 * (`dispatchEvent(new MouseEvent('mouseenter'))`) do NOT reach
 * React's onMouseEnter handlers — React's filtering rejects
 * them. To verify hover styles in preview tooling, fall back
 * to either reading the inlined source values from this file
 * (the handlers assign these constants on real cursor events)
 * or capturing real-cursor screenshots. The handlers are
 * cosmetic — they assign visual state only, no React state
 * updates — so source-read verification is sufficient.
 *
 * Deliberate deviations from the README handoff spec
 * (docs/handoff/proof-viewer-b/README.md):
 *
 *   1. Hero H1 — README §"Visual Language → Typography" line 157
 *      specs 104px. Production renders 84px (20% reduction) after
 *      design review. Tracking, line-height, and italic subline
 *      keep their README values. See the inline comment at the
 *      H1 site in CustomerProofPage.tsx.
 *
 *   2. PAPER_CREAM — README §"Visual Language → Design Tokens"
 *      line 110 specs `#f4f1ea`. Production uses `#fefdfa`
 *      (whisper-of-warmth white, two iterations from spec via
 *      #faf7f0) to widen the contrast between the base paper
 *      register and the PAPER_TINT_1 / PAPER_TINT_2 tinted bands
 *      and to preserve the white-input-on-cream-surface hierarchy
 *      where #ffffff form chrome sits a tiny step above the page.
 *
 *   3. Timeline rows — README §3 line 279 specs a `rgba(123,63,242,0.06)`
 *      indigo wash on the active row inside the bordered list. Production
 *      uses lifted-card treatment instead: inactive rows on PAPER_CARD_DIM
 *      (#f4f1ea, a deeper cream than the now-near-white PAPER_CREAM) with
 *      a hairline border and rounded corners; active row on solid white
 *      (#ffffff) with a 4px ACCENT left-border accent and rounded-r-md.
 *      Three-tone hierarchy: PAPER_TINT_1 band → PAPER_CARD_DIM inactive
 *      cards → #ffffff active card. The inactive bg moved off PAPER_CREAM
 *      after deviation #2 lifted PAPER_CREAM to #fefdfa — cream-on-near-
 *      white was indistinguishable.
 *      The `border-l` rail on the list container and per-row hairlines
 *      retire (cards' own borders handle separation). Date / pill /
 *      "Superseded" caption / serif v{n} font sizes bump from the README
 *      baselines to 15 / 13 / 13 / 24 px for legibility (two rounds of
 *      adjustment based on real-cursor review).
 *
 *   4. Hero docket cell 1 — README §2 lines 235-239 specs "Job no." in
 *      cell 1 displaying the proof reference. Production ships
 *      "Material" / activeVersion.material_display instead — the proof
 *      reference is a Help Scout conversation ID with no customer-
 *      facing meaning, while the material is the headline spec the
 *      docket should foreground at-a-glance. Cell 2 also extends the
 *      adaptive branching: when the material has no options dimension
 *      (activeOption null) the cell falls back to Sides ("Front and
 *      back" / "Front only"), derived from the image set the same way
 *      the Specs section does. README's cell-2 fallback was "Stock /
 *      material_display" — superseded because cell 1 now carries the
 *      material.
 *
 *   5. Decorative dot retired — README §2 specced an ACCENT-coloured
 *      9×9 rounded dot with a glow shadow on docket cell 2 (option-
 *      having materials) and on every option tab in MaterialOptionTabs.
 *      The dot was meant to carry per-option colour intent, but that
 *      colour wiring never landed; in production it was a fixed ACCENT
 *      mark on every active surface — decoration without function.
 *      Both sites ship without dots: the docket cell renders text-only,
 *      and option tabs rely on the 2px ink underline + PAPER_INK text
 *      colour to signal active state.
 *
 *   6. QuantityLookup card lifted — README §"Pricing card" specced a
 *      faint-tint background (rgba(26,22,18,0.02)) for the "Need a
 *      price for a specific quantity?" card so it sat quietly inside
 *      the main pricing section. Production lifts it onto PAPER_TINT_1
 *      (#ebe6dc) with a 0.18 ink hairline so it reads as a discrete
 *      affordance against the PAPER_CREAM page background. The input
 *      gains real white chrome (#ffffff bg, 1px ink-25 border, 14/20
 *      padding, 16px font-paper-mono) and a decorative serif "→"
 *      chevron sits to its right (aria-hidden — the resolver auto-
 *      fires on input change, the chevron is a visual cue only with
 *      no click handler). The heading bumps from 28→30px serif.
 *
 *   7. Approval-state UI on the brand-green base — README's confirmed,
 *      optimistic, and carried banners + the hero approval chip + the
 *      timeline "Current" pill + the per-recipient approved pill all
 *      shipped on a pea-green base (rgba(74,222,128,X) / APPROVED_GREEN
 *      = #4ade80) with #1e7a3e / #166534 text. Production migrates the
 *      whole green family to a brand-tied teal-green base derived from
 *      the logomark — APPROVED_GREEN = #51b494, all rgba bg/border
 *      tints swap to rgba(81,180,148,X) at the same alphas.
 *
 *      Confirmed approve banner adopts the hero approval chip's pale
 *      palette for visual continuity from chip to banner across the
 *      approve flow: bg rgba(81,180,148,0.18), 1px rgba(81,180,148,0.4)
 *      border, text #176b3f. Typography (16px/600 mono eyebrow + 22px
 *      serif body) and 18/22 padding stay — the banner remains a
 *      standalone, wider surface, distinct from the chip's inline
 *      pill. README's earlier saturated treatment (0.55 bg, 0.90 border,
 *      #1f5640 text) is retired on the approve side after design
 *      review found the saturation read disconnected from the chip.
 *      The state-progression now relies on typography + padding weight
 *      (chip = small inline pill, banner = standalone block, optimistic
 *      = lighter bg/border alphas at the same hue, carried = lightest)
 *      rather than colour saturation alone.
 *
 *      Changes-requested family migrates from coral
 *      (rgba(229,114,49,X) + #a04116 / #7c2d12) to the brand blue
 *      #3a2c91 (RGB 58,44,145, the logomark blue) — see deviation #9.
 *
 *      Green text palette after the chip-match revision:
 *        • #51b494 — brand base, used in tick-circle dot and every
 *          rgba(81,180,148,X) bg/border tint.
 *        • #176b3f — text on every approve-state surface that uses
 *          the pale tints (hero chip, confirmed approve banner,
 *          per-recipient pill, optimistic banner, carried banner,
 *          timeline Current pill in both active-row-on-white and
 *          inactive-row-on-PAPER_CARD_DIM contexts). The PAPER_CARD_DIM
 *          surface case is what forced the bump from #1e7a3e (4.15:1
 *          fail) to #176b3f (5.05:1 pass). All other sites land in
 *          5.53–6.01:1 on the brand-tinted bgs.
 *        • #1f5640 — modal title (approve flow) only. The approve
 *          modal title sits on PAPER_TINT_1 (#ebe6dc), and #1f5640
 *          on that surface lands at 6.85:1. #176b3f would also pass
 *          there (5.19:1) — the deeper shade is preserved because
 *          modal titles read at the heaviest weight (kicker eyebrow
 *          immediately above the dialog body), and a deeper shade
 *          ties to "you are about to commit to this action" gravity.
 *
 *      Changes-requested family migrates separately to brand blue —
 *      see deviation #9.
 *
 *   8. Action modal converted from dark to paper register — README
 *      shipped the Approve / Request Changes confirmation modal on
 *      INK with white-on-dark text and a dark alpha-symmetric ghost
 *      treatment for the Request Changes Confirm button (transparent
 *      + 2px rgba(255,255,255,0.45) + white text). Production rebuilds
 *      the modal entirely on paper: panel PAPER_TINT_1 (#ebe6dc) with
 *      a 0.18 ink hairline; description in 14-15px serif PAPER_INK;
 *      form labels mono PAPER_INK; inputs gain real white chrome
 *      (#ffffff bg, 1px ink-18 border, ACCENT/50 focus ring) mirroring
 *      the QuantityLookup card. The disclaimer block becomes a lifted
 *      white card (0.5px ink-18 border) and the tick box renders as
 *      transparent-when-unchecked / PAPER_INK-fill with white tick
 *      when checked. Title text adopts the brand-family shades:
 *      #1f5640 (approve flow) and #3a2c91 (request-changes flow,
 *      post-deviation #9 coral-to-blue migration).
 *      Cancel + request-changes Confirm both adopt the per-recipient
 *      paper-register ghost via the existing CTA_GHOST_* tokens —
 *      the alpha-symmetric dark-ghost treatment is retired.
 *
 *      Pragmatic WCAG calls (after a check on each new surface):
 *        • Helper "Tick the disclaimer above…" bumped from
 *          rgba(26,22,18,0.55) (3.74:1) to 0.65 (5.10:1) — the one
 *          true fail with no exemption available; informational text.
 *        • Placeholder text kept at PAPER_QUATERNARY (rgba(26,22,18,
 *          0.45), 2.95:1 on white) under WCAG 2.2 incidental
 *          exemption — every input has a visible label above it.
 *        • Disabled Confirm text kept at rgba(26,22,18,0.35) (2.17:1
 *          on PAPER_TINT_1) under WCAG 1.4.3 inactive-UI exemption.
 *      All other surfaces (PAPER_INK on PAPER_TINT_1 / on white,
 *      title shades, banner reuse) clear AA with margin.
 *
 *  10. Request-changes CTA rebalanced (Option C). In the per-recipient
 *      pending-state action area, the two buttons swap visual order:
 *      Request changes renders first (left on desktop, top on mobile),
 *      Approve second. Request changes also moves off the ghost outline
 *      onto a soft amber fill via new CTA_AMBER_* tokens (bg #F7E4BE,
 *      border #E6C57C, text #5C3406, with hover / pressed shades); the
 *      Approve button keeps its teal styling unchanged. A small uppercase
 *      mono "Request changes or approve" lead-in label is rendered above
 *      the button row in PAPER_SECONDARY, framed the same way as the
 *      adjacent "Heads up" earlier-version warning eyebrow. The intent
 *      is to make requesting changes feel like a welcome, legitimate
 *      choice rather than a reluctant escape hatch. CTA_GHOST_* tokens
 *      stay in use for the Cancel and request-changes Confirm buttons
 *      inside the action modal further down the page.
 *
 *   9. Coral → brand blue migration on the changes-requested family.
 *      Coral (rgba(229,114,49,X) + #a04116 / #7c2d12) was off-brand;
 *      the logomark blue #3a2c91 (RGB 58,44,145) ties to brand. Every
 *      changes-requested surface adopts the same pale-tint twin
 *      treatment the approve banner uses post-deviation #7:
 *        • Confirmed changes-requested banner: rgba(58,44,145,0.18)
 *          bg + 1px rgba(58,44,145,0.4) border + #3a2c91 text. Visual
 *          twin to the approve banner.
 *        • Optimistic-changes banner: rgba(58,44,145,0.14) bg +
 *          rgba(58,44,145,0.45) border + #3a2c91 text. Twin to
 *          optimistic-approve. Bumped from the original 0.12 alpha
 *          to 0.14 for direct alpha symmetry with the green path.
 *        • Modal title (request-changes flow): #3a2c91 on PAPER_TINT_1.
 *        • Required-field asterisks (* on Your name + What changes):
 *          #3a2c91.
 *        • Form-error text in the modal: #3a2c91. (Error feedback
 *          loses its red signal in this migration; the trade-off is
 *          page-wide brand cohesion. The error condition is still
 *          conveyed by message text + position above the buttons.)
 *      One brand-blue text shade #3a2c91 covers every site at
 *      7.6–8.7:1 — no second-shade variant needed since none of the
 *      changes-requested surfaces use a deep saturated alpha pattern.
 *      No carried-changes equivalent (carried only applies to the
 *      approved-then-rolled-forward path).
 *
 * Clarity corrections (not README deviations — copy improvements
 * surfaced during real-cursor review):
 *
 *   • MaterialOptionTabs surcharge suffix renders "From +£X" rather
 *     than the bare "+£X". The data field is `surchargeFromPrice`
 *     (already conceptualised as a starting price by the data layer);
 *     the bare suffix read as a flat add-on, but surcharges scale
 *     with quantity.
 */

// ── Surface tokens ───────────────────────────────────────────
export const INK = '#141210'
export const PAPER_CREAM = '#fefdfa'
export const PAPER_TINT_1 = '#f5f3ee'
export const PAPER_TINT_2 = '#f3f0e8'
// Lifted cards in inactive states on tinted bands (PAPER_TINT_1).
// A deeper cream than PAPER_CREAM so a three-tone hierarchy is
// possible: tinted band → cream-dim inactive cards → pure white
// active card. See deviation #3 (timeline rows).
export const PAPER_CARD_DIM = '#f8f6f0'

// ── Text on paper ────────────────────────────────────────────
// Ink-on-cream stack per docs/handoff/proof-viewer-b/README.md
// §"Visual Language → Design Tokens" lines 117-122.
export const PAPER_INK = '#1a1612'
export const PAPER_SECONDARY = 'rgba(26,22,18,0.75)'
export const PAPER_TERTIARY = 'rgba(26,22,18,0.55)'
export const PAPER_QUATERNARY = 'rgba(26,22,18,0.45)'
export const PAPER_BORDER = 'rgba(26,22,18,0.12)'
export const PAPER_HAIRLINE = 'rgba(26,22,18,0.10)'

// ── Accent + brand ───────────────────────────────────────────
export const ACCENT = '#7b3ff2'
export const ACCENT_GLOW = 'rgba(123,63,242,0.55)'
export const APPROVED_GREEN = '#51b494'
export const BRAND_ORDER = ['#e11735', '#d81c7e', '#4a21a6', '#3ba58a'] as const

// ── CTA palette ──────────────────────────────────────────────
// Primary teal + ghost-on-paper variants per Section 6b.
export const CTA_TEAL = '#1D9E75'
export const CTA_TEAL_HOVER = '#0F6E56'
export const CTA_TEAL_PRESSED = '#0a5244'
export const CTA_TEAL_RING = 'rgba(29,158,117,0.5)'
export const CTA_GHOST_BORDER = '#2C2C2A'
export const CTA_GHOST_TEXT = '#2C2C2A'
export const CTA_GHOST_BG = 'transparent'
export const CTA_GHOST_HOVER_BG = 'rgba(0,0,0,0.04)'
export const CTA_GHOST_PRESSED_BG = 'rgba(0,0,0,0.08)'
export const CTA_GHOST_HOVER_BORDER = '#2C2C2A'
// Soft amber fill for the Request changes CTA — see deviation #10.
// Same layout footprint as the ghost variant, only colours change.
export const CTA_AMBER_BG = '#F7E4BE'
export const CTA_AMBER_HOVER_BG = '#F1D9A8'
export const CTA_AMBER_PRESSED_BG = '#EACF94'
export const CTA_AMBER_BORDER = '#E6C57C'
export const CTA_AMBER_HOVER_BORDER = '#D9B461'
export const CTA_AMBER_TEXT = '#5C3406'

// ── Type stacks ──────────────────────────────────────────────
// Geist Mono powers MONO — used by PaperPricingTable +
// QuantityLookup for numeric values. Chosen over JetBrains
// Mono because Geist's zero is a plain undecorated oval; the
// JetBrains dotted-zero glyph was being mistaken for an 8 at
// the smaller weights used in the price grid.
// Red Hat Mono lives behind the `font-paper-mono` Tailwind
// utility in src/index.css and is used elsewhere for uppercase
// section labels (no numerals), so the dotted-zero concern
// doesn't reach it.
export const SERIF = "'Cormorant Garamond', Georgia, serif"
export const SANS = "'Inter Tight', system-ui, sans-serif"
export const MONO = "'Geist Mono', ui-monospace, monospace"
