// Customer-facing QR code verification panel.
//
// Renders a dedicated PanelShell section above the spec summary for
// any proof version that has QR images. Customers see the original
// uploaded JPEG (not a re-render — what's on screen is the same
// artefact that gets printed) alongside a plain-English breakdown
// of what the QR encodes: a formatted contact card for vCards, a
// wifi-config panel for wifi strings, MeCard / URL / email / phone
// / sms / plain-text renderers for the rest.
//
// Grouping rules match the approval slot logic in
// _finalize_proof_if_complete (migration 000169):
//   * Named recipient (split-name proofs): one panel per name,
//     showing that name's QRs plus any shared QRs (associated_name
//     = null). Each recipient verifies whatever they'd see on
//     their own printed copy.
//   * Shared-only proofs (names empty): one merged panel with
//     every QR on the version.
//   * Variant rounds: QR rows are version-wide (round_variant_id is
//     never set on QR rows), so every QR renders in one flat list
//     regardless of which variant the customer is viewing.
//
// PHOTO fields are stripped at parse time (qrCodes.ts). vCard
// embedded photos make QRs too dense for letterpress / metal
// printing, so we never produce them.

import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { QrCode } from 'lucide-react'
import {
  classifyQrData,
  isShortenedUrl,
  parseMecard,
  parseVCard,
  parseWifi,
  type QrKind,
} from '../lib/qrCodes'
import {
  fetchVcardForSlug,
  type VcardBundle,
  VcardConfigError,
} from '../lib/vcardClient'
import { parseShortLink, summariseDestination } from '../lib/qrDestination'
import { PanelShell, tokens } from '../design'
import {
  QR_PANEL_INTRO_COPY_DEFAULT,
  QR_PANEL_VCARD_COPY_DEFAULT,
} from '../lib/publicSettings'
import type { GridImage } from './ImageGrid'

interface QrCodePanelProps {
  /**
   * QR rows for the version currently being viewed, already filtered
   * to is_qr_code = true. The customer page maintains this filter at
   * fetch time (see CustomerProofPage versionQrImages).
   */
  qrImages: GridImage[]
  /**
   * The version's recipient names. Empty for shared-only proofs.
   * Used to decide whether to render per-name accordions.
   */
  names: string[]
  /**
   * True when the version is a variant round. QR rows are not
   * variant-scoped (round_variant_id is never set on QR rows), so
   * the panel renders every QR flat in this case.
   */
  isVariantRound: boolean
  /** Optional classes for the panel root (e.g. responsive order-*). */
  className?: string
  /**
   * Admin-editable panel copy (migration 000200), threaded from the
   * customer page's public_settings fetch. Either may be null while
   * settings are still loading or when the column is empty; QrSection
   * falls back to the shipped defaults so the copy never blanks.
   */
  introCopy?: string | null
  vcardCopy?: string | null
}

// ── Plasma (qcrd.uk) card resolution ─────────────────────────────────
//
// A qcrd.uk QR encodes a token, not an address, and one slug space serves
// BOTH hosted vCards and plain redirects. Only the card row says which — so
// the badge, the contents and the standing instructions all have to wait for
// the same lookup, and must never be allowed to disagree about the answer.
// Resolving once here and handing the result down is what guarantees that.
//
// ⚠ Which QRs get resolved is decided by the PAYLOAD, not by the stored
// `qr_kind`. The same code reaches us two ways — pasted into the version
// form's vCard field (kind `hosted_vcard`, slug column set) or dropped in as
// an image and decoded (kind `url`, slug column null) — and the second is the
// common one. Keying on the kind is exactly the bug this replaces: the live
// SkyWalker Septic proof stored its code as `url`, so the destination view
// never ran and the customer was shown a bare qcrd.uk link.

type PlasmaCardState =
  | { kind: 'loading' }
  | { kind: 'loaded'; bundle: VcardBundle }
  | { kind: 'unavailable'; message: string }
  | { kind: 'not_found' }

/** The qcrd.uk slug this QR points at, from either storage path. */
function plasmaSlugForImage(image: GridImage): string | null {
  if (image.qr_vcard_slug) return image.qr_vcard_slug
  const short = parseShortLink(image.qr_decoded_data ?? '')
  return short?.kind === 'plasma' ? short.slug : null
}

