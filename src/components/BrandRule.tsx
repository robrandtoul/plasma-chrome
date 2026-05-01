const BRAND_RULE_COLOURS = ['#e11735', '#d81c7e', '#4a21a6', '#3ba58a'] as const

export function BrandRule({ height = 2 }: { height?: number }) {
  return (
    <div className="flex w-full" style={{ height }}>
      {BRAND_RULE_COLOURS.map((c, i) => (
        <div key={i} className="flex-1" style={{ background: c }} />
      ))}
    </div>
  )
}
