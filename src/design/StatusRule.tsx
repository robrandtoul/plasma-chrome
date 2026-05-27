// 10px vertical rule that hugs the left edge of a card/row. The
// strongest layout signal in the system — every dashboard row and
// proof-detail version row carries one. Parent must be
// position: relative; row content needs ≥18px left padding to clear.
interface StatusRuleProps {
  colour: string
}

export function StatusRule({ colour }: StatusRuleProps) {
  return (
    <span
      aria-hidden="true"
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        bottom: 0,
        width: 'var(--rule-w)',
        backgroundColor: colour,
        borderRadius: '4px 0 0 4px',
      }}
    />
  )
}

export default StatusRule
