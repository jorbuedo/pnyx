/**
 * Builds a CIP-30 {@link CardanoHandlerContext} from the app-published wallet
 * snapshot. The snapshot is read lazily per field so live updates (new sync,
 * account switch) are picked up without rebuilding the resolver. Data reads
 * fail with a typed error when no snapshot is present (wallet not yet synced /
 * no account selected); connect/`isEnabled` don't touch the context.
 *
 * @module
 */

import {ApiErrorCode, type CardanoHandlerContext, type CardanoUtxo, WireError} from '@pnyx/dapp-connector'
import {Effect} from 'effect'
import type {DappSnapshot, SnapshotUtxo} from './protocol'

const decodeUtxo = (u: SnapshotUtxo): CardanoUtxo => ({
  txHashHex: u.txHashHex,
  index: u.index,
  addressHex: u.addressHex,
  coin: BigInt(u.coin),
  assets: u.assets.map((a) => ({policyHex: a.policyHex, nameHex: a.nameHex, quantity: BigInt(a.quantity)})),
})

const snapshotUnavailable = new WireError({
  code: ApiErrorCode.InternalError,
  message: 'wallet data is not available — no account synced for the extension',
})

const cip95Unavailable = new WireError({
  code: ApiErrorCode.InternalError,
  message: 'CIP-95 keys are not available yet — sign once to derive them',
})

/**
 * Build a handler context backed by `loadSnapshot`. `submitTx` is delegated
 * (the service worker has no signing rail) — typically relayed to the app.
 */
export const contextFromSnapshot = (
  loadSnapshot: () => Effect.Effect<DappSnapshot | null>,
  submitTx: (signedTxHex: string) => Effect.Effect<string, WireError>,
): CardanoHandlerContext => {
  const field = <A>(select: (s: DappSnapshot) => A): Effect.Effect<A, WireError> =>
    Effect.flatMap(loadSnapshot(), (s) => (s ? Effect.succeed(select(s)) : Effect.fail(snapshotUnavailable)))

  // CIP-95 fields are absent from the snapshot until the keys are derived.
  const cip95Field = <A>(select: (s: DappSnapshot) => A | undefined): Effect.Effect<A, WireError> =>
    Effect.flatMap(loadSnapshot(), (s) => {
      if (!s) return Effect.fail(snapshotUnavailable)
      const v = select(s)
      return v === undefined ? Effect.fail(cip95Unavailable) : Effect.succeed(v)
    })

  return {
    networkId: field((s) => s.networkId),
    networkMagic: field((s) => s.networkMagic),
    utxos: field((s) => s.utxos.map(decodeUtxo)),
    collateralUtxos: field((s) => s.collateralUtxos.map(decodeUtxo)),
    changeAddressHex: field((s) => s.changeAddressHex),
    usedAddressHexes: field((s) => s.usedAddressHexes),
    unusedAddressHexes: field((s) => s.unusedAddressHexes),
    rewardAddressHexes: field((s) => s.rewardAddressHexes),
    pubDRepKeyHex: cip95Field((s) => s.pubDRepKeyHex),
    registeredPubStakeKeyHexes: cip95Field((s) => s.registeredPubStakeKeyHexes),
    unregisteredPubStakeKeyHexes: cip95Field((s) => s.unregisteredPubStakeKeyHexes),
    submitTx,
  }
}
