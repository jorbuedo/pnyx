/**
 * Which Plutus constructor the mapping validator wants in each redeemer.
 *
 * ⚠️ **The mint handler branches on its redeemer, and the two branches want opposite things.** Under
 * the **unit** redeemer (`Constr 0 []`) it takes the *registration* path, whose first check is
 * `expect [Pair("", 1)] = tokens |> to_pairs` — the policy's token map must be exactly a mint of one.
 * A burn is `("", -1)` and fails it. Under any **other** redeemer it takes a path that accepts the
 * burn.
 *
 * That is why a deregistration built with the unit redeemer everywhere is refused at submit, with the
 * failure attributed to `MintingScript` rather than to the spend — which is what a mainnet attempt on
 * 2026-08-29 returned, and what this module exists to stop.
 *
 * Established by evaluating the real script (`aiken uplc eval`) over the rejected transaction's own
 * context, one purpose at a time — the step the earlier investigation skipped, which is how it
 * concluded the burn was impossible:
 *
 * | mint field | purpose | redeemer | result |
 * |---|---|---|---|
 * | `("", -1)` | spending | unit | **pass** |
 * | `("", -1)` | minting | unit | fail — `expect [Pair("", 1)]` |
 * | `("", -1)` | minting | `Constr 1 []` | **pass** |
 * | `("", +1)` | minting | unit | **pass** — the registration path |
 * | `("", +1)` | spending | unit | fail |
 * | none | spending | unit | fail |
 *
 * ⚠️ **The spend redeemer stays unit.** Only the mint redeemer selects an action; the spend handler
 * ignores its own and reads the mint field instead, which is the asymmetry the table above shows.
 *
 * @module
 */

/** The redeemer the registration path wants: `Constr 0 []`. */
export const REGISTER_REDEEMER_ALT = 0n

/**
 * The redeemer a burn wants: anything that is not the unit constructor.
 *
 * ⚠️ Evaluation shows several non-unit values take the accepting branch, so this being the validator's
 * *intended* "burn" action is inference rather than proof — the script's own names are not in the
 * compiled artefact. `1n` is the next constructor, which is the conventional second action, and it is
 * verified to pass against the real script.
 */
export const BURN_REDEEMER_ALT = 1n

/** Which constructor the **mint** redeemer carries, given what the transaction does to the supply. */
export const mintRedeemerAlt = (mintsAuthToken: 'mint' | 'burn'): bigint =>
  mintsAuthToken === 'burn' ? BURN_REDEEMER_ALT : REGISTER_REDEEMER_ALT
