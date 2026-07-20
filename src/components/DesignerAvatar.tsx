// The per-designer identity chip (24px round): the designer's avatar image when
// set, else their initials on a soft tint of their colour. Shared by the
// dashboard project rows and the Orders "Links to send" worklist so both render
// the same designer-identity register.
//
// Soft 14% tint background with a solid text colour matches the readability you
// want at 24px — a solid bg + white text reads too heavy when 20+ avatars stack
// in a list. Palette shared with the header and chat via lib/designerColours.

import { designerColourCss } from '../lib/designerColours'

export default function DesignerAvatar({
  initials,
  colour,
  avatarUrl,
  tooltip,
}: {
  initials: string | null
  colour: string | null
  avatarUrl: string | null
  tooltip?: string
}) {
  const ini = (initials ?? '').slice(0, 2) || '—'
  const tint = designerColourCss(colour, 'teal')
  const tintedStyle = avatarUrl
    ? undefined
    : {
        backgroundColor: `color-mix(in srgb, ${tint} 14%, transparent)`,
        color: tint,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${tint} 30%, transparent)`,
      }
  return (
    <span
      title={tooltip}
      aria-label={tooltip}
      className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full text-[10px] font-semibold"
      style={tintedStyle}
    >
      {avatarUrl ? <img src={avatarUrl} alt="" className="h-full w-full object-cover" /> : ini}
    </span>
  )
}
