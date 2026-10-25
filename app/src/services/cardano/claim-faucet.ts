/**
 * The CIP-99 (Proof of Onboarding) faucet protocol.
 *
 * A claim link says where to ask and with what code; this is the asking. The
 * wallet POSTs `{address, code, …passthrough}` to the faucet and reads back one of
 * the status blocks CIP-99 documents. Nothing here signs, and nothing here reaches
 * the chain — a claim is a *request* that the project's own server fulfils by
 * sending a transaction later. So the successful outcomes are not "you have the
 * tokens", they are "you are in the queue" and "it was sent"; the copy has to say
 * which, or the user waits for funds already spent or gives up on funds in flight.
 *
 * **The body's `code` is the truth, not the HTTP status.** Verified against the
 * live Moneta tUSDM faucet (`beta.onbd.io`), which answers an invalid address with
 * HTTP 200 carrying `{"code":400,"status":"invalidaddress"}`. Reading the transport
 * status would have called that a success. CIP-99 defines the status block as the
 * unit of meaning and never promises the two agree, so the block decides — and
 * without one there is no success to report, only a transport status that may or
 * may not mean anything.
 *
 * @module
 */

import type {ClaimUri} from '@pnyx/links'
import {logger} from '../../logger'

/** Why a faucet refused, in CIP-99's own vocabulary. */
export type ClaimRejection =
  | 'invalidaddress'
  | 'missingcode'
  | 'invalidnetwork'
  | 'notfound'
  | 'alreadyclaimed'
  | 'expired'
  | 'tooearly'
  | 'ratelimited'
  /** A 500, or any status CIP-99 does not define. The faucet is at fault, not the claim. */
  | 'server'
  /** Reached the faucet, could not read the answer as CIP-99. */
  | 'malformed'
  /** Never reached the faucet at all. */
  | 'unreachable'

/**
 * What the faucet said.
 *
 * `lovelace` and `tokens` are what the *campaign* pays out, echoed back by the
 * server — absent when it does not say, never substituted. A claim that reports
 * nothing is still a claim; inventing `0` would render as "you got 0 tokens".
 */
export type ClaimOutcome =
  | {
      /** First accepted request (200) — queued for distribution. */
      readonly kind: 'accepted'
      readonly queuePosition: number | null
      readonly lovelace: bigint | null
      readonly tokens: ReadonlyArray<ClaimToken> | null
    }
  | {
      /** Asked again before distribution (201). Same claim, still waiting. */
      readonly kind: 'queued'
      readonly queuePosition: number | null
      readonly lovelace: bigint | null
      readonly tokens: ReadonlyArray<ClaimToken> | null
    }
  | {
      /** Distributed (202). `txHash` is the faucet's `tx_hash`, when it gives one. */
      readonly kind: 'claimed'
      readonly txHash: string | null
      readonly lovelace: bigint | null
      readonly tokens: ReadonlyArray<ClaimToken> | null
    }
  | {readonly kind: 'rejected'; readonly reason: ClaimRejection; readonly code: number | null}

/** One entry of CIP-99's `tokens` map: `"<policyId>.<assetNameHex>": "<quantity>"`. */
export type ClaimToken = {
  readonly unit: string
  readonly quantity: bigint
}

const REJECTIONS: ReadonlyMap<number, ClaimRejection> = new Map([
  [404, 'notfound'],
  [409, 'alreadyclaimed'],
  [410, 'expired'],
  [425, 'tooearly'],
  [429, 'ratelimited'],
])

/** CIP-99 spells three different faults 400; the body's `status` is what separates them. */
const BAD_REQUEST: ReadonlyMap<string, ClaimRejection> = new Map([
  ['invalidaddress', 'invalidaddress'],
  ['missingcode', 'missingcode'],
  ['invalidnetwork', 'invalidnetwork'],
])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * A CIP-99 quantity: a decimal string, per the spec's examples.
 *
 * A number is accepted too — servers do send them — but only when it is an exact
 * integer, because `29433292000000` past 2^53 would already have been rounded by
 * the JSON parser and there is no honest way to recover it.
 */
const quantityOf = (value: unknown): bigint | null => {
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value)
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value)
  return null
}

const wholeNumberOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null

const tokensOf = (value: unknown): ReadonlyArray<ClaimToken> | null => {
  if (!isRecord(value)) return null
  const tokens: ClaimToken[] = []
  for (const [unit, quantity] of Object.entries(value)) {
    const parsed = quantityOf(quantity)
    // A unit whose quantity will not read is dropped rather than shown as zero:
    // the rest of the payout is still true and this one is simply not known.
    if (parsed !== null) tokens.push({unit, quantity: parsed})
  }
  return tokens
}

/**
 * Read a faucet's answer.
 *
 * Pure, and separated from the request for exactly that reason — the nine status
 * blocks and the body-over-transport rule are the whole protocol, and they are
 * testable without a server.
 *
 * @param httpStatus - The transport status. Read only where the block is silent.
 * @param body - The parsed JSON body, or `null` when there was none.
 */
