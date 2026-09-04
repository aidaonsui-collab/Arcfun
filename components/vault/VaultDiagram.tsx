/** Animated vault orbit — Instant USDC → keeper → approved RWA into ERC-4626. */
export function VaultDiagram({ className = '' }: { className?: string }) {
  return (
    <div className={`vault-orbit relative mx-auto aspect-square w-full max-w-[360px] ${className}`}>
      <svg
        viewBox="0 0 320 320"
        className="h-full w-full"
        role="img"
        aria-label="Instant USDC into a keeper-gated ERC-4626 vault of approved RWAs"
      >
        <defs>
          <filter id="vault-glow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="1.6" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* faint rails */}
        <circle cx="160" cy="160" r="148" fill="none" stroke="var(--hair)" strokeWidth="1" />
        <circle
          cx="160"
          cy="160"
          r="118"
          fill="none"
          stroke="var(--limeT)"
          strokeOpacity="0.18"
          strokeWidth="1"
        />
        <circle
          cx="160"
          cy="160"
          r="86"
          fill="none"
          stroke="var(--limeT)"
          strokeOpacity="0.22"
          strokeWidth="1"
        />

        {/* spinning arc + satellite on outer rail */}
        <g className="vault-orbit-spin">
          <path
            d="M36 160a124 124 0 0 1 248 0"
            fill="none"
            stroke="var(--limeT)"
            strokeWidth="2.4"
            strokeLinecap="round"
            filter="url(#vault-glow)"
          />
          <circle cx="36" cy="160" r="3.2" fill="var(--limeT)" className="vault-orbit-sat" />
          <circle cx="284" cy="160" r="2.4" fill="var(--limeT)" fillOpacity="0.7" />
        </g>

        {/* core */}
        <circle
          className="vault-orbit-core-ring"
          cx="160"
          cy="160"
          r="42"
          fill="none"
          stroke="var(--limeT)"
          strokeWidth="1.5"
        />
        <circle
          className="vault-orbit-core-fill"
          cx="160"
          cy="160"
          r="42"
          fill="var(--limeT)"
          fillOpacity="0.08"
        />
        <circle className="vault-orbit-core-dot" cx="160" cy="160" r="4.5" fill="var(--limeT)" />

        <text
          x="160"
          y="150"
          textAnchor="middle"
          fill="var(--limeT)"
          fontSize="11"
          fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
          letterSpacing="2.4"
          fontWeight="600"
        >
          VAULT
        </text>
        <text
          x="160"
          y="166"
          textAnchor="middle"
          fill="var(--limeT)"
          fillOpacity="0.75"
          fontSize="8"
          fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
          letterSpacing="1.8"
        >
          ERC-4626
        </text>

        {/* fixed labels (match the art) */}
        <text
          x="160"
          y="22"
          textAnchor="middle"
          fill="rgba(255,255,255,0.42)"
          fontSize="9"
          fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
          letterSpacing="2"
        >
          INSTANT USDC
        </text>
        <text
          x="160"
          y="312"
          textAnchor="middle"
          fill="rgba(255,255,255,0.42)"
          fontSize="9"
          fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
          letterSpacing="2"
        >
          APPROVED RWA
        </text>
        <text
          x="14"
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
