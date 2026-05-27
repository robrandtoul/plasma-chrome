import { useState } from 'react'
import { Layers, Plus, Send, Upload, X, Pencil } from 'lucide-react'

import {
  ButtonInk,
  ButtonCoral,
  ButtonGhost,
  CurrencyAmount,
  Eyebrow,
  Field,
  InkSwatch,
  Input,
  LetterpressMotif,
  Num,
  PanelShell,
  Pill,
  PlasmaWordmark,
  ProofStatusPill,
  StatusRule,
  Textarea,
  tokens,
  useEscape,
  type ProofStatus,
} from './index'

// Showcase page for the reskin shared primitives (PR 2). Lives behind
// the /__design route, which is mounted in App.tsx only when the dev
// flag is on. Designed so Rob (and Claude) can eyeball every primitive
// against the spec without spinning up the full app shell.
export default function DesignDemo() {
  const [overlayOpen, setOverlayOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [errorDemo, setErrorDemo] = useState(true)

  useEscape(() => setOverlayOpen(false))

  const statuses: ProofStatus[] = ['in_progress', 'approved', 'dormant', 'abandoned']
  const inks = [
    { name: 'Pillarbox red', hex: '#cf1f2e' },
    { name: 'Goldenrod', hex: '#dab040' },
    { name: 'Hunter green', hex: '#1f5a3b' },
    { name: 'Slate', hex: '#3a4b5a' },
  ]

  return (
    <div className="min-h-screen bg-canvas text-ink py-12">
      <div className="max-w-[1180px] mx-auto px-6 space-y-10">
        <header className="flex items-end justify-between gap-6 pb-6 border-b border-line">
          <div>
            <Eyebrow>01 Reskin primitives</Eyebrow>
            <h1 className="h-display mt-2">Design system smoke test</h1>
            <p className="body-soft mt-3 max-w-prose">
              Every primitive shipped in PR&nbsp;2, in its variants. Open
              this page after rebuilding the design tokens to confirm
              fonts, colours, focus rings, and pills land correctly.
            </p>
          </div>
          <PlasmaWordmark size="lg" tagline="Reskin" />
        </header>

        <PanelShell eyebrow="01" title="Buttons" count={6} icon={Send} accent={tokens.brand}>
          <div className="flex flex-wrap items-center gap-3">
            <ButtonInk icon={Plus}>New proof</ButtonInk>
            <ButtonCoral icon={Send}>Request changes</ButtonCoral>
            <ButtonGhost icon={Pencil}>Edit version</ButtonGhost>
            <ButtonGhost icon={X} size="sm">
              Cancel
            </ButtonGhost>
            <ButtonInk busy={busy} onClick={() => { setBusy(true); setTimeout(() => setBusy(false), 1500) }}>
              {busy ? 'Saving' : 'Save (click)'}
            </ButtonInk>
            <ButtonInk disabled>Disabled</ButtonInk>
          </div>
        </PanelShell>

        <PanelShell eyebrow="02" title="Proof status pills" count={4} icon={Layers}>
          <div className="flex flex-wrap items-center gap-3">
            {statuses.map((s) => (
              <ProofStatusPill key={s} status={s} />
            ))}
            <ProofStatusPill status="approved" label="Approved on 27 May" />
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Pill colour="brand">Custom quote</Pill>
            <Pill colour="allocated">Variant round</Pill>
            <Pill colour="low">Awaiting customer</Pill>
            <Pill colour="in-stock">Approved</Pill>
            <Pill colour="critical">Cannot supply</Pill>
            <Pill colour="mute">Snoozed</Pill>
          </div>
        </PanelShell>

        <PanelShell eyebrow="03" title="Status rule" icon={Layers} accent={tokens.allocated}>
          <div className="space-y-2">
            {[tokens.brand, tokens.inStock, tokens.allocated, tokens.low, tokens.out, tokens.inkDim].map((c, i) => (
              <div key={i} className="relative bg-surface border border-line rounded-[10px] pl-[18px] pr-3 py-3">
                <StatusRule colour={c} />
                <div className="text-sm text-ink-soft">Row with a status rule painted in {c}</div>
              </div>
            ))}
          </div>
        </PanelShell>

        <PanelShell eyebrow="04" title="Form fields" icon={Pencil}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-2xl">
            <Field label="Customer name" hint="Full name as printed on the proof">
              <Input placeholder="Eve Carter" />
            </Field>
            <Field label="Order quantity" htmlFor="qty-input">
              <Input id="qty-input" type="number" placeholder="100" />
            </Field>
            <Field
              label="Email address"
              error={errorDemo ? 'Please enter a valid email' : undefined}
              hint={errorDemo ? undefined : "We'll only use this for proofing"}
            >
              <Input invalid={errorDemo} defaultValue="not-an-email" />
            </Field>
            <Field label="Quantity (small)">
              <Input size="sm" defaultValue="100" />
            </Field>
            <Field label="Disabled field" hint="Locked at version creation">
              <Input defaultValue="GBP" disabled />
            </Field>
            <Field label="Change notes" hint="Shown to the customer">
              <Textarea placeholder="Anything they should know about this round?" />
            </Field>
            <div className="col-span-full">
              <ButtonGhost size="sm" onClick={() => setErrorDemo((v) => !v)}>
                Toggle error-state demo
              </ButtonGhost>
            </div>
          </div>
        </PanelShell>

        <PanelShell eyebrow="05" title="Ink swatches" icon={Layers}>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            {inks.map((ink) => (
              <InkSwatch key={ink.hex} ink={ink} showLabel />
            ))}
            <div className="flex items-center gap-2 pl-4 border-l border-line-soft">
              {inks.map((ink) => (
                <InkSwatch key={ink.hex + 'sq'} ink={ink} />
              ))}
            </div>
          </div>
        </PanelShell>

        <PanelShell eyebrow="06" title="Currency amounts" icon={Layers}>
          <div className="flex flex-wrap items-baseline gap-6">
            <CurrencyAmount amount={89} size="sm" />
            <CurrencyAmount amount={249} />
            <CurrencyAmount amount={1499} size="lg" />
            <CurrencyAmount amount={12450} size="xl" />
            <CurrencyAmount amount={12.5} currency="EUR" size="lg" />
            <CurrencyAmount amount={9999} currency="USD" size="lg" />
          </div>
        </PanelShell>

        <PanelShell eyebrow="07" title="Numeric specimens" icon={Layers}>
          <div className="flex flex-wrap items-baseline gap-6 text-ink">
            <Num size="sm">128</Num>
            <Num size="md">256</Num>
            <Num size="xl">1,024</Num>
            <Num size="2xl">2,048</Num>
            <Num size="3xl">4,096</Num>
          </div>
        </PanelShell>

        <section className="relative overflow-hidden bg-ink text-on-ink rounded-[14px] p-10">
          <LetterpressMotif />
          <div className="relative">
            <Eyebrow style={{ color: 'rgba(255,255,255,0.6)' }}>08 Ink-filled panel</Eyebrow>
            <h2 className="font-display text-[36px] font-medium tracking-[-0.02em] mt-2">
              Letterpress motif
            </h2>
            <p className="body-soft mt-3 max-w-prose" style={{ color: 'rgba(255,255,255,0.78)' }}>
              The decorative three-line motif sits above this paragraph at 18% opacity, 15° rotation. Used on the
              login brand panel and the customer-page sign-off card.
            </p>
          </div>
        </section>

        <PanelShell eyebrow="09" title="Escape-key overlay" icon={X}>
          <ButtonGhost icon={Upload} onClick={() => setOverlayOpen(true)}>
            Open overlay
          </ButtonGhost>
          {overlayOpen && (
            <div
              className="fixed inset-0 z-50 bg-ink/40 flex items-center justify-center p-6"
              onClick={() => setOverlayOpen(false)}
            >
              <div
                className="bg-surface border border-line rounded-[14px] p-6 max-w-md w-full"
                onClick={(e) => e.stopPropagation()}
              >
                <Eyebrow>Modal demo</Eyebrow>
                <h3 className="font-display text-xl font-medium mt-1">Press Esc to close</h3>
                <p className="body-soft mt-3">
                  This overlay uses the <code className="code">useEscape</code> hook. Tap outside or hit Escape to dismiss.
                </p>
                <div className="mt-5 flex justify-end gap-2">
                  <ButtonGhost size="sm" onClick={() => setOverlayOpen(false)}>
                    Close
                  </ButtonGhost>
                </div>
              </div>
            </div>
          )}
        </PanelShell>
      </div>
    </div>
  )
}
