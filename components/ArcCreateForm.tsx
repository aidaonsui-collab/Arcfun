'use client'

/**
 * Launch on Arc — Instant or Instant Reflection (both TOKEN/USDC + holder rewards path).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAccount, useConnect, useSwitchChain, useWriteContract, useSignMessage } from 'wagmi'
import { erc20Abi, formatUnits, getAddress, isAddress, type Address } from 'viem'
import { prepareTokenRegisterAuth } from '@/lib/arc-auth'
import { Loader2, AlertCircle, CheckCircle, ImagePlus, ChevronDown } from 'lucide-react'
import {
  ARC,
  ARC_CHAIN_ID,
  ARC_INSTANT_CREATE_GAS,
  ARC_ERC20_APPROVE_GAS,
  ARC_SWAP_GAS,
  ARC_MAX_APPROVAL,
  arcInstantEnabled,
  arcReflectionEnabled,
  arcLaunchesEnabled,
  arcInstantV4UiEnabled,
  arcInstantV4Enabled,
  arcCreationFeeWeiFor,
  arcPublicClient,
} from '@/lib/contracts-arc'
import {
  buildCreateTokenMemeInstantArc,
  parseArcQuote,
} from '@/lib/arc-instant-launchpad'
import { buildCreateTokenEveV4, EVE_V4_DEFAULT_VIRTUAL_QUOTE } from '@/lib/eve-instant-v4-launchpad'
import { estimateInstantFirstBuyTokens, instantListedMcUsd } from '@/lib/instant-first-buy'
import {
  liveRwaQuoteAssets,
  pendingRwaQuoteAssets,
  rwaAssetById,
  defaultRwaVirtualQuoteRaw,
  quotePayUsdcSwap,
  quotePolicy,
  quoteUsesUsdInput,
  usdToQuoteHuman,
  type ArcRwaAsset,
} from '@/lib/arc-rwa-assets'
import { BundleBasketCard } from '@/components/BundleBasketCard'
import {
  RWA_V4_FACTORY_ABI,
  basketValid,
  buildCreateTokenRwaV4,
  buildCreateTokenWithBundle,
  buildSetBasket,
  rwaBundleFactoryReady,
  type BasketRow,
  type BundlePayoutMode,
} from '@/lib/rwa-bundle'
import {
  buildCreateTokenReflectionArc,
  ARC_REFLECTION_CREATE_GAS,
} from '@/lib/arc-reflection-launchpad'
import { waitArcCreateConfirmed, waitArcTxConfirmed } from '@/lib/arc-wait-create'
import {
  HANDLE_PAY_FACTORY,
  HANDLE_PAY_FACTORY_ABI,
  HANDLE_PAY_DEPLOY_GAS,
  handleHashFor,
  handlePayEnabled,
  normaliseXHandle,
  readHandlePayVaultOf,
  computeHandlePayVault,
} from '@/lib/handle-pay'
import { uploadImage } from '@/lib/upload-image'
import { fmtCompact, fmtUsd } from '@/lib/ui-format'
import { TokenCard } from '@/components/TokenCard'
import { FeeSplitCard } from '@/components/FeeSplitCard'
import {
  FEE_SPLIT_PRESETS,
  MIN_REFLECT_HOLDERS_BPS,
  foldHoldersIntoCreator,
  splitValid,
  type FeeSplit,
} from '@/lib/eve-fee-split'
import { useArcErc20Balance } from '@/lib/use-arc-erc20-balance'
import type { PoolToken } from '@/lib/tokens'
import { prefillFromSearch, type BlitzPrefill } from '@/lib/arc-blitz'
import { fetchBtcUsdSpot, formatCirBtcApprox } from '@/lib/btc-usd-spot'
import { parseUsdc, planUsdcBuyOfToken } from '@/lib/arc-swap'

type Step =
  | 'idle'
  | 'uploading'
  | 'vault'
  | 'approving'
  | 'swapping'
  | 'creating'
  | 'confirming'
  | 'basket'
  | 'registering'
  | 'done'
type RewardsMode = 'wallet' | 'handle'
type LaunchType = 'instant' | 'reflection'

const LAUNCH_TYPES: {
  key: LaunchType
  title: string
  body: string
}[] = [
  {
    key: 'instant',
    title: 'Meme',
    body: 'Tradable from block one. Quote fees: creator 50 · Crucible 25 · burn 10 · platform 10 · referrer 5.',
  },
  {
    key: 'reflection',
    title: 'Reflect',
    body: 'Holders earn 20% of the quote-fee leg. Crucible is the $EVE holder reward.',
  },
]

const LAUNCH_TYPES_V4: {
  key: LaunchType
  title: string
  body: string
}[] = [
  {
    key: 'instant',
    title: 'Meme',
    body: 'Tradable from block one. You pick the pool fee and where it goes.',
  },
  {
    key: 'reflection',
    title: 'Reflect',
    body: 'Holders take a cut of every swap. At least 20% on the fee card.',
  },
]

/** Dollar chips for peg/spot quotes; other quotes use token units (never fake $). */
function firstBuyPresets(quoteId: string, asset: ArcRwaAsset | null): string[] {
  if (quoteUsesUsdInput(asset, quoteId)) {
    return quotePolicy(asset).usd === 'spot' ? ['10', '100', '1000'] : ['100', '250', '1000']
  }
  const decimals = asset?.decimals || 6
  if (decimals === 8) return ['0.0001', '0.001', '0.01']
  if (decimals >= 18) return ['1', '10', '50']
  return ['1', '10', '50']
}

function defaultFirstBuy(quoteId: string, asset: ArcRwaAsset | null): string {
  return firstBuyPresets(quoteId, asset)[1] || '0'
}

