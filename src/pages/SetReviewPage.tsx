// /set/:id?token=… — the customer review front door for a proof SET
// (bundle orders Slice 3, docs/bundle-orders-spec.md §4/§14.2).
//
// One link opens a design-review overview of the whole set: each card with a
// preview, recipient and approval status, plus a "Your progress" card
// tracking X of N approved. It is a HUB, not a re-implementation of the
// proof page — every card links into its existing /p/:id page, where the
// real review, price matrix and approve action already live.
//
// HARD RULES (spec §4, Rob was firm):
//   * NO pricing anywhere on this page. Pricing lives on each card's own
//     proof page.
//   * NO "order / payment / delivery" language — the design phase must not
//     presume the sale. No pay button, no basket.
//   * It ends at approval: when every card is approved, a warm completion
//     state — the combined pay link is Slice 2, sent later and separately.
//
// Data flows through the token-gated SECURITY DEFINER RPC public_get_proof_set
// (migration 000311) — same posture as the group pay page. Preview images are
// signed by the existing customer-proof-images edge function, called once per
// member card (the proof UUID is the access token, exactly as on /p/:id).

import { useEffect, useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { ArrowRight, CheckCircle2, Circle, PencilLine } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { customerProofPath, customerProofPathFromBundle } from '../lib/customerProofUrl'
import { CustomerHeader } from '../components/CustomerHeader'
import { LoadingProofAnimation } from '../components/LoadingProofAnimation'

// ── Payload shapes (public_get_proof_set, migration 000311) ─────────────────

interface SetInfo {
  id: string
  currency: string | null
  sent_at: string | null
  created_at: string
}

interface MemberProof {
  id: string
  status: 'in_progress' | 'approved' | 'dormant' | 'abandoned'
  approved_at: string | null
  set_discarded_at: string | null
  created_at: string
  current_version_id: string | null
  version_number: number | null
  names: string[] | null
  material_display: string | null
  shape: string | null
}

interface SetPayload {
  set: SetInfo
  company_name: string | null
  contact_name: string | null
  proofs: MemberProof[]
}

// A member card's place in the review journey. "aside" means the card is
// out of the active checklist, quietly and without drama — a designer
// abandon (how a dropped card is handled since the self-serve discard was
// removed, 10 Jul) or a legacy set_discarded_at stamp.
type CardState = 'approved' | 'review' | 'designing' | 'aside'

function cardState(p: MemberProof): CardState {
  if (p.set_discarded_at || p.status === 'abandoned') return 'aside'
  if (p.status === 'approved') return 'approved'
  if (!p.current_version_id) return 'designing'
  return 'review'
}

// Every card shares one anatomy so the overview scans consistently:
// eyebrow (Card N of M) · TITLE = the material (a set is one card per
// material, so it's the natural axis) · SUBTITLE = who or what it's for.
// Before this, a recipients card led with people and a shared-design card
// led with its material — two different grammars side by side.
function cardTitle(p: MemberProof): string {
  if (p.material_display?.trim()) return p.material_display
  const names = (p.names ?? []).filter((n) => n.trim().length > 0)
  if (names.length > 0) return names.join(' & ')
  return 'New card design'
}

function cardSubtitle(p: MemberProof): string | null {
  const names = (p.names ?? []).filter((n) => n.trim().length > 0)
  if (names.length > 0) {
    // Names double as the title when there's no material yet.
    return p.material_display?.trim() ? names.join(' & ') : null
  }
  if (p.shape === 'set_single') return 'One shared design'
  if (p.shape === 'set_collection') return 'A collection of designs'
  return null
}

export default function SetReviewPage() {
  const { id } = useParams<{ id: string }>()
  const [params] = useSearchParams()
  const token = params.get('token')
  const isPreview = params.get('preview') === '1'
  const { session } = useAuth()

  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [payload, setPayload] = useState<SetPayload | null>(null)
  // Preview image per member proof id (signed URL from customer-proof-images).
  const [previews, setPreviews] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!id || !token) {
      setNotFound(true)
      setLoading(false)
      return
    }
    let cancelled = false
    void (async () => {
      const { data, error } = await supabase.rpc('public_get_proof_set', {
        p_set_id: id,
        p_token: token,
      })
      if (cancelled) return
      if (error || data == null) {
        setNotFound(true)
        setLoading(false)
        return
      }
      setPayload(data as unknown as SetPayload)
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [id, token])

  // Stamp "customer opened the set page" — only for real customer visits
  // (not designer previews or signed-in staff), and the RPC itself ignores
  // the call until the set has been sent. Mirrors the pay pages' delay so a
  // bounce doesn't count.
  useEffect(() => {
    if (!id || !token || !payload || isPreview || session) return
    const t = setTimeout(() => {
      // .then makes the lazy builder actually execute (see teamChatStore's
      // stampSeen note) — mirrors record_order_pay_link_opened on OrderPayPage.
      void supabase
        .rpc('record_proof_set_opened', { p_set_id: id, p_token: token })
        .then(({ error }) => {
          if (error) console.error('[SetReviewPage] record open failed:', error.message)
        })
    }, 1500)
    return () => clearTimeout(t)
  }, [id, token, payload, isPreview, session])

  // Preview images: one customer-proof-images call per member card (the
  // same function /p/:id uses), keeping only the current version's first
  // non-QR artwork. Cards render immediately; images fill in as they sign.
  useEffect(() => {
    if (!payload) return
    let cancelled = false
    for (const p of payload.proofs) {
      if (!p.current_version_id) continue
      void supabase.functions
        .invoke<{ images: Array<{ proof_version_id: string; is_qr_code: boolean; signed_url: string }> }>(
          'customer-proof-images',
          { body: { proofId: p.id } },
        )
        .then(({ data }) => {
          if (cancelled || !data?.images) return
          const first = data.images.find(
            (img) => img.proof_version_id === p.current_version_id && !img.is_qr_code && img.signed_url,
          )
          if (first) setPreviews((prev) => ({ ...prev, [p.id]: first.signed_url }))
        })
        .catch(() => {
          /* imageless card is fine — never block the overview */
        })
    }
    return () => {
      cancelled = true
    }
  }, [payload])

  const members = useMemo(() => {
    if (!payload) return []
    return payload.proofs.map((p) => ({ ...p, state: cardState(p) }))
  }, [payload])

  const active = members.filter((m) => m.state !== 'aside')
  const approvedCount = active.filter((m) => m.state === 'approved').length
  const allApproved = active.length > 0 && approvedCount === active.length
  const asideCards = members.filter((m) => m.state === 'aside')

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-canvas bg-draftsman text-ink px-6">
        <LoadingProofAnimation />
      </div>
    )
  }

  if (notFound || !payload) {
    return (
      <div className="flex min-h-screen flex-col bg-canvas">
        <CustomerHeader innerClassName="max-w-5xl" />
        <div className="flex flex-1 items-center justify-center p-4">
          <div className="max-w-sm rounded-2xl bg-surface p-8 text-center shadow-sm ring-1 ring-line">
            <h1 className="text-lg font-semibold text-ink">Not found</h1>
            <p className="mt-2 text-sm text-ink-soft">
              This review link isn't valid. If you were sent here recently, please reply to the email
              you received and we'll sort it out.
            </p>
          </div>
        </div>
      </div>
    )
  }

  const companyProminent = (payload.company_name ?? '').trim().length > 0
  const primaryName = companyProminent ? payload.company_name! : payload.contact_name ?? 'your team'

  // Card links carry the bundle id + token so /p/:id can offer "Back to
  // your bundle" (see customerProofPathFromBundle for the access posture).
  // id/token are guaranteed non-null here — the loader bailed to notFound
  // without them.
  const cardHref = (proofId: string) =>
    id && token ? customerProofPathFromBundle(proofId, id, token) : customerProofPath(proofId)

  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <CustomerHeader innerClassName="max-w-5xl" />

      {isPreview && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-xs font-medium text-amber-900">
          Designer preview — the customer sees this page without this banner.
        </div>
      )}

      <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
        {/* Masthead — same company-prominent rule as the proof page. */}
        <header className="mb-10">
          <span className="eyebrow">Proofs for</span>
          <h1 className="h1 mt-3" style={{ fontSize: 'clamp(32px, 6vw, 48px)' }}>
            {primaryName}
          </h1>
          {companyProminent && payload.contact_name && (
            <p className="mt-1 text-sm text-ink-mute">{payload.contact_name}</p>
          )}
          <p className="body-soft mt-4 max-w-xl">
            {active.length === 1
              ? 'There is one card design in this bundle.'
              : `There are ${active.length} card designs in this bundle.`}{' '}
            Open each one to review it in full and approve it — this page keeps track as you go.
          </p>
        </header>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
          {/* ── The cards ─────────────────────────────────────────────── */}
          <div className="space-y-4">
            {active.map((m, i) => (
              <SetCard
                key={m.id}
                member={m}
                cardNumber={i + 1}
                cardCount={active.length}
                previewUrl={previews[m.id] ?? null}
                href={cardHref(m.id)}
              />
            ))}

            {asideCards.length > 0 && (
              <div className="space-y-4 pt-2">
                <p className="text-xs font-medium uppercase tracking-wide text-ink-mute">Set aside</p>
                {asideCards.map((m) => (
                  <SetCard key={m.id} member={m} previewUrl={previews[m.id] ?? null} href={cardHref(m.id)} />
                ))}
              </div>
            )}
          </div>

          {/* ── Your progress ─────────────────────────────────────────── */}
          <aside>
            <div className="rounded-2xl bg-surface p-6 shadow-sm ring-1 ring-line lg:sticky lg:top-24">
              <span className="eyebrow">Your progress</span>

              {allApproved ? (
                <div className="mt-4">
                  <div className="flex items-center gap-3">
                    <CheckCircle2 size={28} className="shrink-0 text-emerald-600" aria-hidden="true" />
                    <p className="text-lg font-semibold text-ink">All approved — thank you</p>
                  </div>
                  <p className="mt-3 text-sm text-ink-soft">
                    Every card in this bundle is approved. We'll follow up shortly to take it from here —
                    nothing more is needed from you right now.
                  </p>
                </div>
              ) : (
                <p className="mt-3 text-2xl font-semibold text-ink">
                  {approvedCount} of {active.length}
                  <span className="ml-2 text-sm font-normal text-ink-mute">approved</span>
                </p>
              )}

              <ul className="mt-5 space-y-2.5">
                {active.map((m) => (
                  <li key={m.id} className="flex items-start gap-2.5 text-sm">
                    {m.state === 'approved' ? (
                      <CheckCircle2 size={17} className="mt-0.5 shrink-0 text-emerald-600" aria-hidden="true" />
                    ) : m.state === 'designing' ? (
                      <PencilLine size={17} className="mt-0.5 shrink-0 text-ink-mute" aria-hidden="true" />
                    ) : (
                      <Circle size={17} className="mt-0.5 shrink-0 text-ink-mute" aria-hidden="true" />
                    )}
                    <div className="min-w-0">
                      <p className="truncate font-medium text-ink">{cardTitle(m)}</p>
                      <p className="text-xs text-ink-mute">
                        {m.state === 'approved'
                          ? 'Approved'
                          : m.state === 'designing'
                            ? 'Still being designed'
                            : 'Waiting for your review'}
                      </p>
                    </div>
                  </li>
                ))}
                {asideCards.map((m) => (
                  <li key={m.id} className="flex items-start gap-2.5 text-sm opacity-60">
                    <Circle size={17} className="mt-0.5 shrink-0 text-ink-mute" aria-hidden="true" />
                    <div className="min-w-0">
                      <p className="truncate font-medium text-ink line-through">{cardTitle(m)}</p>
                      <p className="text-xs text-ink-mute">Set aside</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}

// ── One card in the overview ─────────────────────────────────────────────────

function SetCard({
  member,
  cardNumber,
  cardCount,
  previewUrl,
  href,
}: {
  member: MemberProof & { state: CardState }
  // Position among the active cards ("Card 1 of 2"). Absent on set-aside
  // cards — their group heading already labels them.
  cardNumber?: number
  cardCount?: number
  previewUrl: string | null
  /** The card's /p/:id link, carrying the bundle back-link params. */
  href: string
}) {
  const title = cardTitle(member)
  const subtitle = cardSubtitle(member)
  const aside = member.state === 'aside'

  return (
    <section
      className={`rounded-2xl bg-surface p-4 shadow-sm ring-1 ring-line sm:p-5 ${aside ? 'opacity-60' : ''}`}
    >
      <div className="flex gap-4">
        {/* Artwork preview — fills in as the signed URL arrives. Contained,
            not cropped, so a business card is never beheaded. */}
        <div className="h-20 w-28 shrink-0 overflow-hidden rounded-lg bg-canvas ring-1 ring-line sm:h-24 sm:w-36">
          {previewUrl ? (
            <img src={previewUrl} alt={`Preview of ${title}`} className="h-full w-full object-contain p-1" />
          ) : (
            <div className="flex h-full w-full items-center justify-center px-2 text-center text-[10px] uppercase tracking-wide text-ink-mute">
              {member.state === 'designing' ? 'In design' : 'No preview yet'}
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          {/* One anatomy for every card: eyebrow · title · subtitle, with
              the status pill PINNED top-right (no wrap — a long title must
              never push it to a different place on a sibling card). */}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              {cardNumber != null && cardCount != null && (
                <p className="eyebrow text-ink-mute">
                  Card {cardNumber} of {cardCount}
                </p>
              )}
              <h2 className={`mt-0.5 text-base font-semibold text-ink ${aside ? 'line-through' : ''}`}>
                {title}
              </h2>
              {subtitle && <p className="mt-0.5 text-sm text-ink-soft">{subtitle}</p>}
            </div>
            <StateChip state={member.state} />
          </div>

          {/* The card's real review lives on its own proof page. */}
          {(member.state === 'review' || member.state === 'approved') && (
            <div className="mt-3">
              <Link
                to={href}
                className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink underline underline-offset-4 hover:opacity-80"
              >
                {member.state === 'approved' ? 'View this card' : 'Review this card'}
                <ArrowRight size={15} aria-hidden="true" />
              </Link>
            </div>
          )}
          {member.state === 'designing' && (
            <p className="mt-3 text-sm text-ink-mute">
              We're still working on this one — it'll appear here as soon as it's ready.
            </p>
          )}

          {/* No self-serve "decide against this card" here (removed 10 Jul,
              Rob's call): it read too much like "reject this version" and
              invited misuse for design feedback, which belongs in the card's
              change-request flow. A genuinely dropped card is handled by the
              designer abandoning that project — this page then shows it as
              set aside via cardState. proof-feedback's set_discard mode and
              the workspace Restore stay dormant behind this. */}
        </div>
      </div>
    </section>
  )
}

function StateChip({ state }: { state: CardState }) {
  const styles: Record<CardState, string> = {
    approved: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    review: 'bg-canvas text-ink-soft ring-line',
    designing: 'bg-canvas text-ink-mute ring-line',
    aside: 'bg-canvas text-ink-mute ring-line',
  }
  const labels: Record<CardState, string> = {
    approved: 'Approved',
    review: 'Ready to review',
    designing: 'Being designed',
    aside: 'Set aside',
  }
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${styles[state]}`}
    >
      {labels[state]}
    </span>
  )
}
