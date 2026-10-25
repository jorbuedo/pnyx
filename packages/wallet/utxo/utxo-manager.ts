/**
 * The confirmed-UTxO set, keyed by {@link utxoId}.
 *
 * ⚠️ Evolution's `UTxO` is the type — see `UtxoManager` in `../types.js` for why, and for the five
 * members removed with the change because nothing called them.
 *
 * @module
 */

import type {UTxO} from '@evolution-sdk/evolution'
import {Effect, Layer, Ref} from 'effect'
import {SyncError} from '../errors.js'
import {UtxoManager} from '../types.js'
import {utxoId} from './utxo.js'

/** Reads every UTxO on the given addresses. The rail supplies this; the fetch strategy is its. */
export type UtxoFetcher = (addresses: readonly string[]) => Effect.Effect<readonly UTxO.UTxO[], Error>

export type UtxoManagerConfig = {
  readonly chainId?: string
  readonly fetchUtxos?: UtxoFetcher
}

export const createUtxoManager = (config: UtxoManagerConfig = {}): Effect.Effect<UtxoManager, never, never> =>
  Effect.gen(function* () {
    const utxos = yield* Ref.make<ReadonlyMap<string, UTxO.UTxO>>(new Map())

    const getUtxos = (): Effect.Effect<readonly UTxO.UTxO[], never> =>
      Effect.map(Ref.get(utxos), (map) => Array.from(map.values()))

    /**
     * Replace the whole set.
     *
     * ⚠️ A full refetch, never a merge: the reconciliation contract is that a UTxO absent from the
     * answer has been spent, and a merge cannot express that.
     */
    const syncFull = (addresses: readonly string[]): Effect.Effect<void, SyncError> =>
      Effect.gen(function* () {
        if (!config.fetchUtxos) {
          return yield* Effect.fail(new SyncError({message: 'No UTXO fetcher configured'}))
        }
        const fetched = yield* config
          .fetchUtxos(addresses)
          .pipe(Effect.mapError((e) => new SyncError({message: `Failed to fetch UTXOs: ${e.message}`, cause: e})))
        yield* Ref.set(utxos, new Map(fetched.map((utxo) => [utxoId(utxo), utxo])))
      })

    return {utxos, getUtxos, syncFull}
  })

export const UtxoManagerLayer = (config?: UtxoManagerConfig) => Layer.effect(UtxoManager, createUtxoManager(config))