/**
 * Resolve every distinct slug on the panel in one pass.
 *
 * Deliberately keyed on the whole set rather than fetched per card: a shared
 * QR renders once under every named recipient, so a per-card fetch asked the
 * vCard app for the same slug once per person on the proof.
 */
function usePlasmaCards(slugs: string[]): Map<string, PlasmaCardState> {
  // Join for a stable dependency — a fresh array each render would re-fetch
  // on every parent update. Comma is safe as the separator because a slug is
  // [a-zA-Z0-9-] only (the vCard app's own rule), so it can never contain one.
  const key = slugs.join(',')
  const [states, setStates] = useState<Map<string, PlasmaCardState>>(new Map())

  useEffect(() => {
    const list = key ? key.split(',') : []
    if (list.length === 0) {
      setStates(new Map())
      return
    }
    setStates(new Map(list.map((s) => [s, { kind: 'loading' } as PlasmaCardState])))
    let cancelled = false
    void (async () => {
      const entries = await Promise.all(
        list.map(async (slug): Promise<[string, PlasmaCardState]> => {
          try {
            const result = await fetchVcardForSlug(slug)
            if (result.ok) return [slug, { kind: 'loaded', bundle: result.data }]
            if (result.reason === 'not_found') return [slug, { kind: 'not_found' }]
            return [slug, { kind: 'unavailable', message: result.message ?? 'Lookup failed.' }]
          } catch (err) {
            // The page must never break because the vCard app is down; the
            // customer can still read the link and approve.
            const message =
              err instanceof VcardConfigError
                ? 'vCard app integration is not configured on this site.'
                : (err as Error).message
            return [slug, { kind: 'unavailable', message }]
          }
        }),
      )
      if (!cancelled) setStates(new Map(entries))
    })()
    return () => {
      cancelled = true
    }
  }, [key])

  return states
}

const PlasmaCardsContext = createContext<Map<string, PlasmaCardState>>(new Map())

export function QrCodePanel({ qrImages, names, isVariantRound, className, introCopy, vcardCopy }: QrCodePanelProps) {
  // Hooks before the early return — qrImages can legitimately be empty.
  const slugs = useMemo(() => {
    const seen = new Set<string>()
    for (const img of qrImages) {
      const slug = plasmaSlugForImage(img)
      if (slug) seen.add(slug)
    }
    return [...seen]
  }, [qrImages])
  const plasmaCards = usePlasmaCards(slugs)

  // The standing "For Plasma vCards, scanning saves the contact details to a
  // phone" note is only true of an actual vCard. On a redirect it is plainly
  // wrong, and it used to show on every proof with any QR at all — including
  // proofs with no Plasma code on them. Show it only once something on this
  // panel has resolved to a real contact card.
  const showVcardCopy = [...plasmaCards.values()].some(
    (s) => s.kind === 'loaded' && s.bundle.card.target_type !== 'external_url',
  )

  const section = (children: React.ReactNode) => (
    <PlasmaCardsContext.Provider value={plasmaCards}>
      <QrSection
        className={className}
        introCopy={introCopy}
        vcardCopy={showVcardCopy ? vcardCopy : null}
        showVcardCopy={showVcardCopy}
      >
        {children}
      </QrSection>
    </PlasmaCardsContext.Provider>
  )

  if (qrImages.length === 0) return null

  // Variant rounds: QR rows are version-wide (no round_variant_id on
  // QR rows), so we render every QR in one flat list. The
  // per-recipient grouping doesn't apply to variant rounds.
  if (isVariantRound) {
    return (
      section(
        <div className="space-y-6">
          {qrImages.map((img) => (
            <QrCodeCard key={img.id} image={img} />
          ))}
        </div>,
      )
    )
  }

  // Standard versions. If the proof has recipient names, group by
  // associated_name and render one panel per name (each panel shows
  // the recipient's own QRs followed by any shared QRs). If the
  // proof is shared-only (names is empty), render a single merged
  // panel.
  if (names.length === 0) {
    return (
      section(
        <div className="space-y-6">
          {qrImages.map((img) => (
            <QrCodeCard key={img.id} image={img} />
          ))}
        </div>,
      )
    )
  }

  const sharedQrs = qrImages.filter((img) => img.associated_name == null)
  const perRecipient = names.map((name) => ({
    name,
    qrs: qrImages.filter((img) => img.associated_name === name),
  }))

  // Suppress rendering entirely if there's nothing applicable to any
  // named recipient AND no shared QRs. The qrImages.length guard
  // above prevented an empty section, but post-filtering it's
  // possible to end up here with every row keyed to a name no
  // longer on the version (edge case during transitions).
  const hasAnyContent = perRecipient.some((r) => r.qrs.length > 0) || sharedQrs.length > 0
  if (!hasAnyContent) return null

  return (
    section(
      <div className="space-y-8">
        {perRecipient.map(({ name, qrs }) => {
          // Skip recipients with no QRs visible to them (no
          // own QRs, no shared QRs). Mostly only happens during
          // edits in flight.
          if (qrs.length === 0 && sharedQrs.length === 0) return null
          return (
            <div key={name}>
              <h3 className="font-display font-medium text-ink leading-tight pb-3 border-b border-line-soft text-[18px]">
                {name}'s QR codes
              </h3>
              <div className="mt-5 space-y-5">
                {qrs.map((img) => (
                  <QrCodeCard key={img.id} image={img} />
                ))}
                {sharedQrs.map((img) => (
                  <QrCodeCard
                    key={`${name}-${img.id}`}
                    image={img}
                    sharedLabel={true}
                  />
                ))}
              </div>
            </div>
          )
        })}
      </div>,
    )
  )
}

