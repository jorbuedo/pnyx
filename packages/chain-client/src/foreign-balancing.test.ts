// The one thing this module exists to guarantee: the caller's transaction is never signed by us.
// Getting it wrong costs a node rejection with `Custom error: 192` and nothing else — the transaction
// looks fine locally, which is why this is asserted rather than reviewed.
import {describe, expect, it} from 'vitest'
import {balanceForeignTx, foreignBalancingProvider} from './foreign-balancing'

const BASE = {id: 'the caller transaction'}
const BALANCING = {id: 'our fee'}

type Call = {type: string; transaction?: unknown; baseTransaction?: unknown; balancingTransaction?: unknown}

const wallet = (options: {balancing?: unknown} = {}) => {
  const signed: unknown[] = []
  const finalized: Call[] = []
  const balanceArgs: {tx: unknown; options: unknown}[] = []
  const facade = {
    balanceUnboundTransaction: async (tx: unknown, _keys: unknown, opts: {ttl: Date}) => {
      balanceArgs.push({tx, options: opts})
      return {
        baseTransaction: tx,
        ...('balancing' in options ? {balancingTransaction: options.balancing} : {balancingTransaction: BALANCING}),
      }
    },
    signRecipe: async (
      recipe: {type: 'UNPROVEN_TRANSACTION'; transaction: unknown},
      sign: (p: Uint8Array) => unknown,
    ) => {
      signed.push(recipe.transaction)
      sign(new Uint8Array([1]))
      return {transaction: {signed: recipe.transaction}}
    },
    finalizeRecipe: async (recipe: Call) => {
      finalized.push(recipe)
      return {finalized: recipe}
    },
  }
  return {
    handle: {
      wallet: facade,
      zswapSecretKeys: 'zswap',
      dustSecretKey: 'dust',
      unshieldedKeystore: {signData: () => 'signature'},
    },
    signed,
    finalized,
    balanceArgs,
  }
}

describe('balanceForeignTx', () => {
  it('finalizes the caller transaction exactly as it arrived', async () => {
    const w = wallet()
    await balanceForeignTx(w.handle, BASE)
    expect(w.finalized).toHaveLength(1)
    expect(w.finalized[0]?.baseTransaction).toBe(BASE)
  })

  it('never signs the caller transaction', async () => {
    const w = wallet()
    await balanceForeignTx(w.handle, BASE)
    // The whole point: `signRecipe` sees our balancing transaction and nothing else. The SDK's own
    // balanceTx signs the base too, which appends a second signature to an offer the caller signed.
    expect(w.signed).toEqual([BALANCING])
    expect(w.signed).not.toContain(BASE)
  })

  it('signs the balancing transaction, so our own dust spend is authorized', async () => {
    const w = wallet()
    await balanceForeignTx(w.handle, BASE)
    expect(w.finalized[0]?.balancingTransaction).toEqual({signed: BALANCING})
  })

  it('omits the balancing transaction entirely when there is none to sign', async () => {
    // The idle-chain zero-fee case: patchNoopDustBalancing drops the dust no-op upstream, and a
    // `balancingTransaction: undefined` key would be a different recipe from one without the key.
    const w = wallet({balancing: undefined})
    await balanceForeignTx(w.handle, BASE)
    expect(w.signed).toEqual([])
    expect(w.finalized[0]).not.toHaveProperty('balancingTransaction')
  })

  it('passes the given ttl through, and an hour out when there is none', async () => {
    // Not optional: the SDK reads `ttl.getTime()` unconditionally, so omitting it throws
    // "undefined is not an object" from inside the balancer — measured on the sponsor host.
    const w = wallet()
    const ttl = new Date(1_700_000_000_000)
    await balanceForeignTx(w.handle, BASE, ttl)
    const before = Date.now()
    await balanceForeignTx(w.handle, BASE)
    const [given, defaulted] = w.balanceArgs.map((a) => a.options as {ttl: Date})
    expect(given?.ttl).toBe(ttl)
    expect(defaulted?.ttl.getTime()).toBeGreaterThanOrEqual(before + 60 * 60_000)
  })

  it('exposes a balanceTx-shaped provider, so it can replace the SDK one', async () => {
    const w = wallet()
    const provider = foreignBalancingProvider(w.handle)
    await provider.balanceTx(BASE)
    expect(w.finalized[0]?.baseTransaction).toBe(BASE)
    expect(w.signed).toEqual([BALANCING])
  })
})
