'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { usePublicClient, useSignMessage, useWriteContract } from 'wagmi'
import { isAddress, parseUnits, type Address, type Hex } from 'viem'
import { collectionAllowlistEditMessage } from '@/lib/arc-auth'
import { ARC_CHAIN_ID } from '@/lib/contracts-arc'
import { PORT_NFT_ABI } from '@/lib/port/abi'
import { parseWallets } from '@/lib/port/merkle'
import type { Collection } from '@/lib/port/types'
import { PortSheet } from './PortSheet'

function localDatetimeValue(ms: number) {
  if (!ms) return ''
  const x = new Date(ms)
  x.setMinutes(x.getMinutes() - x.getTimezoneOffset())
  return x.toISOString().slice(0, 16)
}

function toUnix(v: string): bigint {
  if (!v) return 0n
  const n = Math.floor(new Date(v).getTime() / 1000)
  return BigInt(Number.isFinite(n) && n > 0 ? n : 0)
}

export function DropSettingsSheet({
  collection,
  open,
  onClose,
}: {
  collection: Collection
  open: boolean
  onClose: () => void
}) {
  const router = useRouter()
  const { signMessageAsync } = useSignMessage()
  const { writeContractAsync } = useWriteContract()
  const publicClient = usePublicClient({ chainId: ARC_CHAIN_ID })
  const [price, setPrice] = useState(String(collection.mintPriceUsdc))
  const [publicStart, setPublicStart] = useState(localDatetimeValue(collection.publicStart))
  const [alStart, setAlStart] = useState(localDatetimeValue(collection.allowlistStart))
  const [alEnd, setAlEnd] = useState(localDatetimeValue(collection.allowlistEnd))
  const [wallets, setWallets] = useState('')
  const [teamTo, setTeamTo] = useState(collection.creator)
  const [teamN, setTeamN] = useState('0')
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')

  useEffect(() => {
    if (!open) return
    setPrice(String(collection.mintPriceUsdc))
    setPublicStart(localDatetimeValue(collection.publicStart))
    setAlStart(localDatetimeValue(collection.allowlistStart))
    setAlEnd(localDatetimeValue(collection.allowlistEnd))
    setTeamTo(collection.creator)
    setErr('')
    setNote('')
    fetch(`/api/studio/allowlist?collection=${collection.address}`)
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d?.wallets)) setWallets(d.wallets.join('\n'))
      })
      .catch(() => null)
  }, [open, collection])

  async function savePrice() {
    const n = Number(price)
    if (Number.isNaN(n) || n < 0) throw new Error('Set a mint price')
    const hash = await writeContractAsync({
      address: collection.address as Address,
      abi: PORT_NFT_ABI,
      functionName: 'setPrice',
      args: [parseUnits(String(n), 6)],
      chainId: ARC_CHAIN_ID,
    })
    await publicClient?.waitForTransactionReceipt({ hash, timeout: 120_000 })
  }

  async function saveSchedule() {
    const hash = await writeContractAsync({
      address: collection.address as Address,
      abi: PORT_NFT_ABI,
      functionName: 'setSchedule',
      args: [toUnix(publicStart), toUnix(alStart), toUnix(alEnd)],
      chainId: ARC_CHAIN_ID,
    })
    await publicClient?.waitForTransactionReceipt({ hash, timeout: 120_000 })
  }

  async function saveAllowlist() {
    const timestamp = Date.now()
    const message = collectionAllowlistEditMessage(collection.address, timestamp)
    const signature = await signMessageAsync({ message })
    const res = await fetch('/api/studio/allowlist', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ collection: collection.address, wallets, signature, timestamp }),
    })
    const data = (await res.json()) as { ok?: boolean; root?: Hex; count?: number; error?: string }
    if (!res.ok || !data.ok || !data.root) throw new Error(data.error || 'Allowlist save failed')
    const hash = await writeContractAsync({
      address: collection.address as Address,
      abi: PORT_NFT_ABI,
      functionName: 'setAllowlistRoot',
      args: [data.root],
      chainId: ARC_CHAIN_ID,
    })
    await publicClient?.waitForTransactionReceipt({ hash, timeout: 120_000 })
    return data.count || 0
  }

  async function teamMint() {
    const n = Math.floor(Number(teamN))
    if (!isAddress(teamTo) || n < 1) throw new Error('Team mint needs a wallet and a count')
    const hash = await writeContractAsync({
      address: collection.address as Address,
      abi: PORT_NFT_ABI,
      functionName: 'ownerMint',
      args: [teamTo as Address, BigInt(n)],
      chainId: ARC_CHAIN_ID,
    })
    await publicClient?.waitForTransactionReceipt({ hash, timeout: 120_000 })
    await fetch('/api/studio/activity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ collection: collection.address, txHash: hash }),
    }).catch(() => null)
  }

  async function run(kind: 'price' | 'schedule' | 'allowlist' | 'team') {
    setErr('')
    setNote('')
    setBusy(kind)
    try {
      if (kind === 'price') await savePrice()
      if (kind === 'schedule') {
        try {
          await saveSchedule()
        } catch (e) {
          const msg = (e as { shortMessage?: string }).shortMessage || (e as Error).message || ''
          if (msg.includes('ScheduleLocked')) throw new Error('Schedule is locked after reveal.')
          if (msg.toLowerCase().includes('reverted') || msg.includes('does not exist')) {
            throw new Error(
              'This collection was deployed before schedule edits. New collections can change public start.',
            )
          }
          throw e
        }
      }
      if (kind === 'allowlist') {
        const n = await saveAllowlist()
        setNote(`${n} wallets on-chain.`)
      }
      if (kind === 'team') {
        try {
          await teamMint()
        } catch (e) {
          const msg = (e as { shortMessage?: string }).shortMessage || (e as Error).message || ''
          if (msg.toLowerCase().includes('reverted') || msg.includes('does not exist')) {
            throw new Error(
              'This collection was deployed before reserved mints. New collections can team-mint for free.',
            )
          }
          throw e
        }
      }
      router.refresh()
    } catch (e) {
      const ax = e as { shortMessage?: string; message?: string }
      setErr(ax.shortMessage || ax.message || 'Failed')
    } finally {
      setBusy('')
    }
  }

  const parsed = parseWallets(wallets).length

  return (
    <PortSheet open={open} onClose={onClose} title="Drop settings">
      <div className="max-h-[70vh] space-y-8 overflow-y-auto pb-2">
        <section>
          <h3 className="text-[15px] font-semibold">Mint price</h3>
          <div className="relative mt-2">
            <input
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ''))}
              className="h-12 w-full rounded-xl border border-hair bg-s2 px-3.5 pr-16 text-[15px] outline-none"
            />
            <span className="pointer-events-none absolute inset-y-0 right-4 grid place-items-center text-[13px] text-t3">
              USDC
            </span>
          </div>
          <button
            type="button"
            disabled={!!busy}
            onClick={() => void run('price')}
            className="mt-3 inline-flex h-11 items-center rounded-xl bg-lime px-4 text-[14px] font-semibold text-white disabled:opacity-50"
          >
            {busy === 'price' ? 'Saving…' : 'Update price'}
          </button>
        </section>

        <section>
          <h3 className="text-[15px] font-semibold">Schedule</h3>
          <p className="mt-1 text-[13px] text-t3">Public start is required. Allowlist window is optional. Locked after reveal.</p>
          <label className="mt-3 block text-[13px] text-t3">Public start</label>
          <input
            type="datetime-local"
            value={publicStart}
            onChange={(e) => setPublicStart(e.target.value)}
            className="mt-1 h-12 w-full rounded-xl border border-hair bg-s2 px-3.5 text-[15px] outline-none"
          />
          <label className="mt-3 block text-[13px] text-t3">Allowlist start</label>
          <input
            type="datetime-local"
            value={alStart}
            onChange={(e) => setAlStart(e.target.value)}
            className="mt-1 h-12 w-full rounded-xl border border-hair bg-s2 px-3.5 text-[15px] outline-none"
          />
          <label className="mt-3 block text-[13px] text-t3">Allowlist end</label>
          <input
            type="datetime-local"
            value={alEnd}
            onChange={(e) => setAlEnd(e.target.value)}
            className="mt-1 h-12 w-full rounded-xl border border-hair bg-s2 px-3.5 text-[15px] outline-none"
          />
          <button
            type="button"
            disabled={!!busy}
            onClick={() => void run('schedule')}
            className="mt-3 inline-flex h-11 items-center rounded-xl bg-lime px-4 text-[14px] font-semibold text-white disabled:opacity-50"
          >
            {busy === 'schedule' ? 'Saving…' : 'Update schedule'}
          </button>
        </section>

        <section>
          <h3 className="text-[15px] font-semibold">Allowlist</h3>
          <p className="mt-1 text-[13px] text-t3">
            One wallet per line or CSV. Sign to store the list, then confirm the root on-chain.
          </p>
          <textarea
            value={wallets}
            onChange={(e) => setWallets(e.target.value)}
            placeholder="0x…"
            className="mt-2 h-36 w-full rounded-xl border border-hair bg-s2 px-3.5 py-3 font-mono text-[13px] outline-none"
          />
          <p className="mt-1 text-[13px] text-t3">{parsed} unique wallets</p>
          <button
            type="button"
            disabled={!!busy}
            onClick={() => void run('allowlist')}
            className="mt-3 inline-flex h-11 items-center rounded-xl bg-lime px-4 text-[14px] font-semibold text-white disabled:opacity-50"
          >
            {busy === 'allowlist' ? 'Saving…' : 'Set allowlist'}
          </button>
        </section>

        <section>
          <h3 className="text-[15px] font-semibold">Team / reserved mint</h3>
          <p className="mt-1 text-[13px] text-t3">
            Free mint into a wallet. Counts against supply, not against per-wallet cap. Needs the updated collection contract.
          </p>
          <input
            value={teamTo}
            onChange={(e) => setTeamTo(e.target.value.trim())}
            placeholder="0x…"
            className="mt-2 h-12 w-full rounded-xl border border-hair bg-s2 px-3.5 font-mono text-[14px] outline-none"
          />
          <input
            inputMode="numeric"
            value={teamN}
            onChange={(e) => setTeamN(e.target.value.replace(/[^\d]/g, ''))}
            placeholder="Count"
            className="mt-2 h-12 w-full rounded-xl border border-hair bg-s2 px-3.5 text-[15px] outline-none"
          />
          <button
            type="button"
            disabled={!!busy}
            onClick={() => void run('team')}
            className="mt-3 inline-flex h-11 items-center rounded-xl bg-lime px-4 text-[14px] font-semibold text-white disabled:opacity-50"
          >
            {busy === 'team' ? 'Minting…' : 'Mint to team'}
          </button>
        </section>

        {note ? <p className="text-[13px] text-lime-t">{note}</p> : null}
        {err ? <p className="text-[13px] text-coral">{err}</p> : null}
      </div>
    </PortSheet>
  )
}
