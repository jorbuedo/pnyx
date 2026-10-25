/**
 * Adapts a {@link CardanoRail} to the `@pnyx/dapp-connector` CIP-30
 * `CardanoHandlerContext`: the wallet-side data source the resolver answers
 * `getUtxos` / `getBalance` / addresses / `submitTx` from, in exact CIP-30 wire
 * form (raw address bytes hex; the handler builds the CBOR via the codec).
 *
 * CIP-95 public keys: pass `govKeys` (the account's DRep + stake public keys,
 * derived + persisted via `ensureCardanoGovKeys`) to serve `getPubDRepKey` /
 * the stake-key getters. Absent `govKeys`, they fail with an honest wire error
 * rather than fabricating keys.
 *
 * @module
 */

import type {UTxO} from '@evolution-sdk/evolution'
import {Provider as EvolutionProvider} from '@evolution-sdk/evolution'
import {Bech32, type TxHashHex} from '@evolution-sdk/review/Brands'
import * as Decode from '@evolution-sdk/review/Decode'
import {Address} from '@pnyx/cardano-core'
import {
  ApiErrorCode,
  type CardanoHandlerContext,
  type CardanoUtxo,
  makeCardanoQueryContext,
  TxSendErrorCode,
  WireError,
} from '@pnyx/dapp-connector'
import {utxoId} from '@pnyx/wallet'
import {Effect, Layer} from 'effect'
import {logger} from '../../logger'
import {getCardanoDataStore} from './cardano-store'
import {broadcastFailureReason} from './leaked-key'
import type {CardanoRail} from './rail'
import {utxoAddressBech32, utxoAssetMap} from './utxo-view'

const CIP95_UNAVAILABLE = new WireError({
  code: ApiErrorCode.Refused,
  message: 'CIP-95 public keys are unavailable for this derive-only Cardano wallet',
})

/**
 * One UTxO in CIP-30 wire form.
 *
 * ⚠️ **`utxo.address`, not the account's primary address.** Every UTxO used to be
 * reported at `rail.account.addressHex`, so a dApp balancing against a coin held on a
 * discovered address computed inputs and change for an address the wallet does not
 * hold that coin at. `UTxO.UTxO` has carried its own address all along.
 *
 * `addressHexOf` returns `null` for an address the codec cannot read; such a UTxO is
 * dropped rather than relabelled, because a coin reported at the wrong address is
 * worse for the dApp than a coin it never saw.
 */
const toCardanoUtxo = (utxo: UTxO.UTxO, addressHex: string): CardanoUtxo => ({
  txHashHex: utxoId(utxo).split(':')[0] as TxHashHex,
  index: Number(utxo.index),
  addressHex,
  coin: utxo.assets.lovelace,
  assets: [...utxoAssetMap(utxo)].map(([assetId, quantity]) => {
    const [policyHex = '', nameHex = ''] = assetId.split('.')
    return {policyHex, nameHex, quantity}
  }),
})

/** CIP-95 account public keys (hex) served to dApps when available. */
export type CardanoGovPubKeys = {readonly drepPubKeyHex: string; readonly stakePubKeyHex: string}

/**
 * Build the CIP-30 data source over `rail`. dApp-submitted txs go straight to
 * the rail provider — they carry no change info we can track, so they do NOT
 * enter the pending-tx overlay (wallet-built sends do, via the send flow).
 * Pass `govKeys` to serve the CIP-95 pub-key getters.
 */
/** bech32 → raw-address hex, or `null` when it cannot be read. */
const addressHexOf = (bech32: string): string | null => {
  try {
    return Address.fromBech32Sync(Bech32(bech32))
  } catch (error) {
    logger.warn('dapp: an address could not be encoded for CIP-30 and was left out', {
      origin: 'dapp-context',
      error: String(error),
    })
    return null
  }
}

/**
 * The wallet's external addresses, split as CIP-30 asks for them.
 *
 * Read from the address table — the store that exists so that "CIP-30
 * `getUsedAddresses` / `getUnusedAddresses` are SQL filters, not JS walks". `rail.dataRef`
 * is exactly that table's key, so both dApp surfaces (the in-app browser and the
 * extension) are served here rather than threaded separately through their hooks.
 *
 * ⚠️ **Not `[...rail.knownAddresses]`**, which would fix the count and collapse the
 * distinction: CIP-30 asks two different questions and a dApp picking a fresh receive
 * address needs the unused half to actually be unused.
 *
 * Falls back to the account's own address when the table has no rows for this wallet —
 * a shared wallet, a bare-address watch, or a sync that has not run — so the surface
 * never gets *worse* than the single address it used to report.
 */
