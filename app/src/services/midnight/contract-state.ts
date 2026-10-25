/**
 * Reads of any Midnight contract's state from an indexer, by address.
 *
 * One GraphQL shape, in one place, for every contract this app reads.
 *
 * **There is no read-one-key query on Midnight.** A contract's ledger is a single blob, so any
 * lookup means fetching the whole state and resolving locally. That is a cost — see the size
 * ceiling in `docs/mobile-shell-plan.md` item 24 — but also the privacy property that makes reading
 * directly worth doing: the indexer never learns *which* key was looked up, and neither does anyone
 * else, which is exactly what asking our own service per lookup gave away.
 *
 * **The endpoint is derived from a network, never configured beside it**: it is a property of the
 * chain, and naming the two independently lets them disagree — a mainnet indexer holds no action for a
 * preprod contract, so a lookup reports the peer as unreachable instead of the misconfiguration it is.
 *
 * Which network, though, is per call. Defaulting to {@link declaredIdentityNetwork} is right for
 * anything on this build's own chain, but a caller reading a contract pinned to a *different* network
 * must say so — {@link midnightIndexerUrlFor}. Getting that wrong is quiet rather than loud: an
 * indexer for the wrong chain answers `contractAction: null`, which reads as "nothing deployed
 * there" rather than as the misconfiguration it is.
 *
 * A build that declares no network reports state as unavailable rather than reaching for a public
 * endpoint (Third-Party RPC policy).
 *
 * @module
 */

import {Data} from 'effect'

import {logger} from '../../logger'
import {declaredIdentityNetwork} from '../identity-network'
import {indexerAuthHeaders} from './indexer-auth'
import {identityIndexerUrl, identityIndexerUrlFor} from './networks'

/**
 * The contract-state indexer could not be read.
 *
 * The same split the DUST indexer draws, for the same reason: only `http` is worth retrying. `graphql`
 * means the indexer answered and refused, which no amount of trying again changes.
 */
export class MidnightIndexerError extends Data.TaggedError('MidnightIndexerError')<{
  readonly cause: 'http' | 'graphql'
  readonly reason: string
}> {}

const ORIGIN = 'midnight-indexer'

/**
 * Re-exported under the names this module's callers already use. The policy itself lives in
 * `./networks.ts`, which is the only module allowed to resolve an endpoint.
 */
export const midnightIndexerUrlFor = identityIndexerUrlFor

/** The indexer for the network this build declares, or `null` when it declares none we know. */
export const midnightIndexerUrl = identityIndexerUrl

/** Where a contract stood when we last looked, without downloading its state. */
export type ContractMarker = {
  readonly height: number
  readonly txHash: string
}

export type ContractStateSnapshot = {
  readonly state: Uint8Array
  readonly height: number
}

const MARKER_QUERY = `query Marker($address: HexEncoded!) {
  contractAction(address: $address) {
    address
    transaction { hash block { height } }
  }
}`

// `state` is the blob; selecting it is what makes this the expensive call.
//
// `offset` is nullable: omitting the variable reads the contract's latest action, which is what
// every caller but a vote wants. Supplying one reads the action at or before that point — verified
// against preprod, where a `blockOffset` at the deploy height returns the `ContractDeploy` while the
// same query with no offset returns the latest `ContractCall`.
const STATE_QUERY = `query State($address: HexEncoded!, $offset: ContractActionOffset) {
  contractAction(address: $address, offset: $offset) {
    state
    transaction { block { height } }
  }
}`

const TX_HEIGHT_QUERY = `query TxHeight($offset: TransactionOffset!) {
  transactions(offset: $offset) {
    block { height }
  }
}`

const fromHex = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

type ContractActionReply = {
  data?: {
    contractAction?: {state?: string; transaction?: {hash?: string; block?: {height?: number}}} | null
    transactions?: readonly {block?: {height?: number}}[] | null
  }
  errors?: readonly {message: string}[]
}