// ── Section wrapper ──────────────────────────────────────────────────

function QrSection({
  children,
  className,
  introCopy,
  vcardCopy,
  showVcardCopy = true,
}: {
  children: React.ReactNode
  className?: string
  introCopy?: string | null
  vcardCopy?: string | null
  /**
   * Whether the vCard note applies at all. It describes scanning saving
   * contact details to a phone, which is true of a hosted vCard and false of
   * a redirect — and it used to print on every proof carrying any QR, Plasma
   * or not. Defaults true so the standalone/legacy callers are unchanged.
   */
  showVcardCopy?: boolean
}) {
  // Admin-editable copy (migration 000200), with the shipped defaults
  // as the fallback so a null/loading/empty value never blanks the
  // instructions. Trim-guard mirrors publicSettings.ts.
  const intro = introCopy && introCopy.trim().length > 0 ? introCopy : QR_PANEL_INTRO_COPY_DEFAULT
  const vcard = vcardCopy && vcardCopy.trim().length > 0 ? vcardCopy : QR_PANEL_VCARD_COPY_DEFAULT
  return (
    <PanelShell
      eyebrow="Before approving"
      title="QR code contents"
      icon={QrCode}
      accent={tokens.brand}
      className={className}
    >
      {/* One-third / two-third split: the standing review
          instructions sit in the left column, the QR codes and their
          decoded contents in the right. Mirrors the Thickness /
          Material-notes two-column pattern, but weighted 1:2 so the
          codes get the room. Stacks to one column below md, in reading
          order (instructions first, then the codes). */}
      <div className="grid gap-6 md:gap-8 md:grid-cols-[1fr_2fr] md:items-start">
        <div className="space-y-4 min-w-0">
          <p className="text-[14px] leading-[1.6] text-ink-soft m-0 whitespace-pre-line">
            {intro}
          </p>
          {showVcardCopy && (
            <p className="text-[13px] leading-[1.55] text-ink-mute m-0 whitespace-pre-line">
              {vcard}
            </p>
          )}
        </div>
        <div className="min-w-0">{children}</div>
      </div>
    </PanelShell>
  )
}

// ── Per-QR card ──────────────────────────────────────────────────────

