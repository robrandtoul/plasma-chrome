import type { GridImage } from './ImageGrid'

// Finish-aware artwork recap for the pay pages, shared by the single-order
// checkout (OrderPayPage) and the combined-payment checkout
// (OrderGroupPayPage). Extracted verbatim from OrderPayPage when the group
// page became the second caller, per the house second-caller rule.
//
// Two pieces:
//   * buildRecapTiles — pure derivation: pick one front + one back from the
//     version's images for the ACTIVE finish, and (while the customer can
//     still switch finishes) bundle EVERY candidate finish's image into the
//     tile as layers so switching cross-fades instead of loading.
//   * ArtworkFade — the layered tile itself. Mounting all the layers IS the
//     preload; opacity toggles to the active one.

export interface RecapTile {
  active: GridImage
  layers: GridImage[]
}

// One front + one back from the version's images, filtered to the active
// finish — the live pick on an open-spec order (falling back to a
// persisted/locked finish), so choosing Mirror swaps the big preview to the
// mirror artwork. Images with no finish tab (null material_option = shared
// across finishes) always qualify; a proof with no per-finish tabs, or no
// match, falls back to the whole set. While the finish is switchable
// (finishSwitchable: finish_open with 2+ candidates), every candidate
// finish's front/back mounts as cross-fade layers; otherwise plain tiles.
export function buildRecapTiles(
  versionImages: GridImage[],
  activeFinishCode: string | null,
  finishCodes: string[],
  finishSwitchable: boolean,
): RecapTile[] {
  const recapPool =
    activeFinishCode && versionImages.some((i) => i.material_option === activeFinishCode)
      ? versionImages.filter((i) => i.material_option === activeFinishCode || i.material_option == null)
      : versionImages
  const recapFront = recapPool.find((i) => i.side === 'front')
  const recapBack = recapPool.find((i) => i.side === 'back')
  const recapBySide = [recapFront, recapBack].filter((i): i is GridImage => !!i)
  const thumbs = recapBySide.length > 0 ? recapBySide : recapPool.slice(0, 2)

  const stackForSide = (side: string | null | undefined): GridImage[] => {
    const seen = new Set<string>()
    return versionImages.filter((i) => {
      if (i.side !== side) return false
      if (i.material_option != null && !finishCodes.includes(i.material_option)) return false
      const group = i.material_option ?? '__shared__'
      if (seen.has(group)) return false
      seen.add(group)
      return true
    })
  }

  return finishSwitchable && recapBySide.length > 0
    ? recapBySide.map((active) => {
        const layers = stackForSide(active.side)
        return { active, layers: layers.some((l) => l.id === active.id) ? layers : [active] }
      })
    : thumbs.map((t) => ({ active: t, layers: [t] }))
}

// Layered artwork tile: every candidate finish's image mounted at once (the
// mount IS the preload), with opacity cross-fading to the active layer.
// Layer 0 stays in normal flow to size the tile; the rest stack absolutely —
// the layers are the same design in different finishes, so dimensions match
// in practice, with object-cover guarding any drift. Hidden layers are
// aria-hidden so screen readers see exactly one artwork image.
export function ArtworkFade({ layers, activeId }: { layers: GridImage[]; activeId: string }) {
  if (layers.length <= 1) {
    const img = layers[0]
    if (!img) return null
    return <img src={img.signed_url} alt="Approved proof artwork" className="w-full rounded-lg bg-surface ring-1 ring-line" />
  }
  return (
    <span className="relative block">
      {layers.map((im, i) => (
        <img
          key={im.id}
          src={im.signed_url}
          alt={im.id === activeId ? 'Approved proof artwork' : ''}
          aria-hidden={im.id !== activeId}
          className={[
            i === 0 ? 'relative' : 'absolute inset-0 h-full w-full object-cover',
            'block w-full rounded-lg bg-surface ring-1 ring-line transition-opacity duration-300',
            im.id === activeId ? 'opacity-100' : 'opacity-0',
          ].join(' ')}
        />
      ))}
    </span>
  )
}
