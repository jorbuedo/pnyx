/**
 * Fetching a token's transfer-logic script from the chain, and proving it is the right one.
 *
 * A registry node names a policy's `transfer_logic` by **hash**, not by bytes. But a Plutus script
 * has to be supplied to execute, so any substandard that has ever run is recorded by the indexer —
 * measured on preview 2026-08-16: 8 of the 11 distinct transfer-logic scripts across the twelve
 * live registry nodes come back from `/script_info`, 89 to 6,303 bytes, all PlutusV3.
 *
 * ⚠️ **The verification is what makes this safe, and it is not ceremony.** The hash comes from the
 * on-chain registry node — a value we did not choose and an attacker would have to have got past
 * the registry to influence. Fetched bytes are hashed and compared against it, so a compromised or
 * simply wrong indexer response cannot become a script we hand to the ledger. Same rule
 * `deploymentScripts()` applies to PLB and PLG, for the same reason.
 *
 * The redeemer is the part chain cannot tell us. Our own substandard is
 * `withdraw(_redeemer, _account, _self) { True }` and ignores it, so the unit redeemer satisfies it.
 * A larger third-party script plausibly wants something specific and nothing on chain states what —
 * which is why the redeemer is a parameter here and defaults to nothing.
 *
 * Reads through `Provider.scriptByHash` rather than calling the indexer directly. An earlier
 * version hand-rolled the HTTP call, which skipped the provider's auth token, its retry and paging
 * conventions and its error taxonomy — and the repo's own rule is that indexer access goes through
 * the configured provider. The port gained the method rather than the app keeping a private copy.
 *
 * @module
 */

import type {Cip113} from '@evolution-sdk/cip113'
import {Query as Cip113Query} from '@evolution-sdk/cip113'
import {Provider as EvolutionProvider} from '@evolution-sdk/evolution'
import {ScriptHex} from '@evolution-sdk/review/Brands'
import {Effect} from 'effect'
import {logger} from '../../../logger'

/** The unit redeemer, `Constr 0 []`. What a substandard that ignores its redeemer accepts. */
export const UNIT_REDEEMER_HEX = 'd87980'

/**
 * A generous fixed budget for a substandard's withdraw-zero.
 *
 * There is no Plutus VM on device, so a substandard's true cost cannot be computed here, and its
 * cost is the issuer's to decide so it cannot be presetted from measurement either. The live
 * transfer used exactly this. Over-budgeting costs fee, not correctness — under-budgeting fails the
 * user's transaction, so the asymmetry decides the default.
 */
export const DEFAULT_SUBSTANDARD_EXUNITS: readonly [bigint, bigint] = [6_000_000n, 3_000_000_000n]

export type SubstandardFetch =
  | {readonly kind: 'ok'; readonly substandards: ReadonlyMap<string, Cip113.Substandard>}
  /** One or more scripts could not be obtained. Named, so a screen can say which token. */
  | {readonly kind: 'missing'; readonly scriptHashes: readonly string[]}

/**
 * Fetch and verify the transfer-logic scripts for a set of hashes.
 *
 * A hash whose bytes do not hash back to it is dropped rather than used — and reported as missing,
 * because "we could not get it" and "we got something else" should both stop a transfer, and only
 * one of them is worth distinguishing to a user. An unreachable indexer is likewise missing, never
 * empty-and-fine.
 */
export const fetchSubstandards = (
  scriptHashes: readonly string[],
  opts: {readonly redeemerHexFor?: (scriptHashHex: string) => string} = {},
): Effect.Effect<SubstandardFetch, never, EvolutionProvider.ProviderEffect> =>
  Effect.gen(function* () {
    const wanted = [...new Set(scriptHashes.map((h) => h.toLowerCase()))]
    if (wanted.length === 0) return {kind: 'ok', substandards: new Map()} as SubstandardFetch

    const chain = yield* EvolutionProvider.ProviderEffect
    const byHash = chain.getScriptByHash
    if (byHash === undefined) {
      // A backend that cannot serve scripts cannot support a transfer. Said plainly rather than
      // reported as "no such script", which would blame the token.
      logger.warn('cip113: this provider cannot fetch scripts by hash', {origin: 'fetchSubstandards'})
      return {kind: 'missing', scriptHashes: wanted} as SubstandardFetch
    }

    const found = new Map<string, Cip113.Substandard>()
    for (const hash of wanted) {
      const script = yield* byHash(hash).pipe(Effect.orElseSucceed(() => undefined))
      if (script === undefined) continue
      const actual = Cip113Query.scriptHashV3(script.bytesHex).toLowerCase()
      if (actual !== hash) {
        // Not a warning to shrug at: the indexer returned bytes that are not the script the
        // registry names, and using them would put an unknown script in the user's transaction.
        logger.warn('cip113: a fetched transfer-logic script did not match its hash', {
          origin: 'fetchSubstandards',
          expected: hash,
          actual,
        })
        continue
      }
      found.set(hash, {
        scriptHashHex: hash,
        scriptHex: ScriptHex(script.bytesHex),
        redeemerDataHex: opts.redeemerHexFor?.(hash) ?? UNIT_REDEEMER_HEX,
        exUnits: DEFAULT_SUBSTANDARD_EXUNITS,
      })
    }

    const missing = wanted.filter((h) => !found.has(h))
    return (
      missing.length > 0 ? {kind: 'missing', scriptHashes: missing} : {kind: 'ok', substandards: found}
    ) as SubstandardFetch
  })
