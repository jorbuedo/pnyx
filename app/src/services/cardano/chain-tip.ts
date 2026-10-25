/**
 * The chain tip, read through Evolution's provider.
 *
 * ⚠️ **Its own module because `getTip` is optional.** A backend that cannot report a tip is a
 * legitimate implementation of Evolution's provider, so every caller would otherwise either
 * assert it away with `!` — a claim about a backend the caller did not choose — or write the
 * same absence check. This turns the absence into the typed failure the callers already handle:
 * each one logs and renders nothing rather than a chain position it cannot stand behind.
 *
 * @module
 */

import {Provider as EvolutionProvider} from '@evolution-sdk/evolution'
import {Effect} from 'effect'

export const chainTip = (
  chain: Pick<EvolutionProvider.ProviderEffect, 'getTip'>,
): Effect.Effect<EvolutionProvider.Tip, EvolutionProvider.ProviderError> =>
  chain.getTip === undefined
    ? Effect.fail(new EvolutionProvider.ProviderError({message: 'this chain backend does not report a tip'}))
    : chain.getTip()
