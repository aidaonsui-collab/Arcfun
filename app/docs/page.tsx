import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Docs — Arcfun',
  description:
    'Arcfun pair types, LP fee splits, ArcStudio NFT launchpad, Portfolio reflection claims, and how Instant launches work on Arc.',
}

const TOC = [
  { href: '#pairs', label: 'Pairs' },
  { href: '#launches', label: 'Launch types' },
  { href: '#fees', label: 'LP fees' },
  { href: '#portfolio', label: 'Portfolio' },
  { href: '#studio', label: 'ArcStudio' },
  { href: '#agents', label: 'Agents' },
] as const

export default function DocsPage() {
  return (
    <main className="min-h-screen text-white pt-16 pb-20">
      <div className="max-w-desk mx-auto px-4 sm:px-10 py-8 sm:py-10">
        <p className="m-0 text-[12px] font-semibold uppercase tracking-[0.08em] text-lime-t">
          Docs
        </p>
        <h1 className="m-0 mt-2 text-[32px] sm:text-[40px] font-semibold tracking-display leading-[1.12]">
          How Arcfun works
        </h1>
        <p className="mt-3 mb-0 max-w-2xl text-[16px] text-t2 leading-relaxed">
          Instant token launches on Arc. Full supply onto Uniswap V3 from block one, always quoted
          in USDC, LP locked. Two live launch types — Meme and Reflection.
        </p>

        <nav
          aria-label="On this page"
          className="mt-7 flex flex-wrap gap-2"
        >
          {TOC.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="h-8 inline-flex items-center px-3 rounded-full border border-hair bg-s2 text-[13px] font-semibold text-t2 hover:text-white hover:border-lime-line"
            >
              {item.label}
            </a>
          ))}
        </nav>

        {/* Pairs */}
        <section id="pairs" className="scroll-mt-24 mt-14">
          <h2 className="m-0 text-[24px] font-semibold tracking-tightish">Pair types</h2>
          <p className="mt-2 mb-5 max-w-2xl text-[15px] text-t2 leading-relaxed">
            Every live launch is a single Uniswap V3 pool. The quote asset is always Arc USDC.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <article className="border border-lime-line rounded-[22px] bg-s1 p-5 sm:p-6">
              <div className="flex items-center justify-between gap-3">
                <h3 className="m-0 text-[17px] font-semibold tracking-tightish">TOKEN / USDC</h3>
                <span className="px-2 py-0.5 rounded-full bg-lime-soft border border-lime-line text-[11px] font-bold uppercase tracking-wide text-lime-t">
                  Live
                </span>
              </div>
              <p className="mt-2 mb-4 text-[13px] text-t2 leading-snug">
                Canonical pair for Meme and Reflection launches. 1% Uniswap V3 fee tier.
              </p>
              <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-3 text-[13px]">
                <div>
                  <dt className="text-t3 font-medium">Quote</dt>
                  <dd className="m-0 mt-0.5 font-semibold">Arc USDC (6dp)</dd>
                </div>
                <div>
                  <dt className="text-t3 font-medium">Pool fee</dt>
                  <dd className="m-0 mt-0.5 font-semibold">1% (fee = 10_000)</dd>
                </div>
                <div>
                  <dt className="text-t3 font-medium">Venue</dt>
                  <dd className="m-0 mt-0.5 font-semibold">Uniswap V3</dd>
                </div>
                <div>
                  <dt className="text-t3 font-medium">Gas</dt>
                  <dd className="m-0 mt-0.5 font-semibold">Native USDC</dd>
                </div>
              </dl>
            </article>

            <article className="relative border border-hair rounded-[22px] bg-s1 p-5 sm:p-6 opacity-80">
              <div className="flex items-center justify-between gap-3">
                <h3 className="m-0 text-[17px] font-semibold tracking-tightish">RWA paired</h3>
                <span className="px-2 py-0.5 rounded-full bg-white/[0.06] text-[11px] font-bold uppercase tracking-wide text-t3">
                  Soon
                </span>
              </div>
              <p className="mt-2 mb-0 text-[13px] text-t2 leading-snug">
                Same Instant mint + LP lock, quoted against a real-world asset instead of USDC.
                Not live — trading existing TOKEN/USDC pools is unaffected.
              </p>
            </article>
          </div>
        </section>

        {/* Launch types */}
        <section id="launches" className="scroll-mt-24 mt-14">
          <h2 className="m-0 text-[24px] font-semibold tracking-tightish">Launch types</h2>
          <p className="mt-2 mb-5 max-w-2xl text-[15px] text-t2 leading-relaxed">
            Both types mint a fixed 1,000,000,000 supply (18 decimals) and seed a TOKEN/USDC pool
            in the same create transaction. The difference is who earns the quote-side LP fees.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <article className="border border-hair rounded-[22px] bg-s1 p-5 sm:p-6">
              <p className="m-0 text-[12px] font-semibold text-t3">⚡ Meme Launch</p>
              <h3 className="m-0 mt-1.5 text-[18px] font-semibold tracking-tightish">
                Instant
              </h3>
              <p className="mt-2 mb-4 text-[14px] text-t2 leading-relaxed">
                Tradable from block one. Quote-side LP fees go to the creator and the platform.
                Launch-token fees are burned.
              </p>
              <ul className="m-0 pl-4 text-[13px] text-t2 space-y-1.5 leading-snug">
                <li>Full float on Uniswap V3 at creation</li>
                <li>70% creator · 30% platform</li>
                <li>Optional USDC first buy in the create tx</li>
              </ul>
            </article>

            <article className="border border-violet-400/35 rounded-[22px] bg-gradient-to-br from-violet-500/10 to-s1 p-5 sm:p-6">
              <p className="m-0 text-[12px] font-semibold text-violet-200/90">◈ Reflection</p>
              <h3 className="m-0 mt-1.5 text-[18px] font-semibold tracking-tightish">
                Instant Reflection
              </h3>
              <p className="mt-2 mb-4 text-[14px] text-t2 leading-relaxed">
                Same Instant pool, but half of quote-side LP fees are distributed to holders of
                the token. Claim from{' '}
                <Link href="/portfolio" className="text-lime-t font-semibold hover:text-white">
                  Portfolio
                </Link>
                .
              </p>
              <ul className="m-0 pl-4 text-[13px] text-t2 space-y-1.5 leading-snug">
                <li>50% holders · 25% creator · 25% platform</li>
                <li>Default reward is Arc USDC</li>
                <li>Share scales with how much of the token you hold</li>
              </ul>
            </article>
          </div>
        </section>

        {/* Fees */}
        <section id="fees" className="scroll-mt-24 mt-14">
          <h2 className="m-0 text-[24px] font-semibold tracking-tightish">LP fee structure</h2>
          <p className="mt-2 mb-5 max-w-2xl text-[15px] text-t2 leading-relaxed">
            The pool charges a <strong className="text-white font-semibold">1% Uniswap V3 swap
            fee</strong>. When fees are collected from the locked LP NFT, the quote (USDC) side is
            split as below. The launch-token side is always burned — it never pays out.
          </p>

          <div className="border border-hair rounded-[24px] bg-s1 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm min-w-[560px]">
                <thead>
                  <tr className="text-[12px] font-semibold text-t3 border-b border-hair2">
                    <th className="px-5 py-3 font-semibold"> </th>
                    <th className="px-5 py-3 font-semibold">Meme (Instant)</th>
                    <th className="px-5 py-3 font-semibold">Reflection</th>
                  </tr>
                </thead>
                <tbody className="text-[14px]">
                  {[
                    ['Pair', 'TOKEN / USDC', 'TOKEN / USDC'],
                    ['Pool fee', '1%', '1%'],
                    ['Creator', '70%', '25%'],
                    ['Holders', '—', '50% via reflect()'],
                    ['Platform', '30%', '25%'],
                    ['Launch-token fees', 'Burned', 'Burned'],
                    ['Supply', '1,000,000,000', '1,000,000,000'],
                  ].map(([k, a, b]) => (
                    <tr key={k} className="border-b border-hair2 last:border-0">
                      <td className="px-5 py-3 text-t3 font-medium">{k}</td>
                      <td className="px-5 py-3 font-semibold tabular-nums">{a}</td>
                      <td className="px-5 py-3 font-semibold tabular-nums">{b}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
            <div className="border border-hair rounded-[22px] bg-s1 p-5">
              <p className="m-0 text-[13px] font-semibold text-t3 mb-3">Meme — quote-side split</p>
              <FeeBar
                parts={[
                  { label: 'Creator 70%', pct: 70, className: 'bg-lime' },
                  { label: 'Platform 30%', pct: 30, className: 'bg-s3' },
                ]}
              />
            </div>
            <div className="border border-hair rounded-[22px] bg-s1 p-5">
              <p className="m-0 text-[13px] font-semibold text-t3 mb-3">
                Reflection — quote-side split
              </p>
              <FeeBar
                parts={[
                  { label: 'Holders 50%', pct: 50, className: 'bg-violet-500' },
                  { label: 'Creator 25%', pct: 25, className: 'bg-lime' },
                  { label: 'Platform 25%', pct: 25, className: 'bg-s3' },
                ]}
              />
            </div>
          </div>

          <ul className="mt-5 mb-0 pl-4 text-[14px] text-t2 space-y-2 leading-relaxed max-w-2xl">
            <li>
              Creator share is paid to the <strong className="text-white font-semibold">rewards
              wallet</strong> set at launch (defaults to the signing wallet).
            </li>
            <li>
              Creation fee is <strong className="text-white font-semibold">0.10 USDC</strong> plus
              Arc gas (also USDC).
            </li>
            <li>
              Reflection holder share is not streamed per swap. A keeper collects the locked
              position, forwards USDC, then calls <code className="text-t2">reflect()</code> so
              balances become claimable.
            </li>
          </ul>
        </section>

        {/* Portfolio */}
        <section id="portfolio" className="scroll-mt-24 mt-14">
          <h2 className="m-0 text-[24px] font-semibold tracking-tightish">Portfolio</h2>
          <p className="mt-2 mb-5 max-w-2xl text-[15px] text-t2 leading-relaxed">
            Connect a wallet and open{' '}
            <Link href="/portfolio" className="text-lime-t font-semibold hover:text-white">
              Portfolio
            </Link>{' '}
            from the header. It is the claim surface for Instant Reflection — USDC (or a custom
            reward token) earned from tokens you hold. Profile is next to it: that is where you
            set the avatar that shows on token activity.
          </p>

          <h3 className="m-0 mb-3 text-[16px] font-semibold tracking-tightish">Rewards</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="border border-violet-400/35 rounded-[20px] bg-gradient-to-br from-violet-500/15 to-s1 px-5 py-4">
              <p className="m-0 text-[11px] font-semibold uppercase tracking-wide text-violet-200/90">
                USDC rewards
              </p>
              <p className="m-0 mt-2 text-[15px] text-t2 leading-snug">
                Ready to <code className="text-white">claim()</code> now. If nothing is
                claimable yet, this is your share of uncollected LP fees waiting on the next
                keeper sweep.
              </p>
            </div>
            <div className="border border-hair rounded-[20px] bg-s1 px-5 py-4">
              <p className="m-0 text-[11px] font-semibold uppercase tracking-wide text-t3">
                Lifetime earned
              </p>
              <p className="m-0 mt-2 text-[15px] text-t2 leading-snug">
                Everything this wallet has accrued from reflections, including amounts already
                claimed.
              </p>
            </div>
            <div className="border border-hair rounded-[20px] bg-s1 px-5 py-4">
              <p className="m-0 text-[11px] font-semibold uppercase tracking-wide text-t3">
                Already claimed
              </p>
              <p className="m-0 mt-2 text-[15px] text-t2 leading-snug">
                Pushed by the keeper or pulled with a manual <code className="text-white">claim()</code>.
              </p>
            </div>
          </div>

          <div className="mt-3 border border-hair rounded-[22px] bg-s1 p-5">
            <h3 className="m-0 text-[15px] font-semibold tracking-tightish">
              Reflection rewards by token
            </h3>
            <ul className="mt-3 mb-0 pl-4 text-[14px] text-t2 space-y-2 leading-relaxed">
              <li>
                One row per Instant Reflection launch: your holding, claimable, and lifetime
                earned in that token&apos;s reward asset (usually USDC).
              </li>
              <li>
                Claim is one transaction per token — tap Claim on the row. There is no batch
                claim.
              </li>
              <li>
                Holding more of a reflection token earns a larger share of that token&apos;s
                50% holder leg. Meme Instant launches do not pay holders.
              </li>
              <li>
                Fees are not streamed per swap. A keeper collects the locked LP, forwards USDC,
                then calls <code className="text-t2">reflect()</code>. Refresh after a sweep if
                the tile still says Pending.
              </li>
            </ul>
          </div>

          <h3 className="m-0 mt-8 mb-3 text-[16px] font-semibold tracking-tightish">
            Profile and avatar
          </h3>
          <div className="border border-hair rounded-[22px] bg-s1 p-5 sm:p-6">
            <p className="m-0 text-[14px] text-t2 leading-relaxed">
              Open <strong className="text-white font-semibold">Profile</strong> in the header
              (or <code className="text-t2">/creator/your-wallet</code>) and tap Edit profile.
              You can set an avatar, display name, bio, and X handle. Saving is a wallet
              signature — nothing on-chain.
            </p>
            <ul className="mt-4 mb-0 pl-4 text-[14px] text-t2 space-y-2 leading-relaxed">
              <li>
                Your avatar shows on your public creator page and, when you trade, on the
                token page activity tape under the chart — replacing the color dot next to
                your wallet.
              </li>
              <li>
                Display name or <code className="text-t2">@handle</code> replaces the
                truncated address in that same tape. Wallets without an avatar stay as a
                color chip.
              </li>
              <li>
                Profile also lists coins you launched, creator LP-fee positions, followers,
                and trading PnL.
              </li>
            </ul>
            <Link
              href="/portfolio"
              className="inline-flex mt-5 h-10 items-center px-4 rounded-xl bg-lime text-white text-sm font-semibold hover:bg-lime-2"
            >
              Open Portfolio
            </Link>
          </div>
        </section>

        {/* Port */}
        <section id="studio" className="scroll-mt-24 mt-14">
          <h2 className="m-0 text-[24px] font-semibold tracking-tightish">ArcStudio</h2>
          <p className="mt-2 mb-5 max-w-2xl text-[15px] text-t2 leading-relaxed">
            NFT launchpad and marketplace on the same site as token launches.{' '}
            <Link href="/studio" className="text-lime-t font-semibold hover:text-white">
              ArcStudio
            </Link>{' '}
            is the marketplace. Create collection is the launchpad. You do not need to launch a
            collection to run the pad.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <article className="border border-hair rounded-[22px] bg-s1 p-5 sm:p-6">
              <h3 className="m-0 text-[17px] font-semibold tracking-tightish">Launchpad</h3>
              <p className="mt-2 mb-0 text-[13px] text-t2 leading-snug">
                Any creator deploys an ERC-721 clone. Creation fee 0.1 native USDC (factory owner
                free). Mint price is ERC-20 USDC (6dp). 95% of mint proceeds to the creator, 5%
                to treasury. Royalty 0–10% (EIP-2981, honored on secondary later).
              </p>
            </article>
            <article className="border border-hair rounded-[22px] bg-s1 p-5 sm:p-6">
              <h3 className="m-0 text-[17px] font-semibold tracking-tightish">Marketplace</h3>
              <p className="mt-2 mb-0 text-[13px] text-t2 leading-snug">
                Browse collections, mint from the sticky bar on phone. Secondary list, buy, and
                cancel run on Seaport 1.6. Floor, listed count, and 24h volume come from live
                listings — not invented stats.
              </p>
            </article>
            <article className="border border-hair rounded-[22px] bg-s1 p-5 sm:p-6">
              <h3 className="m-0 text-[17px] font-semibold tracking-tightish">Your studio</h3>
              <p className="mt-2 mb-0 text-[13px] text-t2 leading-snug">
                On Studio, Profile (or the You icon in the dock) opens collections you launched,
                primary mint earnings (95%), royalty %, and ArcStudio items in that wallet. Upload
                item art from the collection page (Upload items) or You → Items, then reveal
                on-chain. Token Profile stays on Instant for coins you launched.
              </p>
            </article>
          </div>
        </section>

        <section id="agents" className="scroll-mt-24 mt-14">
          <h2 className="m-0 text-[24px] font-semibold tracking-tightish">Agents</h2>
          <p className="mt-2 mb-5 max-w-2xl text-[15px] text-t2 leading-relaxed">
            ArcFun is the venue. Circle Agent Stack is the wallet. Eve is the agent runtime.
            Together they let an AI launch and trade Instant / Reflection tokens on Arc without
            ArcFun ever holding a key. Signing is <code className="text-t2">circle wallet execute</code>.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
            <article className="border border-hair rounded-[22px] bg-s1 p-5">
              <h3 className="m-0 text-[15px] font-semibold tracking-tightish">ArcFun MCP</h3>
              <p className="mt-1.5 mb-0 text-[13px] text-t2 leading-relaxed">
                List, quote, holders, candles, and unsigned launch/swap transactions.
              </p>
            </article>
            <article className="border border-hair rounded-[22px] bg-s1 p-5">
              <h3 className="m-0 text-[15px] font-semibold tracking-tightish">Circle Agent Stack</h3>
              <p className="mt-1.5 mb-0 text-[13px] text-t2 leading-relaxed">
                Agent Wallets, Circle CLI, spend policies, USDC on Arc. The signer. Each
                prepared step includes a <code>circle wallet execute</code> command.
              </p>
            </article>
            <article className="border border-hair rounded-[22px] bg-s1 p-5">
              <h3 className="m-0 text-[15px] font-semibold tracking-tightish">Eve</h3>
              <p className="mt-1.5 mb-0 text-[13px] text-t2 leading-relaxed">
                <code>defineMcpClientConnection</code> to this MCP, then{' '}
                <code>submit_prepared_tx</code> with approval always on. Eve runs Circle CLI.
              </p>
            </article>
          </div>
          <div className="border border-hair rounded-[22px] bg-s1 p-5 sm:p-6">
            <p className="m-0 text-[14px] text-t2 leading-relaxed">
              MCP URL:{' '}
              <code className="text-white">https://www.arcfun.co/api/mcp</code>
            </p>
            <p className="mt-3 mb-0 text-[13px] text-t3 leading-relaxed">
              Claude / Cursor / Codex: add that URL as a Streamable HTTP MCP server. Then call{' '}
              <code className="text-t2">about</code>, <code className="text-t2">list_tokens</code>,{' '}
              <code className="text-t2">prepare_swap</code>. Sign the returned steps with a funded
              Circle Agent Wallet on chain 5042.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <a
                href="/skills/arcfun.md"
                className="inline-flex h-10 items-center px-4 rounded-xl border border-hair bg-s2 text-sm font-semibold text-t2 hover:text-white"
              >
                Circle / Eve skill
              </a>
              <a
                href="/eve/README.md"
                className="inline-flex h-10 items-center px-4 rounded-xl border border-hair bg-s2 text-sm font-semibold text-t2 hover:text-white"
              >
                Eve sample
              </a>
            </div>
          </div>
        </section>

        <div className="mt-12 flex flex-wrap gap-3">
          <Link
            href="/create"
            className="inline-flex h-11 items-center px-5 rounded-full bg-lime text-white text-sm font-semibold hover:bg-lime-2"
          >
            Launch a token
          </Link>
          <Link
            href="/"
            className="inline-flex h-11 items-center px-5 rounded-full border border-hair bg-s2 text-sm font-semibold text-t2 hover:text-white"
          >
            Browse launches
          </Link>
        </div>
      </div>
    </main>
  )
}

function FeeBar({
  parts,
}: {
  parts: { label: string; pct: number; className: string }[]
}) {
  return (
    <div>
      <div className="flex h-2.5 rounded-full overflow-hidden bg-black/40">
        {parts.map((p) => (
          <div
            key={p.label}
            className={p.className}
            style={{ width: `${p.pct}%` }}
            title={p.label}
          />
        ))}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-t3">
        {parts.map((p) => (
          <span key={p.label} className="inline-flex items-center gap-1.5">
            <span className={`inline-block w-2 h-2 rounded-sm ${p.className}`} />
            {p.label}
          </span>
        ))}
      </div>
    </div>
  )
}
