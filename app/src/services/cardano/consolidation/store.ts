/**
 * Persistence for the wallet-optimization policy.
 *
 * Decoding is **per field** rather than all-or-nothing, and deliberately so: a
 * later release that adds a knob must not silently reset the ones the user
 * already chose, and a value stored before that knob existed is not corrupt — it
 * simply predates it. A field that is missing or of the wrong type falls back to
 * that field's documented default, which is the one place in this app where a
 * default *is* the domain-correct answer for absent data.
 *
 * @module
 */

import {logger} from '../../../logger'
import {storage} from '../../../platform/storage'
import {DEFAULT_WALLET_OPTIMIZATION, type WalletOptimization} from './policy'

export const WALLET_OPTIMIZATION_KEY = '@pnyx/wallet_optimization'

const boolOr = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback)

/**
 * Read a stored policy. `maxInputsPerTx` stays absent unless a positive integer
 * was stored — a cap of zero or a fraction is not a cap, it is corruption, and
 * honouring it would silently refuse to consolidate anything.
 */
export const decodeWalletOptimization = (value: unknown): WalletOptimization => {
  if (typeof value !== 'object' || value === null) return DEFAULT_WALLET_OPTIMIZATION
  const stored = value as Record<string, unknown>
  const cap = stored.maxInputsPerTx
  const validCap = typeof cap === 'number' && Number.isInteger(cap) && cap > 0
  return {
    autoConsolidate: boolOr(stored.autoConsolidate, DEFAULT_WALLET_OPTIMIZATION.autoConsolidate),
    autoWithdrawRewards: boolOr(stored.autoWithdrawRewards, DEFAULT_WALLET_OPTIMIZATION.autoWithdrawRewards),
    bundleByPolicy: boolOr(stored.bundleByPolicy, DEFAULT_WALLET_OPTIMIZATION.bundleByPolicy),
    keepPureAdaOutput: boolOr(stored.keepPureAdaOutput, DEFAULT_WALLET_OPTIMIZATION.keepPureAdaOutput),
    ...(validCap ? {maxInputsPerTx: cap} : {}),
  }
}

/** The stored policy, or the defaults when nothing is stored or storage is unreadable. */
export const loadWalletOptimization = async (): Promise<WalletOptimization> => {
  try {
    const raw = await storage.get(WALLET_OPTIMIZATION_KEY)
    if (raw === null) return DEFAULT_WALLET_OPTIMIZATION
    return decodeWalletOptimization(JSON.parse(raw))
  } catch (e: unknown) {
    // The defaults are the right answer, but a policy the user set and one that could not be
    // read produce the same consolidation behaviour with nothing to tell them apart.
    logger.warn('Wallet optimization policy unreadable; using the defaults', {
      origin: 'consolidation/store',
      error: String(e),
    })
    return DEFAULT_WALLET_OPTIMIZATION
  }
}

/** Persist the policy. Resolves `false` when storage refused the write. */
export const saveWalletOptimization = async (policy: WalletOptimization): Promise<boolean> => {
  try {
    await storage.set(WALLET_OPTIMIZATION_KEY, JSON.stringify(policy))
    return true
  } catch (e: unknown) {
    // `false` reaches the caller, so the UI can say so — but not why.
    logger.warn('Wallet optimization policy not persisted', {origin: 'consolidation/store', error: String(e)})
    return false
  }
}