const externalAddresses = (rail: CardanoRail, isUsed: boolean): Effect.Effect<readonly string[]> =>
  Effect.gen(function* () {
    const store = getCardanoDataStore()
    if (store === null) {
      logger.debug('dapp: no wallet data store bound; answering with the account address alone', {
        origin: 'dapp-context',
        isUsed,
      })
      return isUsed ? [rail.account.addressHex] : []
    }
    const rows = yield* store
      .listAddresses({
        groupId: rail.dataRef.groupId,
        chainId: rail.dataRef.chainId,
        accountIndex: rail.dataRef.accountIndex,
        branch: 'external',
        isUsed,
      })
      .pipe(
        Effect.catchAll((error) => {
          logger.warn('dapp: the address table could not be read; falling back to the account address', {
            origin: 'dapp-context',
            isUsed,
            error: String(error),
          })
          return Effect.succeed([] as readonly {readonly human: string}[])
        }),
      )
    const hexes = rows.map((row) => addressHexOf(row.human)).filter((hex): hex is string => hex !== null)
    if (hexes.length > 0) {
      // Logged on the way OUT, not only on the fallback. Reporting nothing on success made a
      // query that worked indistinguishable from one that never ran — which is exactly what
      // happened: a scan served the right addresses and the only evidence in the log was the
      // *absence* of the fallback line. `dropped` is the gap between rows read and addresses
      // served, so an address the codec refuses shows up as a number rather than as silence.
      logger.info('dapp: served the wallet its stored external addresses', {
        origin: 'dapp-context',
        isUsed,
        served: hexes.length,
        dropped: rows.length - hexes.length,
      })
      return hexes
    }
    logger.debug('dapp: no stored external addresses; answering with the account address', {
      origin: 'dapp-context',
      isUsed,
      rowCount: rows.length,
    })
    return isUsed ? [rail.account.addressHex] : []
  })

export const createCardanoHandlerContext = (rail: CardanoRail, govKeys?: CardanoGovPubKeys): CardanoHandlerContext => {
  const utxos = Effect.map(rail.spendableUtxos, (list) =>
    list
      .map((u) => {
        const addressHex = addressHexOf(utxoAddressBech32(u))
        return addressHex === null ? null : toCardanoUtxo(u, addressHex)
      })
      .filter((u): u is CardanoUtxo => u !== null),
  )
  const rewardAddressHex = rail.account.rewardAddressHex
  return {
    networkId: Effect.succeed(rail.config.networkId),
    networkMagic: Effect.succeed(rail.config.protocolMagic),
    utxos,
    collateralUtxos: Effect.map(utxos, (list) => list.filter((u) => u.assets.length === 0)),
    changeAddressHex: Effect.succeed(rail.account.addressHex),
    usedAddressHexes: externalAddresses(rail, true),
    unusedAddressHexes: externalAddresses(rail, false),
    // Empty for a wallet watching a bare address: CIP-30 asks which reward addresses
    // the wallet has, and an enterprise address has none.
    rewardAddressHexes: Effect.succeed(rewardAddressHex === null ? [] : [rewardAddressHex]),
    // A leaked-key refusal is `Refused`, not `Failure`: the wallet declined to
    // broadcast, the network never saw the transaction.
    submitTx: (signedTxHex) =>
      rail.submit(signedTxHex).pipe(
        Effect.mapError(
          (e) =>
            new WireError({
              code: e._tag === 'LeakedSigningKeyError' ? TxSendErrorCode.Refused : TxSendErrorCode.Failure,
              message: broadcastFailureReason(e),
            }),
        ),
      ),
    // CIP-139 chain reads — this is what makes the wallet "full-data" (CPS-10), so a
    // dApp can stop running its own query backend and the two views can no longer
    // disagree about a UTxO the wallet is asked to sign for.
    //
    // The rail's guarded provider is reused deliberately: reads share the rate limiter
    // and the identity's authenticated Koios tier, so a dApp's traffic is paced with
    // ours rather than beside it. Its `submit` error is widened back into a
    // `ProviderError` rather than cast away — the query layer never submits, but a
    // future caller should still find a typed channel instead of a lie.
    //
    // Passing this at all is the switch: omit `query` and the extension is neither
    // advertised nor served.
    query: makeCardanoQueryContext(
      Layer.merge(
        // ⚠️ The rail's OWN typed client, not a second one: it is the same Koios instance the rail
        // reads through, so a dApp's reads share our request budget and the identity's
        // authenticated tier rather than spending beside them.
        //
        // This used to hand over the wallet-shaped port and let the query layer derive the typed
        // one — a conversion that existed only because the two ends disagreed, plus a widening of
        // a `submit` error for a layer that never submits. `chain` carries no `submitTx` at all,
        // which is what keeps the leaked-key gate on one path.
        Layer.succeed(EvolutionProvider.ProviderEffect, rail.chain as EvolutionProvider.ProviderEffect),
        // ⚠️ `review`'s `Decode` specifically: the CIP-139 query layer asks for that service and
        // ships its own implementation, so a same-named decoder from elsewhere is not what belongs
        // here.
        Decode.layer,
      ),
    ),
    pubDRepKeyHex: govKeys ? Effect.succeed(govKeys.drepPubKeyHex) : Effect.fail(CIP95_UNAVAILABLE),
    // Registration status isn't cheaply known here, so the stake key is reported
    // as unregistered (the conservative bucket); CIP-95 dApps query both.
    registeredPubStakeKeyHexes: govKeys ? Effect.succeed([]) : Effect.fail(CIP95_UNAVAILABLE),
    unregisteredPubStakeKeyHexes: govKeys ? Effect.succeed([govKeys.stakePubKeyHex]) : Effect.fail(CIP95_UNAVAILABLE),
  }
}
