'use client'

import { useEffect, useState } from 'react'
import { useAccount, useWriteContract } from 'wagmi'
import { decodeEventLog, erc20Abi, getAddress, type Address } from 'viem'
import { ARC_CHAIN_ID, arcPublicClient } from '@/lib/contracts-arc'
import { setClientBasketQuotes } from '@/lib/arc-rwa-assets'
import {
  BASKET_FACTORY_ABI,
  BASKET_VAULT_ABI,
  DINARI_LEGS,
  basketFactoryAddress,
  basketQuoteId,
  basketToAsset,
  loadBaskets,
  saveBasket,
  mintLegCost,
  unitsPerShare,
  type SavedBasket,
} from '@/lib/arc-basket'

const APPROVE_GAS = 250_000n
const VAULT_GAS = 3_000_000n

export function BasketPairCard({
  active,
  disabled,
  onSelect,
}: {
  active: boolean
  disabled?: boolean
  onSelect: (id: string) => void
}) {
  const { address, isConnected } = useAccount()
  const { writeContractAsync } = useWriteContract()
  const factory = basketFactoryAddress()
  const [picked, setPicked] = useState<string[]>(['NVDA', 'AAPL'])
  const [perShare, setPerShare] = useState<Record<string, string>>({})
  const [seedShares, setSeedShares] = useState('100')
  const [mintFeeBps, setMintFeeBps] = useState('10')
  const [redeemFeeBps, setRedeemFeeBps] = useState('10')
  const [usdPerShare, setUsdPerShare] = useState('100')
  const [symbol, setSymbol] = useState('NVDAAAPL')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [saved, setSaved] = useState<SavedBasket[]>([])

  useEffect(() => {
    const rows = loadBaskets()
    setSaved(rows)
    setClientBasketQuotes(rows.map(basketToAsset))
  }, [])

  const toggle = (sym: string) => {
    setPicked((cur) => {
      if (cur.includes(sym)) return cur.filter((s) => s !== sym)
      if (cur.length >= 3) return cur
      return [...cur, sym]
    })
  }

  const seed = async () => {
    setNote('')
    if (!factory) return
    if (!isConnected || !address) {
      setNote('Connect a wallet to seed.')
      return
    }
    if (picked.length < 2 || picked.length > 3) {
      setNote('Pick two or three stocks.')
      return
    }
    const usd = Number(usdPerShare)
    if (!(usd > 0)) {
      setNote('Set how many dollars one share is worth.')
      return
    }
    const legs = DINARI_LEGS.filter((l) => picked.includes(l.symbol))
    const client = arcPublicClient()
    setBusy(true)
    try {
      const resolved = []
      for (const leg of legs) {
        const [decimals, supply] = await Promise.all([
          client.readContract({
            address: leg.address as Address,
            abi: erc20Abi,
            functionName: 'decimals',
          }) as Promise<number>,
          client.readContract({
            address: leg.address as Address,
            abi: erc20Abi,
            functionName: 'totalSupply',
          }) as Promise<bigint>,
        ])
        if (supply === 0n) {
          throw new Error(`${leg.symbol} has no supply yet. Mint waits until it can be pulled.`)
        }
        const human = perShare[leg.symbol] || '1'
        const units = unitsPerShare(human, Number(decimals))
        if (units === 0n) throw new Error(`Set a token amount for ${leg.symbol}.`)
        resolved.push({ ...leg, decimals: Number(decimals), tokensPerShare: human, units })
      }
      const seedRaw = unitsPerShare(seedShares, 18)
      const mintBps = Number(mintFeeBps)
      const redeemBps = Number(redeemFeeBps)
      if (seedRaw < 10n ** 15n) throw new Error('Mint at least 0.001 share.')
      if (!Number.isInteger(mintBps) || !Number.isInteger(redeemBps) || mintBps < 0 || redeemBps < 0 || mintBps > 100 || redeemBps > 100) {
        throw new Error('Owner fees are 0 to 1%.')
      }
      const sym = symbol.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 11)
      if (sym.length < 2) throw new Error('Give the share a short symbol.')
      const name = resolved.map((l) => l.symbol).join(' ')

      const createHash = await writeContractAsync({
        address: factory,
        abi: BASKET_FACTORY_ABI,
        functionName: 'create',
        args: [name, sym, resolved.map((l) => l.address as Address), resolved.map((l) => l.units), mintBps, redeemBps],
        chainId: ARC_CHAIN_ID,
        gas: VAULT_GAS,
      })
      const created = await client.waitForTransactionReceipt({ hash: createHash })
      let vault: Address | null = null
      for (const log of created.logs) {
        try {
          const ev = decodeEventLog({ abi: BASKET_FACTORY_ABI, data: log.data, topics: log.topics })
          if (ev.eventName === 'VaultCreated') vault = getAddress(ev.args.vault)
        } catch {
          /* other logs */
        }
      }
      if (!vault) throw new Error('Vault address was missing from the create receipt.')

      for (const leg of resolved) {
        const need = mintLegCost(leg.units, seedRaw, mintBps)
        const approveHash = await writeContractAsync({
          address: leg.address as Address,
          abi: erc20Abi,
          functionName: 'approve',
          args: [vault, need],
          chainId: ARC_CHAIN_ID,
          gas: APPROVE_GAS,
        })
        await client.waitForTransactionReceipt({ hash: approveHash })
      }
      const seedHash = await writeContractAsync({
        address: vault,
        abi: BASKET_VAULT_ABI,
        functionName: 'mint',
        args: [seedRaw, address],
        chainId: ARC_CHAIN_ID,
        gas: VAULT_GAS,
      })
      await client.waitForTransactionReceipt({ hash: seedHash })

      const row: SavedBasket = {
        id: basketQuoteId(vault),
        symbol: sym,
        name,
        share: vault,
        vault,
        usdPerShare: usd,
        legs: resolved.map((l) => ({
          symbol: l.symbol,
          address: l.address as Address,
          tokensPerShare: l.tokensPerShare,
          decimals: l.decimals,
        })),
      }
      saveBasket(row)
      const rows = loadBaskets()
      setSaved(rows)
      setClientBasketQuotes(rows.map(basketToAsset))
      onSelect(row.id)
      setNote(`${sym} is minted. Launch uses it as the pair.`)
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Seed failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className={`rounded-2xl bg-s1 p-4 text-left border sm:col-span-2 ${
        active ? 'border-lime-line' : 'border-hair'
      } ${disabled ? 'opacity-60' : ''}`}
    >
      <div className="text-sm font-medium">Basket paired</div>
      <p className="mt-1 mb-3 text-xs leading-relaxed text-t2">
        Two or three assets back one share. A mint pulls that recipe plus a fee. A redeem pays it back
        minus a fee. The share is the Instant quote. USDC can buy or sell it in one swap once each
        asset has a pool, and a dead asset can be skipped on the way out. Mint turns on once each
        asset can be pulled.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {DINARI_LEGS.map((leg) => {
          const on = picked.includes(leg.symbol)
          return (
            <button
              key={leg.symbol}
              type="button"
              disabled={disabled || busy || (!on && picked.length >= 3)}
              onClick={() => toggle(leg.symbol)}
              className={`h-8 rounded-full pl-1 pr-2.5 text-[12px] font-semibold border inline-flex items-center gap-1.5 ${
                on ? 'border-lime-line text-white bg-lime/15' : 'border-hair text-t3'
              }`}
            >
              <span className="inline-flex size-6 items-center justify-center rounded-full bg-white overflow-hidden shrink-0">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={leg.logo}
                  alt=""
                  className={leg.symbol === 'COIN' ? 'size-6 object-cover' : 'size-3.5 object-contain'}
                />
              </span>
              {leg.symbol}
            </button>
          )
        })}
      </div>
      {picked.length > 0 ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {picked.map((sym) => (
            <label key={sym} className="text-xs text-t3">
              {sym} per share
              <input
                value={perShare[sym] ?? '1'}
                onChange={(e) => setPerShare((m) => ({ ...m, [sym]: e.target.value }))}
                className="mt-1 w-full h-10 rounded-xl bg-s2 px-3 text-sm text-white border border-hair"
              />
            </label>
          ))}
        </div>
      ) : null}
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <label className="text-xs text-t3">
          Shares to mint
          <input
            value={seedShares}
            onChange={(e) => setSeedShares(e.target.value)}
            className="mt-1 w-full h-10 rounded-xl bg-s2 px-3 text-sm text-white border border-hair"
          />
        </label>
        <label className="text-xs text-t3">
          Mint fee, bps
          <input
            value={mintFeeBps}
            onChange={(e) => setMintFeeBps(e.target.value)}
            className="mt-1 w-full h-10 rounded-xl bg-s2 px-3 text-sm text-white border border-hair"
          />
        </label>
        <label className="text-xs text-t3">
          Redeem fee, bps
          <input
            value={redeemFeeBps}
            onChange={(e) => setRedeemFeeBps(e.target.value)}
            className="mt-1 w-full h-10 rounded-xl bg-s2 px-3 text-sm text-white border border-hair"
          />
        </label>
        <label className="text-xs text-t3">
          Dollars per share
          <input
            value={usdPerShare}
            onChange={(e) => setUsdPerShare(e.target.value)}
            className="mt-1 w-full h-10 rounded-xl bg-s2 px-3 text-sm text-white border border-hair"
          />
        </label>
      </div>
      <label className="mt-3 block text-xs text-t3">
        Share symbol
        <input
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          className="mt-1 w-full h-10 rounded-xl bg-s2 px-3 text-sm text-white border border-hair"
        />
      </label>
      <button
        type="button"
        disabled={disabled || busy}
        onClick={() => void seed()}
        className="mt-3 h-10 rounded-xl px-4 text-sm font-semibold bg-lime text-black disabled:opacity-50"
      >
        {busy ? 'Minting…' : 'Mint basket'}
      </button>
      {saved.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {saved.map((b) => (
            <button
              key={b.id}
              type="button"
              disabled={disabled}
              onClick={() => onSelect(b.id)}
              className="h-8 rounded-full px-2.5 text-[12px] font-semibold border border-lime-line text-white"
            >
              Use {b.symbol}
            </button>
          ))}
        </div>
      ) : null}
      {note ? <p className="mt-2 text-xs text-amber-200/90">{note}</p> : null}
      {!factory ? (
        <p className="mt-2 text-xs text-t3">Waiting on the basket vault factory address.</p>
      ) : null}
    </div>
  )
}
