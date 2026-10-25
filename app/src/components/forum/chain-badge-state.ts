/**
 * Which state a circle's chain badge should render.
 *
 * Pulled out of the component because the interesting case is a *disagreement*: the settlement says
 * confirmed and the template says the contract is from an older compile. The circle really is on
 * chain — that is exactly what makes "On-chain" the wrong thing to say, because its verifier keys are
 * an older compile, every proof against it is invalid, and the sponsor refuses its calls.
 *
 * ⚠️ `unknown` must not upgrade or downgrade anything. It means the service has not resolved the
 * contract's digest yet, which is neither evidence that the template matches nor that it does not.
 *
 * @module
 */

export type ChainBadgeState = 'pending' | 'confirmed' | 'failed' | 'outdated'

export type ChainBadgeStateInput = {
  readonly status?: 'pending' | 'confirmed' | 'failed' | undefined
  readonly template?: 'current' | 'outdated' | 'unknown' | undefined
}

export const chainBadgeState = ({status, template}: ChainBadgeStateInput): ChainBadgeState | undefined =>
  // Only a *settled* circle can be outdated: a pending one has nothing deployed to compare, and a
  // failed one already says the louder thing.
  template === 'outdated' && status === 'confirmed' ? 'outdated' : status