function QrCodeCard({
  image,
  sharedLabel = false,
}: {
  image: GridImage
  sharedLabel?: boolean
}) {
  // Prefer the row's stored qr_kind (set at upload time per the
  // CHECK constraint in 000168), but fall back to a live classify
  // pass if for some reason it's missing. Defensive: legacy or
  // partial-rollout rows shouldn't crash the page.
  const decoded = image.qr_decoded_data ?? ''
  const kind: QrKind = image.qr_kind ?? classifyQrData(decoded)

  // Resolved once for the whole panel; null for anything that isn't a
  // qcrd.uk code. Derived from the PAYLOAD, so it catches a Plasma link
  // however the row was stored — see the note on usePlasmaCards.
  const plasmaSlug = plasmaSlugForImage(image)
  const plasmaCards = useContext(PlasmaCardsContext)
  const plasmaState = plasmaSlug ? plasmaCards.get(plasmaSlug) : undefined

  return (
    <article className="grid gap-5 sm:grid-cols-[120px_1fr] rounded-[10px] bg-canvas border border-line p-5">
      <div>
        {image.signed_url ? (
          <img
            src={image.signed_url}
            alt="QR code"
            width={120}
            height={120}
            className="block w-full max-w-[120px] aspect-square object-contain bg-surface rounded-[6px] border border-line-soft"
          />
        ) : (
          // Edge-function signing failure — graceful empty box.
          // The decoded panel still renders so the customer can
          // verify the contents even without the visible QR.
          <div className="block w-full max-w-[120px] aspect-square bg-canvas border border-dashed border-line rounded-[6px]" />
        )}
        {sharedLabel && (
          <div className="eyebrow mt-2" style={{ letterSpacing: '0.16em', whiteSpace: 'normal', lineHeight: 1.5 }}>
            Shared across all cards
          </div>
        )}
      </div>
      <div className="min-w-0">
        <KindBadge kind={kind} plasmaState={plasmaState} />
        <div className="mt-3">
          {plasmaState ? (
            <PlasmaCardView state={plasmaState} url={decoded} />
          ) : (
            <DecodedContents kind={kind} data={decoded} />
          )}
        </div>
      </div>
    </article>
  )
}

// ── Kind badge ───────────────────────────────────────────────────────

const KIND_LABELS: Record<QrKind, string> = {
  vcard: 'Contact card',
  mecard: 'Contact card',
  url: 'Website link',
  wifi: 'Wifi network',
  email: 'Email address',
  phone: 'Phone number',
  sms: 'Text message',
  text: 'Plain text',
  hosted_vcard: 'Plasma vCard',
}

/**
 * The chip above each QR. For a qcrd.uk code the stored kind can't be trusted
 * to describe it: a redirect dropped in as an image stores as `url` ("Website
 * link" — true but uninformative), and a redirect pasted into the version
 * form's vCard field stores as `hosted_vcard`, which would badge a Google
 * search "Plasma vCard". So a Plasma code is labelled from the resolved card,
 * and reads the neutral "Plasma link" until the lookup lands or if it fails —
 * never a guess that later turns out wrong.
 */
function plasmaBadgeLabel(state: PlasmaCardState): string {
  if (state.kind !== 'loaded') return 'Plasma link'
  return state.bundle.card.target_type === 'external_url' ? 'Plasma link' : 'Plasma vCard'
}

function KindBadge({ kind, plasmaState }: { kind: QrKind; plasmaState?: PlasmaCardState }) {
  return (
    <span className="inline-flex items-center rounded-full bg-line-soft text-ink-soft px-2.5 py-1 eyebrow" style={{ letterSpacing: '0.14em' }}>
      {plasmaState ? plasmaBadgeLabel(plasmaState) : KIND_LABELS[kind]}
    </span>
  )
}

// ── Decoded contents dispatcher ──────────────────────────────────────

/**
 * Renders anything that ISN'T a Plasma (qcrd.uk) code — those are routed to
 * PlasmaCardView by QrCodeCard before this is reached, keyed on the payload
 * rather than the stored kind, so `hosted_vcard` never arrives here.
 */
function DecodedContents({ kind, data }: { kind: QrKind; data: string }) {
  switch (kind) {
    case 'hosted_vcard':
      // Only reachable if the row claims hosted_vcard but its payload isn't a
      // qcrd.uk link at all — a corrupt or hand-edited row. Show the raw URL
      // rather than an empty panel.
      return <UrlView raw={data} />
    case 'vcard':
      return <VCardView raw={data} />
    case 'mecard':
      return <MecardView raw={data} />
    case 'wifi':
      return <WifiView raw={data} />
    case 'url':
      return <UrlView raw={data} />
    case 'email':
      return <SimpleLineView label="Sends an email to" value={stripPrefix(data, 'mailto:')} />
    case 'phone':
      return <SimpleLineView label="Calls" value={stripPrefix(data, 'tel:')} />
    case 'sms':
      return <SmsView raw={data} />
    case 'text':
    default:
      return <RawTextView raw={data} />
  }
}

