/**
 * Serialize an app-side {@link CardanoHandlerContext} into the JSON-safe
 * {@link DappSnapshot} the background dApp router reads. The app publishes this
 * for the active Cardano account so the service worker can answer CIP-30 reads
 * without a live app window. CIP-95 keys are omitted until derived.
 *
 * @module
 */

import type {CardanoHandlerContext, CardanoUtxo} from '@pnyx/dapp-connector'
import {Effect} from 'effect'
import type {DappSnapshot, SnapshotUtxo} from './protocol'

const toSnapshotUtxo = (u: CardanoUtxo): SnapshotUtxo => ({
  txHashHex: u.txHashHex,
  index: u.index,
  addressHex: u.addressHex,
  coin: u.coin.toString(),
  assets: u.assets.map((a) => ({policyHex: a.policyHex, nameHex: a.nameHex, quantity: a.quantity.toString()})),
})

/**
 * Run the context's read Effects and produce a snapshot for `groupId`'s
 * account at `accountIndex`. Rejects if a data field fails (e.g. the rail can't produce UTxOs) —
 * the caller skips publishing. CIP-95 fields degrade to omitted rather than
 * failing the whole snapshot.
 */
export const contextToSnapshot = (
  ctx: CardanoHandlerContext,
  groupId: string,
  accountIndex: number,
): Promise<DappSnapshot> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const networkId = yield* ctx.networkId
      const networkMagic = yield* ctx.networkMagic
      const utxos = yield* ctx.utxos
      const collateralUtxos = yield* ctx.collateralUtxos
      const changeAddressHex = yield* ctx.changeAddressHex
      const usedAddressHexes = yield* ctx.usedAddressHexes
      const unusedAddressHexes = yield* ctx.unusedAddressHexes
      const rewardAddressHexes = yield* ctx.rewardAddressHexes
      const pubDRepKeyHex = yield* ctx.pubDRepKeyHex.pipe(Effect.orElseSucceed(() => undefined))
      const registered = yield* ctx.registeredPubStakeKeyHexes.pipe(Effect.orElseSucceed(() => undefined))
      const unregistered = yield* ctx.unregisteredPubStakeKeyHexes.pipe(Effect.orElseSucceed(() => undefined))

      return {
        groupId,
        accountIndex,
        networkId,
        networkMagic,
        usedAddressHexes: [...usedAddressHexes],
        unusedAddressHexes: [...unusedAddressHexes],
        changeAddressHex,
        rewardAddressHexes: [...rewardAddressHexes],
        utxos: utxos.map(toSnapshotUtxo),
        collateralUtxos: collateralUtxos.map(toSnapshotUtxo),
        ...(pubDRepKeyHex !== undefined ? {pubDRepKeyHex} : {}),
        ...(registered !== undefined ? {registeredPubStakeKeyHexes: [...registered]} : {}),
        ...(unregistered !== undefined ? {unregisteredPubStakeKeyHexes: [...unregistered]} : {}),
      }
    }),
  )
