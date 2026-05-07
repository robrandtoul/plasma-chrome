import { PAPER_INK } from '../lib/theme'

type DocketCellProps = {
  label: string
  value: string
}

export function DocketCell({ label, value }: DocketCellProps) {
  return (
    <div
      className={[
        'border-r border-[rgba(26,22,18,0.10)]',
        'even:border-r-0 sm:even:border-r sm:last:border-r-0',
        'py-6 px-1 even:pl-4 sm:[&:not(:first-child)]:pl-6',
      ].join(' ')}
    >
      <dt
        className="font-paper-mono uppercase"
        style={{
          fontSize: 9,
          fontWeight: 500,
          letterSpacing: '0.28em',
          color: 'rgba(26,22,18,0.5)',
        }}
      >
        {label}
      </dt>
      <dd
        className="mt-2 font-body"
        style={{ fontSize: 15, fontWeight: 400, color: PAPER_INK }}
      >
        {value}
      </dd>
    </div>
  )
}
