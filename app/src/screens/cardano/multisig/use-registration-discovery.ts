/**
 * Searching the chain for shared wallets this device's seed is part of.
 *
 * Derives our own CIP-1854 credentials across the address gap, fetches every
 * label-1854 registration, and applies the CIP's oldest-wins rule. The rule and
 * the fetching live in `registration-discovery.ts`; this is the ceremony, the
 * network wiring and the screen's state.
 *
 * **A result is a finding, not a wallet.** A registration names participants by
 * *key hash* — that is what a native script contains — and a `SharedWallet` needs
 * their account **xpubs** to derive any address beyond the ones the registration
 * compiled. Hashes are one-way, so a discovered wallet cannot be reconstructed
 * into a usable one here. What discovery answers is "am I in a shared wallet, and
 * who else is in it" — enough to go and ask a participant to re-invite you, which
 * is the exchange that carries keys. Offering an "add" button would be promising
 * a wallet this cannot produce.
 *
 * The search needs the account xpub, which means the vault, which means the
 * biometric prompt — appropriate for an action the user explicitly asks for, and
 * the reason this runs on a button rather than on mount.
 *
 * @module
 */

import {XpubHex} from '@evolution-sdk/review/Brands'
import type {WalletSource} from '@pnyx/wallet'
import {Effect, Either} from 'effect'
import {useCallback, useState} from 'react'
import {logger} from '../../../logger'
import {useI18n} from '../../../providers'
import {getActiveCardanoNetwork} from '../../../services/cardano/config'
import {coSignerFailureKey} from '../../../services/cardano/multisig/cosigner-key-message'
import {paymentKeyHashAt, scriptsAt, stakeKeyHashOf} from '../../../services/cardano/multisig/derive'
import {
  loadRegistrationCache,
  mergeRows,
  saveRegistrationCache,
} from '../../../services/cardano/multisig/registration-cache'
import {
  type DiscoveredWallet,
  fetchRegistrationHashes,
  fetchRegistrationRows,
  matchRegistrations,
  oldestPerCredential,
} from '../../../services/cardano/multisig/registration-discovery'
import {MULTISIG_ADDRESS_GAP, type SharedWallet} from '../../../services/cardano/multisig/types'
import {getPoolDRepConfig} from '../../../services/cardano-pool-drep/config'
import {resolveGroupCoSignerXpub} from '../../../services/group-seed'

/**
 * A result, and whether this device already has it.
 *
 * A search that lists a wallet sitting in the list below it, with no sign that it
 * is the same one, is a worse answer than one that says so — and it is the common
 * case, since the wallets you published are the wallets you have.
 */
export type DiscoveryResult = {
  readonly wallet: DiscoveredWallet
  readonly alreadyAdded: boolean
}

export type DiscoveryState =
  | {readonly status: 'idle'}
  | {readonly status: 'searching'}
  /** Ran to completion. An empty `found` is a real answer, not a failure. */
  | {readonly status: 'done'; readonly found: readonly DiscoveryResult[]; readonly scanned: number}
  | {readonly status: 'failed'; readonly reason: string}

/**
 * Our own credentials, across the gap.
 *
 * Both roles: a registration carries a payment script and a delegation script,
 * and the delegation one names stake keys. Searching payment keys only would miss
 * a wallet whose payment template happens not to include us — which the ledger
 * allows and a roster editor can produce.
 */
const ownCredentials = (accountXpubHex: string): Effect.Effect<readonly string[]> =>
  Effect.gen(function* () {
    const payment = yield* Effect.forEach(
      Array.from({length: MULTISIG_ADDRESS_GAP}, (_, i) => i),
      (i) => paymentKeyHashAt(XpubHex(accountXpubHex), i),
    )
    const stake = yield* stakeKeyHashOf(XpubHex(accountXpubHex))
    return [...payment, stake]
  }).pipe(
    Effect.catchAll((e) => {
      logger.warn('Key-hash derivation failed; discovery cannot match this account', {
        origin: 'useRegistrationDiscovery',
        error: String(e),
      })
      return Effect.succeed([] as readonly string[])
    }),
  )

/**
 * The script hashes of the wallets already on this device.
 *
 * Matching on the compiled script rather than the name: a name is whatever the
 * publisher typed, and two wallets can share one. The script hash *is* the wallet.
 */
