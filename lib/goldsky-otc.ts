/**
 * Goldsky GraphQL client for ArcFun OTC offer book.
 * Set GOLDSKY_OTC_URL to the public subgraph endpoint after deploy.
 */
import { getAddress, type Address, type Hex } from 'viem'
import { allInMultiplier, fetchOtcFeeBps } from '@/lib/bridge/robin-otc'

export type GoldskyOtcOffer = {
  offerId: Hex
  maker: Address
  sellerPayment: Address
  premiumBps: number
  remaining: bigint
  active: boolean
  allInMult: number
  available: bigint
  pendingReserved: bigint
  hasPending: boolean
}

function endpoint(): string {
  return (process.env.GOLDSKY_OTC_URL || process.env.NEXT_PUBLIC_GOLDSKY_OTC_URL || '').trim()
}

export function goldskyOtcConfigured(): boolean {
  return endpoint().startsWith('http')
}

type GqlOffer = {
  id: string
  maker: string
  sellerPayment: string
  premiumBps: number
  remaining: string
  amount: string
  active: boolean
}

export async function fetchGoldskyOtcOffers(): Promise<GoldskyOtcOffer[] | null> {
  const url = endpoint()
  if (!url) return null

  const query = `{
    otcOffers(
      first: 100
      where: { active: true, remaining_gt: "0" }
      orderBy: premiumBps
      orderDirection: asc
    ) {
      id
      maker
      sellerPayment
      premiumBps
      remaining
      amount
      active
    }
  }`

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      // Edge/server: short timeout preference via AbortSignal if available
      next: { revalidate: 5 },
    } as RequestInit)

    if (!res.ok) {
      console.warn('[goldsky-otc] http', res.status)
      return null
    }
    const json = (await res.json()) as {
      data?: { otcOffers?: GqlOffer[] }
      errors?: { message: string }[]
    }
    if (json.errors?.length) {
      console.warn('[goldsky-otc] gql', json.errors[0]?.message)
      return null
    }
    const rows = json.data?.otcOffers ?? []
    const feeBps = await fetchOtcFeeBps().catch(() => 200)

    return rows.map((o) => {
      const remaining = BigInt(o.remaining || '0')
      return {
        offerId: o.id as Hex,
        maker: getAddress(o.maker),
        sellerPayment: getAddress(o.sellerPayment),
        premiumBps: Number(o.premiumBps),
        remaining,
        active: o.active,
        allInMult: allInMultiplier(Number(o.premiumBps), feeBps),
        available: remaining,
        pendingReserved: 0n,
        hasPending: false,
      }
    })
  } catch (e) {
    console.warn('[goldsky-otc]', e instanceof Error ? e.message : e)
    return null
  }
}
