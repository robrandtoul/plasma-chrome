// Customer-facing QR code verification panel.
//
// Renders a dedicated docket section above the spec summary for
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

import { useEffect, useState } from 'react'
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
import {
  MONO,
  PAPER_BORDER,
  PAPER_HAIRLINE,
  PAPER_INK,
  PAPER_SECONDARY,
  PAPER_TERTIARY,
  PAPER_TINT_1,
  SANS,
  SERIF,
} from '../lib/theme'
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
}

export function QrCodePanel({ qrImages, names, isVariantRound }: QrCodePanelProps) {
  if (qrImages.length === 0) return null

  // Variant rounds: QR rows are version-wide (no round_variant_id on
  // QR rows), so we render every QR in one flat list. The
  // per-recipient grouping doesn't apply to variant rounds.
  if (isVariantRound) {
    return (
      <QrSection>
        <QrSectionIntro />
        <div className="space-y-12">
          {qrImages.map((img) => (
            <QrCodeCard key={img.id} image={img} />
          ))}
        </div>
      </QrSection>
    )
  }

  // Standard versions. If the proof has recipient names, group by
  // associated_name and render one panel per name (each panel shows
  // the recipient's own QRs followed by any shared QRs). If the
  // proof is shared-only (names is empty), render a single merged
  // panel.
  if (names.length === 0) {
    return (
      <QrSection>
        <QrSectionIntro />
        <div className="space-y-12">
          {qrImages.map((img) => (
            <QrCodeCard key={img.id} image={img} />
          ))}
        </div>
      </QrSection>
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
    <QrSection>
      <QrSectionIntro />
      <div className="space-y-14">
        {perRecipient.map(({ name, qrs }) => {
          // Skip recipients with no QRs visible to them (no
          // own QRs, no shared QRs). Mostly only happens during
          // edits in flight.
          if (qrs.length === 0 && sharedQrs.length === 0) return null
          return (
            <div key={name}>
              <h3
                className="leading-tight pb-3"
                style={{
                  fontFamily: SERIF,
                  fontWeight: 400,
                  fontSize: 'clamp(28px, 5vw, 36px)',
                  color: PAPER_INK,
                  borderBottom: `1px solid ${PAPER_BORDER}`,
                }}
              >
                {name}'s QR codes
              </h3>
              <div className="mt-6 space-y-10">
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
      </div>
    </QrSection>
  )
}

// ── Section wrapper ──────────────────────────────────────────────────

function QrSection({ children }: { children: React.ReactNode }) {
  return (
    <section
      aria-labelledby="section-qr-heading"
      style={{
        // PAPER_TINT_1 distinguishes the QR verification section
        // from the artwork band above (PAPER_CREAM). Matches the
        // tonal rhythm Construction uses; for non-letterpress
        // proofs the band-progression reads cream → tint_1 (QR) →
        // tint_2 (Spec) → cream (Pricing).
        background: PAPER_TINT_1,
        color: PAPER_INK,
        borderTop: `1px solid ${PAPER_HAIRLINE}`,
      }}
    >
      <div className="mx-auto max-w-[1080px] px-8 py-20 sm:px-8 sm:py-24">
        <div className="grid gap-10 sm:grid-cols-[1fr_2fr] sm:gap-16">
          <div>
            <h2
              id="section-qr-heading"
              className="leading-[1.02] border-b-2 pb-4 break-words"
              style={{
                fontFamily: SERIF,
                fontWeight: 400,
                fontSize: 'clamp(40px, 9vw, 56px)',
                color: PAPER_INK,
                borderColor: 'rgba(26,22,18,0.8)',
              }}
            >
              QR code contents
            </h2>
            <p
              className="mt-5 max-w-[30ch] text-[14px] leading-[1.55]"
              style={{ color: PAPER_TERTIARY }}
            >
              Before approving, please double-check the contents of each QR code. Scan with your phone or read the decoded text alongside each one. The on-screen QR is the exact image we'll print.
            </p>
            <p
              className="mt-3 max-w-[30ch] text-[13px] leading-[1.55]"
              style={{ color: PAPER_TERTIARY }}
            >
              For Plasma vCards, scanning the QR saves the contact details below to a phone. The look of the page it opens, the photo, colours and layout, is yours to personalise after your cards arrive.
            </p>
          </div>
          <div>{children}</div>
        </div>
      </div>
    </section>
  )
}

function QrSectionIntro() {
  return null
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

  return (
    <article
      className="grid gap-6 sm:grid-cols-[180px_1fr]"
      style={{
        background: 'rgba(255,255,255,0.55)',
        border: `1px solid ${PAPER_BORDER}`,
        borderRadius: 6,
        padding: 20,
      }}
    >
      <div>
        {image.signed_url ? (
          <img
            src={image.signed_url}
            alt="QR code"
            width={180}
            height={180}
            style={{
              width: '100%',
              maxWidth: 180,
              aspectRatio: '1 / 1',
              objectFit: 'contain',
              display: 'block',
              background: '#fff',
              border: `1px solid ${PAPER_HAIRLINE}`,
              borderRadius: 4,
            }}
          />
        ) : (
          // Edge-function signing failure — graceful empty box.
          // The decoded panel still renders so the customer can
          // verify the contents even without the visible QR.
          <div
            style={{
              width: '100%',
              maxWidth: 180,
              aspectRatio: '1 / 1',
              background: '#f4f1eb',
              border: `1px dashed ${PAPER_BORDER}`,
              borderRadius: 4,
            }}
          />
        )}
        {sharedLabel && (
          <div
            className="mt-2 text-[11px] tracking-wide uppercase"
            style={{
              fontFamily: MONO,
              color: PAPER_TERTIARY,
              letterSpacing: '0.05em',
            }}
          >
            Shared across all cards
          </div>
        )}
      </div>
      <div>
        <KindBadge kind={kind} />
        <div className="mt-3">
          <DecodedContents kind={kind} data={decoded} vcardSlug={image.qr_vcard_slug ?? null} />
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

function KindBadge({ kind }: { kind: QrKind }) {
  return (
    <span
      className="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] uppercase tracking-wide"
      style={{
        fontFamily: MONO,
        background: 'rgba(26,22,18,0.06)',
        color: PAPER_SECONDARY,
        letterSpacing: '0.05em',
      }}
    >
      {KIND_LABELS[kind]}
    </span>
  )
}

// ── Decoded contents dispatcher ──────────────────────────────────────

function DecodedContents({
  kind,
  data,
  vcardSlug,
}: {
  kind: QrKind
  data: string
  /** Populated by the proof-viewer only for kind = 'hosted_vcard' rows. */
  vcardSlug: string | null
}) {
  switch (kind) {
    case 'hosted_vcard':
      // The hosted-vCard renderer fetches live contact details from
      // the vCard app and shows them field by field. Falls back to
      // the URL + a "temporarily unavailable" line if the vCard app
      // is unreachable, so the page never breaks even if the
      // integration is down.
      return <HostedVcardView slug={vcardSlug} url={data} />
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
        <div
          style={{
            fontFamily: SERIF,
            fontSize: 22,
            lineHeight: 1.2,
            color: PAPER_INK,
          }}
        >
          {v.formattedName}
        </div>
      )}
      {(v.title || v.org) && (
        <div
          className="text-[14px]"
          style={{ fontFamily: SANS, color: PAPER_SECONDARY, lineHeight: 1.45 }}
        >
          {[v.title, v.org].filter(Boolean).join(' · ')}
        </div>
      )}
      {v.tels.length > 0 && (
        <FieldGroup label="Phone">
          {v.tels.map((tel, i) => (
            <div key={i}>
              <span style={{ fontFamily: MONO, color: PAPER_INK }}>{tel.value}</span>
              {tel.types.length > 0 && (
                <span
                  className="ml-2 text-[11px] uppercase tracking-wide"
                  style={{ color: PAPER_TERTIARY, fontFamily: MONO }}
                >
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
              <span style={{ fontFamily: MONO, color: PAPER_INK }}>{em.value}</span>
              {em.types.length > 0 && (
                <span
                  className="ml-2 text-[11px] uppercase tracking-wide"
                  style={{ color: PAPER_TERTIARY, fontFamily: MONO }}
                >
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
            <div key={i} style={{ fontFamily: MONO, color: PAPER_INK, wordBreak: 'break-all' }}>
              {url}
              {isShortenedUrl(url) && <ShortenedBadge />}
            </div>
          ))}
        </FieldGroup>
      )}
      {v.addresses.length > 0 && (
        <FieldGroup label="Address">
          {v.addresses.map((addr, i) => (
            <div key={i} style={{ color: PAPER_INK }}>{addr}</div>
          ))}
        </FieldGroup>
      )}
      {v.note && <FieldGroup label="Note">{v.note}</FieldGroup>}
      <RawDataDisclosure raw={raw} extraRawLines={v.rawOtherLines} />
    </div>
  )
}

// ── HostedVcardView ─────────────────────────────────────────────────
//
// Hosted-vCard QRs encode a short URL only. The customer can't verify
// the actual contact details from the URL itself, so the panel fetches
// the live contact data from the vCard app via its anon RPCs and
// renders the relevant fields. Styling fields (photo, cover, accent,
// font) are intentionally not shown — they're the customer's job to
// personalise after the cards arrive.
//
// If the vCard app is unreachable (network error, env vars missing,
// CORS, anything), the panel degrades gracefully: it shows the URL,
// a quiet "contact details are temporarily unavailable" line, and
// the QR-confirmation tick above the Approve button still works.
// The customer can always re-open the page later if they want to
// re-verify.

function HostedVcardView({ slug, url }: { slug: string | null; url: string }) {
  // Three states: idle (loading), loaded with data, error.
  type State =
    | { kind: 'loading' }
    | { kind: 'loaded'; bundle: VcardBundle }
    | { kind: 'unavailable'; message: string }
    | { kind: 'not_found' }
  const [state, setState] = useState<State>({ kind: 'loading' })

  useEffect(() => {
    if (!slug) {
      setState({ kind: 'unavailable', message: 'No Plasma vCard slug attached to this QR.' })
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const result = await fetchVcardForSlug(slug)
        if (cancelled) return
        if (result.ok) {
          setState({ kind: 'loaded', bundle: result.data })
        } else if (result.reason === 'not_found') {
          setState({ kind: 'not_found' })
        } else {
          setState({ kind: 'unavailable', message: result.message ?? 'Lookup failed.' })
        }
      } catch (err) {
        if (cancelled) return
        if (err instanceof VcardConfigError) {
          setState({
            kind: 'unavailable',
            message: 'vCard app integration is not configured on this site.',
          })
        } else {
          setState({ kind: 'unavailable', message: (err as Error).message })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [slug])

  // URL row is always shown, regardless of state — it's what the QR
  // literally encodes and the customer should always be able to read
  // the destination back to themselves.
  const urlLine = (
    <FieldGroup label="QR link">
      <span style={{ fontFamily: MONO, color: PAPER_INK, wordBreak: 'break-all' }}>
        {url}
      </span>
    </FieldGroup>
  )

  if (state.kind === 'loading') {
    return (
      <div className="space-y-3">
        {urlLine}
        <div className="text-[13px]" style={{ color: PAPER_TERTIARY, fontFamily: SANS }}>
          Loading the contact details for this Plasma vCard…
        </div>
      </div>
    )
  }

  if (state.kind === 'not_found') {
    return (
      <div className="space-y-3">
        {urlLine}
        <div className="text-[13px]" style={{ color: PAPER_TERTIARY, fontFamily: SANS }}>
          The Plasma vCard for this QR hasn't been published yet. The
          link is correct and will resolve as soon as the card is live.
        </div>
      </div>
    )
  }

  if (state.kind === 'unavailable') {
    return (
      <div className="space-y-3">
        {urlLine}
        <div className="text-[13px]" style={{ color: PAPER_TERTIARY, fontFamily: SANS }}>
          The contact details for this Plasma vCard are temporarily
          unavailable. Try refreshing this page; you can still approve
          once you've reviewed the link above.
        </div>
      </div>
    )
  }

  const { card, links, contactMethods } = state.bundle
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
        <div
          style={{
            fontFamily: SERIF,
            fontSize: 22,
            lineHeight: 1.2,
            color: PAPER_INK,
          }}
        >
          {formattedName}
        </div>
      )}
      {card.nickname && formattedName && card.nickname !== formattedName && (
        <div
          className="text-[13px]"
          style={{ fontFamily: SANS, color: PAPER_SECONDARY }}
        >
          Also known as {card.nickname}
        </div>
      )}
      {titleLine && (
        <div
          className="text-[14px]"
          style={{ fontFamily: SANS, color: PAPER_SECONDARY, lineHeight: 1.45 }}
        >
          {titleLine}
        </div>
      )}
      {card.primary_phone && (
        <FieldGroup label="Phone">
          <div>
            <span style={{ fontFamily: MONO, color: PAPER_INK }}>
              {card.primary_phone}
            </span>
            {card.phone_label && (
              <span
                className="ml-2 text-[11px] uppercase tracking-wide"
                style={{ color: PAPER_TERTIARY, fontFamily: MONO }}
              >
                {card.phone_label}
              </span>
            )}
          </div>
          {extraPhones.map((p) => (
            <div key={p.id}>
              <span style={{ fontFamily: MONO, color: PAPER_INK }}>{p.value}</span>
              {p.label && (
                <span
                  className="ml-2 text-[11px] uppercase tracking-wide"
                  style={{ color: PAPER_TERTIARY, fontFamily: MONO }}
                >
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
            <span style={{ fontFamily: MONO, color: PAPER_INK }}>
              {card.primary_email}
            </span>
            {card.email_label && (
              <span
                className="ml-2 text-[11px] uppercase tracking-wide"
                style={{ color: PAPER_TERTIARY, fontFamily: MONO }}
              >
                {card.email_label}
              </span>
            )}
          </div>
          {extraEmails.map((em) => (
            <div key={em.id}>
              <span style={{ fontFamily: MONO, color: PAPER_INK }}>{em.value}</span>
              {em.label && (
                <span
                  className="ml-2 text-[11px] uppercase tracking-wide"
                  style={{ color: PAPER_TERTIARY, fontFamily: MONO }}
                >
                  {em.label}
                </span>
              )}
            </div>
          ))}
        </FieldGroup>
      )}
      {addressLine && (
        <FieldGroup label="Address">
          <span style={{ color: PAPER_INK }}>{addressLine}</span>
        </FieldGroup>
      )}
      {card.birthday && (
        <FieldGroup label="Birthday">
          <span style={{ color: PAPER_INK, fontFamily: MONO }}>{card.birthday}</span>
        </FieldGroup>
      )}
      {card.bio && (
        <FieldGroup label="Bio">
          <span style={{ color: PAPER_INK }}>{card.bio}</span>
        </FieldGroup>
      )}
      {links.length > 0 && (
        <FieldGroup label="Links">
          {links
            .slice()
            .sort((a, b) => a.sort_order - b.sort_order)
            .map((l) => (
              <div key={l.id} style={{ fontFamily: MONO, color: PAPER_INK, wordBreak: 'break-all' }}>
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
    <div className="grid grid-cols-[80px_1fr] gap-x-3 gap-y-1 text-[14px]" style={{ fontFamily: SANS, lineHeight: 1.55 }}>
      <div
        className="text-[11px] uppercase tracking-wide pt-1"
        style={{ color: PAPER_TERTIARY, fontFamily: MONO, letterSpacing: '0.05em' }}
      >
        {label}
      </div>
      <div style={{ color: PAPER_INK }}>{children}</div>
    </div>
  )
}

function MecardView({ raw }: { raw: string }) {
  const m = parseMecard(raw)
  return (
    <div className="space-y-3">
      {m.name && (
        <div
          style={{ fontFamily: SERIF, fontSize: 22, lineHeight: 1.2, color: PAPER_INK }}
        >
          {m.name}
        </div>
      )}
      {m.tel && (
        <FieldGroup label="Phone">
          <span style={{ fontFamily: MONO }}>{m.tel}</span>
        </FieldGroup>
      )}
      {m.email && (
        <FieldGroup label="Email">
          <span style={{ fontFamily: MONO }}>{m.email}</span>
        </FieldGroup>
      )}
      {m.url && (
        <FieldGroup label="Website">
          <span style={{ fontFamily: MONO, wordBreak: 'break-all' }}>
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
          <span style={{ fontFamily: MONO }}>{w.ssid}</span>
          {w.hidden && (
            <span
              className="ml-2 text-[11px] uppercase tracking-wide"
              style={{ color: PAPER_TERTIARY, fontFamily: MONO }}
            >
              hidden
            </span>
          )}
        </FieldGroup>
      )}
      {w.security && (
        <FieldGroup label="Security">
          <span style={{ fontFamily: MONO }}>
            {w.security === 'nopass' ? 'Open (no password)' : w.security}
          </span>
        </FieldGroup>
      )}
      {w.password && (
        <FieldGroup label="Password">
          <span style={{ fontFamily: MONO }}>{w.password}</span>
        </FieldGroup>
      )}
      <RawDataDisclosure raw={raw} />
    </div>
  )
}

function UrlView({ raw }: { raw: string }) {
  return (
    <div className="space-y-2">
      <div style={{ fontFamily: MONO, color: PAPER_INK, wordBreak: 'break-all', fontSize: 14 }}>
        {raw}
      </div>
      {isShortenedUrl(raw) && (
        <div
          className="text-[12px]"
          style={{ color: PAPER_SECONDARY, fontFamily: SANS }}
        >
          This is a shortened link, which redirects to a different address.<ShortenedBadge inline />
        </div>
      )}
    </div>
  )
}

function SimpleLineView({ label, value }: { label: string; value: string }) {
  return (
    <FieldGroup label={label}>
      <span style={{ fontFamily: MONO }}>{value}</span>
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
        <span style={{ fontFamily: MONO }}>{number}</span>
      </FieldGroup>
      {body && (
        <FieldGroup label="Message">
          <span style={{ color: PAPER_INK }}>{body}</span>
        </FieldGroup>
      )}
    </div>
  )
}

function RawTextView({ raw }: { raw: string }) {
  return (
    <pre
      className="whitespace-pre-wrap text-[13px] leading-[1.55]"
      style={{ fontFamily: MONO, color: PAPER_INK }}
    >
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
    <details className="mt-3 text-[12px]" style={{ color: PAPER_TERTIARY }}>
      <summary
        className="cursor-pointer select-none"
        style={{ fontFamily: SANS, color: PAPER_SECONDARY }}
      >
        View raw QR data
      </summary>
      <pre
        className="mt-2 whitespace-pre-wrap break-all p-3"
        style={{
          fontFamily: MONO,
          background: 'rgba(26,22,18,0.04)',
          color: PAPER_INK,
          borderRadius: 4,
          fontSize: 11,
        }}
      >
        {raw}
      </pre>
      {showExtra && (
        <div className="mt-2">
          <div
            className="text-[11px] uppercase tracking-wide mb-1"
            style={{ fontFamily: MONO, letterSpacing: '0.05em' }}
          >
            Other vCard fields
          </div>
          <pre
            className="whitespace-pre-wrap break-all p-3"
            style={{
              fontFamily: MONO,
              background: 'rgba(26,22,18,0.04)',
              color: PAPER_INK,
              borderRadius: 4,
              fontSize: 11,
            }}
          >
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
      className={
        (inline ? 'inline-flex' : 'ml-2 inline-flex') +
        ' items-center rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide align-middle'
      }
      style={{
        fontFamily: MONO,
        background: 'rgba(225,23,53,0.10)',
        color: '#a01124',
        letterSpacing: '0.05em',
        marginLeft: inline ? 8 : undefined,
      }}
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
