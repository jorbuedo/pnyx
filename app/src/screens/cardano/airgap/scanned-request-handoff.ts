/**
 * In-memory handoff from the QR scanner to the air-gapped request screen.
 *
 * The same shape as `review-handoff`, for the same reason: a reassembled UR is bytes, not a
 * router-serializable value, and hex in a route param would be a kilobyte of URL for a payload
 * the receiving screen is about to decode anyway.
 *
 * Single-consumer and evicted on claim, so a re-mount cannot re-decide a request the user already
 * dealt with.
 *
 * @module
 */

import type {Ur} from '@pnyx/ur'

const scans = new Map<string, Ur>()
let counter = 0

/** Register a completed scan; returns the id to pass as the `scan` route param. */
export const registerScannedUr = (ur: Ur): string => {
  counter += 1
  const id = `scan_${counter}`
  scans.set(id, ur)
  return id
}

/** Take the scan, removing it. */
export const claimScannedUr = (id: string): Ur | undefined => {
  const ur = scans.get(id)
  scans.delete(id)
  return ur
}