function stripPrefix(input: string, prefix: string): string {
  const lower = input.toLowerCase()
  if (lower.startsWith(prefix)) return input.slice(prefix.length)
  return input
}

// ── Type-specific renderers ──────────────────────────────────────────

function VCardView({ raw }: { raw: string }) {
  const v = parseVCard(raw)
  return (
    <div className="space-y-3">
      {v.formattedName && (
        <div className="font-display text-ink leading-tight" style={{ fontSize: 20 }}>
          {v.formattedName}
        </div>
      )}
      {(v.title || v.org) && (
        <div className="text-[14px] leading-[1.45] text-ink-soft">
          {[v.title, v.org].filter(Boolean).join(' · ')}
        </div>
      )}
      {v.tels.length > 0 && (
        <FieldGroup label="Phone">
          {v.tels.map((tel, i) => (
            <div key={i}>
              <span className="font-mono text-ink">{tel.value}</span>
              {tel.types.length > 0 && (
                <span className="ml-2 eyebrow" style={{ letterSpacing: '0.14em' }}>
                  {tel.types.map((t) => t.toLowerCase()).join(', ')}
                </span>
              )}
            </div>
          ))}
        </FieldGroup>
      )}
      {v.emails.length > 0 && (
        <FieldGroup label="Email">
          {v.emails.map((em, i) => (
            <div key={i}>
              <span className="font-mono text-ink">{em.value}</span>
              {em.types.length > 0 && (
                <span className="ml-2 eyebrow" style={{ letterSpacing: '0.14em' }}>
                  {em.types.map((t) => t.toLowerCase()).join(', ')}
                </span>
              )}
            </div>
          ))}
        </FieldGroup>
      )}
      {v.urls.length > 0 && (
        <FieldGroup label="Website">
          {v.urls.map((url, i) => (
            <div key={i} className="font-mono text-ink break-all">
              {url}
              {isShortenedUrl(url) && <ShortenedBadge />}
            </div>
          ))}
        </FieldGroup>
      )}
      {v.addresses.length > 0 && (
        <FieldGroup label="Address">
          {v.addresses.map((addr, i) => (
            <div key={i} className="text-ink">{addr}</div>
          ))}
        </FieldGroup>
      )}
      {v.note && <FieldGroup label="Note">{v.note}</FieldGroup>}
      <RawDataDisclosure raw={raw} extraRawLines={v.rawOtherLines} />
    </div>
  )
}

// ── PlasmaCardView ──────────────────────────────────────────────────
//
// A qcrd.uk QR encodes a short URL only, so the customer can verify
// nothing from the payload itself. One slug space serves two products:
// a hosted vCard (render the contact fields) and a plain redirect
// (render where it lands). Only the card row says which, so this is
// presentation-only — the lookup happens once for the whole panel in
// usePlasmaCards, which is what stops the badge, these contents and the
// standing instructions disagreeing, and stops a shared QR being
// fetched once per named recipient.
//
// Styling fields (photo, cover, accent, font) are intentionally not
// shown — they're the customer's job to personalise after the cards
// arrive.
//
// If the vCard app is unreachable (network error, env vars missing,
// CORS, anything), the panel degrades gracefully: it shows the URL,
// a quiet "contact details are temporarily unavailable" line, and
// the QR-confirmation tick above the Approve button still works.
// The customer can always re-open the page later if they want to
// re-verify.

