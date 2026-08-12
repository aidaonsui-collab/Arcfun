import {
  OfferCreated,
  OfferCancelled,
  Reserved,
  ReservationReleased,
  Delivered,
} from '../generated/RobinOtcLiquidity/RobinOtcLiquidity'
import { OtcOffer, OtcReservation, OtcDelivery, DeskStat } from '../generated/schema'
import { BigInt, Bytes } from '@graphprotocol/graph-ts'

function desk(): DeskStat {
  let s = DeskStat.load('global')
  if (s == null) {
    s = new DeskStat('global')
    s.openOffers = 0
    s.totalCreated = 0
    s.totalDelivered = 0
    s.lastUpdated = BigInt.fromI32(0)
  }
  return s
}

export function handleOfferCreated(event: OfferCreated): void {
  let id = event.params.offerId.toHexString()
  let o = new OtcOffer(id)
  o.maker = event.params.maker
  o.sellerPayment = event.params.sellerPayment
  o.premiumBps = event.params.premiumBps.toI32()
  o.amount = event.params.amount
  o.remaining = event.params.amount
  o.active = true
  o.createdAt = event.block.timestamp
  o.createdBlock = event.block.number
  o.createdTx = event.transaction.hash
  o.updatedAt = event.block.timestamp
  o.save()

  let s = desk()
  s.openOffers = s.openOffers + 1
  s.totalCreated = s.totalCreated + 1
  s.lastUpdated = event.block.timestamp
  s.save()
}

export function handleOfferCancelled(event: OfferCancelled): void {
  let o = OtcOffer.load(event.params.offerId.toHexString())
  if (o == null) return
  if (o.active) {
    let s = desk()
    s.openOffers = s.openOffers > 0 ? s.openOffers - 1 : 0
    s.lastUpdated = event.block.timestamp
    s.save()
  }
  o.active = false
  o.remaining = BigInt.fromI32(0)
  o.updatedAt = event.block.timestamp
  o.save()
}

export function handleReserved(event: Reserved): void {
  let id = event.params.reservationId.toHexString()
  let r = new OtcReservation(id)
  r.offer = event.params.offerId.toHexString()
  r.reserver = event.params.reserver
  r.amount = event.params.amount
  r.expiresAt = event.params.expiresAt
  r.released = false
  r.createdAt = event.block.timestamp
  r.createdBlock = event.block.number
  r.createdTx = event.transaction.hash
  r.save()

  // Free remaining decreases on hard reserve (matches contract)
  let o = OtcOffer.load(event.params.offerId.toHexString())
  if (o != null) {
    if (o.remaining.ge(event.params.amount)) {
      o.remaining = o.remaining.minus(event.params.amount)
    } else {
      o.remaining = BigInt.fromI32(0)
    }
    o.updatedAt = event.block.timestamp
    o.save()
  }
}

export function handleReservationReleased(event: ReservationReleased): void {
  let r = OtcReservation.load(event.params.reservationId.toHexString())
  if (r == null) return
  r.released = true
  r.save()

  let o = OtcOffer.load(r.offer)
  if (o != null && o.active) {
    o.remaining = o.remaining.plus(event.params.amount)
    o.updatedAt = event.block.timestamp
    o.save()
  }
}

export function handleDelivered(event: Delivered): void {
  let id = event.params.fillId.toHexString()
  let d = new OtcDelivery(id)
  d.offer = event.params.offerId.toHexString()
  d.recipient = event.params.recipient
  d.amount = event.params.amount
  d.remainingAfter = event.params.remaining
  d.reservationId = event.params.reservationId
  d.createdAt = event.block.timestamp
  d.createdBlock = event.block.number
  d.createdTx = event.transaction.hash
  d.save()

  let o = OtcOffer.load(event.params.offerId.toHexString())
  if (o != null) {
    o.remaining = event.params.remaining
    if (event.params.remaining.equals(BigInt.fromI32(0))) {
      if (o.active) {
        let s = desk()
        s.openOffers = s.openOffers > 0 ? s.openOffers - 1 : 0
        s.totalDelivered = s.totalDelivered + 1
        s.lastUpdated = event.block.timestamp
        s.save()
      }
      o.active = false
    } else {
      let s = desk()
      s.totalDelivered = s.totalDelivered + 1
      s.lastUpdated = event.block.timestamp
      s.save()
    }
    o.updatedAt = event.block.timestamp
    o.save()
  } else {
    let s = desk()
    s.totalDelivered = s.totalDelivered + 1
    s.lastUpdated = event.block.timestamp
    s.save()
  }
}
