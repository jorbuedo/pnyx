/**
 * The shared (multisig) wallets registered on the active network, and the
 * on-chain state of one of them.
 *
 * Discovery walks the CIP-1854 address gap, which is one provider call per
 * index, so it runs on demand rather than on every focus.
 *
 * @important A wallet whose scan was truncated reports `truncated`, and the UI
 * must say so — a balance that silently under-reports is worse than one that
 * admits it could not finish looking.
 *
 * @module
 */

import {Provider as EvolutionProvider} from '@evolution-sdk/evolution'
import {Effect} from 'effect'
import {useCallback, useEffect, useState} from 'react'
import {logger} from '../logger'
import {getActiveCardanoNetwork, getCardanoRailConfig} from '../services/cardano/config'
import {
  addressNetworkOf,
  type Discovery,
  discoverSharedWallet,
  platformSharedWalletRegistry,
  type SharedWallet,
  sharedScanReader,
} from '../services/cardano/multisig'
import {cardanoRailLayer} from '../services/cardano/rail'

/** Every shared wallet on the active network, refreshed on demand. */
export const useSharedWallets = (): {
  readonly wallets: readonly SharedWallet[]
  readonly loading: boolean
  readonly reload: () => void
} => {
  const [wallets, setWallets] = useState<readonly SharedWallet[]>([])
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: `nonce` is the reload trigger, not a read value
  useEffect(() => {
    let active = true
    setLoading(true)
    const network = addressNetworkOf(getActiveCardanoNetwork())
    void Effect.runPromise(platformSharedWalletRegistry().list(network))
      .then((list) => {
        if (active) setWallets(list)
      })
      .catch((e: unknown) => {
        logger.warn('Shared wallet list failed', {origin: 'useSharedWallets', message: String(e)})
        if (active) setWallets([])
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [nonce])

  return {wallets, loading, reload: useCallback(() => setNonce((n) => n + 1), [])}
}

export type SharedWalletState =
  | {readonly status: 'loading'}
  /** No Cardano rail configured for this build — not "zero balance". */
  | {readonly status: 'unavailable'}
  | {readonly status: 'error'; readonly message: string}
  | {readonly status: 'ready'; readonly discovery: Discovery}

/**
 * Scan one shared wallet's addresses for funds.
 *
 * A failure is reported as `error`, never as an empty balance: a wallet showing
 * 0 because the indexer was unreachable is indistinguishable from one that is
 * genuinely empty, and only one of those is safe to act on.
 */
export const useSharedWalletState = (
  wallet: SharedWallet | null,
): SharedWalletState & {readonly reload: () => void} => {
  const [state, setState] = useState<SharedWalletState>({status: 'loading'})
  const [nonce, setNonce] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: `nonce` is the reload trigger, not a read value
  useEffect(() => {
    if (wallet === null) return
    let active = true
    setState({status: 'loading'})
    const config = getCardanoRailConfig()
    if (config === null) {
      setState({status: 'unavailable'})
      return
    }
    const layer = cardanoRailLayer(config)
    const program = Effect.gen(function* () {
      const chain = yield* EvolutionProvider.ProviderEffect
      // The same reader the rail resolver walks with — so this scan asks a refused address
      // again instead of ending on it, which it did not before, and the two agree on a row.
      return yield* discoverSharedWallet(
        wallet,
        sharedScanReader(chain.getUtxos, (refusal) =>
          logger.warn('Koios refused an address in a shared wallet scan; asking again', {
            origin: 'useSharedWallets',
            walletId: wallet.id,
            kind: refusal.kind,
            detail: refusal.detail,
          }),
        ),
      )
    })

    void Effect.runPromise(Effect.provide(program, layer) as Effect.Effect<Discovery>)
      .then((discovery) => {
        if (active) setState({status: 'ready', discovery})
      })
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e)
        logger.warn('Shared wallet scan failed', {origin: 'useSharedWallets', walletId: wallet.id, message})
        if (active) setState({status: 'error', message})
      })
    return () => {
      active = false
    }
  }, [wallet, nonce])

  return {...state, reload: useCallback(() => setNonce((n) => n + 1), [])}
}
