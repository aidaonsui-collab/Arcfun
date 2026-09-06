/** eve.fun pixel star — public/eve-star.png */
export function BrandMark({ className = "w-[26px] h-[26px]" }: { className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- small brand glyph; keep crisp pixels
    <img
      src="/eve-star.png?v=4"
      alt=""
      width={26}
      height={26}
      className={`${className} object-contain`}
      aria-hidden
      draggable={false}
    />
  )
}
