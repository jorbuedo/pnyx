/**
 * Running one byte operation inside the typed failure channel.
 *
 * Evolution's leaves are plain and synchronous: they throw on malformed input, because a byte
 * operation has nothing useful to say about *why* a hex string was not a hex string. The tiers
 * above are Effects, so something has to turn a throw into a typed failure exactly once — this is
 * that something, and every tier is written through it.
 *
 * @since 0.1.0
 */

import {Data, Effect} from 'effect'

/**
 * A byte operation failed: malformed input, a bad length, an unsupported shape.
 *
 * Carries the operation's name, because the message alone rarely identifies which of the tiers'
 * operations produced it.
 *
 * @since 0.1.0
 */
export class CoreError extends Data.TaggedError('CoreError')<{
  readonly op: string
  readonly message: string
}> {}

/**
 * Run one byte operation, mapping any throw into a typed {@link CoreError}.
 *
 * ⚠️ **It used to require a `Codec` service from the Effect context**, so every tier's Effect
 * carried `Codec` in its R channel and 65 files had to provide `EvolutionCodecLayer` to run one.
 * The tiers call Evolution directly now, so there is no service to provide and the R channel is
 * `never`. Callers that only ever provided that layer can drop it.
 *
 * `Effect.try`, not `Effect.suspend`: a throw inside `suspend` is a DEFECT, which `catchAll` does
 * not catch -- and every leaf below throws on malformed input.
 *
 * @since 0.1.0
 */
export const op = <A>(name: string, f: () => A): Effect.Effect<A, CoreError> =>
  Effect.try({
    try: f,
    catch: (e) => new CoreError({op: name, message: e instanceof Error ? e.message : String(e)}),
  })
