import type { ReactNode } from 'react'

// Shared dark masthead for the customer-facing surfaces — the order pay-page and
// the proof page. A sticky ink band carrying the full-colour Plasma logo
// (/logo-dark.png is the white-on-dark variant designed for this band). The
// optional `right` slot holds page-specific content: "Last updated" on the proof
// page, a "Secure payment" note on the checkout. `innerClassName` sets the
// content max-width so the logo lines up with the page below.
export function CustomerHeader({
  right,
  innerClassName = 'max-w-[1280px]',
}: {
  right?: ReactNode
  innerClassName?: string
}) {
  return (
    <header className="sticky top-0 z-[5] bg-ink text-on-ink">
      <div className={`mx-auto ${innerClassName} flex items-center gap-4 px-gutter pt-[calc(env(safe-area-inset-top)+1.5rem)] pb-3.5`}>
        <img src="/logo-dark.png" alt="PlasmaDesign" className="h-[47px] sm:h-[60px] w-auto" />
        {right && <div className="ml-auto flex items-center gap-4">{right}</div>}
      </div>
    </header>
  )
}
