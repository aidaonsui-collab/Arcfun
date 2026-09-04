/** Geometric vault glyph. No generated mark, no replacement for BrandMark. */
export function VaultDiagram({ className = '' }: { className?: string }) {
  return (
    <div className={`relative mx-auto aspect-square w-full max-w-[320px] ${className}`}>
      <svg
        viewBox="0 0 320 320"
        className="h-full w-full"
        role="img"
        aria-label="Instant USDC into a keeper-gated ERC-4626 vault of approved RWAs"
      >
        <circle cx="160" cy="160" r="148" fill="none" stroke="var(--hair)" strokeWidth="1.2" />
        <circle
          cx="160"
          cy="160"
          r="112"
          fill="none"
          stroke="var(--limeT)"
          strokeOpacity="0.28"
          strokeWidth="1.2"
        />
        <circle
          cx="160"
          cy="160"
          r="72"
          fill="none"
          stroke="var(--limeT)"
          strokeOpacity="0.7"
          strokeWidth="1.4"
        />
        <circle
          cx="160"
          cy="160"
          r="36"
          fill="var(--limeT)"
          fillOpacity="0.12"
          stroke="var(--limeT)"
          strokeWidth="1.6"
        />
        <path
          d="M36 160a124 124 0 0 1 248 0"
          fill="none"
          stroke="var(--limeT)"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <circle cx="160" cy="160" r="5" fill="var(--limeT)" />
        <text
          x="160"
          y="152"
          textAnchor="middle"
          fill="var(--limeT)"
          fontSize="10"
          fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
          letterSpacing="2"
        >
          VAULT
        </text>
        <text
          x="160"
          y="168"
          textAnchor="middle"
          fill="rgba(255,255,255,0.48)"
          fontSize="8"
          fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
          letterSpacing="1.6"
        >
          ERC-4626
        </text>
        <text
          x="160"
          y="26"
          textAnchor="middle"
          fill="rgba(255,255,255,0.48)"
          fontSize="9"
          fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
          letterSpacing="2"
        >
          INSTANT USDC
        </text>
        <text
          x="160"
          y="308"
          textAnchor="middle"
          fill="rgba(255,255,255,0.48)"
          fontSize="9"
          fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
          letterSpacing="2"
        >
          APPROVED RWA
        </text>
        <text
          x="18"
          y="164"
          fill="rgba(255,255,255,0.38)"
          fontSize="8"
          fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
          letterSpacing="1.6"
        >
          KEEPER
        </text>
      </svg>
    </div>
  )
}
