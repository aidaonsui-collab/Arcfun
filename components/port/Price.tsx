import { formatUsdc } from '@/lib/port/format'
import { cn } from '@/lib/cn'

export function Price({
  value,
  className,
  size = 'sm',
  symbol = 'USDC',
}: {
  value: number
  className?: string
  size?: 'sm' | 'lg'
  /** Defaults to USDC — pass a collection's paymentSymbol for a mint price that may not be. */
  symbol?: string
}) {
  return (
    <span
      className={cn(
        'tabular-nums tracking-tightish',
        size === 'lg' ? 'text-[17px] font-semibold' : 'text-[13px] font-semibold',
        className,
      )}
    >
      {formatUsdc(value)}
      <span className="ml-1 font-medium text-t3">{symbol}</span>
    </span>
  )
}