function PlasmaCardView({ state, url }: { state: PlasmaCardState; url: string }) {
  // URL row is always shown, regardless of state — it's what the QR
  // literally encodes and the customer should always be able to read
  // the destination back to themselves.
  const urlLine = (
    <FieldGroup label="QR link">
      <span className="font-mono text-ink break-all">{url}</span>
    </FieldGroup>
  )

  if (state.kind === 'loading') {
    return (
      <div className="space-y-3">
        {urlLine}
        <div className="text-[13px] text-ink-mute">
          Loading the contact details for this Plasma vCard…
        </div>
      </div>
    )
  }

  if (state.kind === 'not_found') {
    return (
      <div className="space-y-3">
        {urlLine}
        <div className="text-[13px] text-ink-mute">
          We couldn't find a Plasma card for this code. It may simply not have
          been published yet — or the code may be wrong, in which case scanning
          it would reach a "not found" page. Worth checking with us before you
          approve.
        </div>
      </div>
    )
  }

  if (state.kind === 'unavailable') {
    return (
      <div className="space-y-3">
        {urlLine}
        <div className="text-[13px] text-ink-mute">
          The contact details for this Plasma vCard are temporarily
          unavailable. Try refreshing this page; you can still approve
          once you've reviewed the link above.
        </div>
      </div>
    )
  }

  const { card, links, contactMethods } = state.bundle

  // A qcrd.uk link can be a hosted vCard OR a plain redirect — one slug space
  // serves both, and only the card row says which. A redirect has no contact
  // details to check, so rendering the vCard view here would show a panel of
  // empty fields. What the customer actually needs to verify is where it lands:
  // the printed code is an opaque token, so this is the only place they can
  // see that it points at their review page and not somebody else's.
  if (card.target_type === 'external_url') {
    const dest = (card.external_url ?? '').trim()
    if (!dest) {
      return (
        <div className="space-y-3">
          {urlLine}
          <div className="text-[13px] text-ink-mute">
            This QR opens a web page, but no address has been set for it yet.
          </div>
        </div>
      )
    }
    const summary = summariseDestination(dest)
    return (
      <div className="space-y-3">
        {urlLine}
        <FieldGroup label="Goes to">
          <span className="text-ink break-words">{summary.label}</span>
          {summary.droppedVolatile > 0 && (
            <div className="text-[12px] text-ink-mute">
              plus {summary.droppedVolatile} tracking{' '}
              {summary.droppedVolatile === 1 ? 'parameter' : 'parameters'}
            </div>
          )}
        </FieldGroup>
        {/* The full address is available but folded away — these links routinely
            run to a thousand characters of tracking, and pasting that wall in
            front of someone makes the destination harder to check, not easier. */}
        <details className="text-[12px] text-ink-mute">
          <summary className="cursor-pointer select-none">Show the full web address</summary>
          <span className="mt-1 block break-all font-mono text-ink-soft">{summary.full}</span>
        </details>
        {card.status !== 'live' && (
          <div className="text-[13px] text-ink-mute">
            This link isn't live yet — it will start working once the card is published.
          </div>
        )}
      </div>
    )
  }

  const formattedName =
    [card.first_name, card.last_name].filter(Boolean).join(' ').trim() ||
    card.nickname ||
    null
  const titleLine = [card.job_title, card.company].filter(Boolean).join(' · ')
  const addressLine = [
    card.address_street,
    card.address_city,
    card.address_region,
    card.address_postcode,
    card.address_country,
  ]
    .map((p) => (p ?? '').trim())
    .filter(Boolean)
    .join(', ')
  const extraEmails = contactMethods.filter((m) => m.method_type === 'email')
  const extraPhones = contactMethods.filter((m) => m.method_type === 'phone')

  return (
    <div className="space-y-3">
      {formattedName && (
        <div className="font-display text-ink leading-tight" style={{ fontSize: 20 }}>
          {formattedName}
        </div>
      )}
      {card.nickname && formattedName && card.nickname !== formattedName && (
        <div className="text-[13px] text-ink-soft">Also known as {card.nickname}</div>
      )}
      {titleLine && (
        <div className="text-[14px] leading-[1.45] text-ink-soft">{titleLine}</div>
      )}
      {card.primary_phone && (
        <FieldGroup label="Phone">
          <div>
            <span className="font-mono text-ink">{card.primary_phone}</span>
            {card.phone_label && (
              <span className="ml-2 eyebrow" style={{ letterSpacing: '0.14em' }}>
                {card.phone_label}
              </span>
            )}
          </div>
          {extraPhones.map((p) => (
            <div key={p.id}>
              <span className="font-mono text-ink">{p.value}</span>
              {p.label && (
                <span className="ml-2 eyebrow" style={{ letterSpacing: '0.14em' }}>
                  {p.label}
                </span>
              )}
            </div>
          ))}
        </FieldGroup>
      )}
      {card.primary_email && (
        <FieldGroup label="Email">
          <div>
            <span className="font-mono text-ink">{card.primary_email}</span>
            {card.email_label && (
              <span className="ml-2 eyebrow" style={{ letterSpacing: '0.14em' }}>
                {card.email_label}
              </span>
            )}
          </div>
          {extraEmails.map((em) => (
            <div key={em.id}>
              <span className="font-mono text-ink">{em.value}</span>
              {em.label && (
                <span className="ml-2 eyebrow" style={{ letterSpacing: '0.14em' }}>
                  {em.label}
                </span>
              )}
            </div>
          ))}
        </FieldGroup>
      )}
      {addressLine && (
        <FieldGroup label="Address">
          <span className="text-ink">{addressLine}</span>
        </FieldGroup>
      )}
      {card.birthday && (
        <FieldGroup label="Birthday">
          <span className="font-mono text-ink">{card.birthday}</span>
        </FieldGroup>
      )}
      {card.bio && (
        <FieldGroup label="Bio">
          <span className="text-ink">{card.bio}</span>
        </FieldGroup>
      )}
      {links.length > 0 && (
        <FieldGroup label="Links">
          {links
            .slice()
            .sort((a, b) => a.sort_order - b.sort_order)
            .map((l) => (
              <div key={l.id} className="font-mono text-ink break-all">
                {l.label ? `${l.label} — ` : ''}
                {l.url}
              </div>
            ))}
        </FieldGroup>
      )}
      {urlLine}
    </div>
  )
}

