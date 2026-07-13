import { useState } from 'react'
import { Layers, Plus, Send, Upload, X, Pencil } from 'lucide-react'

import {
  ButtonInk,
  ButtonCoral,
  ButtonGhost,
  CurrencyAmount,
  Eyebrow,
  Field,
  HelpTip,
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
import { tagHelp } from '../lib/tagHelp'
import FollowUpPipelinePanel, {
  type PipelineProjectRow,
} from '../components/FollowUpPipelinePanel'

// Fixture rows for the Follow-up pipeline showcase — one or two projects in
// every stage, with the customer-signal timestamps exercising each badge.
function pipelineDemo(): { rows: PipelineProjectRow[]; automation: Record<string, { repeat_days?: number; max_nudges?: number }> } {
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()
  const base: Omit<PipelineProjectRow, 'proof_id' | 'contact_name' | 'company_name'> = {
    material_display: 'Stainless Steel',
    current_version_number: 1,
    rule_code: null,
    rule_meta: null,
    follow_up_rule_code: 'sent_never_viewed',
    follow_up_sent_count: 0,
    follow_up_max_nudges: 3,
    follow_up_last_sent_at: null,
    current_version_viewed_at: null,
    helpscout_last_customer_reply_at: null,
    latest_non_view_event_at: null,
    latest_non_view_event_type: null,
  }
  return {
    automation: {
      sent_never_viewed: { repeat_days: 3, max_nudges: 3 },
      viewed_not_actioned: { repeat_days: 3, max_nudges: 3 },
    },
    rows: [
      { ...base, proof_id: 'demo-1', contact_name: 'Ada Lovelace', company_name: 'Analytical Engines' },
      {
        ...base, proof_id: 'demo-2', contact_name: 'Grace Hopper', company_name: 'Flowmatic Ltd',
        follow_up_sent_count: 1, follow_up_last_sent_at: daysAgo(1),
      },
      {
        ...base, proof_id: 'demo-3', contact_name: 'Alan Turing', company_name: 'Bletchley & Co',
        follow_up_rule_code: 'viewed_not_actioned', material_display: 'Wood',
        follow_up_sent_count: 1, follow_up_last_sent_at: daysAgo(2),
        current_version_viewed_at: daysAgo(1),
      },
      {
        ...base, proof_id: 'demo-4', contact_name: 'Katherine Johnson', company_name: 'Orbital Mechanics',
        follow_up_rule_code: 'viewed_not_actioned', current_version_number: 2,
        follow_up_sent_count: 2, follow_up_last_sent_at: daysAgo(4),
        helpscout_last_customer_reply_at: daysAgo(1),
      },
      {
        ...base, proof_id: 'demo-5', contact_name: 'Tim Berners-Lee', company_name: 'Hypertext Print',
        follow_up_sent_count: 3, follow_up_last_sent_at: daysAgo(2),
      },
      {
        ...base, proof_id: 'demo-6', contact_name: 'Margaret Hamilton', company_name: 'Apollo Cards',
        rule_code: 'nudges_exhausted', rule_meta: { sent: 3 },
        follow_up_rule_code: null, follow_up_sent_count: null,
        follow_up_max_nudges: null, follow_up_last_sent_at: null,
      },
    ],
  }
}

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

        <PanelShell eyebrow="02b" title="Help tooltips" icon={Layers} accent={tokens.allocated}>
          <p className="body-soft mb-4 max-w-prose">
            Hover or tab to a tagged label to see its plain-English meaning,
            pulled from <span className="code">tagHelp</span>. Three affordances:
            a dotted underline for text labels, a faint ring for filled chips,
            or none.
          </p>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3 text-[13px] text-ink-soft">
            <span>
              Status:{' '}
              <HelpTip body={tagHelp('needs', 'sent_never_viewed')}>never opened</HelpTip>
            </span>
            <span>
              Outbox:{' '}
              <HelpTip body={tagHelp('outbox', 'skipped_cooldown')}>too soon since the last touch</HelpTip>
            </span>
            <HelpTip body={tagHelp('outbox', 'fresh_conversation')} affordance="ring">
              <span className="inline-flex items-center rounded-md bg-allocated-soft px-1.5 py-0.5 text-[10px] font-semibold text-allocated">
                fresh conversation
              </span>
            </HelpTip>
            <HelpTip body={tagHelp('system', 'live')} affordance="ring">
              <span className="inline-flex items-center rounded-md bg-in-stock-soft px-2 py-0.5 text-[10px] font-semibold text-in-stock">
                live
              </span>
            </HelpTip>
            <HelpTip body={tagHelp('bucket', 'snoozed')} affordance="none">
              <Pill colour="mute">Snoozed</Pill>
            </HelpTip>
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

        {/* Follow-up pipeline (Admin → Follow-ups) in fixture mode — no
            network, so the composite can be eyeballed here without auth.
            Dates are computed relative to now so the "sent Nd ago / next ~"
            copy stays realistic. */}
        <section className="space-y-3">
          <Eyebrow>10 Follow-up pipeline (fixture data)</Eyebrow>
          <FollowUpPipelinePanel demo={pipelineDemo()} />
        </section>
      </div>
    </div>
  )
}
