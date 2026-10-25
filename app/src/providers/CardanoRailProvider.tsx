/**
 * Resolve the memoized Cardano rail for the active wallet group (group id +
 * its persisted derive-only ADA address). Returns `null` rail when the group
 * has no Cardano address or no first-party endpoint is configured.
 *
 * ⚠️ **This runs ONCE for the whole app, which is why it is a provider.** It was a
 * plain per-consumer hook with 23 call sites, and every one of them ran this entire
 * pipeline for the same wallet: its own `getCardanoRail`, its own address-book read,
 * its own gap scan, its own upgrade and its own post-upgrade sync. Measured on device
 * 2026-09-12 — three consumers on the Wallets screen produced three "discovery
 * settled" and three "rail upgraded" inside 3 ms for one groupId.
 *
 * The module-level maps below were added to blunt that, and they only ever coalesced
 * the *network* calls; the React work, the store reads and the state churn stayed
 * multiplied. They are kept because a provider remount (the `key={network}` on
 * `PlatformWalletProvider`) can still overlap two runs.
 *
 * Once the primary rail is up, seedless discovery runs in the background:
 * derive the CIP-1852 book from the stored account xpub, gap-limit scan the
 * provider, persist the discovered rows, and upgrade the rail to sync the full
 * multi-address set. Discovery failures leave the primary-only rail in place.
 *
 * A CIP-1854 shared wallet takes a different route entirely — it has no xpub of
 * its own and its addresses come from compiled scripts — but it comes out of the
 * same hook, so send, staking, activity and the rest reach it without knowing.
 *
 * @module
 */

import {Bech32} from '@evolution-sdk/review/Brands'
import {CARDANO_MAINNET} from '@pnyx/config'
import {Effect} from 'effect'
import {createContext, type ReactNode, useContext, useEffect, useState} from 'react'
import {logger} from '../logger'
import {type CardanoRail, getCardanoRail} from '../services/cardano'
import {type RailAddressSet, railAddressSetFromRows} from '../services/cardano/address-paths'
import {
  accountAddressUsageProbe,
  addressNetworkFor,
  type CardanoUsageProbe,
  discoveryDue,
  fetchAllAccountAddresses,
  loadLastDiscoveredAt,
  saveLastDiscoveredAt,
  seenAddressUsedSet,
  setExternalCardanoAddresses,
  txHistoryUsageProbe,
  txHistoryWindowProbe,
  utxoUsageProbe,
} from '../services/cardano/discovery'
import {resolveSharedWalletRail} from '../services/cardano/multisig/rail-resolution'
import type {SharedWallet} from '../services/cardano/multisig/types'
import {filterKeyCredentialAddresses} from '../services/cardano/read-only'
import {inFlight} from '../utils/in-flight'
import {useWalletAddress, useWalletData, useWalletList} from './WalletProvider'

export type CardanoRailState = {
  readonly rail: CardanoRail | null
  readonly groupId: string | null
  readonly address: string | null
  readonly loading: boolean
  /** Rail unavailable: no Cardano address, or no configured endpoint. */
  readonly unavailable: boolean
  /**
   * The CIP-1854 wallet behind this rail, and the payment index it spends at —
   * `null` for every ordinary wallet.
   *
   * Carried here because it is resolved here: the index is chosen by the same
   * gap scan that decides which addresses the rail syncs, and the roster is what
   * a gathered signature has to be filed against. Consumers that do not co-sign
   * ignore it; none of them has to ask what kind of wallet they are serving.
   */
  readonly shared: {readonly wallet: SharedWallet; readonly keyIndex: number} | null
}

/**
 * Session cache of a watch-only account's full key-credential base-address set,
 * keyed by reward address — so re-mounts don't re-hit `/account_addresses`.
 */
const readOnlyAddressCache = new Map<string, Promise<readonly string[]>>()