function FieldGroup({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="grid grid-cols-[80px_1fr] gap-x-3 gap-y-1 text-[14px] leading-[1.55]">
      {/* The label column is a fixed 80px and `.eyebrow` sets white-space:
          nowrap, so a label wider than 80px cannot wrap — it overflows its cell
          and paints straight over the value beside it, which reads as
          corruption rather than as a layout bug. Overriding to normal (and
          allowing mid-word breaks) makes it take a second line instead. Note
          `break-words` alone does nothing here: nowrap forbids breaking at all,
          so the whitespace override is the load-bearing half. */}
      <div className="eyebrow pt-1 whitespace-normal break-words" style={{ letterSpacing: '0.14em' }}>
        {label}
      </div>
      <div className="text-ink min-w-0 break-words">{children}</div>
    </div>
  )
}

function MecardView({ raw }: { raw: string }) {
  const m = parseMecard(raw)
  return (
    <div className="space-y-3">
      {m.name && (
        <div className="font-display text-ink leading-tight" style={{ fontSize: 20 }}>
          {m.name}
        </div>
      )}
      {m.tel && (
        <FieldGroup label="Phone">
          <span className="font-mono">{m.tel}</span>
        </FieldGroup>
      )}
      {m.email && (
        <FieldGroup label="Email">
          <span className="font-mono">{m.email}</span>
        </FieldGroup>
      )}
      {m.url && (
        <FieldGroup label="Website">
          <span className="font-mono break-all">
            {m.url}
            {isShortenedUrl(m.url) && <ShortenedBadge />}
          </span>
        </FieldGroup>
      )}
      {m.address && <FieldGroup label="Address">{m.address}</FieldGroup>}
      {m.note && <FieldGroup label="Note">{m.note}</FieldGroup>}
      <RawDataDisclosure raw={raw} />
    </div>
  )
}

function WifiView({ raw }: { raw: string }) {
  const w = parseWifi(raw)
  return (
    <div className="space-y-3">
      {w.ssid && (
        <FieldGroup label="Network">
          <span className="font-mono">{w.ssid}</span>
          {w.hidden && (
            <span className="ml-2 eyebrow" style={{ letterSpacing: '0.14em' }}>
              hidden
            </span>
          )}
        </FieldGroup>
      )}
      {w.security && (
        <FieldGroup label="Security">
          <span className="font-mono">
            {w.security === 'nopass' ? 'Open (no password)' : w.security}
          </span>
        </FieldGroup>
      )}
      {w.password && (
        <FieldGroup label="Password">
          <span className="font-mono">{w.password}</span>
        </FieldGroup>
      )}
      <RawDataDisclosure raw={raw} />
    </div>
  )
}