/**
 * Which point in the chain to read a contract's state at.
 *
 * A vote needs the circle's members tree **as the proposal sealed it**, not as it stands now: a join
 * after the proposal was created moves the root, and a path read from the live tree then proves
 * nothing. Every other caller wants the latest action and passes nothing.
 */
export type ContractStateAt = {readonly height: number} | {readonly txHash: string}

const offsetFor = (at: ContractStateAt | undefined): Record<string, unknown> | undefined =>
  at === undefined
    ? undefined
    : 'height' in at
      ? {blockOffset: {height: at.height}}
      : {transactionOffset: {hash: at.txHash}}

const query = async (url: string, body: string, variables: Record<string, unknown>): Promise<ContractActionReply> => {
  const response = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', ...indexerAuthHeaders(url)},
    body: JSON.stringify({query: body, variables}),
  })
  if (!response.ok) {
    throw new MidnightIndexerError({cause: 'http', reason: `indexer responded ${response.status}`})
  }
  const reply = (await response.json()) as ContractActionReply
  if (reply.errors !== undefined && reply.errors.length > 0) {
    throw new MidnightIndexerError({cause: 'graphql', reason: reply.errors.map((e) => e.message).join('; ')})
  }
  return reply
}

/**
 * The cheap read: has this contract moved? `null` means the question could not be answered — an
 * unset indexer, an outage, or a contract with no actions yet. Deliberately not `0`: a caller must
 * not read "could not check" as "nothing changed", which would freeze a stale cache forever.
 */
export const fetchContractMarker = async (
  address: string,
  network: string | null = declaredIdentityNetwork(),
): Promise<ContractMarker | null> => {
  const url = midnightIndexerUrlFor(network)
  if (url === null) return null
  try {
    const reply = await query(url, MARKER_QUERY, {address})
    const action = reply.data?.contractAction
    const height = action?.transaction?.block?.height
    const txHash = action?.transaction?.hash
    if (height === undefined || txHash === undefined) return null
    return {height, txHash}
  } catch (error) {
    logger.warn('contract marker read failed', {origin: ORIGIN, error: String(error)})
    return null
  }
}

/**
 * The expensive read: the contract's whole state. `null` on any failure, so callers fall back to
 * whatever snapshot they hold — but a failure must never be reported as "the key is absent".
 */
export const fetchContractStateByAddress = async (
  address: string,
  network: string | null = declaredIdentityNetwork(),
  at?: ContractStateAt,
): Promise<ContractStateSnapshot | null> => {
  const url = midnightIndexerUrlFor(network)
  if (url === null) return null
  try {
    const offset = offsetFor(at)
    const reply = await query(url, STATE_QUERY, offset === undefined ? {address} : {address, offset})
    const action = reply.data?.contractAction
    const state = action?.state
    const height = action?.transaction?.block?.height
    if (state === undefined || height === undefined) return null
    return {state: fromHex(state), height}
  } catch (error) {
    logger.warn('contract state read failed', {origin: ORIGIN, error: String(error)})
    return null
  }
}

/**
 * The block a transaction landed in, or `null` when it could not be resolved.
 *
 * A proposal's `ChainRef` records the deploy's `txId` but no height, and the circle state a vote
 * proves against is the one at that height. `null` is "could not look", never "not on chain" —
 * reading it as the latter would make a voter prove against the live tree and fail at the root
 * comparison for the wrong reason.
 */
export const fetchTransactionHeight = async (
  txHash: string,
  network: string | null = declaredIdentityNetwork(),
): Promise<number | null> => {
  const url = midnightIndexerUrlFor(network)
  if (url === null) return null
  try {
    const reply = await query(url, TX_HEIGHT_QUERY, {offset: {hash: txHash}})
    const height = reply.data?.transactions?.[0]?.block?.height
    return height ?? null
  } catch (error) {
    logger.warn('transaction height read failed', {origin: ORIGIN, txHash, error: String(error)})
    return null
  }
}
