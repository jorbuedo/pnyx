/**
 * Registration health for the active account, assembled from what is already synced.
 *
 * The DUST destination the account *wants* is its own derived `mn_dust` address — slot 1 of
 * the Midnight receive-address set. Comparing that against what the chain says is how a
 * stale destination is caught.
 *
 * @module
 */

import {Effect} from 'effect'
import {useCallback, useEffect, useState} from 'react'
import {useCardanoRail} from '../../../hooks/useCardanoRail'
import {logger} from '../../../logger'
import type {CardanoRail} from '../../../services/cardano'
import {rewardAddressFor} from '../../../services/cardano/reward-address'
import {midnightFundsNetwork} from '../../../services/midnight/networks'
import {
  assessRegistration,
  type CnightUtxo,
  type ObservedDust,
  type RegistrationAssessment,
  type RegistrationUtxo,
} from '../../../services/midnight-dust'
import {fetchDustGenerationStatus} from '../../../services/midnight-dust/indexer'
import {type DustGeneration, parseDustGeneration, toObservedDust} from '../../../services/midnight-dust/observability'
import {readCnightUtxos, readRegistrations} from '../../../services/midnight-dust/read-registrations'

/**
 * Grace period, in slots, before a registration that is not yet producing DUST counts as a
 * problem. One Cardano slot is ~1s and the observation pipeline is documented as taking a
 * while, so this is deliberately generous: calling a healthy registration broken would
 * prompt a fee-bearing repair for nothing.
 */
const LAG_WINDOW_SLOTS = 4 * 60 * 60

/**
 * How long to wait on the indexer before carrying on without it. It only ever refines a
 * verdict the Cardano read has already produced, so waiting longer than this buys nothing a
 * user would notice and risks a screen that never settles.
 */
const INDEXER_TIMEOUT = '8 seconds'

export type DustRegistrationState = {
  readonly assessment: RegistrationAssessment | null
  readonly registrations: readonly RegistrationUtxo[]
  /** The account's NIGHT-bearing UTxOs, so the screen can total and date them. */
  readonly night: readonly CnightUtxo[]
  /**
   * Midnight-side generation telemetry, or `null` when the indexer said nothing. Only this
   * can say how much of the held NIGHT is *eligible* — the Cardano side sees the holding, not
   * the subset that counts.
   */
  readonly generation: DustGeneration | null
  readonly loading: boolean
  /** True when DUST registration cannot be shown at all — see {@link unavailableReasonKey}. */
  readonly unavailable: boolean
  /** `midnightDust.*` key naming why, so the screen never shows a bare empty state. */
  readonly unavailableReasonKey: 'unavailable' | 'wrongNetwork'
  /** The rail these reads came from, so actions build against the same one. */
  readonly rail: CardanoRail | null
  readonly refresh: () => void
}

export const useDustRegistration = (): DustRegistrationState => {
  const {rail, unavailable} = useCardanoRail()
  // The mapping validator's script hash, address and min-ADA in `validator.ts` are the
  // mainnet deployment, decoded from a real mainnet registration. On another network those
  // constants name an address that holds no such validator, so a build there would produce a
  // transaction that cannot succeed. Absent capability, not a silent substitution.
  const wrongNetwork = rail !== null && rail.config.network !== 'mainnet'
  const [assessment, setAssessment] = useState<RegistrationAssessment | null>(null)
  const [registrations, setRegistrations] = useState<readonly RegistrationUtxo[]>([])
  const [night, setNight] = useState<readonly CnightUtxo[]>([])
  const [generation, setGeneration] = useState<DustGeneration | null>(null)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)

  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: `nonce` is the refresh trigger.
  useEffect(() => {
    // A DUST registration names a stake credential, so a wallet watching a bare
    // address has nothing to read or register. Not an error state: the screen simply
    // has no account to report on.
    if (rail === null || wrongNetwork || rail.account.stakeKeyHashHex === null) return
    const stakeKeyHashHex = rail.account.stakeKeyHashHex
    let active = true
    setLoading(true)
    void (async () => {
      try {
        const [regs, cnight] = await Effect.runPromise(
          Effect.all([readRegistrations(rail, stakeKeyHashHex), readCnightUtxos(rail)]),
        )
        if (!active) return
        setRegistrations(regs)
        setNight(cnight)

        // Publish the Cardano-only verdict first. Every state the user most needs — not
        // registered, registered twice, holding no NIGHT — is decided here, and making them
        // wait on a third-party read means an indexer having a bad day blanks the screen.
        const assess = (observedDust: ObservedDust | null) =>
          assessRegistration({regs, cnight, observedDust, lagWindow: LAG_WINDOW_SLOTS})
        setAssessment(assess(null))
        setLoading(false)

        // Then refine, and only refine: the indexer answers whether DUST is generating, never
        // whether the account is registered. A multiply-registered wallet reads back as
        // unregistered there, so believing it would undo the diagnosis that matters most.
        // Keyed by the reward address — the same stake credential the datum names, so no new
        // key material, just another encoding of one we already have.
        const rewardAddress = rewardAddressFor(rail.config.networkId, {
          hashHex: stakeKeyHashHex,
          type: 'key',
        })
        if (rewardAddress === undefined) return
        const snapshot = await Effect.runPromise(
          fetchDustGenerationStatus(rewardAddress, midnightFundsNetwork(rail.config.network)).pipe(
            Effect.timeoutTo({
              duration: INDEXER_TIMEOUT,
              onTimeout: () => ({kind: 'unavailable'}) as const,
              onSuccess: (s) => s,
            }),
          ),
        )
        if (!active || snapshot.kind !== 'ok') return
        setGeneration(parseDustGeneration(snapshot.row))
        setAssessment(assess(toObservedDust(snapshot)))
      } catch (error) {
        logger.warn('dust registration read failed', {origin: 'useDustRegistration', error: String(error)})
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [rail, wrongNetwork, nonce])

  return {
    assessment,
    registrations,
    night,
    generation,
    loading,
    unavailable: unavailable || wrongNetwork,
    unavailableReasonKey: wrongNetwork ? 'wrongNetwork' : 'unavailable',
    rail,
    refresh,
  }
}