function UrlView({ raw }: { raw: string }) {
  return (
    <div className="space-y-2">
      <div className="font-mono text-ink break-all text-[14px]">{raw}</div>
      {isShortenedUrl(raw) && (
        <div className="text-[12px] text-ink-soft">
          This is a shortened link, which redirects to a different address.<ShortenedBadge inline />
        </div>
      )}
    </div>
  )
}

function SimpleLineView({ label, value }: { label: string; value: string }) {
  return (
    <FieldGroup label={label}>
      <span className="font-mono">{value}</span>
    </FieldGroup>
  )
}

function SmsView({ raw }: { raw: string }) {
  // sms:<number>:<body> or smsto:<number>:<body> shapes. Body
  // is optional.
  const stripped = raw.replace(/^sms(to)?:/i, '')
  const colonIdx = stripped.indexOf(':')
  const number = colonIdx === -1 ? stripped : stripped.slice(0, colonIdx)
  const body = colonIdx === -1 ? '' : stripped.slice(colonIdx + 1)
  return (
    <div className="space-y-3">
      <FieldGroup label="Sends to">
        <span className="font-mono">{number}</span>
      </FieldGroup>
      {body && (
        <FieldGroup label="Message">
          <span className="text-ink">{body}</span>
        </FieldGroup>
      )}
    </div>
  )
}

function RawTextView({ raw }: { raw: string }) {
  return (
    <pre className="whitespace-pre-wrap text-[13px] leading-[1.55] font-mono text-ink m-0">
      {raw}
    </pre>
  )
}

// ── Raw-data disclosure ──────────────────────────────────────────────

function RawDataDisclosure({
  raw,
  extraRawLines,
}: {
  raw: string
  extraRawLines?: string[]
}) {
  const showExtra = extraRawLines && extraRawLines.length > 0
  return (
    <details className="mt-3 text-[12px] text-ink-mute">
      <summary className="cursor-pointer select-none text-ink-soft">
        View raw QR data
      </summary>
      <pre className="mt-2 whitespace-pre-wrap break-all p-3 font-mono text-ink rounded-[6px] bg-canvas border border-line-soft text-[11px]">
        {raw}
      </pre>
      {showExtra && (
        <div className="mt-2">
          <div className="eyebrow mb-1" style={{ letterSpacing: '0.14em' }}>
            Other vCard fields
          </div>
          <pre className="whitespace-pre-wrap break-all p-3 font-mono text-ink rounded-[6px] bg-canvas border border-line-soft text-[11px]">
            {extraRawLines.join('\n')}
          </pre>
        </div>
      )}
    </details>
  )
}

// ── Shortened-link badge ─────────────────────────────────────────────

function ShortenedBadge({ inline = false }: { inline?: boolean }) {
  return (
    <span
      className={[
        inline ? 'inline-flex' : 'ml-2 inline-flex',
        'items-center rounded-full bg-out-soft text-out px-2 py-0.5 eyebrow align-middle',
      ].join(' ')}
      style={{ letterSpacing: '0.14em', marginLeft: inline ? 8 : undefined }}
    >
      shortened link
    </span>
  )
}

// ── helpers exported for unit-testable grouping logic ────────────────

/**
 * Returns the set of QR rows applicable to a given approval slot,
 * matching _finalize_proof_if_complete's slot-coordinate rules
 * (000169). Exported so the approval-flow tick on the customer
 * page can check whether QRs apply before showing the gating
 * checkbox.
 */
export function qrRowsForSlot({
  qrImages,
  slotName,
  versionHasNames,
}: {
  qrImages: GridImage[]
  /** Recipient name, or '__shared__' for the shared sentinel. */
  slotName: string
  /** True when the version has at least one named recipient. */
  versionHasNames: boolean
}): GridImage[] {
  if (slotName === '__shared__') {
    // __shared__ only behaves as a slot when names is empty
    // (the all-shared one-off path). Match the DB predicate:
    // every QR on the version applies.
    if (!versionHasNames) return qrImages
    // For split-name + shared proofs, __shared__ is approved-
    // by-implication, so the tick never gates on a __shared__
    // slot. Return an empty set so the caller short-circuits.
    return []
  }
  return qrImages.filter(
    (img) => img.associated_name === slotName || img.associated_name == null,
  )
}