export function ArcCreateForm({
  initial,
  compact = false,
}: {
  initial?: BlitzPrefill
  compact?: boolean
} = {}) {
  const router = useRouter()
  const { address, isConnected, chainId } = useAccount()
  const { connect, connectors, isPending: connecting } = useConnect()
  const { switchChain, isPending: switching } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()
  const { signMessageAsync } = useSignMessage()

  const [launchType, setLaunchType] = useState<LaunchType>('instant')
  /** Instant quote asset. `usdc` is the live factory; an RWA id is plug-and-play. */
  const [quoteId, setQuoteId] = useState('usdc')
  const [feeSplit, setFeeSplit] = useState<FeeSplit>(FEE_SPLIT_PRESETS.creator)
  const [feeOpen, setFeeOpen] = useState(false)
  const [bundleOn, setBundleOn] = useState(false)
  const [bundleMode, setBundleMode] = useState<BundlePayoutMode>('all')
  const [basketRows, setBasketRows] = useState<BasketRow[]>([])
  const [name, setName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [description, setDescription] = useState('')
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string>('')
  const [imageRemote, setImageRemote] = useState<string>('')
  const [twitter, setTwitter] = useState('')
  const [telegram, setTelegram] = useState('')
  const [website, setWebsite] = useState('')
  const [rewardsWallet, setRewardsWallet] = useState('')
  const [rewardsMode, setRewardsMode] = useState<RewardsMode>('wallet')
  const [rewardsHandle, setRewardsHandle] = useState('')
  const payToHandle = handlePayEnabled()
  /** Holder reward ERC-20 — default Arc USDC (6dp). Pool quote is always USDC. */
  const [rewardToken, setRewardToken] = useState<string>(ARC.USDC)
  const [buyAtLaunch, setBuyAtLaunch] = useState(false)
  const [firstBuy, setFirstBuy] = useState(() => defaultFirstBuy('usdc', null))
  /** Live BTC-USD spot for spot-quoted first-buy / virtual quote. */
  const [btcUsd, setBtcUsd] = useState<number | null>(null)
  const [btcUsdStatus, setBtcUsdStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')

  const [step, setStep] = useState<Step>('idle')
  const [error, setError] = useState<string | null>(null)
  // Set only when the on-chain create succeeded but the off-chain name/image/socials write
  // (a signed, separate step — see prepareTokenRegisterAuth) failed or the creator dismissed
  // that second wallet prompt. The token is already live either way; this just remembers enough
  // to retry the metadata write without asking the creator to fill the form out again.
  const [pendingRegister, setPendingRegister] = useState<{
    token: Address
    payload: Record<string, unknown>
  } | null>(null)
  const [pendingBasket, setPendingBasket] = useState<{
    token: Address
    sink: Address
    quote: Address
  } | null>(null)
  const [registerError, setRegisterError] = useState<string | null>(null)
  const [registering, setRegistering] = useState(false)

  const wrongChain = isConnected && chainId !== ARC_CHAIN_ID
  const configured = arcInstantEnabled()
  const reflectionLive = arcReflectionEnabled()
  /** Public creates on by default; set NEXT_PUBLIC_ARC_LAUNCHES_ENABLED=0 to pause. */
  const launchesLive = arcLaunchesEnabled()
  const busy = step !== 'idle' && step !== 'done'
  const liveRwas = liveRwaQuoteAssets()
  const pendingRwas = pendingRwaQuoteAssets()
  // Create-ready quotes (incl. permissioned USYC) are selectable — first-buy UI is quote-aware.
  // True pending (no issuer CA / factory) stay Soon in the picker.
  const openRwas = liveRwas.filter((a) => !a.permissioned)
  const readyGatedRwas = liveRwas.filter((a) => a.permissioned)
  const selectableRwas = [...openRwas, ...readyGatedRwas]
  const soonRwas = pendingRwas
  const rwaQuote = quoteId !== 'usdc' ? rwaAssetById(quoteId) : null
  const usdInput = quoteUsesUsdInput(rwaQuote, quoteId)
  const payUsdcSwap = quotePayUsdcSwap(rwaQuote)
  const spotUsd = quotePolicy(rwaQuote).usd === 'spot'

  const quoteDecimalsLive = rwaQuote?.decimals || 6
  const quoteTokenLive = (rwaQuote?.address as Address | undefined) || ARC.USDC
  const quoteBalQ = useArcErc20Balance(
    quoteTokenLive,
    isConnected && chainId === ARC_CHAIN_ID ? address : undefined,
  )
  const usdcBalQ = useArcErc20Balance(
    ARC.USDC,
    isConnected && chainId === ARC_CHAIN_ID && payUsdcSwap ? address : undefined,
  )

  // Keep first-buy amount in the active quote's units when the pair changes.
  // Spot quotes keep USD string state (converted to quote raw only at submit).
  useEffect(() => {
    setFirstBuy(defaultFirstBuy(quoteId, rwaQuote))
  }, [quoteId, quoteDecimalsLive, rwaQuote])

  const quoteSymbol = rwaQuote?.symbol || 'USDC'
  const cirBtcUsdInput = spotUsd

  const refreshBtcUsd = useCallback(async (force = false) => {
    if (!spotUsd) return null
    setBtcUsdStatus((s) => (s === 'ready' && !force ? s : 'loading'))
    const price = await fetchBtcUsdSpot({ force })
    if (price == null) {
      setBtcUsdStatus('error')
      return null
    }
    setBtcUsd(price)
    setBtcUsdStatus('ready')
    return price
  }, [spotUsd])

  useEffect(() => {
    if (!spotUsd) {
      setBtcUsdStatus('idle')
      return
    }
    let cancelled = false
    ;(async () => {
      const price = await fetchBtcUsdSpot()
      if (cancelled) return
      if (price == null) {
        setBtcUsdStatus('error')
        return
      }
      setBtcUsd(price)
      setBtcUsdStatus('ready')
    })()
    const t = window.setInterval(() => {
      void fetchBtcUsdSpot({ force: true }).then((price) => {
        if (cancelled || price == null) return
        setBtcUsd(price)
        setBtcUsdStatus('ready')
      })
    }, 60_000)
    return () => {
      cancelled = true
      window.clearInterval(t)
    }
  }, [spotUsd])
  const isReflection = launchType === 'reflection'
  const v4Ui = arcInstantV4UiEnabled()
  const v4Live = arcInstantV4Enabled()
  const rwaFactoryAddr = (() => {
    if (!rwaQuote) return null
    const f = (rwaQuote.factory || '').toLowerCase()
    const v3 = ARC.INSTANT_FACTORY.toLowerCase()
    const eve = ARC.INSTANT_V4_FACTORY.toLowerCase()
    if (f && rwaBundleFactoryReady(rwaQuote.factory) && f !== v3 && f !== eve) {
      return rwaQuote.factory as Address
    }
    if (ARC.INSTANT_V4_RWA_FACTORY && ARC.INSTANT_V4_RWA_FACTORY !== '0x0000000000000000000000000000000000000000') {
      return ARC.INSTANT_V4_RWA_FACTORY
    }
    return null
  })()
  const rwaV4Live = Boolean(v4Live && rwaQuote && rwaFactoryAddr)
  const bundleLive = rwaV4Live
  const hideHolders = Boolean(rwaQuote) && !bundleOn
  const minHoldersBps = isReflection
    ? MIN_REFLECT_HOLDERS_BPS
    : bundleOn
      ? 100
      : 0
  // RWA factory reverts HoldersNotOnRwa unless Bundle is on — fold any leftover holders slice.
  useEffect(() => {
    if (!hideHolders || feeSplit.holdersBps === 0) return
    setFeeSplit((s) => foldHoldersIntoCreator(s))
  }, [hideHolders, feeSplit.holdersBps])
  const feeOk = !v4Ui || splitValid(feeSplit, { hideHolders, minHoldersBps }).ok
  const basketCheck = bundleOn
    ? basketValid(basketRows, {
        quote: ((rwaQuote?.address as Address) || ARC.USDC) as Address,
        mode: bundleMode,
      })
    : { ok: true, reason: null as string | null }
  const handleNorm = normaliseXHandle(rewardsHandle)
  const handleMode = payToHandle && rewardsMode === 'handle'
  const rewardsOk = handleMode
    ? !!handleNorm
    : !rewardsWallet.trim() || isAddress(rewardsWallet.trim() as Address)
  const rewardTokenOk = isAddress(rewardToken)

  const onPickImage = (f: File | null) => {
    setImageFile(f)
    setImageRemote('')
    setImagePreview(f ? URL.createObjectURL(f) : '')
  }

  const applyPrefill = (p: BlitzPrefill) => {
    if (p.name) setName(p.name)
    if (p.symbol) setSymbol(p.symbol)
    if (p.description) setDescription(p.description)
    if (p.twitter) setTwitter(p.twitter)
    if (p.website) setWebsite(p.website)
    if (p.imageUrl) {
      setImageFile(null)
      setImageRemote(p.imageUrl)
      setImagePreview(`/api/arc/blitz/media?u=${encodeURIComponent(p.imageUrl)}`)
    } else {
      setImageFile(null)
      setImageRemote('')
      setImagePreview('')
    }
    setLaunchType('instant')
  }

  useEffect(() => {
    if (initial) {
      applyPrefill(initial)
      return
    }
    if (compact) return
    try {
      const p = prefillFromSearch(new URLSearchParams(window.location.search))
      if (p) applyPrefill(p)
    } catch {
      /* ignore */
    }
    // Blitz desk passes a new `initial` when the picked tweet changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial, compact])

  /** Signs + POSTs the off-chain name/image/socials record. Returns false rather than throwing —
   *  callers decide what "the creator never got to sign, or the write failed" means for the UI. */
  const submitRegister = async (token: Address, payload: Record<string, unknown>): Promise<boolean> => {
    try {
      const prepared = prepareTokenRegisterAuth(token, payload)
      const signature = await signMessageAsync({ message: prepared.message })
      const res = await fetch('/api/arc/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...payload,
          signature,
          timestamp: prepared.timestamp,
          nonce: prepared.nonce,
        }),
      })
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null
        setRegisterError(j?.error || `save failed (${res.status})`)
        return false
      }
      setRegisterError(null)
      return true
    } catch (e: unknown) {
      const ax = e as { shortMessage?: string; message?: string }
      // Most common case in practice: the creator closed the second wallet prompt.
      setRegisterError(ax?.shortMessage || ax?.message || 'signature was not completed')
      return false
    }
  }

  const retryRegister = async () => {
    if (!pendingRegister || registering) return
    setRegistering(true)
    const ok = await submitRegister(pendingRegister.token, pendingRegister.payload)
    setRegistering(false)
    if (ok) setPendingRegister(null)
  }

  const onSubmit = async () => {
    if (!address) return
    if (!launchesLive) {
      setError('Token launches are temporarily paused — check back soon.')
      return
    }
    if (isReflection && !v4Live && !reflectionLive) {
      setError('Reflection factory isn’t live on Arc yet — pick Meme Launch to ship today.')
      return
    }
    if (handleMode && !handleNorm) {
      setError('Enter a valid X handle (or switch back to wallet).')
      return
    }
    if (!handleMode && !rewardsOk) {
      setError('Rewards wallet must be a valid 0x address (or leave blank to use your wallet).')
      return
    }
    if (isReflection && !v4Live && !rewardTokenOk) {
      setError('Reward token must be a valid ERC-20 address (e.g. Arc USDC).')
      return
    }
    // rewardToken may be Arc USDC (holders earn USDC) or any other ERC-20 with a USDC pool.
    setError(null)
    try {
      let imageUrl = ''
      if (imageFile) {
        setStep('uploading')
        imageUrl = await uploadImage(imageFile, 'arcfun')
      } else if (imageRemote) {
        setStep('uploading')
        const imgRes = await fetch(`/api/arc/blitz/media?u=${encodeURIComponent(imageRemote)}`)
        if (!imgRes.ok) throw new Error('Could not pull the tweet image')
        const blob = await imgRes.blob()
        const file = new File([blob], 'blitz.jpg', { type: blob.type || 'image/jpeg' })
        imageUrl = await uploadImage(file, 'arcfun')
      }

      const feeWei = arcCreationFeeWeiFor(address)
      let rewardsAddr: Address | null =
        !handleMode && rewardsWallet.trim() && isAddress(rewardsWallet.trim() as Address)
          ? (rewardsWallet.trim() as Address)
          : null

      if (handleMode && handleNorm && !bundleOn) {
        setStep('vault')
        const existing = await readHandlePayVaultOf(handleNorm)
        if (!existing || /^0x0+$/i.test(existing)) {
          const vaultHash = await writeContractAsync({
            address: HANDLE_PAY_FACTORY,
            abi: HANDLE_PAY_FACTORY_ABI,
            functionName: 'deployVault',
            args: [handleHashFor(handleNorm)],
            chainId: ARC_CHAIN_ID,
            gas: HANDLE_PAY_DEPLOY_GAS,
          })
          await waitArcTxConfirmed(vaultHash)
        }
        const vault = await computeHandlePayVault(handleNorm)
        if (!vault || /^0x0+$/i.test(vault)) {
          throw new Error('Could not resolve the handle vault address.')
        }
        rewardsAddr = vault
      }

      let hash: `0x${string}`
      let token: Address | undefined
      let pool: Address | undefined

      const quoteDecimals = rwaQuote?.decimals || 6
      let firstBuyQuote = 0n
      let firstBuyUsdForErr: number | null = null
      if (buyAtLaunch && firstBuy && Number(firstBuy) > 0) {
        if (spotUsd) {
          firstBuyUsdForErr = Number(firstBuy)
          const spot = await refreshBtcUsd(true)
          if (spot == null || !(spot > 0)) {
            throw new Error(`Could not fetch USD price for ${quoteSymbol}. Retry in a moment.`)
          }
          const quoteAmt = usdToQuoteHuman(firstBuyUsdForErr, spot, quoteDecimals)
          if (!(Number(quoteAmt) > 0)) {
            throw new Error('First buy amount is too small after USD conversion.')
          }
          firstBuyQuote = parseArcQuote(quoteAmt, quoteDecimals)
        } else {
          firstBuyQuote = parseArcQuote(firstBuy, quoteDecimals)
        }
      }
      // Belt-and-suspenders: never send holdersBps to plain RWA createToken.
      const splitForCreate =
        Boolean(rwaQuote) && !bundleOn ? foldHoldersIntoCreator(feeSplit) : feeSplit
      const factory =
        rwaV4Live && rwaFactoryAddr
          ? rwaFactoryAddr
          : v4Live
            ? ARC.INSTANT_V4_FACTORY
            : isReflection
              ? ARC.REFLECTION_FACTORY
              : rwaQuote?.factory
                ? (rwaQuote.factory as Address)
                : ARC.INSTANT_FACTORY
      const quoteToken = (rwaQuote?.address as Address) || ARC.USDC

      if (firstBuyQuote > 0n) {
        const client = arcPublicClient()
        let bal = (await client.readContract({
          address: quoteToken,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [address],
        })) as bigint

        // Instant still pulls the quote token. USD input → swap USDC to quote first.
        if (payUsdcSwap && bal < firstBuyQuote && firstBuyUsdForErr != null) {
          const usdcIn = parseUsdc(firstBuyUsdForErr)
          if (usdcIn <= 0n) {
            throw new Error('First buy amount is too small.')
          }
          const usdcBal = (await client.readContract({
            address: ARC.USDC,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [address],
          })) as bigint
          if (usdcBal < usdcIn) {
            throw new Error(
              `First buy needs $${firstBuyUsdForErr.toFixed(2)} USDC to swap into ${quoteSymbol} (wallet has $${Number(formatUnits(usdcBal, 6)).toFixed(2)}).`,
            )
          }
          const plan = await planUsdcBuyOfToken(quoteToken, usdcIn, address, 100)
          if (!plan) {
            throw new Error(`Could not quote USDC → ${quoteSymbol}. The ${quoteSymbol}/USDC pool may be unavailable.`)
          }
          const usdcAllow = (await client.readContract({
            address: ARC.USDC,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [address, plan.spender],
          })) as bigint
          if (usdcAllow < usdcIn) {
            setStep('approving')
            await writeContractAsync({
              address: ARC.USDC,
              abi: erc20Abi,
              functionName: 'approve',
              args: [plan.spender, ARC_MAX_APPROVAL],
              chainId: ARC_CHAIN_ID,
              gas: ARC_ERC20_APPROVE_GAS,
            })
          }
          setStep('swapping')
          const swapHash = await writeContractAsync({
            address: plan.call.address,
            abi: plan.call.abi as never,
            functionName: plan.call.functionName as never,
            args: plan.call.args as never,
            chainId: plan.call.chainId,
            gas: ARC_SWAP_GAS,
          })
          await waitArcTxConfirmed(swapHash)
          const cirAfter = (await client.readContract({
            address: quoteToken,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [address],
          })) as bigint
          const received = cirAfter > bal ? cirAfter - bal : cirAfter
          if (received <= 0n) {
            throw new Error(`USDC → ${quoteSymbol} swap returned no ${quoteSymbol}.`)
          }
          firstBuyQuote = received
          bal = cirAfter
        }

        if (bal < firstBuyQuote) {
          const need = formatUnits(firstBuyQuote, quoteDecimals)
          const have = formatUnits(bal, quoteDecimals)
          if (payUsdcSwap && firstBuyUsdForErr != null) {
            throw new Error(
              `First buy needs ${need} ${quoteSymbol} (≈ $${firstBuyUsdForErr.toFixed(2)}; wallet has ${have} ${quoteSymbol}). Swap USDC → ${quoteSymbol} failed or was short.`,
            )
          }
          throw new Error(
            `First buy needs ${need} ${rwaQuote?.symbol || 'USDC'} (wallet has ${have}). This field is in ${rwaQuote?.symbol || 'USDC'}, not USD.`,
          )
        }
        const allowed = (await client.readContract({
          address: quoteToken,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [address, factory],
        })) as bigint
        if (allowed < firstBuyQuote) {
          setStep('approving')
          await writeContractAsync({
            address: quoteToken,
            abi: erc20Abi,
            functionName: 'approve',
            args: [factory, ARC_MAX_APPROVAL],
            chainId: ARC_CHAIN_ID,
            gas: ARC_ERC20_APPROVE_GAS,
          })
        }
      }

      if (rwaV4Live && bundleOn && bundleLive) {
        setStep('creating')
        const creator = address
        const call = buildCreateTokenWithBundle({
          factory,
          name: name.trim(),
          symbol: symbol.trim(),
          quote: quoteToken,
          creator,
          firstBuyQuoteRaw: firstBuyQuote,
          split: splitForCreate,
          launchVirtualQuote: rwaQuote
            ? defaultRwaVirtualQuoteRaw(rwaQuote, {
                btcUsd: spotUsd ? await refreshBtcUsd(true) : undefined,
              })
            : undefined,
        })
        hash = await writeContractAsync({
          address: call.address,
          abi: call.abi as never,
          functionName: call.functionName as never,
          args: call.args as never,
          chainId: call.chainId,
          gas: ARC_INSTANT_CREATE_GAS,
        })
        setStep('confirming')
        const created = await waitArcCreateConfirmed(hash)
        token = created.token
        pool = created.pool
        const row = (await arcPublicClient().readContract({
          address: factory,
          abi: RWA_V4_FACTORY_ABI,
          functionName: 'poolOf',
          args: [token],
        })) as readonly [Address, Address, Address, Address, `0x${string}`]
        const sink = row[3]
        if (!sink || /^0x0+$/i.test(sink)) {
          throw new Error('Token launched but the bundle sink address was missing.')
        }
        setStep('basket')
        try {
          const basketCall = buildSetBasket({
            sink,
            rows: basketRows,
            quote: quoteToken,
            mode: bundleMode,
          })
          const basketHash = await writeContractAsync({
            address: basketCall.address,
            abi: basketCall.abi as never,
            functionName: basketCall.functionName as never,
            args: basketCall.args as never,
            chainId: basketCall.chainId,
            gas: 1_200_000n,
          })
          await waitArcTxConfirmed(basketHash)
        } catch (e) {
          setPendingBasket({ token, sink, quote: quoteToken })
          throw e
        }
      } else if (rwaV4Live && rwaFactoryAddr) {
        setStep('creating')
        const creator = rewardsAddr || address
        const call = buildCreateTokenRwaV4({
          factory: rwaFactoryAddr,
          name: name.trim(),
          symbol: symbol.trim(),
          quote: quoteToken,
          creator,
          firstBuyQuoteRaw: firstBuyQuote,
          split: splitForCreate,
          launchVirtualQuote: rwaQuote
            ? defaultRwaVirtualQuoteRaw(rwaQuote, {
                btcUsd: spotUsd ? await refreshBtcUsd(true) : undefined,
              })
            : undefined,
        })
        hash = await writeContractAsync({
          address: call.address,
          abi: call.abi as never,
          functionName: call.functionName as never,
          args: call.args as never,
          chainId: call.chainId,
          gas: ARC_INSTANT_CREATE_GAS,
        })
        setStep('confirming')
        const created = await waitArcCreateConfirmed(hash)
        token = created.token
        pool = created.pool
      } else if (v4Live) {
        setStep('creating')
        const creator = rewardsAddr || address
        const call = buildCreateTokenEveV4({
          name: name.trim(),
          symbol: symbol.trim(),
          quote: quoteToken,
          creator,
          firstBuyQuoteRaw: firstBuyQuote,
          split: splitForCreate,
        })
        hash = await writeContractAsync({
          address: call.address,
          abi: call.abi as never,
          functionName: call.functionName as never,
          args: call.args as never,
          chainId: call.chainId,
          gas: ARC_INSTANT_CREATE_GAS,
        })
        setStep('confirming')
        const created = await waitArcCreateConfirmed(hash)
        token = created.token
        pool = created.pool
      } else if (isReflection) {
        setStep('creating')
        const call = buildCreateTokenReflectionArc(
          name.trim(),
          symbol.trim(),
          rewardToken as Address,
          firstBuyQuote,
          feeWei,
          rewardsAddr,
        )
        hash = await writeContractAsync({
          address: call.address,
          abi: call.abi as never,
          functionName: call.functionName as never,
          args: call.args as never,
          value: call.value,
          chainId: call.chainId,
          gas: ARC_REFLECTION_CREATE_GAS,
        })
        setStep('confirming')
        const created = await waitArcCreateConfirmed(hash)
        token = created.token
        pool = created.pool
      } else {
        setStep('creating')
        const call = buildCreateTokenMemeInstantArc(
          name.trim(),
          symbol.trim(),
          firstBuyQuote,
          feeWei,
          rewardsAddr,
          isReflection ? undefined : (rwaQuote?.factory as Address | undefined),
        )
        hash = await writeContractAsync({
          address: call.address,
          abi: call.abi as never,
          functionName: call.functionName as never,
          args: call.args as never,
          value: call.value,
          chainId: call.chainId,
          gas: ARC_INSTANT_CREATE_GAS,
        })
        setStep('confirming')
        const created = await waitArcCreateConfirmed(hash)
        token = created.token
        pool = created.pool
      }

      if (!token)
        throw new Error(
          'Token created, but could not read its address from the transaction. Check ArcScan.',
        )

      // No signature, can't meaningfully fail, best-effort — see the route's own comment for why
      // this is safe with zero auth: name/symbol/creator are chain reads, not client claims. This
      // runs BEFORE the signed step below so a token's basic identity never again depends on that
      // second wallet prompt being completed.
      try {
        await fetch('/api/arc/register/identity', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token: getAddress(token),
            pool: pool || '',
            dexVenue: v4Live ? 'v4' : 'v3',
            feeBps: feeSplit.feeBps,
          }),
        })
      } catch {
        /* purely a cache warm — every reader already falls back to the same chain reads */
      }

      setStep('registering')
      const registerPayload = {
        token: getAddress(token),
        name: name.trim(),
        symbol: symbol.trim(),
        description: description.trim() || '',
        imageUrl: imageUrl || '',
        twitter: twitter.trim(),
        telegram: telegram.trim(),
        website: website.trim(),
        streamUrl: '',
        pool: pool || '',
        rewardsHandle: handleMode && handleNorm ? handleNorm : '',
      }
      const registered = await submitRegister(token, registerPayload)

      setStep('done')
      if (registered) {
        router.push(`/token/${token}`)
      } else {
        // Do NOT navigate away silently. The token's name/symbol are already safe regardless —
        // written above with no signature required, and every reader falls back to the same live
        // chain reads anyway — so what's actually at risk here is only the image/description/
        // socials, which genuinely do need the creator's signature (arbitrary content, nothing
        // on-chain to check it against). Stay put with a retry banner instead of navigating away
        // as if nothing happened; the creator can still jump to the token page themselves once
        // they've had a chance to fix it, or on purpose if they don't care.
        setPendingRegister({ token, payload: registerPayload })
      }
    } catch (e: unknown) {
      const ax = e as { shortMessage?: string; message?: string }
      const msg = ax?.shortMessage || ax?.message || String(e)
      setError(msg.length > 200 ? msg.slice(0, 200) + '…' : msg)
      setStep('idle')
    }
  }

  const canSubmit =
    launchesLive &&
    isConnected &&
    !wrongChain &&
    name.trim().length > 0 &&
    symbol.trim().length > 0 &&
    !busy &&
    // step 'done' + a pending metadata retry means the on-chain create already happened —
    // busy alone doesn't cover this window, and without this guard the re-enabled "Launched"
    // button re-runs the whole mint flow (fresh signatures, a second on-chain token) instead of
    // just retrying the metadata save the banner is there for.
    !pendingRegister &&
    rewardsOk &&
    feeOk &&
    !pendingBasket &&
    (!bundleOn || (bundleLive && basketCheck.ok)) &&
    (v4Live
      ? true
      : isReflection
        ? reflectionLive && rewardTokenOk
        : configured)

  if (!configured && !reflectionLive) {
    return (
      <div className="rounded-[22px] border border-amber-500/25 bg-amber-500/10 p-4 text-sm text-amber-100">
        Arc launch factories aren&apos;t configured — set NEXT_PUBLIC_ARC_INSTANT_* and/or
        NEXT_PUBLIC_ARC_REFLECTION_*.
      </div>
    )
  }

  const rewardsPreview = handleMode && handleNorm
    ? `@${handleNorm}`
    : rewardsWallet.trim() && isAddress(rewardsWallet.trim() as Address)
      ? `${rewardsWallet.trim().slice(0, 6)}…${rewardsWallet.trim().slice(-4)}`
      : 'Your wallet'
  const feeUsd = v4Live ? 0 : Number(arcCreationFeeWeiFor(address)) / 1e18
  const buyAmt = buyAtLaunch ? Number(firstBuy) || 0 : 0
  const cirBtcApproxLabel = spotUsd ? formatCirBtcApprox(buyAmt, btcUsd) : null
  const virtualQuoteRaw = rwaQuote
    ? defaultRwaVirtualQuoteRaw(rwaQuote, { btcUsd })
    : EVE_V4_DEFAULT_VIRTUAL_QUOTE
  const usdPerQuote = spotUsd ? (btcUsd != null && btcUsd > 0 ? btcUsd : 0) : usdInput ? 1 : 0
  const listedMcUsd = instantListedMcUsd({
    virtualQuoteRaw,
    quoteDecimals: quoteDecimalsLive,
    usdPerQuote,
  })
  let firstBuyTokens = 0
  if (buyAtLaunch && buyAmt > 0 && !(spotUsd && !(btcUsd != null && btcUsd > 0))) {
    try {
      const quoteHuman = spotUsd && btcUsd
        ? usdToQuoteHuman(buyAmt, btcUsd, quoteDecimalsLive)
        : firstBuy
      const quoteInRaw = parseArcQuote(quoteHuman, quoteDecimalsLive)
      firstBuyTokens = estimateInstantFirstBuyTokens({
        quoteInRaw,
        virtualQuoteRaw,
        tokenDecimals: 18,
        feeBps: v4Ui ? feeSplit.feeBps : 100,
      })
    } catch {
      firstBuyTokens = 0
    }
  }
  const ticker = (symbol || '').trim().toUpperCase() || 'tokens'
  const firstBuyTokensLabel =
    firstBuyTokens > 0 ? `~${fmtCompact(firstBuyTokens)} ${ticker === 'tokens' ? 'tokens' : `$${ticker}`}` : null
  const firstBuyLabel = usdInput
    ? spotUsd && cirBtcApproxLabel
      ? `$${buyAmt.toFixed(2)} (≈ ${cirBtcApproxLabel} ${quoteSymbol})`
      : `$${buyAmt.toFixed(2)}`
    : `${buyAmt} ${quoteSymbol}`
  const payLabel = usdInput
    ? spotUsd && cirBtcApproxLabel
      ? feeUsd > 0
        ? `$${feeUsd.toFixed(2)} + $${buyAmt.toFixed(2)} (≈ ${cirBtcApproxLabel} ${quoteSymbol})`
        : `$${buyAmt.toFixed(2)} (≈ ${cirBtcApproxLabel} ${quoteSymbol})`
      : `$${(feeUsd + buyAmt).toFixed(2)}`
    : feeUsd > 0
      ? `$${feeUsd.toFixed(2)} + ${buyAmt} ${quoteSymbol}`
      : `${buyAmt} ${quoteSymbol}`
  const walletLabel =
    !isConnected
      ? 'Not connected'
      : quoteBalQ.data == null
        ? quoteBalQ.isPending
          ? '…'
          : '—'
        : quoteId === 'usdc'
          ? fmtUsd(Number(formatUnits(quoteBalQ.data, quoteDecimalsLive)))
          : `${formatUnits(quoteBalQ.data, quoteDecimalsLive)} ${quoteSymbol}`
  const previewToken: PoolToken = {
    id: 'preview',
    poolId: '',
    coinType: '',
    name: name.trim() || 'Untitled',
    symbol: (symbol || 'TICKER').toUpperCase(),
    description: description.trim(),
    imageUrl: imagePreview || '',
    logoUrl: imagePreview || '',
    twitter: twitter.trim(),
    telegram: telegram.trim(),
    website: website.trim(),
    creator: address || '',
    creatorShort: '',
    creatorFull: address || '',
    rewardsHandle: handleMode && handleNorm ? handleNorm : undefined,
    currentPrice: listedMcUsd > 0 ? listedMcUsd / 1_000_000_000 : 0,
    realSuiRaised: 0,
    threshold: 0,
    progress: 100,
    isCompleted: true,
    volume1h: 0,
    priceChange24h: 0,
    age: '0s',
    marketCap: listedMcUsd,
    totalSupply: 1_000_000_000,
    bondingProgress: 100,
    createdAt: Date.now(),
    instant: true,
    instantLaunch: true,
    reflection: isReflection,
    launchKind: isReflection ? 'reflection' : 'instant',
    instantMeta: { quote: quoteSymbol, isMeme: !isReflection, isRwaBacked: Boolean(rwaQuote) },
  }

  const launchCta = !isConnected
    ? connecting
      ? 'Connecting…'
      : 'Connect to launch'
    : wrongChain
      ? switching
        ? 'Switching…'
        : 'Switch to Arc'
      : busy
        ? stepLabel(step)
        : step === 'done'
          ? 'Launched'
          : 'Launch token'

  const onCta = () => {
    if (!isConnected) {
      connect({ connector: connectors[0] })
      return
    }
    if (wrongChain) {
      switchChain({ chainId: ARC_CHAIN_ID })
      return
    }
    void onSubmit()
  }

  const typePicker = (
    <div>
      <div className="mb-2 text-xs text-t3">Type</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      {(v4Ui ? LAUNCH_TYPES_V4 : LAUNCH_TYPES).map((lt) => (
        <TypeCard
          key={lt.key}
          active={launchType === lt.key && (lt.key !== 'instant' || quoteId === 'usdc')}
          disabled={!launchesLive}
          soon={!launchesLive}
          title={lt.title}
          body={lt.body}
          onClick={
            launchesLive
              ? () => {
                  setLaunchType(lt.key)
                  setQuoteId('usdc')
                  setBundleOn(false)
                  if (lt.key === 'reflection') setFeeSplit(FEE_SPLIT_PRESETS.reflect)
                  else if (isReflection) setFeeSplit(FEE_SPLIT_PRESETS.creator)
                }
              : undefined
          }
        />
      ))}
      {selectableRwas.length > 0 || soonRwas.length > 0 ? (
        <RwaPairedPicker
          open={selectableRwas}
          gated={soonRwas}
          active={launchType === 'instant' && quoteId !== 'usdc' && Boolean(selectableRwas.some((a) => a.id === quoteId))}
          selectedId={selectableRwas.some((a) => a.id === quoteId) ? quoteId : null}
          v4Ui={v4Ui}
          disabled={!launchesLive}
          onSelect={(id) => {
            setLaunchType('instant')
            setQuoteId(id)
            setBundleOn(false)
            setFeeSplit(foldHoldersIntoCreator(feeSplit))
          }}
        />
      ) : null}
      </div>
    </div>
  )

  const fields = (
    <>
        {compact && initial?.handle ? (
          <p className="mt-2 mb-0 text-[13px] text-lime-t font-semibold">From @{initial.handle}</p>
        ) : null}

        {typePicker}

        {rwaQuote?.permissioned ? (
          <p className="mt-2 mb-0 text-[12px] text-amber-200/90 leading-snug">
            {quoteSymbol} is permissioned — Instant create works when the issuer has allowlisted the factory.
            {spotUsd
              ? `Enter first buy in USDC; it converts to ${quoteSymbol} at the live USD spot.`
              : usdInput
                ? `First buy is in ${quoteSymbol} (≈ USD).`
                : `First buy is in ${quoteSymbol} units, not USD.`}
          </p>
        ) : null}

        {v4Ui && launchesLive ? (
          <div className="mt-3 space-y-3">
            <FeeSplitCard
              split={feeSplit}
              onChange={setFeeSplit}
              hideHolders={hideHolders}
              minHoldersBps={minHoldersBps}
              preview={!v4Live}
              open={feeOpen}
              onOpenChange={setFeeOpen}
            />
            {rwaQuote ? (
              <BundleBasketCard
                enabled={bundleOn}
                onEnabled={(on) => {
                  setBundleOn(on)
                  if (on) {
                    setRewardsMode('wallet')
                    if (feeSplit.holdersBps === 0) setFeeSplit(FEE_SPLIT_PRESETS.reflect)
                  } else {
                    setFeeSplit(foldHoldersIntoCreator(feeSplit))
                  }
                }}
                mode={bundleMode}
                onMode={setBundleMode}
                rows={basketRows}
                onRows={setBasketRows}
                quoteId={rwaQuote.id}
                quoteSymbol={quoteSymbol}
                quoteAddress={(rwaQuote.address as string) || ''}
                preview={!bundleLive}
              />
            ) : null}
          </div>
        ) : null}

        {!launchesLive ? (
          <div className="mt-6 rounded-[22px] border border-hair bg-s1 px-5 py-6 text-center">
            <p className="m-0 text-[15px] font-semibold tracking-tightish text-white">
              Launches coming soon
            </p>
            <p className="mt-2 mb-0 text-[13px] text-t2 leading-relaxed max-w-md mx-auto">
              Instant, Reflection, and RWA paired launches are paused while we finish polishing.
              Trading existing tokens stays live.
            </p>
          </div>
        ) : (
          <>
            {isReflection && !v4Live && (
              <div className="mt-3 p-5 rounded-2xl bg-s1 border border-lime-line space-y-4">
                <div className="flex flex-col gap-1">
                  {v4Ui ? (
                    <>
                      <span className="text-[15px] font-semibold tracking-tightish">Holder reward token</span>
                      <span className="text-[13px] text-t2 leading-snug">
                        Holders slice is set on the fee card. This address is what they earn when
                        reflect() runs on the live Instant locker.
                      </span>
                    </>
                  ) : (
                    <>
                  <span className="text-[15px] font-semibold tracking-tightish">LP fee split</span>
                  <span className="text-[13px] text-t2 leading-snug">
                    Quote-side LP fees: <strong className="text-white">20% holders</strong> ·{' '}
                    <strong className="text-white">35% Crucible</strong> ·{' '}
                    <strong className="text-white">20% creator</strong> ·{' '}
                    <strong className="text-white">15% project burn</strong> ·{' '}
                    <strong className="text-white">10% platform</strong>. Referrals pay 0.05% on
                    eve.fun buys, not from this collect. Launch-token fees burn.
                  </span>
                    </>
                  )}
                  {!reflectionLive ? (
                    <span className="text-[12px] text-coral mt-1">
                      Reflection factory not configured — switch to Meme Launch.
                    </span>
                  ) : (
                    <span className="text-[12px] text-lime-t mt-1">
                      Live · TOKEN/USDC pool · factory {ARC.REFLECTION_FACTORY.slice(0, 10)}…
                    </span>
                  )}
                </div>
                <Field label="Holder reward token *">
                  <input
                    value={rewardToken}
                    onChange={(e) => setRewardToken(e.target.value.trim())}
                    placeholder="0x… ERC-20 holders earn (default Arc USDC)"
                    spellCheck={false}
                    className={FIELD}
                  />
                  <p className="mt-1.5 mb-0 text-[12px] text-t3 leading-snug">
                    Defaults to Arc USDC. The trading pair is always TOKEN/USDC; this address is the
                    token holders earn when reflect() runs.
                  </p>
                </Field>
              </div>
            )}

            <Field label="Token image *">
              <div className="flex items-center gap-5">
                <label className="w-24 h-24 rounded-full border-[1.5px] border-dashed border-white/20 bg-s1 flex flex-col items-center justify-center gap-1.5 cursor-pointer shrink-0 overflow-hidden hover:border-lime-line transition-colors">
                  {imagePreview ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={imagePreview} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <>
                      <ImagePlus className="w-5 h-5 text-t3" />
                      <span className="text-[11px] font-semibold text-t3">Upload</span>
                    </>
                  )}
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => onPickImage(e.target.files?.[0] ?? null)}
                  />
                </label>
                <span className="text-sm text-t2">PNG or JPG, 256px or larger. Square crops best.</span>
              </div>
            </Field>

            <Field label="Name *">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="eve"
                maxLength={64}
                className={FIELD}
              />
            </Field>
            <Field label="Ticker *">
              <input
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                placeholder="EVE"
                maxLength={12}
                className={`${FIELD} uppercase`}
              />
            </Field>
            <Field label="Description">
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                maxLength={500}
                placeholder="What is this token."
                className="w-full rounded-2xl bg-s1 px-4 py-3 text-sm outline-none border border-hair focus:border-lime-line placeholder:text-white/30 resize-none"
              />
            </Field>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {[
                { v: twitter, set: setTwitter, ph: '@handle or URL', label: 'X / Twitter' },
                { v: telegram, set: setTelegram, ph: 't.me/…', label: 'Telegram' },
                { v: website, set: setWebsite, ph: 'https://…', label: 'Website' },
              ].map((f) => (
                <Field key={f.label} label={f.label}>
                  <input
                    value={f.v}
                    onChange={(e) => f.set(e.target.value)}
                    placeholder={f.ph}
                    className={FIELD}
                  />
                </Field>
              ))}
            </div>

            <div>
              <div className="mb-2 text-xs text-t3">Creator rewards (optional)</div>
              {payToHandle && !bundleOn ? (
                <div className="mb-3 grid grid-cols-2 gap-1 p-1 rounded-2xl bg-s1 border border-hair">
                  {(
                    [
                      ['wallet', 'Wallet'],
                      ['handle', 'X handle'],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setRewardsMode(key)}
                      className={`h-9 rounded-xl text-[13px] font-semibold transition-colors ${
                        rewardsMode === key
                          ? 'bg-s2 border border-lime-line text-white'
                          : 'border border-transparent text-t2 hover:text-white'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              ) : null}
              {handleMode ? (
                <>
                  <input
                    value={rewardsHandle}
                    onChange={(e) => setRewardsHandle(e.target.value)}
                    placeholder="@handle or x.com/handle"
                    spellCheck={false}
                    className={FIELD}
                  />
                  <p className="mt-2 mb-0 text-[12px] text-t3 leading-snug">
                    {handleNorm ? (
                      <>
                        Creator LP fees go to <span className="text-lime-t">@{handleNorm}</span>
                        &apos;s on-chain vault. They claim at /claim-handle by verifying the handle.
                        Your first buy still lands in your wallet. This cannot be changed after launch.
                      </>
                    ) : (
                      'Pay creator fees to an X handle. Leave empty and switch back to Wallet to keep them yourself.'
                    )}
                  </p>
                  {rewardsHandle.trim() && !handleNorm && (
                    <p className="mt-1.5 mb-0 text-[12px] text-coral">Enter a valid X handle.</p>
                  )}
                </>
              ) : (
                <>
                  <input
                    value={rewardsWallet}
                    onChange={(e) => setRewardsWallet(e.target.value.trim())}
                    placeholder={address || '0x… leave blank to use your connected wallet'}
                    spellCheck={false}
                    className={`${FIELD} font-mono`}
                  />
                  <p className="mt-2 mb-0 text-[12px] text-t3 leading-snug">
                    Where the creator slice of the pool fee is paid
                    {v4Ui ? '' : ' (Instant: ~70% of quote-side fees)'}. Defaults to
                    the wallet that signs the create tx. Rewards to {rewardsPreview}.
                  </p>
                  {rewardsWallet.trim() && !rewardsOk && (
                    <p className="mt-1.5 mb-0 text-[12px] text-coral">Enter a valid 0x address.</p>
                  )}
                </>
              )}
            </div>

            <div className="flex items-center justify-between gap-4 p-4 rounded-2xl bg-s1 border border-hair">
              <div className="flex flex-col gap-0.5 pr-5">
                <span className="text-[15px] font-semibold tracking-tightish">Buy at launch</span>
                <span className="text-[13px] text-t3 leading-snug">
                  {spotUsd
                    ? `Bundle a first buy into create — enter USDC, settle in ${quoteSymbol}.`
                    : `Bundle a ${quoteSymbol} first buy into the create transaction.`}
                </span>
              </div>
              <Toggle on={buyAtLaunch} onToggle={() => setBuyAtLaunch((v) => !v)} />
            </div>

            {buyAtLaunch && (
              <Field label={spotUsd || usdInput ? (spotUsd ? 'Buy at launch · USDC' : `Buy at launch · ${quoteSymbol}`) : `Buy at launch · ${quoteSymbol}`}>
                <div className="flex items-center gap-3">
                  <input
                    value={firstBuy}
                    onChange={(e) => setFirstBuy(e.target.value.replace(/[^0-9.]/g, ''))}
                    inputMode="decimal"
                    className={FIELD}
                  />
                  <div className="flex gap-1.5 shrink-0">
                    {firstBuyPresets(quoteId, rwaQuote).map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setFirstBuy(p)}
                        className="px-3 py-1.5 rounded-full bg-s1 border border-hair text-[13px] font-semibold tabular-nums text-t2 hover:text-white"
                      >
                        {usdInput
                          ? p === '1000'
                            ? '$1K'
                            : `$${p}`
                          : p}
                      </button>
                    ))}
                  </div>
                </div>
                {firstBuyTokensLabel ? (
                  <p className="mt-2 mb-0 text-[13px] font-medium tabular-nums text-white">
                    You receive (est.) {firstBuyTokensLabel}
                  </p>
                ) : spotUsd && buyAmt > 0 && btcUsdStatus !== 'ready' ? (
                  <p className="mt-2 mb-0 text-[12px] text-t3">You receive (est.) …</p>
                ) : null}
                <p className="mt-2 mb-0 text-[12px] text-t3 leading-snug">
                  {spotUsd ? (
                    <>
                      Amount is in USDC (dollars), then converted to {quoteSymbol} at the live USD spot for the on-chain buy.
                      {btcUsdStatus === 'ready' && btcUsd != null
                        ? ` Spot ≈ $${btcUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}.`
                        : btcUsdStatus === 'loading'
                          ? ' Fetching BTC-USD…'
                          : btcUsdStatus === 'error'
                            ? ' BTC-USD unavailable — retry before creating.'
                            : ''}
                      {cirBtcApproxLabel ? ` ≈ ${cirBtcApproxLabel} ${quoteSymbol}.` : ''}
                      {' '}We swap your USDC to {quoteSymbol}, then the factory pulls {quoteSymbol} for the first buy.
                      {usdcBalQ.data != null
                        ? ` Wallet: ${Number(formatUnits(usdcBalQ.data, 6)).toFixed(2)} USDC`
                        : ''}
                      {quoteBalQ.data != null
                        ? `${usdcBalQ.data != null ? ',' : ' Wallet:'} ${formatUnits(quoteBalQ.data, quoteDecimalsLive)} ${quoteSymbol}.`
                        : usdcBalQ.data != null
                          ? '.'
                          : ''}
                    </>
                  ) : (
                    <>
                      Amount is in {quoteSymbol}
                      {quoteId === 'usdc' ? ' (USD)' : ', not USD'}.
                      {quoteBalQ.data != null
                        ? ` Wallet: ${formatUnits(quoteBalQ.data, quoteDecimalsLive)} ${quoteSymbol}.`
                        : ''}
                    </>
                  )}
                </p>
              </Field>
            )}

            {error && (
              <p className="text-xs text-coral flex items-start gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {error}
              </p>
            )}

            {pendingBasket && (
              <div className="rounded-[14px] border border-amber-500/40 bg-amber-500/10 px-4 py-3.5">
                <p className="flex items-start gap-1.5 text-[13px] font-medium text-amber-200">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  Token launched. The holder basket still needs setBasket from this wallet.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      void (async () => {
                        if (!pendingBasket) return
                        try {
                          setError(null)
                          setStep('basket')
                          const basketCall = buildSetBasket({
                            sink: pendingBasket.sink,
                            rows: basketRows,
                            quote: pendingBasket.quote,
                            mode: bundleMode,
                          })
                          const basketHash = await writeContractAsync({
                            address: basketCall.address,
                            abi: basketCall.abi as never,
                            functionName: basketCall.functionName as never,
                            args: basketCall.args as never,
                            chainId: basketCall.chainId,
                            gas: 1_200_000n,
                          })
                          await waitArcTxConfirmed(basketHash)
                          const tok = pendingBasket.token
                          setPendingBasket(null)
                          setStep('done')
                          router.push(`/token/${tok}`)
                        } catch (e: unknown) {
                          const ax = e as { shortMessage?: string; message?: string }
                          setError(ax?.shortMessage || ax?.message || 'setBasket failed')
                          setStep('idle')
                        }
                      })()
                    }}
                    className="h-9 px-4 rounded-full bg-amber-500 text-black text-[13px] font-semibold disabled:opacity-50 flex items-center gap-1.5"
                  >
                    {step === 'basket' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                    Retry basket
                  </button>
                  <button
                    type="button"
                    onClick={() => router.push(`/token/${pendingBasket.token}`)}
                    className="h-9 px-4 rounded-full border border-hair text-[13px] font-medium text-t2 hover:text-white"
                  >
                    Skip, view token
                  </button>
                </div>
              </div>
            )}

            {pendingRegister && (
              <div className="rounded-[14px] border border-amber-500/40 bg-amber-500/10 px-4 py-3.5">
                <p className="flex items-start gap-1.5 text-[13px] font-medium text-amber-200">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  Token launched — its name and ticker are already live. Its image and socials didn’t
                  save{registerError ? ` — ${registerError}` : ''}, though.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={registering}
                    onClick={() => void retryRegister()}
                    className="h-9 px-4 rounded-full bg-amber-500 text-black text-[13px] font-semibold disabled:opacity-50 flex items-center gap-1.5"
                  >
                    {registering ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                    {registering ? 'Retrying…' : 'Retry save'}
                  </button>
                  <button
                    type="button"
                    onClick={() => router.push(`/token/${pendingRegister.token}`)}
                    className="h-9 px-4 rounded-full border border-hair text-[13px] font-medium text-t2 hover:text-white"
                  >
                    Skip, view token
                  </button>
                </div>
              </div>
            )}
          </>
        )}
    </>
  )

  const cta = (
    <button
      type="button"
      disabled={
        isConnected && !wrongChain
          ? !canSubmit
          : connecting || switching
      }
      onClick={onCta}
      className={`w-full h-12 rounded-full text-[15px] font-semibold tracking-tightish disabled:opacity-40 flex items-center justify-center gap-2 ${
        isConnected && wrongChain ? 'bg-amber-500 text-black' : 'bg-lime text-white hover:bg-lime-2'
      }`}
    >
      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : step === 'done' ? <CheckCircle className="w-4 h-4" /> : null}
      {launchCta}
    </button>
  )

  if (compact) {
    return (
      <div>
        <h1 className="m-0 text-[30px] font-semibold tracking-[-0.03em]">Launch this</h1>
        <p className="mt-2.5 mb-5 text-[15px] text-t2 leading-relaxed">
          Instant TOKEN/{quoteSymbol}. 1B supply,{' '}
          {v4Live
            ? 'LP locked for 365 days, then platform-reclaimable.'
            : 'LP locked.'}{' '}
          Confirm to mint. We do not send the tx for you.
        </p>
        <div className="space-y-5">{fields}</div>
        {launchesLive ? <div className="mt-6">{cta}</div> : null}
      </div>
    )
  }

  return (
    <div>
      <p className="m-0 text-xs font-medium tracking-[0.16em] text-t3 uppercase">Launch</p>
      <h1 className="mt-2 mb-0 text-3xl font-semibold tracking-tight">One transaction. Full float.</h1>
      <p className="mt-2 max-w-xl text-sm text-t2 text-pretty">
        1B supply, Uniswap {v4Live ? 'V4' : 'V3'},{' '}
        {v4Live ? 'LP locked for 365 days, then platform-reclaimable' : 'LP locked'}, pair {quoteSymbol}.
        {v4Live ? ' Pool fee is yours to set.' : ` $${feeUsd.toFixed(2)} creation fee. Launch-token LP fees auto-burn.`}
      </p>

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-5">{fields}</div>
        {launchesLive ? (
          <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
            <TokenCard token={previewToken} preview />
            <div className="rounded-2xl bg-s1 p-5 text-sm border border-hair">
              <FeeRow k="Creation fee" v={`$${feeUsd.toFixed(2)}`} />
              <FeeRow k="First buy" v={firstBuyLabel} />
              {firstBuyTokensLabel ? <FeeRow k="You receive (est.)" v={firstBuyTokensLabel} /> : null}
              <FeeRow k="You pay" v={payLabel} />
              <FeeRow k="Wallet" v={walletLabel} />
              <div className="mt-4">{cta}</div>
              <p className="mt-3 mb-0 text-xs text-t3 leading-relaxed">
                Gas on Arc · launch-token LP fees auto-burn · pair {quoteSymbol}
              </p>
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-2 text-xs text-t3">{label}</div>
      {children}
    </label>
  )
}

function FeeRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <span className="text-t2">{k}</span>
      <span className="tabular-nums">{v}</span>
    </div>
  )
}

function rwaMarkSrc(id: string): string | null {
  const k = id.toLowerCase()
  if (k === 'usyc') return '/marks/usyc.png'
  if (k === 'cirbtc') return '/marks/cirbtc.svg'
  if (k === 'buidl') return '/marks/buidl.png'
  if (k === 'crcl') return '/marks/crcl.svg'
  return null
}

function RwaPairedPicker({
  open: openAssets,
  gated,
  active,
  selectedId,
  v4Ui,
  disabled,
  onSelect,
}: {
  open: ReturnType<typeof liveRwaQuoteAssets>
  gated: ReturnType<typeof pendingRwaQuoteAssets>
  active?: boolean
  selectedId: string | null
  v4Ui: boolean
  disabled?: boolean
  onSelect: (id: string) => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const selected = openAssets.find((a) => a.id === selectedId) || null
  const canPick = openAssets.length > 0 && !disabled

  useEffect(() => {
    if (!menuOpen) return
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [menuOpen])

  const gatedLabel = gated.map((a) => a.symbol).join(' · ')
  const body = selected
    ? selected.permissioned
      ? `Quoted in ${selected.symbol} (permissioned). First buy is in ${selected.symbol}, not USD.`
      : v4Ui
        ? `Same Instant mint + LP lock, quoted in ${selected.symbol}. Optional holder basket.`
        : `Same Instant mint + LP lock, quoted in ${selected.symbol}.`
    : canPick
      ? gatedLabel
        ? `Pick a quote. ${gatedLabel} stay Soon until the issuer publishes an Arc address.`
        : 'Pick a quote.'
      : gatedLabel
        ? `${gatedLabel} — waiting on issuer address + Instant factory.`
        : 'Waiting on issuer + Instant factory.'

  const cls = `relative rounded-2xl bg-s1 p-4 text-left border transition-colors duration-150 sm:col-span-2 ${
    !canPick
      ? 'border-hair opacity-60'
      : active
        ? 'border-lime-line'
        : 'border-hair hover:border-lime-line'
  }`

  return (
    <div className={cls} ref={rootRef}>
      {!canPick ? (
        <span className="absolute top-3 right-3 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide text-t3 bg-white/5">
          Soon
        </span>
      ) : null}
      <div className="text-sm font-medium">RWA paired</div>
      <p className="mt-1 mb-3 text-xs leading-relaxed text-t2">{body}</p>
      {canPick ? (
        <div className="relative">
          <button
            type="button"
            aria-expanded={menuOpen}
            aria-haspopup="listbox"
            onClick={() => setMenuOpen((v) => !v)}
            className="w-full h-11 rounded-2xl bg-s2 px-3 text-sm text-white outline-none border border-hair focus:border-lime-line flex items-center gap-2.5"
          >
            {selected && rwaMarkSrc(selected.id) ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={rwaMarkSrc(selected.id)!}
                alt=""
                className="size-5 rounded-full object-cover bg-white/5 shrink-0"
              />
            ) : (
              <span className="size-5 rounded-full bg-white/10 shrink-0" />
            )}
            <span className="flex-1 text-left font-medium">
              {selected ? selected.symbol : 'Select RWA quote…'}
            </span>
            <ChevronDown className={`size-4 text-t3 shrink-0 transition-transform ${menuOpen ? 'rotate-180' : ''}`} />
          </button>
          {menuOpen ? (
            <ul
              role="listbox"
              className="absolute z-20 mt-1.5 w-full rounded-2xl border border-hair bg-s1 p-1.5 shadow-[0_12px_40px_rgba(0,0,0,0.45)]"
            >
              {openAssets.map((a) => {
                const on = selected?.id === a.id
                const mark = rwaMarkSrc(a.id)
                return (
                  <li key={a.id} role="option" aria-selected={on}>
                    <button
                      type="button"
                      onClick={() => {
                        onSelect(a.id)
                        setMenuOpen(false)
                      }}
                      className={`w-full flex items-center gap-2.5 rounded-xl px-2.5 h-10 text-left text-sm transition-colors ${
                        on ? 'bg-lime/15 text-white' : 'text-t1 hover:bg-white/[0.04]'
                      }`}
                    >
                      {mark ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={mark} alt="" className="size-5 rounded-full object-cover shrink-0" />
                      ) : (
                        <span className="size-5 rounded-full bg-white/10 shrink-0" />
                      )}
                      <span className="font-medium">{a.symbol}</span>
                      {a.permissioned ? (
                        <span className="ml-auto text-[10px] uppercase tracking-wide text-amber-200/80 font-semibold">Gated</span>
                      ) : null}
                    </button>
                  </li>
                )
              })}
              {gated.map((a) => {
                const mark = rwaMarkSrc(a.id)
                return (
                  <li key={`gated-${a.id}`} role="option" aria-disabled="true">
                    <div className="w-full flex items-center gap-2.5 rounded-xl px-2.5 h-10 text-left text-sm opacity-45 cursor-not-allowed">
                      {mark ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={mark} alt="" className="size-5 rounded-full object-cover shrink-0" />
                      ) : (
                        <span className="size-5 rounded-full bg-white/10 shrink-0" />
                      )}
                      <span className="font-medium">{a.symbol}</span>
                      <span className="ml-auto text-[10px] uppercase tracking-wide text-t3 font-semibold">Soon</span>
                    </div>
                  </li>
                )
              })}
            </ul>
          ) : null}
        </div>
      ) : gated.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {gated.map((a) => {
            const mark = rwaMarkSrc(a.id)
            return (
              <span
                key={a.id}
                className="inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-semibold border border-hair text-t3 bg-white/[0.03]"
              >
                {mark ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={mark} alt="" className="size-4 rounded-full object-cover" />
                ) : null}
                {a.symbol}
                <span className="text-[10px] uppercase tracking-wide">Soon</span>
              </span>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

function TypeCard({
  active,
  onClick,
  title,
  body,
  disabled,
  soon,
}: {
  active?: boolean
  onClick?: () => void
  title: string
  body: string
  disabled?: boolean
  soon?: boolean
}) {
  const cls = `relative rounded-2xl bg-s1 p-4 text-left border transition-colors duration-150 ${
    disabled
      ? 'border-hair opacity-60 cursor-not-allowed'
      : active
        ? 'border-lime-line'
        : 'border-hair hover:border-lime-line'
  }`
  const inner = (
    <>
      {soon ? (
        <span className="absolute top-3 right-3 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide text-t3 bg-white/5">
          Soon
        </span>
      ) : null}
      <div className="text-sm font-medium">{title}</div>
      <p className="mt-1 mb-0 text-xs leading-relaxed text-t2">{body}</p>
    </>
  )
  if (disabled || !onClick) return <div className={cls}>{inner}</div>
  return (
    <button type="button" onClick={onClick} className={cls}>
      {inner}
    </button>
  )
}

const FIELD =
  'w-full h-11 rounded-2xl bg-s1 px-4 text-sm text-white outline-none border border-hair focus:border-lime-line placeholder:text-white/30'

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="shrink-0 w-[52px] h-8 rounded-full p-0.5 flex transition-[background] duration-200"
      style={{
        background: on ? 'var(--lime)' : 'rgba(255,255,255,0.14)',
        justifyContent: on ? 'flex-end' : 'flex-start',
      }}
      aria-pressed={on}
    >
      <span className="w-7 h-7 rounded-full bg-white shadow-[0_2px_6px_rgba(0,0,0,0.35)]" />
    </button>
  )
}

function stepLabel(step: Step): string {
  switch (step) {
    case 'uploading':
      return 'Uploading image…'
    case 'vault':
      return 'Creating handle vault…'
    case 'approving':
      return 'Approve token…'
    case 'swapping':
      return `Swapping USDC → quote…`
    case 'creating':
      return 'Confirm in wallet…'
    case 'confirming':
      return 'Waiting for confirmation…'
    case 'basket':
      return 'Setting holder basket…'
    case 'registering':
      return 'Saving details…'
    default:
      return 'Working…'
  }
}
