import { formatUsdc } from '@/lib/port/format'
import { cn } from '@/lib/cn'

export function Price({
  value,
  className,
  size = 'sm',
}: {
  value: number
  className?: string
  size?: 'sm' | 'lg'
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
      <span className="ml-1 font-medium text-t3">USDC</span>
    </span>
  )
}
