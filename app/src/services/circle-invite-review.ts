/**
 * The subject of an invite request: which stake credential is being asserted, and the request the
 * ceremony signs to assert it.
 *
 * ⚠️ **This proves a *funds wallet's* stake credential, so it goes through the review screen.** An
 * earlier version signed here directly, off the ceremony rail, and recorded the result as
 * `infra-exempt`. That classification was true while the signer was the identity's own stake key —
 * app infrastructure, no funds reachable — and stopped being true the moment the person started
 * picking one of their own wallets. `docs/SIGNING_AUDIT.md` states the rule the other way round and
 * it is the one that governs: *funds wallets are never exempt*. So this module builds the leg and
 * the request; `circle-invite-ceremony.ts` hands them to `TxReviewScreen` like every other producer.
 *
 * ⚠️ **The stake key, not the payment key.** Control of the *stake credential* is what makes
 * `account_info` mean anything about delegation, pool membership or controlled balance — the three
 * things a circle can gate on. A payment-key signature would prove control of the wrong thing.
 *
 * ⚠️ **Cardano mainnet, always.** The two axes are independent (`services/midnight/networks.ts`): a
 * circle lives on the identity axis, and delegation and balance only exist on mainnet. Building the
 * reward address for whatever network the app was on made the service ask mainnet Koios about a
 * `stake_test1…` address, which answers `500` — so every request came back as a retryable outage.
 * The credential itself is network-independent (a key hash), so the mainnet reward address is built
 * from the stored address of whichever network the wallet is currently synced on.
 *
 * @module
 */

import {Bech32} from '@evolution-sdk/review/Brands'
import {Address} from '@pnyx/cardano-core'
import type {CardanoDataPayload, SigningRequest} from '@pnyx/signing-service'
import {Effect} from 'effect'
import {cardanoStakePath} from './cardano/account'

/** Cardano **mainnet**, never the app's selected network. See the module note. */
const INVITE_NETWORK = Address.Network.Mainnet

/** The reward address a circle's predicate is evaluated against. */
export type InviteRewardAddress = {
  /** Raw address bytes — what the COSE protected header claims, and what the service is sent. */
  readonly rewardHex: string
  readonly rewardBech32: string
}

/** UTF-8 bytes of the challenge, hex — the wire form `signData` takes. */
export const utf8ToHex = (text: string): string =>
  [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, '0')).join('')

/**
 * The **mainnet** reward address of the stake credential behind `baseAddressBech32`.
 *
 * Derived from the wallet's stored address rather than from its seed, so choosing a wallet costs no
 * biometric prompt: the person sees what they are about to assert before the ceremony asks for
 * anything. The seed is read once, by the signing service, after they confirm.
 *
 * Throws when the address has no key stake credential — an enterprise address has none to assert,
 * and a script one belongs to a policy rather than to a signer. Both are refusals, not empty
 * results: `inviteEligibleWallets` should have kept such a wallet off the list, so reaching here is
 * a bug worth surfacing rather than a case worth defaulting.
 */
export const inviteRewardAddress = async (baseAddressBech32: string): Promise<InviteRewardAddress> => {
  const baseHex = await Effect.runPromise(Address.fromBech32(Bech32(baseAddressBech32)))
  const info = Address.inspect(baseHex)
  if (info.stakeCredHex === undefined) {
    throw new Error(`invite: ${info.kind} address has no stake credential to prove`)
  }
  if (info.stakeIsScript === true) {
    throw new Error('invite: the stake credential is a script, which no single signer controls')
  }
  const rewardHex = Address.rewardHex(INVITE_NETWORK, info.stakeCredHex)
  const rewardBech32 = await Effect.runPromise(Address.toBech32(rewardHex))
  return {rewardHex, rewardBech32}
}

/**
 * The CIP-8 request that asserts `rewardHex`, signed by `groupId`'s stake key at `accountIndex`.
 *
 * `signingPath` is CIP-1852 role 2 **for the chosen account**, not the role-2 constant: a person
 * proving with their second account signs with that account's stake key, and a fixed
 * `CARDANO_STAKE_PATH` would derive account 0's — a key whose hash does not match the address, which
 * `softwareSignData` refuses outright rather than signing the wrong assertion.
 */
export const inviteSigningRequest = (params: {
  readonly groupId: string
  readonly accountIndex: number
  readonly rewardHex: string
  /** The exact string the service issued — signed as its UTF-8 bytes. */
  readonly payload: string
}): SigningRequest & {readonly payload: CardanoDataPayload} => ({
  groupId: params.groupId,
  accountIndex: params.accountIndex,
  payload: {
    _tag: 'CardanoData',
    addressHex: params.rewardHex,
    payloadHex: utf8ToHex(params.payload),
    signingPath: cardanoStakePath(params.accountIndex),
    networkId: INVITE_NETWORK,
  },
})