/**
 * The gap scan currently running for a (wallet, account), so concurrent mounts
 * share one walk instead of each starting their own.
 *
 * ⚠️ **`discoveryDue` cannot prevent this on its own**: the timestamp it reads is
 * written when a scan *finishes*, so every mount that arrives while one is running
 * sees "never scanned" and starts another. Measured on the 611-address wallet —
 * six `Cardano discovery started` for one groupId inside ten seconds, none of them
 * finished, which is six times the Koios spend for one answer.
 *
 * Unlike {@link readOnlyAddressCache} the entry is dropped once the walk settles:
 * this coalesces concurrent callers, it does not cache the result. A later scan is
 * due again after `MIN_DISCOVERY_INTERVAL_MS` and must actually run.
 */
const discoveryRuns = new Map<string, Promise<readonly string[]>>()

/**
 * The account's on-chain address set, per (network, reward address).
 *
 * ⚠️ **Six identical requests per boot before this** — every one `offset=0`, so not paging,
 * just the same question asked again by each mount that reached discovery. This is the
 * endpoint that answered **51 MB** on a large stake key, so repeating it is the worst kind
 * of duplication.
 *
 * Unlike {@link discoveryRuns} the entry is KEPT once it settles: the answer changes only
 * when the account touches an address it has never used, which is the same event that makes
 * a gap scan due — so it is refreshed on the same clock, by clearing it when a scan
 * completes rather than by a timer of its own.
 */
const accountAddressCache = new Map<string, Promise<readonly string[]>>()

/**
 * Coverage already announced per wallet, so the upgrade line is `info` once and `debug`
 * after.
 *
 * ⚠️ **Not cosmetic.** The hook re-runs on every remount and something upstream remounts it
 * in bursts — 40 of these in one 3-minute device log, nine inside 4 ms. At `info` that
 * buries every other line in the file, which is the opposite of what the line was added
 * for. The *first* time a wallet reaches a given address set is the event worth seeing.
 */
const announcedCoverage = new Set<string>()

