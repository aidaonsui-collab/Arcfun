'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useAccount, useConnect, usePublicClient, useSignMessage, useSwitchChain, useWriteContract } from 'wagmi'
import { authQuery, prepareCollectionAuth } from '@/lib/arc-auth'
import { erc20Abi, formatUnits, getAddress, isAddress, parseUnits, zeroAddress, type Address } from 'viem'
import { ARC, ARC_CHAIN_ID } from '@/lib/contracts-arc'
import { ARC_DISPERSE_ABI } from '@/lib/port/abi'
import { aggregateAirdrop, type TokenHolder } from '@/lib/port/holders'
import { RARITY_TIERS } from '@/lib/port/item-meta'
import { studioPath } from '@/lib/port/path'
import type { Collection } from '@/lib/port/types'
import { formatUsdc, shortAddr } from '@/lib/port/format'
import { cn } from '@/lib/cn'

const CHUNK = 40

export function AirdropDesk({ collection }: { collection: Collection }) {
  const { address, isConnected, chainId } = useAccount()
  const { connect, connectors, isPending } = useConnect()
  const { switchChain } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()
  const { signMessageAsync } = useSignMessage()
  const publicClient = usePublicClient({ chainId: ARC_CHAIN_ID })
  const mine = Boolean(address && collection.creator && address.toLowerCase() === collection.creator.toLowerCase())
  const wrongChain = isConnected && chainId !== ARC_CHAIN_ID

  const [holders, setHolders] = useState<TokenHolder[]>([])
  const [minted, setMinted] = useState(0)
  const [loading, setLoading] = useState(true)
  const [rarity, setRarity] = useState('')
  const [perNft, setPerNft] = useState(false)
  const [amount, setAmount] = useState('')
  const [tokenMode, setTokenMode] = useState<'usdc' | 'origin' | 'custom'>(
    collection.originToken ? 'origin' : 'usdc',
  )
  const [customToken, setCustomToken] = useState('')
  const [decimals, setDecimals] = useState(tokenMode === 'usdc' ? 6 : 18)
  const [symbol, setSymbol] = useState(tokenMode === 'usdc' ? 'USDC' : collection.originSymbol || 'TOKEN')
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [done, setDone] = useState('')

  const token = useMemo((): Address | null => {
    if (tokenMode === 'usdc') return ARC.USDC
    if (tokenMode === 'origin' && collection.originToken) return collection.originToken as Address
    if (tokenMode === 'custom' && isAddress(customToken)) return customToken as Address
    return null
  }, [tokenMode, customToken, collection.originToken])

  useEffect(() => {
    if (!mine) return
    let cancelled = false
    setLoading(true)
    ;(async () => {
      try {
        let url = `/api/studio/holders?collection=${collection.address}`
        if (!collection.revealed) {
          const payload = { collection: getAddress(collection.address) }
          const prepared = prepareCollectionAuth(collection.address, 'read-holders', payload)
          const signature = await signMessageAsync({ message: prepared.message })
          url += `&${authQuery({ signature, timestamp: prepared.timestamp, nonce: prepared.nonce })}`
        }
        const d = await fetch(url).then((r) => r.json())
        if (cancelled) return
        setHolders(d.holders || [])
        setMinted(d.minted || 0)
      } catch {
        if (!cancelled) setErr('Could not load holders')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [mine, collection.address, collection.revealed, signMessageAsync])

  useEffect(() => {
    if (!token || !publicClient) return
    let cancelled = false
    Promise.all([
      publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
      publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }),
    ])
      .then(([d, s]) => {
        if (cancelled) return
        setDecimals(Number(d))
        setSymbol(String(s))
      })
      .catch(() => {
        if (cancelled) return
        setDecimals(tokenMode === 'usdc' ? 6 : 18)
      })
    return () => {
      cancelled = true
    }
  }, [token, publicClient, tokenMode])

  const plan = useMemo(() => {
    let atomic = 0n
    try {
      if (amount && Number(amount) > 0) atomic = parseUnits(amount, decimals)
    } catch {
      atomic = 0n
    }
    return aggregateAirdrop(holders, { rarity: rarity || undefined, perNft, amountAtomic: atomic })
  }, [holders, rarity, perNft, amount, decimals])

  const total = plan.amounts.reduce((s, a) => s + a, 0n)
  const disperse = ARC.DISPERSE
  const disperseReady = disperse && disperse !== zeroAddress

  async function run() {
    setErr('')
    setDone('')
    if (!isConnected) {
      const c = connectors[0]
      if (c) connect({ connector: c })
      return
    }
    if (wrongChain) {
      switchChain({ chainId: ARC_CHAIN_ID })
      return
    }
    if (!mine) {
      setErr('Only the collection creator can airdrop.')
      return
    }
    if (!token || !publicClient) {
      setErr('Pick a token.')
      return
    }
    if (!disperseReady) {
      setErr('Airdrop contract is not deployed.')
      return
    }
    if (plan.wallets.length === 0 || total <= 0n) {
      setErr('No recipients or amount is zero.')
      return
    }
    setBusy('approve')
    try {
      const allowance = (await publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [address as Address, disperse],
      })) as bigint
      if (allowance < total) {
        const h = await writeContractAsync({
          address: token,
          abi: erc20Abi,
          functionName: 'approve',
          args: [disperse, total],
          chainId: ARC_CHAIN_ID,
        })
        await publicClient.waitForTransactionReceipt({ hash: h, timeout: 120_000 })
      }
      let sent = 0
      for (let i = 0; i < plan.wallets.length; i += CHUNK) {
        const to = plan.wallets.slice(i, i + CHUNK)
        const amt = plan.amounts.slice(i, i + CHUNK)
        setBusy(`Sending ${i + 1}–${i + to.length} of ${plan.wallets.length}…`)
        const h = await writeContractAsync({
          address: disperse,
          abi: ARC_DISPERSE_ABI,
          functionName: 'disperseToken',
          args: [token, to, amt],
          chainId: ARC_CHAIN_ID,
        })
        await publicClient.waitForTransactionReceipt({ hash: h, timeout: 180_000 })
        sent += to.length
      }
      setDone(`Sent to ${sent} wallet${sent === 1 ? '' : 's'}.`)
    } catch (e) {
      const ax = e as { shortMessage?: string; message?: string }
      setErr(ax.shortMessage || ax.message || 'Airdrop failed')
    } finally {
      setBusy('')
    }
  }

  function exportCsv() {
    const lines = ['wallet,amount,nfts']
    const counts = new Map<string, number>()
    const filtered = rarity ? holders.filter((h) => h.rarity.toLowerCase() === rarity.toLowerCase()) : holders
    for (const h of filtered) counts.set(h.owner.toLowerCase(), (counts.get(h.owner.toLowerCase()) || 0) + 1)
    plan.wallets.forEach((w, i) => {
      lines.push(`${w},${formatUnits(plan.amounts[i], decimals)},${counts.get(w.toLowerCase()) || 0}`)
    })
    const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${collection.symbol || 'collection'}-airdrop.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  if (!isConnected) {
    return (
      <div className="mx-auto max-w-md px-4 py-24 text-center">
        <h1 className="text-[28px] font-semibold tracking-display">Airdrop</h1>
        <p className="mt-2 text-[15px] text-t2">Connect the collection owner wallet.</p>
        <button
          type="button"
          disabled={isPending}
          onClick={() => connect({ connector: connectors[0] })}
          className="mt-6 inline-flex h-11 items-center rounded-xl bg-lime px-5 text-[14px] font-semibold text-white"
        >
          Connect
        </button>
      </div>
    )
  }

  if (!mine) {
    return <div className="px-4 py-24 text-center text-t2">Only the collection creator can airdrop.</div>
  }

  const inputClass =
    'mt-1 h-12 w-full rounded-xl border border-hair bg-s2 px-3.5 text-[15px] outline-none placeholder:text-white/25'

  return (
    <div className="mx-auto w-full max-w-desk px-4 pb-24 pt-8 sm:px-10">
      <Link href={studioPath(collection)} className="text-[13px] font-semibold text-t3 hover:text-white">
        ← {collection.name}
      </Link>
      <h1 className="mt-3 text-[28px] font-semibold tracking-display sm:text-[32px]">Airdrop</h1>
      <p className="mt-2 max-w-xl text-[15px] leading-relaxed text-t2">
        Snapshot current holders, filter by rarity, then send an ERC-20. Unique wallets by default.
        {loading ? ' Loading holders…' : ` ${minted} minted.`}
      </p>

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <div className="space-y-5">
          <div>
            <div className="text-[13px] text-t3">Who</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {['', ...RARITY_TIERS].map((tier) => (
                <button
                  key={tier || 'all'}
                  type="button"
                  onClick={() => setRarity(tier)}
                  className={cn(
                    'h-8 rounded-full border px-3 text-[12px] font-semibold',
                    rarity === tier ? 'border-lime-line bg-s2 text-white' : 'border-hair text-t3 hover:text-white',
                  )}
                >
                  {tier || 'All holders'}
                </button>
              ))}
            </div>
          </div>
          <label className="flex h-12 items-center justify-between rounded-xl border border-hair bg-s2 px-3.5">
            <span className="text-[15px]">Pay per NFT, not per wallet</span>
            <input
              type="checkbox"
              checked={perNft}
              onChange={(e) => setPerNft(e.target.checked)}
              className="h-5 w-5 accent-[#2f84db]"
            />
          </label>
          <div>
            <div className="text-[13px] text-t3">Token</div>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setTokenMode('usdc')}
                className={cn(
                  'h-8 rounded-full border px-3 text-[12px] font-semibold',
                  tokenMode === 'usdc' ? 'border-lime-line bg-s2 text-white' : 'border-hair text-t3',
                )}
              >
                USDC
              </button>
              {collection.originToken ? (
                <button
                  type="button"
                  onClick={() => setTokenMode('origin')}
                  className={cn(
                    'h-8 rounded-full border px-3 text-[12px] font-semibold',
                    tokenMode === 'origin' ? 'border-lime-line bg-s2 text-white' : 'border-hair text-t3',
                  )}
                >
                  {collection.originSymbol || 'Origin token'}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => setTokenMode('custom')}
                className={cn(
                  'h-8 rounded-full border px-3 text-[12px] font-semibold',
                  tokenMode === 'custom' ? 'border-lime-line bg-s2 text-white' : 'border-hair text-t3',
                )}
              >
                Custom
              </button>
            </div>
            {tokenMode === 'custom' ? (
              <input
                value={customToken}
                onChange={(e) => setCustomToken(e.target.value.trim())}
                placeholder="0x…"
                className={`${inputClass} font-mono text-[14px]`}
              />
            ) : null}
          </div>
          <div>
            <label className="text-[13px] text-t3">
              Amount {perNft ? 'per NFT' : 'per wallet'} ({symbol})
            </label>
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
              placeholder="0"
              className={inputClass}
            />
          </div>
          <div className="rounded-[20px] border border-hair bg-s1 p-4 text-[15px]">
            <div className="flex justify-between">
              <span className="text-t3">Matching NFTs</span>
              <span className="tabular-nums">{plan.nfts}</span>
            </div>
            <div className="mt-2 flex justify-between">
              <span className="text-t3">Wallets</span>
              <span className="tabular-nums">{plan.unique}</span>
            </div>
            <div className="mt-2 flex justify-between">
              <span className="text-t3">Total</span>
              <span className="font-semibold tabular-nums">
                {symbol === 'USDC' ? formatUsdc(Number(formatUnits(total, decimals))) : formatUnits(total, decimals)}{' '}
                {symbol}
              </span>
            </div>
          </div>
          {err ? <p className="text-[13px] text-coral">{err}</p> : null}
          {done ? <p className="text-[13px] text-lime-t">{done}</p> : null}
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              disabled={!!busy || plan.unique === 0 || total <= 0n}
              onClick={() => void run()}
              className="inline-flex h-12 min-w-[160px] items-center justify-center rounded-xl bg-lime px-5 text-[15px] font-semibold text-white disabled:opacity-50"
            >
              {!isConnected
                ? 'Connect'
                : wrongChain
                  ? 'Switch to Arc'
                  : busy
                    ? busy === 'approve'
                      ? 'Approve…'
                      : busy
                    : `Airdrop ${symbol}`}
            </button>
            <button
              type="button"
              disabled={plan.unique === 0}
              onClick={exportCsv}
              className="inline-flex h-12 items-center rounded-xl border border-hair px-4 text-[14px] font-semibold text-white disabled:opacity-50"
            >
              Export CSV
            </button>
          </div>
        </div>
        <div>
          <div className="text-[13px] text-t3">Recipients</div>
          <div className="mt-2 max-h-[28rem] overflow-auto rounded-[20px] border border-hair bg-s1">
            {loading ? (
              <p className="px-4 py-8 text-center text-[14px] text-t3">Reading owners on-chain…</p>
            ) : plan.wallets.length === 0 ? (
              <p className="px-4 py-8 text-center text-[14px] text-t3">No holders in this filter.</p>
            ) : (
              <div className="divide-y divide-hair2">
                {plan.wallets.slice(0, 80).map((w, i) => (
                  <div key={w} className="flex items-center justify-between gap-3 px-4 py-2.5 text-[13px]">
                    <span className="font-mono text-t2">{shortAddr(w)}</span>
                    <span className="tabular-nums text-white">
                      {formatUnits(plan.amounts[i], decimals)} {symbol}
                    </span>
                  </div>
                ))}
                {plan.wallets.length > 80 ? (
                  <p className="px-4 py-2 text-[12px] text-t3">+{plan.wallets.length - 80} more</p>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