const localScriptHashes = (wallets: readonly SharedWallet[]): Effect.Effect<ReadonlySet<string>> =>
  Effect.forEach(wallets, (w) =>
    scriptsAt(w, 0).pipe(
      Effect.map((s) => [s.paymentScriptHashHex.toLowerCase(), s.stakingScriptHashHex.toLowerCase()]),
      Effect.catchAll((e) => {
        logger.warn('Script derivation failed for a shared wallet; it is left out of the local set', {
          origin: 'useRegistrationDiscovery',
          error: String(e),
        })
        return Effect.succeed([] as readonly string[])
      }),
    ),
  ).pipe(
    Effect.map((all) => new Set(all.flat())),
    Effect.catchAll((e) => {
      logger.warn('Local script-hash set could not be built; every registration reads as remote', {
        origin: 'useRegistrationDiscovery',
        error: String(e),
      })
      return Effect.succeed(new Set<string>())
    }),
  )

export const useRegistrationDiscovery = (
  groupId: string | null,
  source: WalletSource | null,
  known: readonly SharedWallet[],
  /** Which account's co-signer key to search with — the caller's selection, never assumed. */
  accountIndex: number,
): {readonly state: DiscoveryState; readonly search: () => void; readonly reset: () => void} => {
  const {t} = useI18n()
  const [state, setState] = useState<DiscoveryState>({status: 'idle'})

  const search = useCallback(() => {
    if (groupId === null || source === null) return
    setState({status: 'searching'})
    void (async () => {
      try {
        const xpub = await resolveGroupCoSignerXpub(groupId, source, t('common.biometricPrompt'), accountIndex)
        if (Either.isLeft(xpub)) {
          // The specific reason, so a hardware wallet is told to connect its
          // device rather than that it has no key — which it does have.
          setState({status: 'failed', reason: t(coSignerFailureKey(xpub.left))})
          return
        }
        const credentials = await Effect.runPromise(ownCredentials(xpub.right))
        if (credentials.length === 0) {
          setState({status: 'failed', reason: t('multisig.discovery.noKey')})
          return
        }

        const network = getActiveCardanoNetwork()
        const {koiosUrl} = getPoolDRepConfig(network)
        // Resume from what a previous search already resolved. The watermark is
        // inclusive, so this re-reads one block and the merge de-duplicates it.
        const cache = await Effect.runPromise(Effect.orElseSucceed(loadRegistrationCache(network), () => null))
        const hashes = await Effect.runPromise(fetchRegistrationHashes(koiosUrl, cache?.watermark, fetch))
        const alreadyResolved = new Set((cache?.rows ?? []).map((row) => row.txHash))
        const fresh = await Effect.runPromise(
          fetchRegistrationRows(
            koiosUrl,
            hashes.filter((h) => !alreadyResolved.has(h)),
            fetch,
          ),
        )
        const rows = mergeRows(cache?.rows ?? [], fresh)
        // Written only from a complete read — both fetches fail rather than
        // returning what survived, so a partial set can never become the cached
        // "everything".
        await Effect.runPromise(Effect.ignore(saveRegistrationCache(network, rows)))
        // One entry per wallet, not per credential: a registration naming two of
        // our indexes is one wallet, and `oldestPerCredential` is what applies the
        // rule before the de-duplication.
        const winners = [...new Set(oldestPerCredential(matchRegistrations(rows, credentials)).values())]
        const mine = await Effect.runPromise(localScriptHashes(known))
        const found = winners.map((wallet) => ({
          wallet,
          alreadyAdded: wallet.scriptHashes.some((h) => mine.has(h.toLowerCase())),
        }))
        // The ones this device does not have come first — they are the reason
        // somebody ran a search.
        found.sort((a, b) => Number(a.alreadyAdded) - Number(b.alreadyAdded))
        setState({status: 'done', found, scanned: rows.length})
      } catch (error) {
        logger.error('registration discovery failed', {origin: 'SharedWalletsScreen', error})
        setState({status: 'failed', reason: t('multisig.discovery.failed')})
      }
    })()
  }, [groupId, source, known, t, accountIndex])

  const reset = useCallback(() => setState({status: 'idle'}), [])

  return {state, search, reset}
}
