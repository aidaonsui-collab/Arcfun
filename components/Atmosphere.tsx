/** SVG atmosphere — nested Arc ellipses, no canvas. */
export function Atmosphere() {
  return (
    <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden" aria-hidden>
      <div className="absolute inset-x-0 -top-24 h-[420px] bg-[radial-gradient(ellipse_80%_60%_at_80%_0%,rgb(110_200_232_/_0.1),transparent_70%)]" />
      <div className="absolute -right-24 top-[12%] size-[520px] rounded-full bg-[radial-gradient(circle,rgb(110_200_232_/_0.08),transparent_68%)]" />
      <div className="absolute -left-32 bottom-[8%] size-[380px] rounded-full bg-[radial-gradient(circle,rgb(156_255_87_/_0.04),transparent_70%)]" />

      <svg
        className="absolute top-[6%] right-[-8%] h-[78%] w-[78%] max-w-none opacity-80"
        viewBox="0 0 800 640"
        fill="none"
      >
        <g className="origin-center quote-orbit" style={{ transformOrigin: '400px 300px' }}>
          <ellipse
            cx="400"
            cy="300"
            rx="340"
            ry="150"
            stroke="rgba(110,200,232,0.16)"
            strokeWidth="1.2"
            strokeDasharray="3 12"
          />
          <ellipse
            cx="400"
            cy="300"
            rx="270"
            ry="118"
            stroke="rgba(156,255,87,0.1)"
            strokeWidth="1"
            strokeDasharray="16 14"
          />
        </g>
        <g className="origin-center quote-orbit-rev" style={{ transformOrigin: '400px 300px' }}>
          <ellipse cx="400" cy="300" rx="200" ry="88" stroke="rgba(142,212,238,0.2)" strokeWidth="1.1" />
          <ellipse cx="400" cy="300" rx="140" ry="60" stroke="rgba(110,200,232,0.14)" strokeDasharray="2 8" />
        </g>
        {STARS.map((s) => (
          <circle key={s.id} cx={s.x} cy={s.y} r={s.r} fill={s.fill} className="live-dot" />
        ))}
      </svg>
    </div>
  )
}

const STARS = [
  { id: 1, x: 120, y: 80, r: 1.4, fill: 'rgba(126,192,247,0.55)' },
  { id: 2, x: 210, y: 160, r: 1.1, fill: 'rgba(124,255,58,0.4)' },
  { id: 3, x: 520, y: 90, r: 1.6, fill: 'rgba(126,192,247,0.5)' },
  { id: 4, x: 680, y: 220, r: 1.2, fill: 'rgba(124,255,58,0.35)' },
  { id: 5, x: 640, y: 400, r: 1.5, fill: 'rgba(126,192,247,0.45)' },
  { id: 6, x: 300, y: 470, r: 1.1, fill: 'rgba(59,142,239,0.5)' },
  { id: 7, x: 90, y: 340, r: 1.3, fill: 'rgba(126,192,247,0.35)' },
  { id: 8, x: 450, y: 520, r: 1.2, fill: 'rgba(124,255,58,0.3)' },
  { id: 9, x: 740, y: 140, r: 1.0, fill: 'rgba(126,192,247,0.4)' },
  { id: 10, x: 380, y: 40, r: 1.4, fill: 'rgba(59,142,239,0.45)' },
]
