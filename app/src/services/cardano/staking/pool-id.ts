/**
 * Stake-pool id parsing: `pool1…` bech32 → the 28-byte pool key hash.
 *
 * Pure and non-throwing, because two very different callers need the same rule.
 * The delegation builder needs the *hash* to put in a certificate, and a link
 * arriving from outside needs to know whether an id is a pool id at all before a
 * card offers to delegate to it. Written once here so the two cannot drift into
 * disagreeing about what a pool id is — a link that classifies as delegable but
 * fails at certificate build would be a card promising something that does not
 * happen.
 *
 * @module
 */

import {bech32} from '@pnyx/crypto'
import {logger} from '../../../logger'

/** A pool key hash is 28 bytes, and the hrp is `pool` (CIP-5). */
const POOL_HASH_BYTES = 28
const POOL_HRP = 'pool'

/**
 * The 28-byte pool key hash as hex, or `null` when this is not a pool id.
 *
 * `null` covers every way it can fail — not bech32 at all, the wrong hrp
 * (`pool_test`, `addr`, `drep`), or the right hrp over the wrong payload length.
 * None of them is a pool that can be delegated to, and none is guessable into
 * one.
 */
export const poolKeyHashHex = (poolId: string): string | null => {
  let prefix: string
  let bytes: Uint8Array
  try {
    const decoded = bech32.decode(poolId as `${string}1${string}`, 1023)
    prefix = decoded.prefix
    bytes = bech32.fromWords(decoded.words)
  } catch (e: unknown) {
    logger.debug('Pool id failed bech32 decode', {origin: 'staking/pool-id', error: String(e)})
    return null
  }
  if (prefix !== POOL_HRP || bytes.length !== POOL_HASH_BYTES) return null
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}

/** Whether this is a delegable pool id. */
export const isPoolId = (poolId: string): boolean => poolKeyHashHex(poolId) !== null
