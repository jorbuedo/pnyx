/**
 * Walker-Vose alias sampler — draws an index according to a weight vector in O(1).
 *
 * Used for exactly one thing: picking a fountain part's *degree* from a harmonic distribution.
 * Like everything else in the fountain path it is protocol rather than choice, so two details
 * that look arbitrary are load-bearing and must not be tidied:
 *
 * - the worklists are filled **backwards** (index n-1 first) and popped from the end, which
 *   fixes which index pairs with which alias;
 * - `next` draws **two** doubles from the generator, in that order, even when the second is not
 *   needed — the generator is shared with the shuffle that follows, so consuming a different
 *   number of draws shifts every later fragment index.
 *
 * @module
 */

export type RandomSampler = {
  /** Draw an index in [0, n), consuming exactly two doubles from `rng`. */
  readonly next: (rng: {readonly nextDouble: () => number}) => number
}

/**
 * Indexed read and stack pop that state the invariant once rather than at a dozen call sites.
 * Every index below is derived from the same `n`, so neither can fire — but saying so in one
 * place beats scattering non-null assertions through the construction.
 */
const at = (values: readonly number[], index: number): number => {
  const value = values[index]
  if (value === undefined) throw new Error(`randomSampler: index ${index} is out of range`)
  return value
}

const pop = (stack: number[]): number => {
  const value = stack.pop()
  if (value === undefined) throw new Error('randomSampler: worklist underflow')
  return value
}

/**
 * Build a sampler over `weights`, which must be non-empty and strictly positive; they are
 * normalized internally, so they need not sum to 1.
 */
export const randomSampler = (weights: readonly number[]): RandomSampler => {
  const n = weights.length
  if (n === 0) throw new Error('randomSampler: weights must not be empty')
  if (weights.some((weight) => !(weight > 0) || !Number.isFinite(weight))) {
    throw new Error('randomSampler: every weight must be finite and greater than zero')
  }

  const total = weights.reduce((sum, weight) => sum + weight, 0)
  // Scale so the weights sum to n; each entry is then its probability relative to a uniform 1/n.
  const scaled = weights.map((weight) => (weight * n) / total)

  const small: number[] = []
  const large: number[] = []
  for (let i = n - 1; i >= 0; i--) {
    ;(at(scaled, i) < 1 ? small : large).push(i)
  }

  const probabilities = new Array<number>(n).fill(0)
  const aliases = new Array<number>(n).fill(0)

  while (small.length > 0 && large.length > 0) {
    const a = pop(small)
    const g = pop(large)
    probabilities[a] = at(scaled, a)
    aliases[a] = g
    scaled[g] = at(scaled, g) + at(scaled, a) - 1
    ;(at(scaled, g) < 1 ? small : large).push(g)
  }

  // Whatever is left is a full bucket. `small` should be empty here; it can hold a straggler
  // through floating-point drift, and the reference treats that case identically.
  while (large.length > 0) probabilities[pop(large)] = 1
  while (small.length > 0) probabilities[pop(small)] = 1

  return {
    next: (rng) => {
      const r1 = rng.nextDouble()
      const r2 = rng.nextDouble()
      const i = Math.floor(n * r1)
      return r2 < at(probabilities, i) ? i : at(aliases, i)
    },
  }
}