const useCardanoRailPipeline = (): CardanoRailState => {
  const {selectedWalletGroup, selectedAccountIndex} = useWalletList()
  const {getDeriveOnlyAddresses, discoverCardanoAddresses} = useWalletAddress()
  const {listAddressesForWallet} = useWalletData()
  const groupId = selectedWalletGroup?.groupId ?? null
  const isReadOnly = selectedWalletGroup?.primaryWallet?.implementation === 'readOnly'
  const isShared = selectedWalletGroup?.primaryWallet?.source === 'multisig'

  const [state, setState] = useState<CardanoRailState>({
    rail: null,
    groupId,
    address: null,
    loading: groupId !== null,
    unavailable: false,
    shared: null,
  })

  useEffect(() => {
    let active = true
    if (groupId === null) {
      setState({rail: null, groupId: null, address: null, loading: false, unavailable: true, shared: null})
      return
    }
    setState((s) => ({...s, groupId, loading: true, unavailable: false, shared: null}))
    void (async () => {
      // A shared wallet holds no key material and derives nothing from an xpub,
      // so none of the path below applies: its addresses come from the roster's
      // compiled scripts and its rail is built from the account those produce.
      if (isShared) {
        try {
          const {rail, wallet, plan} = await resolveSharedWalletRail(groupId, Date.now())
          if (active) {
            setState({
              rail,
              groupId,
              address: plan.primaryAddress,
              loading: false,
              unavailable: false,
              shared: {wallet, keyIndex: plan.keyIndex},
            })
          }
        } catch (e: unknown) {
          logger.warn('Shared wallet rail unavailable', {
            origin: 'useCardanoRail',
            groupId,
            message: e instanceof Error ? e.message : String(e),
          })
          if (active) {
            setState({rail: null, groupId, address: null, loading: false, unavailable: true, shared: null})
          }
        }
        return
      }

      // ⚠️ Guarded because this sits in a `void (async …)()`: a rejection here reaches no caller and
      // surfaces as a red box. It rejects for real on a network switch, when the address store closes
      // under the read — `NativeStatement.runAsync` rejected, caused by a native NPE (2026-10-19).
      let derived: Awaited<ReturnType<typeof getDeriveOnlyAddresses>>
      try {
        derived = await getDeriveOnlyAddresses(selectedAccountIndex)
      } catch (e: unknown) {
        logger.warn('Derive-only address read failed, so the Cardano rail is unavailable', {
          origin: 'useCardanoRail',
          groupId,
          accountIndex: selectedAccountIndex,
          error: String(e),
        })
        if (active) {
          setState({rail: null, groupId, address: null, loading: false, unavailable: true, shared: null})
        }
        return
      }
      const address = derived.cardano
      if (!active) return
      if (address === undefined) {
        setState({rail: null, groupId, address: null, loading: false, unavailable: true, shared: null})
        return
      }
      // Watch-only wallets fetch balance account-level (accountUtxos, keyed on
      // the reward address) — no per-address UTxO fanout. The primary-only rail
      // paints the balance immediately; below we upgrade to a rail whose
      // knownAddresses is the FULL account set (needed for correct history
      // direction classification — see the read-only branch).
      const handle = getCardanoRail(
        groupId,
        address,
        undefined,
        isReadOnly
          ? {accountUtxoMode: 'all', accountIndex: selectedAccountIndex}
          : {accountIndex: selectedAccountIndex},
      )
      if (handle === null) {
        setState({rail: null, groupId, address, loading: false, unavailable: true, shared: null})
        return
      }
      let rail: CardanoRail
      try {
        rail = await handle
        if (active) setState({rail, groupId, address, loading: false, unavailable: false, shared: null})
      } catch (e: unknown) {
        logger.error('Cardano primary rail could not be built; the wallet has no Cardano rail at all', {
          origin: 'useCardanoRail',
          groupId,
          accountIndex: selectedAccountIndex,
          error: String(e),
        })
        if (active) setState({rail: null, groupId, address, loading: false, unavailable: true, shared: null})
        return
      }

      // Watch-only: the history classifier decides sent/received/internal from
      // whether a tx's addresses are "own", and falls back to rail.knownAddresses
      // when its cache is cold. With only the primary address, real txs on other
      // addresses net to zero and mislabel as "Internal / 0". So build a rail
      // whose knownAddresses is every key-credential base address under the stake
      // key (script payments dropped). Balance stays account-level (no fanout);
      // the set is memoized per reward address so it's fetched once per session.
      // A bare-address watch has no account to enumerate: its one address is the wallet.
      if (isReadOnly && rail.rewardAddressBech32 !== null) {
        const rewardKey = rail.rewardAddressBech32
        try {
          // Coalesced, not merely cached: three call sites reach this for the same reward address
          // within milliseconds of a load, and a result cache is still empty while the first request
          // is in the air — measured as six identical `/account_addresses` posts in nine milliseconds.
          const owned = await inFlight(readOnlyAddressCache, rewardKey, async () => {
            const enumerate = rail.chain.getAccountAddresses
            const all = enumerate ? await Effect.runPromise(fetchAllAccountAddresses(enumerate, Bech32(rewardKey))) : []
            return filterKeyCredentialAddresses([...all])
          })
          const beyondPrimary = owned.filter((a) => a !== address)
          if (!active || beyondPrimary.length === 0) return
          const fullHandle = getCardanoRail(groupId, address, beyondPrimary, {
            accountUtxoMode: 'all',
            accountIndex: selectedAccountIndex,
          })
          if (fullHandle === null) return
          const full = await fullHandle
          if (active) setState({rail: full, groupId, address, loading: false, unavailable: false, shared: null})
        } catch (e: unknown) {
          logger.warn('watch-only account address set unreadable; the primary-only rail stands', {
            origin: 'useCardanoRail',
            groupId,
            accountIndex: selectedAccountIndex,
            error: String(e),
          })
        }
        return
      }

      // Start from what discovery already persisted, before re-running it.
      //
      // A gap scan over a paced endpoint takes on the order of a minute, and the
      // rail is rebuilt on every mount — so without this the wallet spends that
      // minute believing it owns only its primary address, on every navigation.
      // That is not merely slow: history classification runs in that window, so
      // the user watches their own address be called a stranger's and then, a
      // minute later, become theirs again. The persisted rows are the same answer
      // discovery is about to recompute.
      let knownUsed: readonly string[] = []
      let addressPaths: ReadonlyMap<string, string> = new Map()
      try {
        // Read every derived row, not only the used ones — see `railAddressSetFromRows`
        // for why `isUsed` must not gate the credential set. The rows carry branch +
        // index, so every address they name can also be signed for; without those paths
        // the rail recognises an address but a send spending it ships with no witness.
        const set = railAddressSetFromRows(
          await listAddressesForWallet(groupId, CARDANO_MAINNET, {accountIndex: selectedAccountIndex}),
          address,
        )
        knownUsed = set.knownUsed
        addressPaths = set.paths
        const beyondPrimary = set.beyondPrimary
        if (active && beyondPrimary.length > 0) {
          const seededHandle = getCardanoRail(groupId, address, beyondPrimary, {
            accountUtxoMode: 'owned',
            accountIndex: selectedAccountIndex,
            addressPaths,
          })
          if (seededHandle !== null) {
            const seeded = await seededHandle
            if (active) setState({rail: seeded, groupId, address, loading: false, unavailable: false, shared: null})
          }
        }
      } catch (e: unknown) {
        // A first run genuinely has no rows and that is the ordinary case — but it is
        // indistinguishable here from a store read that failed, and both leave the rail
        // syncing one address.
        logger.debug('Cardano address book seeded nothing; the primary-only rail stands until discovery', {
          origin: 'useCardanoRail',
          groupId,
          accountIndex: selectedAccountIndex,
          error: String(e),
        })
      }

      // Seedless discovery: gap-scan OUR derivation, asking of each address "has
      // this ever been used?". Ownership stays gated on our own derivation, so a
      // foreign or adversarial address sharing our public stake credential can
      // never match.
      //
      // The probe order matters and was got wrong once: `/account_addresses`
      // membership is free but INCOMPLETE (it returned a single address for a
      // spent-out account with 1486 transactions), and UTxO presence is blind to
      // any address that has been emptied. Both reported a real, used address as
      // unused, which collapsed the scan onto its first window and left the
      // wallet not recognising its own address at index 36. Transaction history
      // is the authoritative answer, so membership is only a fast path in front
      // of it, never a substitute.
      //
      // The scan itself is rate-limited: it is dozens to hundreds of paced calls,
      // and it answers "which addresses became used", which needs a transaction to
      // change. The rail refuses to re-probe the chain more often than
      // MIN_DISCOVERY_INTERVAL_MS, so neither does discovery.
      //
      // ⚠️ **A scan that is not due must not skip the rail upgrade.** These are two
      // questions — "re-probe the chain?" and "is the rail syncing every address we
      // derived?" — and collapsing them stranded a freshly imported wallet on its
      // primary address for the whole interval. The run that finished the scan lost
      // `active` to a remount and returned before building the rail; every later mount
      // then found the scan not due and returned even earlier. Neither `credential_utxos`
      // nor `account_utxos` was ever requested, so only address 0's UTxOs existed as far
      // as the wallet was concerned, while history — a stake-level `account_txs` read —
      // showed the transaction perfectly.
      const upgradeFromAddressBook = async (): Promise<void> => {
        let set: RailAddressSet
        try {
          set = railAddressSetFromRows(
            await listAddressesForWallet(groupId, CARDANO_MAINNET, {accountIndex: selectedAccountIndex}),
            address,
          )
        } catch (e: unknown) {
          logger.warn('Cardano address book unreadable; the rail keeps the address set it already has', {
            origin: 'useCardanoRail',
            groupId,
            accountIndex: selectedAccountIndex,
            error: String(e),
          })
          return
        }
        if (set.beyondPrimary.length === 0) {
          logger.debug('Cardano address book names nothing beyond the primary address', {
            origin: 'useCardanoRail',
            groupId,
            accountIndex: selectedAccountIndex,
            rows: set.paths.size,
          })
          return
        }
        const fullHandle = getCardanoRail(groupId, address, set.beyondPrimary, {
          accountUtxoMode: 'owned',
          accountIndex: selectedAccountIndex,
          addressPaths: set.paths,
        })
        if (fullHandle === null) {
          logger.warn('Cardano rail unavailable for the full address set; the primary-only rail stands', {
            origin: 'useCardanoRail',
            groupId,
            accountIndex: selectedAccountIndex,
          })
          return
        }
        const full = await fullHandle
        // The line whose absence made this undiagnosable: which address set the UTxO
        // fetch actually covers. A rail syncing one address and a wallet holding coins
        // on one address produce the same screen.
        const announceKey = `${groupId}|${selectedAccountIndex}|${set.paths.size}`
        const firstTime = !announcedCoverage.has(announceKey)
        announcedCoverage.add(announceKey)
        logger[firstTime ? 'info' : 'debug']('Cardano rail upgraded to the full owned address set', {
          origin: 'useCardanoRail',
          groupId,
          accountIndex: selectedAccountIndex,
          addresses: set.beyondPrimary.length + 1,
          credentials: set.paths.size,
          applied: active,
        })
        if (active) setState({rail: full, groupId, address, loading: false, unavailable: false, shared: null})

        // ⚠️ **The upgrade had no fetch of its own.** Installing the wider rail only changes
        // which addresses a *later* sync would cover; it fetches nothing. Gate 5 has by then
        // already rejected the narrow rail's watermark, so a full refetch is known to be
        // needed — and the only thing that eventually ran it was the 60 s scheduler tick.
        // Measured on 2026-09-09: rail widened to 69 credentials at 6.07 s, first
        // `credential_utxos` fetch at 40.53 s, which is the "restart shows the wrong balance
        // and it fixes itself after a while" report.
        //
        // Safe to run from every mounted consumer: `getCardanoRail` hands them one shared
        // instance, whose own min-interval collapses the burst to a single fetch.
        void Effect.runPromise(
          full.sync.pipe(
            Effect.catchAll((e) =>
              Effect.sync(() => {
                logger.warn('Cardano rail upgraded but its first sync failed; the cached balance stands', {
                  origin: 'useCardanoRail',
                  groupId,
                  accountIndex: selectedAccountIndex,
                  error: String(e),
                })
              }),
            ),
          ),
        )
      }

      if (!discoveryDue(await loadLastDiscoveredAt(groupId, selectedAccountIndex), Date.now())) {
        await upgradeFromAddressBook()
        return
      }

      try {
        const rewardBech32 = rail.rewardAddressBech32
        const enumerate = rail.chain.getAccountAddresses
        const accountAddrs =
          enumerate !== undefined && rewardBech32 !== null
            ? new Set(
                await inFlight(accountAddressCache, `${rail.config.network}/${rewardBech32}`, () =>
                  Effect.runPromise(fetchAllAccountAddresses(enumerate, Bech32(rewardBech32))),
                ),
              )
            : null

        const txsAt = rail.chain.getTxsAt
        const addressesSeen = rail.chain.getAddressesSeen
        const historyProbe = txsAt !== undefined ? txHistoryUsageProbe(txsAt) : utxoUsageProbe(rail.chain.getUtxos)
        const membership = accountAddrs === null ? null : accountAddressUsageProbe(accountAddrs)
        const probe: CardanoUsageProbe =
          membership === null
            ? historyProbe
            : (bech32) =>
                membership(bech32).pipe(Effect.flatMap((hit) => (hit ? Effect.succeed(true) : historyProbe(bech32))))
        const scanKey = `${groupId}/${selectedAccountIndex}`
        const extra = await inFlight(discoveryRuns, scanKey, () =>
          discoverCardanoAddresses(addressNetworkFor(rail.config.network), probe, selectedAccountIndex, {
            // Already-proved-used addresses cost nothing to re-confirm ("used" is
            // permanent), and an untouched window clears in one call instead of
            // one per address.
            alreadyUsed: new Set(knownUsed),
            ...(txsAt !== undefined ? {anyUsed: txHistoryWindowProbe(txsAt)} : {}),
            // The one that decides how long this takes: with it a window is one
            // call, without it one call per address.
            ...(addressesSeen !== undefined ? {seenAmong: seenAddressUsedSet(addressesSeen)} : {}),
          }).finally(() => {
            discoveryRuns.delete(scanKey)
          }),
        )
        await saveLastDiscoveredAt(groupId, selectedAccountIndex, Date.now())
        // The scan that just finished is the event that can change this answer, so the
        // next due scan asks again rather than reusing a set from before it.
        accountAddressCache.delete(`${rail.config.network}/${rewardBech32}`)
        // On-chain addresses under our stake key that are NOT ours (scripts,
        // DEX/escrow, adversarial) — parked for a future positions view.
        if (accountAddrs !== null) {
          const ours = new Set(extra)
          const external = [...accountAddrs].filter((a) => !ours.has(a))
          setExternalCardanoAddresses(groupId, external)
          if (external.length > 0) {
            logger.info('Cardano external (non-owned) addresses under stake key', {
              origin: 'useCardanoRail',
              count: external.length,
            })
          }
        }
        // Discovery upserted rows for everything it scanned, so re-reading the book is
        // how the newly-found addresses get their signing paths. Deliberately NOT gated
        // on `active`: a superseded run must still leave the upgraded rail in the cache
        // for the mount that replaced it, which then finds the scan not due and reaches
        // the same call. Gating the *work* on `active` is what stranded the wallet.
        logger.debug('Cardano discovery settled; upgrading the rail from the address book', {
          origin: 'useCardanoRail',
          groupId,
          accountIndex: selectedAccountIndex,
          discovered: extra.length,
        })
        await upgradeFromAddressBook()
      } catch (e: unknown) {
        logger.warn('Cardano discovery failed; the rail keeps the address set it already has', {
          origin: 'useCardanoRail',
          groupId,
          accountIndex: selectedAccountIndex,
          error: String(e),
        })
      }
    })()
    return () => {
      active = false
    }
  }, [
    groupId,
    selectedAccountIndex,
    isReadOnly,
    isShared,
    getDeriveOnlyAddresses,
    discoverCardanoAddresses,
    listAddressesForWallet,
  ])

  return state
}

/**
 * `undefined` means "no provider above me", which is a wiring bug rather than a
 * state a wallet can be in — {@link useCardanoRail} turns it into a named error
 * instead of handing back a rail-less state that reads as "this wallet has no
 * Cardano address".
 */
const CardanoRailContext = createContext<CardanoRailState | undefined>(undefined)

export const CardanoRailProvider = ({children}: {children: ReactNode}) => {
  const state = useCardanoRailPipeline()
  return <CardanoRailContext.Provider value={state}>{children}</CardanoRailContext.Provider>
}

export const useCardanoRail = (): CardanoRailState => {
  const state = useContext(CardanoRailContext)
  if (state === undefined) {
    throw new Error('useCardanoRail must be used inside CardanoRailProvider (mounted in app/_layout.tsx)')
  }
  return state
}