export const readClaimResponse = (httpStatus: number, body: unknown): ClaimOutcome => {
  const block = isRecord(body) ? body : null

  // No status block, no success. This faucet family answers errors with HTTP 200
  // (see the module note), so a 200 carrying an error page or an empty body would
  // otherwise read as "accepted" and tell the user tokens are on the way. A
  // transport status that is *itself* a failure is still worth reporting, because
  // that direction cannot flatter the outcome.
  if (block === null) {
    const known = REJECTIONS.get(httpStatus)
    if (known !== undefined) return {kind: 'rejected', reason: known, code: httpStatus}
    if (httpStatus >= 400) return {kind: 'rejected', reason: 'server', code: httpStatus}
    return {kind: 'rejected', reason: 'malformed', code: httpStatus}
  }

  const code = wholeNumberOf(block.code) ?? httpStatus
  const status = typeof block.status === 'string' ? block.status : null
  const lovelace = quantityOf(block.lovelaces)
  const tokens = tokensOf(block.tokens)

  if (code === 200 || code === 201) {
    return {
      kind: code === 200 ? 'accepted' : 'queued',
      queuePosition: wholeNumberOf(block.queue_position),
      lovelace,
      tokens,
    }
  }

  if (code === 202) {
    return {
      kind: 'claimed',
      txHash: typeof block.tx_hash === 'string' && block.tx_hash !== '' ? block.tx_hash : null,
      lovelace,
      tokens,
    }
  }

  if (code === 400) {
    // An unnamed 400 is still a refusal by the faucet, and `invalidaddress` is the
    // one the user can act on — so an unrecognised spelling stays generic rather
    // than blaming their address for what might be a missing code.
    const reason = status === null ? null : BAD_REQUEST.get(status)
    return {kind: 'rejected', reason: reason ?? 'malformed', code}
  }

  const known = REJECTIONS.get(code)
  if (known !== undefined) return {kind: 'rejected', reason: known, code}

  return {kind: 'rejected', reason: 'server', code}
}

/**
 * The link's pass-through parameters, as a route param carries them.
 *
 * A route param is a string, so they cross as JSON. Anything that will not parse
 * as a flat string map is dropped rather than guessed at: forwarding a malformed
 * set would put values the link never carried into a request to a third party.
 */
export const passThroughParamsOf = (raw: string | undefined): Readonly<Record<string, string>> => {
  if (raw === undefined || raw === '') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const entries = Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    return Object.fromEntries(entries)
  } catch (e: unknown) {
    // Dropping them is right (see above) — but a link that carried parameters and a link that
    // carried none reach the faucet identically, and only this line tells them apart.
    logger.warn('Claim link pass-through parameters could not be parsed; sending none', {
      origin: 'claim-faucet',
      error: String(e),
    })
    return {}
  }
}

/**
 * A CIP-99 `tokens` unit rendered as something a person can read.
 *
 * The unit is `<policyId>.<assetNameHex>`, and the asset name is hex of UTF-8 in
 * every faucet that has ever shipped one — but not by rule, so a name that will
 * not decode to printable text keeps its hex rather than becoming mojibake.
 */
export const claimTokenName = (unit: string): string => {
  const dot = unit.indexOf('.')
  const nameHex = dot === -1 ? '' : unit.slice(dot + 1)
  if (nameHex === '' || nameHex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(nameHex)) return unit
  const bytes = new Uint8Array(nameHex.length / 2)
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(nameHex.slice(i * 2, i * 2 + 2), 16)
  const printable = (from: number): string | null => {
    const slice = bytes.slice(from)
    if (slice.length === 0 || slice.some((b) => b < 0x20 || b > 0x7e)) return null
    return String.fromCharCode(...slice)
  }
  // A CIP-67 label is four bytes shaped `0000 <16-bit label> <8-bit crc> 0000`, so
  // the outer nibbles are what identify one. Matching on "the rest looks printable"
  // instead would eat the first four bytes of any five-letter name — `HOSKY` came
  // back as `Y`.
  const labelled = nameHex.length > 8 && nameHex.startsWith('0') && nameHex[7] === '0'
  return (labelled ? printable(4) : null) ?? printable(0) ?? unit
}

/**
 * The JSON body CIP-99 says to send.
 *
 * The link's own extra parameters go alongside `address` and `code` — that is what
 * "passed through without modification" means at the wire — but neither reserved
 * key can be overwritten by one, or a crafted link could post an address the user
 * never chose while the screen showed theirs.
 */
export const claimRequestBody = (
  address: string,
  code: string,
  params: Readonly<Record<string, string>>,
): Record<string, string> => ({...params, address, code})

export type ClaimRequest = {
  readonly uri: Pick<ClaimUri, 'faucetUrl' | 'code' | 'params'>
  readonly address: string
  /** Cut the wait when a faucet hangs. Defaults to 20s. */
  readonly timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 20_000

/**
 * Ask a faucet for a claim.
 *
 * Never throws: a network failure is `unreachable` and a body that will not parse
 * is `malformed`, because both are outcomes the screen has to render and neither
 * is more of an exception than a 409.
 */
export const postClaim = async ({uri, address, timeoutMs}: ClaimRequest): Promise<ClaimOutcome> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const response = await fetch(uri.faucetUrl, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Accept: 'application/json'},
      body: JSON.stringify(claimRequestBody(address, uri.code, uri.params)),
      signal: controller.signal,
    })
    const text = await response.text()
    let parsed: unknown = null
    try {
      parsed = text === '' ? null : JSON.parse(text)
    } catch (e: unknown) {
      // A faucet that answered with an error page rather than a status block.
      logger.warn('Faucet response body was not JSON; reading the outcome from the status alone', {
        origin: 'claim-faucet',
        status: response.status,
        error: String(e),
      })
      return readClaimResponse(response.status, null)
    }
    return readClaimResponse(response.status, parsed)
  } catch (e: unknown) {
    // `unreachable` covers a refused connection, a DNS failure and our own 20s abort alike, and
    // the screen renders one sentence for all three.
    logger.warn('Faucet claim request failed; reporting the faucet unreachable', {
      origin: 'claim-faucet',
      error: String(e),
    })
    return {kind: 'rejected', reason: 'unreachable', code: null}
  } finally {
    clearTimeout(timer)
  }
}
